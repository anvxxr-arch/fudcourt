#!/usr/bin/env python3
"""
backfill-prices.py -- materialize implied unit prices from `asset_history`.

Why this exists
---------------
`asset_history` already stores each holding's `quantity` and `value_usd` per
sync, and their ratio IS a unit price. DR-046 exposes that as the `price_history`
table so the P&L board can show a real series instead of inventing one — but a
materialization is only useful if it keeps up with the data it derives from.

This is that cadence, and it is deliberately its OWN unit pair rather than an
`ExecStartPost` on `fudcourt-sync.service`: the sync is the Python oracle whose
exit status is the cross-check for the Rust service, and a derived read-side
projection must never be able to mark it failed. If this run fails, only the
`fudcourt-prices` timer shows it; the sync stays clean.

The write is idempotent -- `ON CONFLICT (symbol, ts, source) DO NOTHING` against
the unique index -- so running it after every sync inserts only new observations
and running it twice inserts nothing. It reads the same repo-root `.env` the sync
does (`FUDCOURT_PG_URL`), so there is one connection string, not two.

Rows with no quantity or no value are skipped: a price needs both a numerator and
a denominator, and a `NULL`/`0` denominator would be a division by zero dressed
up as data.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]  # scripts/tools/ -> scripts -> repo


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    envfile = REPO / ".env"
    if envfile.exists():
        for raw in envfile.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


SQL = """
WITH ins AS (
  INSERT INTO price_history (ts, symbol, source, price)
  SELECT ts, asset, 'implied', (value_usd / quantity)::float8
  FROM asset_history
  WHERE quantity IS NOT NULL AND quantity > 0
    AND value_usd IS NOT NULL AND value_usd > 0
  ON CONFLICT (symbol, ts, source) DO NOTHING
  RETURNING 1
)
SELECT count(*)::int FROM ins
"""


def main() -> int:
    env = load_env()
    dsn = os.environ.get("FUDCOURT_PG_URL") or env.get("FUDCOURT_PG_URL")
    if not dsn:
        print("FUDCOURT_PG_URL not set (checked env and repo .env)", file=sys.stderr)
        return 2
    try:
        import psycopg2  # noqa: PLC0415
    except ModuleNotFoundError:
        print(
            "psycopg2 missing; install the host package python3-psycopg2 "
            "(see tests/oracle/requirements.txt)",
            file=sys.stderr,
        )
        return 3
    with psycopg2.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(SQL)
        row = cur.fetchone()
        inserted = int(row[0]) if row else 0
    print(f"backfill-prices: inserted {inserted} implied price rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
