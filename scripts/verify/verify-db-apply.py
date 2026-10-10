#!/usr/bin/env python3
"""
verify-db-apply.py -- EMPTY -> LATEST application of the tracked schemas
against a real PostgreSQL, with a disposable database. LIVE harness (needs a
Postgres; not part of the offline suite, listed in `node tools/fud.ts live`):

    FUDCOURT_QA_ADMIN_URL=postgres://...  # role with CREATEDB, used to
                                          # create/drop the scratch database
    FUDCOURT_PG_URL=postgres://...        # the applier role; the scratch DB is
                                          # owned by it so the apply runs under
                                          # the same privileges production uses

What it proves, on every run:
  1. db/schema/pg-schema.sql applies to an EMPTY database with zero errors,
  2. it is re-appliable (second run: zero errors, constraint count unchanged),
  3. the timescaledb extension and both hypertables exist after apply,
  4. the ON CONFLICT (wallet, chain, asset) arbiter index exists and upserts
     (the exact statement the Rust sync runs; it fails on a drifted database),
  5. db/schema/executor-schema.sql applies the same way, 10 executor tables,
     every FK validated,
  6. the scratch database is dropped even when a check fails,
  7. snapshot timestamp semantics (2026-10-09): a naive UTC `updated_at`
     keeps its value, an ISO string carrying Z or a numeric offset is stored
     as the instant it names, an empty string snapshots at now().

Exit 0 + APPLY_OK on success; exit 1 with APPLY_FAILED lines otherwise.
"""
from __future__ import annotations

import os
import sys
import time
import urllib.parse
from pathlib import Path

import psycopg2
from psycopg2 import sql as pgsql

REPO = Path(__file__).resolve().parents[2]
PG_SCHEMA = REPO / "db" / "schema" / "pg-schema.sql"
EXECUTOR_SCHEMA = REPO / "db" / "schema" / "executor-schema.sql"

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)
    print(f"APPLY_FAILED: {msg}", file=sys.stderr)


def db_url(base: str, dbname: str) -> str:
    u = urllib.parse.urlparse(base)
    return urllib.parse.urlunparse(u._replace(path="/" + dbname))


def apply_file(conn, name: str, path: Path, phase: str) -> None:
    sql_text = path.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        try:
            cur.execute(sql_text)
        except Exception as e:  # noqa: BLE001 - reported verbatim
            fail(f"{name} {phase}: {e}")
            raise SystemExit(1)


def main() -> int:
    admin_url = os.environ.get("FUDCOURT_QA_ADMIN_URL")
    applier_url = os.environ.get("FUDCOURT_PG_URL")
    if not admin_url:
        fail("FUDCOURT_QA_ADMIN_URL not set (role needs CREATEDB)")
        return 1
    if not applier_url:
        fail("FUDCOURT_PG_URL not set (the applier role whose privileges are under test)")
        return 1
    applier_role = urllib.parse.urlparse(applier_url).username or ""
    if not applier_role:
        fail("FUDCOURT_PG_URL has no username")
        return 1
    db_name = f"fudcourt_qa_apply_{int(time.time())}"

    admin = psycopg2.connect(admin_url)
    admin.autocommit = True  # CREATE/DROP DATABASE cannot run in a transaction
    applied = None
    created = False
    try:
        with admin.cursor() as cur:
            try:
                cur.execute(
                    pgsql.SQL("CREATE DATABASE {} OWNER {}").format(
                        pgsql.Identifier(db_name), pgsql.Identifier(applier_role)
                    )
                )
                created = True
            except Exception as e:  # noqa: BLE001 - reported verbatim
                fail(f"CREATE DATABASE: {e}")
                return 1

        applied = psycopg2.connect(db_url(applier_url, db_name))
        applied.autocommit = True

        apply_file(applied, "pg-schema.sql", PG_SCHEMA, "apply")
        apply_file(applied, "pg-schema.sql", PG_SCHEMA, "re-apply")
        apply_file(applied, "executor-schema.sql", EXECUTOR_SCHEMA, "apply")
        apply_file(applied, "executor-schema.sql", EXECUTOR_SCHEMA, "re-apply")

        with applied.cursor() as cur:
            cur.execute(
                """
                SELECT
                  (SELECT count(*) FROM pg_extension WHERE extname = 'timescaledb'),
                  (SELECT count(*) FROM timescaledb_information.hypertables
                    WHERE hypertable_schema = 'public'),
                  (SELECT count(*) FROM pg_indexes
                    WHERE schemaname='public' AND indexname='assets_wallet_chain_asset'),
                  (SELECT count(*) FROM pg_constraint
                    WHERE connamespace::regnamespace::text IN ('public','executor')),
                  (SELECT count(*) FROM pg_tables
                    WHERE schemaname IN ('public','executor')),
                  (SELECT count(*) FROM pg_constraint
                    WHERE contype='f' AND NOT convalidated),
                  (SELECT count(*) FROM pg_tables
                    WHERE schemaname='executor')
                """
            )
            ext_n, ht_n, arbiter_n, con_n, tbl_n, badfk_n, exec_tbl_n = cur.fetchone()
            if ext_n != 1:
                fail(f"timescaledb extension missing after apply (got {ext_n})")
            if ht_n != 2:
                fail(f"expected 2 hypertables, got {ht_n}")
            if arbiter_n != 1:
                fail(
                    "assets_wallet_chain_asset unique index missing -- "
                    "ON CONFLICT (wallet, chain, asset) writers would fail"
                )
            if badfk_n != 0:
                fail(f"{badfk_n} FKs are NOT valid")
            if exec_tbl_n != 10:
                fail(f"executor schema: expected 10 tables, got {exec_tbl_n}")
            if tbl_n != 22:
                fail(f"expected 22 tables (12 public + 10 executor), got {tbl_n}")

            # the arbiter actually works end to end: insert, then upsert
            try:
                cur.execute(
                    """
                    INSERT INTO assets (chain, asset, quantity, value_usd, share_pct, wallet, updated_at)
                    VALUES ('qa','QA', 1, 1, 1, '0xqa',
                            to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))
                    ON CONFLICT (wallet, chain, asset) DO UPDATE
                      SET quantity = EXCLUDED.quantity
                    RETURNING quantity
                    """
                )
                cur.execute(
                    """
                    INSERT INTO assets (chain, asset, quantity, value_usd, share_pct, wallet, updated_at)
                    VALUES ('qa','QA', 2, 2, 2, '0xqa',
                            to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))
                    ON CONFLICT (wallet, chain, asset) DO UPDATE
                      SET quantity = EXCLUDED.quantity
                    RETURNING quantity
                    """
                )
                q = cur.fetchone()[0]
                if q != 2:
                    fail(f"ON CONFLICT upsert did not update (quantity={q})")
            except Exception as e:  # noqa: BLE001
                fail(f"ON CONFLICT (wallet, chain, asset) insert failed: {e}")

            # snapshot timestamp semantics: a naive UTC string keeps its value,
            # an ISO string carrying Z or a numeric offset is stored as the
            # instant it names (the 2026-10-09 fix; the old cast silently
            # ignored the offset), an empty string falls back to now()
            try:
                cur.execute(
                    """
                    INSERT INTO assets (chain, asset, quantity, value_usd, share_pct, wallet, updated_at)
                    VALUES ('qa','TS_NAIVE',1,1,1,'0xtnaive','2026-03-29 01:30:00'),
                           ('qa','TS_OFFSET',1,1,1,'0xtoffset','2026-10-09T21:00:00+08:00'),
                           ('qa','TS_ZULU',1,1,1,'0xtz','2026-10-09T13:00:00.123Z'),
                           ('qa','TS_EMPTY',1,1,1,'0xtempty','')
                    """
                )
                cur.execute(
                    """
                    SELECT wallet, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
                    FROM asset_history
                    WHERE chain='qa' AND asset LIKE 'TS_%'
                    """
                )
                got = dict(cur.fetchall())
                want = {
                    "0xtnaive": "2026-03-29 01:30:00.000000",
                    "0xtoffset": "2026-10-09 13:00:00.000000",
                    "0xtz": "2026-10-09 13:00:00.123000",
                }
                for w, ts_want in want.items():
                    if got.get(w) != ts_want:
                        fail(f"snapshot ts for {w}: want {ts_want}, got {got.get(w)}")
                if "0xtempty" not in got:
                    fail("empty updated_at produced no snapshot row")
                else:
                    cur.execute(
                        "SELECT now() - ts < interval '60 seconds' "
                        "FROM asset_history WHERE wallet='0xtempty'"
                    )
                    if not cur.fetchone()[0]:
                        fail("empty updated_at snapshot is not near now()")
            except Exception as e:  # noqa: BLE001
                fail(f"snapshot timestamp regression tests: {e}")

            # constraint count must be identical after the second apply
            cur.execute(
                "SELECT count(*) FROM pg_constraint "
                "WHERE connamespace::regnamespace::text IN ('public','executor')"
            )
            con_after = cur.fetchone()[0]
            if con_after != con_n:
                fail(f"re-apply changed constraint count {con_n} -> {con_after}")
    finally:
        if applied is not None:
            applied.close()
        if created:
            with admin.cursor() as cur:
                try:
                    cur.execute(
                        pgsql.SQL("DROP DATABASE {}").format(pgsql.Identifier(db_name))
                    )
                except Exception as e:  # noqa: BLE001
                    print(f"APPLY_FAILED: DROP DATABASE {db_name}: {e}", file=sys.stderr)
        admin.close()

    if failures:
        return 1
    print(
        f"APPLY_OK ({db_name}: pg-schema + executor-schema applied twice, "
        "extension/hypertables/arbiter/FKs verified, database dropped)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
