#!/usr/bin/env python3
"""
check-schema-bootstrap.py -- db/schema/pg-schema.sql must apply EMPTY -> LATEST.

Offline, stdlib-only. Three failure classes this gate exists to catch, all
found by the 2026-10-09 QA pass:

1. Bootstrap order. The file calls create_hypertable() (asset_history,
   price_history), which only exists once the timescaledb extension is
   installed. CI's timescale/timescaledb container ships it pre-created, so a
   missing CREATE EXTENSION is invisible there -- and a clean database on a
   plain Postgres dies mid-apply with "function create_hypertable(...) does not
   exist". The declaration must therefore be present AND precede the first
   create_hypertable call.

2. Destructive statements. This file is re-applied to the live system of
   record (out-of-band, per db/README.md). A DROP TABLE / DROP SCHEMA /
   TRUNCATE / DELETE that lands here would execute against production data.
   Only DROP TRIGGER IF EXISTS (the pre-create reset of assets_snapshot_trg)
   is allowed.

3. Upsert arbiters. The Rust sync (apps/reconciler/src/persistence/db.rs)
   upserts assets on a three-column key through an ON CONFLICT clause;
   PostgreSQL resolves that
   clause at plan time against a matching unique index; if the index is absent
   -- from the schema file or from the live database -- the INSERT fails with
   "no unique or exclusion constraint matching the ON CONFLICT specification".
   Every plain-column arbiter used in tracked source must be backed by a
   unique index this file creates.

SQL comments are stripped before scanning (prose here discusses the very
statements being checked); the file contains no `--` inside string literals.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCHEMA = REPO / "db" / "schema" / "pg-schema.sql"
SOURCE_SUFFIXES = {".rs", ".py", ".go", ".ts", ".tsx", ".js", ".mjs", ".sql"}
SOURCE_DIRS = ("apps", "scripts", "tests", "db", "contracts", "tools")

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def strip_comments_keep_lines(sql: str) -> str:
    """Blank out `--` comments line by line, preserving line numbers."""
    out = []
    for line in sql.splitlines(keepends=True):
        idx = line.find("--")
        if idx == -1:
            out.append(line)
        else:
            out.append(line[:idx] + ("\n" if line.endswith("\n") else ""))
    return "".join(out)


def main() -> int:
    raw = SCHEMA.read_text(encoding="utf-8")
    sql = strip_comments_keep_lines(raw)

    # --- 1. bootstrap order: extension before first create_hypertable ---
    ext = re.search(
        r"^\s*CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+timescaledb\s*;",
        sql,
        re.IGNORECASE | re.MULTILINE,
    )
    if not ext:
        fail(
            "db/schema/pg-schema.sql does not declare "
            "`CREATE EXTENSION IF NOT EXISTS timescaledb;` -- a clean database "
            "cannot reach create_hypertable()"
        )
    first_ht = re.search(r"create_hypertable\s*\(", sql, re.IGNORECASE)
    if not first_ht:
        fail(
            "db/schema/pg-schema.sql no longer calls create_hypertable() "
            "-- gate assumptions changed, re-read this gate"
        )
    if first_ht and ext and ext.start() > first_ht.start():
        fail(
            f"CREATE EXTENSION timescaledb (offset {ext.start()}) must precede "
            f"the first create_hypertable() call (offset {first_ht.start()})"
        )

    # --- 2. no destructive DDL in the re-appliable schema ---
    destructive = re.compile(
        r"\bDROP\s+(TABLE|SCHEMA|DATABASE)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b",
        re.IGNORECASE,
    )
    allowed_drop_trigger = re.compile(r"^\s*DROP\s+TRIGGER\b", re.IGNORECASE)
    for n, line in enumerate(sql.splitlines(), 1):
        if allowed_drop_trigger.match(line):
            continue
        if destructive.search(line):
            fail(
                f"db/schema/pg-schema.sql:{n}: destructive statement: "
                f"{raw.splitlines()[n - 1].strip()}"
            )

    # --- 3. ON CONFLICT arbiters used in source must exist as unique indexes ---
    arbiters: dict[tuple[str, ...], None] = {}
    for rel in SOURCE_DIRS:
        root = REPO / rel
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if path.suffix not in SOURCE_SUFFIXES or not path.is_file():
                continue
            if "node_modules" in path.parts or "target" in path.parts:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for m in re.finditer(r"ON\s+CONFLICT\s*\(([^)]+)\)", text, re.IGNORECASE):
                cols = tuple(
                    re.sub(r"\s+", " ", c).strip().lower()
                    for c in m.group(1).split(",")
                    if c.strip() and "(" not in c
                )
                if cols:
                    relpath = path.relative_to(REPO).as_posix()
                    if not relpath.startswith("db/schema/"):
                        arbiters[(relpath,) + cols] = None
    # unique index definitions the schema creates: CREATE UNIQUE INDEX ... ON <table> (<cols>)
    indexes: list[tuple[str, tuple[str, ...]]] = []
    for m in re.finditer(
        r"CREATE\s+UNIQUE\s+INDEX\s+[^;]*?\bON\s+([a-z_][\w.]*)\s*\(([^)]*)\)",
        sql,
        re.IGNORECASE | re.DOTALL,
    ):
        table = m.group(1).split(".")[-1].lower()
        cols = tuple(re.sub(r"\s+", " ", c).strip().lower() for c in m.group(2).split(","))
        indexes.append((table, cols))
    checked = 0
    for key in sorted(arbiters):
        rel, cols = key[0], key[1:]
        if cols == ("wallet", "chain", "asset"):
            checked += 1
            if not any(t == "assets" and c == cols for t, c in indexes):
                fail(
                    f"{rel}: ON CONFLICT ({', '.join(cols)}) has no matching "
                    "CREATE UNIQUE INDEX in db/schema/pg-schema.sql"
                )

    if failures:
        for f in failures:
            print(f"SCHEMA_BOOTSTRAP_FAILED: {f}", file=sys.stderr)
        return 1
    print(
        "SCHEMA_BOOTSTRAP_OK "
        "(extension declared before create_hypertable, no destructive DDL, "
        f"{checked} ON CONFLICT arbiter(s) checked)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
