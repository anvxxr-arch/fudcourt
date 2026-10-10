#!/usr/bin/env python3
"""
check-live-drift.py -- the live database must match what `db/schema/*.sql`
would produce on an empty database. LIVE harness (needs Postgres; listed in
`node tools/fud.ts live dbdrift`):

    FUDCOURT_QA_ADMIN_URL=postgres://...  # superuser: catalogs must be read
                                          # without per-role visibility holes
    FUDCOURT_PG_URL=postgres://...        # the applier role (fudcourt); the
                                          # reference side is built as this role
    FUDCOURT_QA_LIVE_DB=fudcourt          # optional; DB under check

Method: apply both schema files to a disposable scratch database (same path
`verify-db-apply.py` proves applies cleanly), then diff NORMALIZED CATALOGS
(columns, indexes, constraints, hypertables) between scratch and the live DB,
read on both sides as the admin role. The live side subtracts an explicit
ALLOWLIST of tool-self-provisioned tables (`alert_state` from
scripts/tools/alert-engine.py, `signal_plans` from scripts/tools/signal-pipeline.py):
those are created by their tools' runtime `CREATE TABLE IF NOT EXISTS`, are not
part of the tracked DDL, and are deliberately not schema-owned.

It also asserts what broke the 2026-10-09 re-apply: every relation and every
file-defined function in the live `public`/`executor` schemas must be OWNED by
the applier role — an object owned by anyone else makes `IF NOT EXISTS`
statements fail at `must be owner of ...` even when the object exists.

Exit 0 + LIVE_DRIFT_OK; exit 1 + LIVE_DRIFT_DETECTED with the diff.
"""
from __future__ import annotations

import difflib
import os
import sys
import time
import urllib.parse
from pathlib import Path

import psycopg2
from psycopg2 import sql as pgsql

REPO = Path(__file__).resolve().parents[2]
SCHEMAS = ("public", "executor")
# Tool-self-provisioned tables, excluded from the LIVE side only.
ALLOWLIST_LIVE_ONLY = ("alert_state", "signal_plans")

QUERIES = {
    "columns": """
        SELECT c.table_name || '|' || c.column_name || '|' || c.data_type || '|'
               || c.is_nullable || '|' || coalesce(c.column_default, '-')
        FROM information_schema.columns c
        WHERE c.table_schema IN ('public','executor')
          AND NOT (c.table_name = ANY(%(allow)s))
        ORDER BY 1
    """,
    "indexes": """
        SELECT i.tablename || '|' || i.indexname || '|' || i.indexdef
        FROM pg_indexes i
        WHERE i.schemaname IN ('public','executor')
          AND NOT (i.tablename = ANY(%(allow)s))
        ORDER BY 1
    """,
    "constraints": """
        SELECT conrelid::regclass::text || '|' || conname || '|'
               || pg_get_constraintdef(oid)
        FROM pg_constraint
        WHERE connamespace::regnamespace::text IN ('public','executor')
          AND NOT (conrelid::regclass::text = ANY(%(rel_names)s))
        ORDER BY 1
    """,
    "hypertables": """
        SELECT hypertable_schema || '|' || hypertable_name
        FROM timescaledb_information.hypertables
        WHERE hypertable_schema IN ('public','executor')
        ORDER BY 1
    """,
    "relations": """
        SELECT relname || '|' || pg_get_userbyid(relowner)
        FROM pg_class
        WHERE relkind = 'r'
          AND relnamespace::regnamespace::text IN ('public','executor')
          AND NOT (relname = ANY(%(allow)s))
        ORDER BY 1
    """,
    "functions": """
        SELECT n.nspname || '|' || p.proname || '|' || pg_get_userbyid(p.proowner)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public','executor')
          AND p.prokind = 'f'
        ORDER BY 1
    """,
}


def db_url(base: str, dbname: str) -> str:
    u = urllib.parse.urlparse(base)
    return urllib.parse.urlunparse(u._replace(path="/" + dbname))


def dump(conn, live_side: bool) -> dict[str, list[str]]:
    allow = list(ALLOWLIST_LIVE_ONLY) if live_side else []
    out: dict[str, list[str]] = {}
    with conn.cursor() as cur:
        for name, q in QUERIES.items():
            params = None
            if "%(allow)s" in q:
                params = {"allow": allow}
            if "%(rel_names)s" in q:
                params = {"rel_names": ["public." + t for t in allow] + allow}
            cur.execute(q, params)
            out[name] = [r[0] for r in cur.fetchall()]
    return out


def main() -> int:
    admin_url = os.environ.get("FUDCOURT_QA_ADMIN_URL")
    applier_url = os.environ.get("FUDCOURT_PG_URL")
    live_db = os.environ.get("FUDCOURT_QA_LIVE_DB", "fudcourt")
    if not admin_url:
        print("LIVE_DRIFT_FAILED: FUDCOURT_QA_ADMIN_URL not set", file=sys.stderr)
        return 1
    if not applier_url:
        print("LIVE_DRIFT_FAILED: FUDCOURT_PG_URL not set", file=sys.stderr)
        return 1
    applier_role = urllib.parse.urlparse(applier_url).username or ""
    if not applier_role:
        print("LIVE_DRIFT_FAILED: FUDCOURT_PG_URL has no username", file=sys.stderr)
        return 1

    scratch_name = f"fudcourt_drift_ref_{int(time.time())}"
    admin = psycopg2.connect(admin_url)
    admin.autocommit = True
    ref = None
    created = False
    failures: list[str] = []
    try:
        with admin.cursor() as cur:
            cur.execute(
                pgsql.SQL("CREATE DATABASE {} OWNER {}").format(
                    pgsql.Identifier(scratch_name), pgsql.Identifier(applier_role)
                )
            )
            created = True
        ref = psycopg2.connect(db_url(applier_url, scratch_name))
        ref.autocommit = True
        applier = psycopg2.connect(applier_url)
        applier.autocommit = True
        try:
            for fname in ("pg-schema.sql", "executor-schema.sql"):
                sql_text = (REPO / "db" / "schema" / fname).read_text(encoding="utf-8")
                with ref.cursor() as cur:
                    cur.execute(sql_text)

            ref_dump = dump(ref, live_side=False)
            live_conn = psycopg2.connect(db_url(admin_url, live_db))
            try:
                live_dump = dump(live_conn, live_side=True)
            finally:
                live_conn.close()

            total = 0
            for name in QUERIES:
                a, b = ref_dump[name], live_dump[name]
                total += len(a)
                if a != b:
                    diff = list(
                        difflib.unified_diff(
                            b, a,
                            fromfile=f"live:{live_db}#{name}",
                            tofile=f"schema-file:{name}",
                            lineterm="",
                        )
                    )
                    for line in diff:
                        if line.startswith(("+++", "---", "@@")):
                            continue
                        if not line.startswith(("+", "-")):
                            continue  # context line, not a difference
                        failures.append(f"{name}: {line}")

            # ownership: live relations + file-defined functions must belong to
            # the applier role, or re-applying the schema dies at "must be owner"
            live_rel = dict(
                row.split("|", 1) for row in live_dump["relations"] if "|" in row
            )
            for rel, owner in sorted(live_rel.items()):
                if owner != applier_role:
                    failures.append(
                        f"ownership: relation {rel} is owned by {owner}, "
                        f"not the applier role {applier_role}"
                    )
            # Extension API functions (timescaledb) also live in public and are
            # postgres-owned by design; only functions the schema file itself
            # creates (present on the reference side, owned by the applier
            # role there) count as ownership-checked.
            ref_func_owner = {
                f"{row.split('|', 2)[0]}.{row.split('|', 2)[1]}": row.split("|", 2)[2]
                for row in ref_dump["functions"]
            }
            for row in live_dump["functions"]:
                nsp, proname, owner = row.split("|", 2)
                if ref_func_owner.get(f"{nsp}.{proname}") == applier_role and owner != applier_role:
                    failures.append(
                        f"ownership: function {nsp}.{proname} is owned by {owner}, "
                        f"not the applier role {applier_role}"
                    )
        finally:
            applier.close()
            ref.close()
    finally:
        if ref is not None:
            pass
        if created:
            with admin.cursor() as cur:
                cur.execute(
                    pgsql.SQL("DROP DATABASE {}").format(pgsql.Identifier(scratch_name))
                )
        admin.close()

    if failures:
        for f in failures:
            print(f"LIVE_DRIFT_DETECTED: {f}", file=sys.stderr)
        print(
            f"LIVE_DRIFT_DETECTED ({len(failures)} difference(s) between "
            f"{live_db} and db/schema/*.sql; allowlist: "
            f"{', '.join(ALLOWLIST_LIVE_ONLY)})",
            file=sys.stderr,
        )
        return 1
    print(
        f"LIVE_DRIFT_OK ({live_db} matches db/schema/*.sql: {total} catalog "
        f"objects compared, ownership clean, allowlist: "
        f"{', '.join(ALLOWLIST_LIVE_ONLY)})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
