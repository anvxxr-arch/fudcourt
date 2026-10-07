#!/usr/bin/env python3
"""
signal-pipeline.py -- turn an actionable signal into a RISK-SIZED paper plan,
exactly once (F8).

Why this exists
---------------
The signals family surfaces tokens the research side has vetted (decision
`surfaced`). Nothing carried one of those into a sized, auditable trade plan:
the boards stop at "this token was flagged". This is the missing bridge, and it
is deliberately PAPER-FIRST and plan-only.

What it does, and what it deliberately does NOT
-----------------------------------------------
It produces a PLAN, not an order. For each actionable signal it computes the
position a disciplined risk budget would take: a risk amount (a percent of
equity), a stop distance, and the quantity/notional that follow from them. The
plan is recorded for audit and the execution step is left to the executor.

WHY PLAN-ONLY, AND WHY THAT IS THE HONEST SHAPE: the surfaced signals are
on-chain Solana tokens (a mint address on a DEX). The executor trades CEX
venues (binance/bybit/mexc) under `marketType: spot|linear_perp`, so it cannot
place these — and pretending otherwise would be a fabricated capability. The
plan is the part of the loop that is real today; "paper-trade first" is the
sequencing the plan records, not a promise the code cannot keep.

THE EXECUTOR REMAINS THE AUTHORITY. The sizing here mirrors the executor's
`risk_percent` model (planner.DefaultRiskProfile: 1% default risk, 2% cap per
trade) so the proposal is expressed in the same vocabulary. When a plan is ever
handed to the executor, the executor's planner re-plans and its numbers win --
this file never claims to be the source of truth for a real position.

The honesty rules this file is built on
---------------------------------------
- A PLAN NEEDS A PRICE. A signal with no `price` cannot be sized: it is
  recorded as `skipped` with the reason, never planned against a fabricated
  entry.
- A PLAN NEEDS A RISK BUDGET. With no equity (no treasury run and no configured
  `FUDCOURT_PIPELINE_EQUITY_USD`) there is no risk amount to divide, so the run
  reports the missing input by name and records nothing -- it does not invent an
  account size.
- AT MOST ONCE PER SIGNAL. `signal_plans` keys on `(chain, mint)`: a token that
  is still surfaced on the next run does not get a second plan. The stored
  `score` is refreshed so the row shows the latest sighting.
- NEVER LIVE. The recorded mode is always `paper`. The script refuses to run
  while `FUDCOURT_EXECUTOR_LIVE=1` unless the operator also sets
  `FUDCOURT_PIPELINE_ALLOW_LIVE=1`, and even then it records `paper`.

Cadence: its own systemd pair (fudcourt-signals.{service,timer}), offset from
the sync so it plans against a settled equity figure.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]  # scripts/tools/ -> scripts -> repo
DEFAULT_SIGNALS_URL = "http://127.0.0.1:3100/api/signals?type=feed&chain=all"


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


def cfg(env: dict[str, str], key: str, default: str | None = None) -> str | None:
    v = os.environ.get(key) or env.get(key)
    if v is None or not v.strip():
        return default
    return v.strip()


def cfg_float(env: dict[str, str], key: str, default: float | None = None) -> float | None:
    v = cfg(env, key)
    if v is None:
        return default
    try:
        return float(v)
    except ValueError:
        return default


# --- the plan model ---------------------------------------------------------
#
# risk_percent sizing, mirroring planner.DefaultRiskProfile so a proposal speaks
# the executor's own vocabulary: risk a fixed FRACTION of equity, and let the
# stop distance decide the position that fraction buys.
#
#   risk_usd  = equity * risk_pct / 100          (capped at max_risk_pct)
#   stop_px   = entry * (1 - stop_pct / 100)
#   quantity  = risk_usd / (entry - stop_px)      (risk-per-unit is the divisor)
#   notional  = quantity * entry
#
# The notional is then capped at max_notional_pct of equity: a tight stop on a
# volatile token can imply a position larger than the book should ever carry,
# and the cap is applied and REPORTED (capped=true) rather than silently.

DEFAULT_RISK_PCT = 1.0        # planner.DefaultRiskProfile.DefaultRisk
DEFAULT_MAX_RISK_PCT = 2.0    # planner.DefaultRiskProfile.MaxRiskPerTradePct
DEFAULT_STOP_PCT = 25.0       # a memecoin stop: wide, because the tape is wide
DEFAULT_MAX_NOTIONAL_PCT = 10.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS signal_plans (
  chain       text        NOT NULL,
  mint        text        NOT NULL,
  symbol      text,
  decision    text,
  score       double precision,
  entry_usd   double precision,
  stop_usd    double precision,
  target_usd  double precision,
  quantity    double precision,
  notional_usd double precision,
  risk_usd    double precision,
  risk_pct    double precision,
  equity_usd  double precision,
  stop_pct    double precision,
  capped      boolean     NOT NULL DEFAULT false,
  mode        text        NOT NULL DEFAULT 'paper',
  status      text        NOT NULL,
  reason      text,
  planned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, mint)
);
"""

# The latest sync run's total, the equity the risk budget divides (DR-045's
# sessionize-by-gap rule, reused). An operator can override with
# FUDCOURT_PIPELINE_EQUITY_USD when the treasury read is not what they want to
# size against.
LATEST_EQUITY = """
WITH runs AS (
  SELECT ts, value_usd,
         CASE WHEN ts - lag(ts) OVER (ORDER BY ts) > interval '60 seconds'
              OR lag(ts) OVER (ORDER BY ts) IS NULL
              THEN 1 ELSE 0 END AS is_new
  FROM asset_history
  WHERE ts > now() - interval '48 hours'
), numbered AS (
  SELECT ts, value_usd, sum(is_new) OVER (ORDER BY ts) AS run
  FROM runs
)
SELECT sum(value_usd) FROM numbered
WHERE run = (SELECT max(run) FROM numbered)
"""


# --- signal ingestion -------------------------------------------------------

def fetch_signals(url: str, timeout: float = 25.0) -> list[dict]:
    """The row family from our own /api/signals route. A non-200 is loud."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status != 200:
            raise RuntimeError(f"signals route answered {resp.status}")
        payload = json.loads(resp.read().decode())
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise RuntimeError("signals payload has no rows array")
    return rows


def actionable(rows: list[dict], decisions: set[str]) -> list[dict]:
    """Rows whose decision is in the configured set, newest first."""
    picked = [r for r in rows if str(r.get("decision") or "").lower() in decisions]
    picked.sort(key=lambda r: float(r.get("ts") or 0), reverse=True)
    return picked


# --- the plan (pure) --------------------------------------------------------

def plan_for(row: dict, equity_usd: float, risk_pct: float, stop_pct: float,
             max_risk_pct: float, max_notional_pct: float) -> dict:
    """One risk-sized plan, or a named skip. Pure: no IO, no clock.

    Returns a dict with `status` = 'planned' | 'skipped' and, when planned, the
    entry/stop/quantity/notional/risk. Every refusal names the missing input.
    """
    chain = str(row.get("chain") or "")
    mint = str(row.get("mint") or "")
    symbol = row.get("symbol")
    decision = row.get("decision")
    score = row.get("score")
    try:
        entry = float(str(row.get("price")))
    except (TypeError, ValueError):
        entry = None
    base = {
        "chain": chain, "mint": mint, "symbol": symbol, "decision": decision,
        "score": float(score) if isinstance(score, (int, float)) else None,
    }
    if entry is None or entry <= 0:
        return {**base, "status": "skipped", "reason": "no usable price on the signal"}
    if equity_usd is None or equity_usd <= 0:
        return {**base, "status": "skipped", "reason": "no equity to size against"}
    if stop_pct <= 0 or stop_pct >= 100:
        return {**base, "status": "skipped", "reason": f"stop_pct {stop_pct} is out of (0,100)"}

    risk = min(risk_pct, max_risk_pct)
    risk_usd = equity_usd * risk / 100.0
    stop = entry * (1.0 - stop_pct / 100.0)
    per_unit = entry - stop
    if per_unit <= 0:
        return {**base, "status": "skipped", "reason": "stop sits at or above entry"}
    quantity = risk_usd / per_unit
    notional = quantity * entry

    cap = equity_usd * max_notional_pct / 100.0
    capped = False
    if notional > cap and cap > 0:
        capped = True
        scale = cap / notional
        quantity *= scale
        notional = cap
        risk_usd = quantity * per_unit  # the risk that the capped position can lose

    return {
        **base, "status": "planned",
        "entry_usd": entry, "stop_usd": stop,
        "target_usd": entry * (1.0 + 2.0 * stop_pct / 100.0),  # 2R, stated not implied
        "quantity": quantity, "notional_usd": notional, "risk_usd": risk_usd,
        "risk_pct": risk, "equity_usd": equity_usd, "stop_pct": stop_pct,
        "capped": capped, "reason": None,
    }


# --- persistence ------------------------------------------------------------

UPSERT = """
INSERT INTO signal_plans (
  chain, mint, symbol, decision, score, entry_usd, stop_usd, target_usd,
  quantity, notional_usd, risk_usd, risk_pct, equity_usd, stop_pct,
  capped, mode, status, reason, planned_at
) VALUES (
  %(chain)s, %(mint)s, %(symbol)s, %(decision)s, %(score)s, %(entry_usd)s,
  %(stop_usd)s, %(target_usd)s, %(quantity)s, %(notional_usd)s, %(risk_usd)s,
  %(risk_pct)s, %(equity_usd)s, %(stop_pct)s, %(capped)s, 'paper',
  %(status)s, %(reason)s, now()
)
ON CONFLICT (chain, mint) DO UPDATE SET
  score    = EXCLUDED.score,
  decision = EXCLUDED.decision
RETURNING (xmax = 0) AS inserted
"""


def row_params(p: dict) -> dict:
    """Fill the plan's absent columns with None so one UPSERT serves both
    a planned row and a skipped one."""
    return {
        "chain": p["chain"], "mint": p["mint"], "symbol": p.get("symbol"),
        "decision": p.get("decision"), "score": p.get("score"),
        "entry_usd": p.get("entry_usd"), "stop_usd": p.get("stop_usd"),
        "target_usd": p.get("target_usd"), "quantity": p.get("quantity"),
        "notional_usd": p.get("notional_usd"), "risk_usd": p.get("risk_usd"),
        "risk_pct": p.get("risk_pct"), "equity_usd": p.get("equity_usd"),
        "stop_pct": p.get("stop_pct"), "capped": bool(p.get("capped")),
        "status": p["status"], "reason": p.get("reason"),
    }


# --- main -------------------------------------------------------------------

def main() -> int:
    env = load_env()
    dsn = cfg(env, "FUDCOURT_PG_URL")
    if not dsn:
        print("FUDCOURT_PG_URL not set (checked env and repo .env)", file=sys.stderr)
        return 2

    if (cfg(env, "FUDCOURT_EXECUTOR_LIVE") == "1"
            and cfg(env, "FUDCOURT_PIPELINE_ALLOW_LIVE") != "1"):
        print("refusing to run: FUDCOURT_EXECUTOR_LIVE=1 and "
              "FUDCOURT_PIPELINE_ALLOW_LIVE!=1 (this pipeline is paper-first)",
              file=sys.stderr)
        return 2

    try:
        import psycopg2  # noqa: PLC0415
    except ModuleNotFoundError:
        print("psycopg2 missing; install the host package python3-psycopg2", file=sys.stderr)
        return 3

    signals_url = cfg(env, "FUDCOURT_PIPELINE_SIGNALS_URL", DEFAULT_SIGNALS_URL) or DEFAULT_SIGNALS_URL
    decisions = {
        d.strip().lower()
        for d in (cfg(env, "FUDCOURT_PIPELINE_DECISIONS", "surfaced") or "surfaced").split(",")
        if d.strip()
    }
    risk_pct = cfg_float(env, "FUDCOURT_PIPELINE_RISK_PCT", DEFAULT_RISK_PCT) or DEFAULT_RISK_PCT
    max_risk_pct = cfg_float(env, "FUDCOURT_PIPELINE_MAX_RISK_PCT", DEFAULT_MAX_RISK_PCT) or DEFAULT_MAX_RISK_PCT
    stop_pct = cfg_float(env, "FUDCOURT_PIPELINE_STOP_PCT", DEFAULT_STOP_PCT) or DEFAULT_STOP_PCT
    max_notional_pct = (cfg_float(env, "FUDCOURT_PIPELINE_MAX_NOTIONAL_PCT", DEFAULT_MAX_NOTIONAL_PCT)
                        or DEFAULT_MAX_NOTIONAL_PCT)

    try:
        rows = fetch_signals(signals_url)
    except (urllib.error.URLError, RuntimeError, json.JSONDecodeError, OSError) as exc:
        print(f"signals fetch failed: {exc}", file=sys.stderr)
        return 1

    picked = actionable(rows, decisions)

    planned = skipped = new = refreshed = 0
    reasons: dict[str, int] = {}
    with psycopg2.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(SCHEMA)

        equity = cfg_float(env, "FUDCOURT_PIPELINE_EQUITY_USD")
        if equity is None:
            cur.execute(LATEST_EQUITY)
            got = cur.fetchone()
            equity = float(got[0]) if got and got[0] is not None else None
        if equity is None or equity <= 0:
            print("no equity available: treasury has no settled run and "
                  "FUDCOURT_PIPELINE_EQUITY_USD is unset -- nothing to size against",
                  file=sys.stderr)
            return 0

        for row in picked:
            plan = plan_for(row, equity, risk_pct, stop_pct, max_risk_pct, max_notional_pct)
            if plan["status"] == "planned":
                planned += 1
            else:
                skipped += 1
                reasons[plan["reason"] or "unknown"] = reasons.get(plan["reason"] or "unknown", 0) + 1
            cur.execute(UPSERT, row_params(plan))
            got = cur.fetchone()
            if got and got[0]:
                new += 1
            else:
                refreshed += 1

    print(f"signal-pipeline: {len(rows)} rows, {len(picked)} actionable "
          f"[{','.join(sorted(decisions))}], equity={equity:,.2f}")
    print(f"signal-pipeline: {planned} planned ({new} new, {refreshed} refreshed), "
          f"{skipped} skipped, mode=paper")
    for reason, n in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"  skipped x{n}: {reason}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
