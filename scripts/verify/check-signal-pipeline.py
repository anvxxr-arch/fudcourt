#!/usr/bin/env python3
"""
check-signal-pipeline.py -- the signal pipeline's risk sizing, offline.

The sizing in scripts/tools/signal-pipeline.py is a PURE function (plan_for), so
it is checked here without Postgres, without the network and without a clock.
This is the gate that keeps the proposal honest: a plan that silently fabricates
an entry, or that leaves a capped position reporting its pre-cap risk, is the
bug this check exists to catch.

The tool module has a hyphen in its name, so it is loaded by path.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "scripts" / "tools" / "signal-pipeline.py"

spec = importlib.util.spec_from_file_location("signal_pipeline", TOOL)
assert spec and spec.loader, f"cannot load {TOOL}"
sp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sp)

cases = 0


def close(a: float, b: float, tol: float = 1e-9) -> bool:
    return abs(a - b) <= tol * max(1.0, abs(b))


def check(cond: bool, msg: str) -> None:
    global cases
    cases += 1
    if not cond:
        print(f"SIGNAL_PIPELINE_FAILED: {msg}", file=sys.stderr)
        raise SystemExit(1)


# 1. a normal plan: 10k equity, 1% risk = 100 USD, 25% stop -> 400 units at 1.0
p = sp.plan_for({"chain": "solana", "mint": "M1", "symbol": "AAA",
                 "decision": "surfaced", "score": 70, "price": 1.0},
                10_000.0, 1.0, 25.0, 2.0, 10.0)
check(p["status"] == "planned", f"normal plan refused: {p.get('reason')}")
check(close(p["entry_usd"], 1.0), "entry not taken from the signal price")
check(close(p["stop_usd"], 0.75), "stop is not entry*(1-stop_pct)")
check(close(p["quantity"], 400.0), "quantity is not risk/per-unit-risk")
check(close(p["notional_usd"], 400.0), "notional is not quantity*entry")
check(close(p["risk_usd"], 100.0), "risk_usd is not equity*risk_pct")
check(close(p["target_usd"], 1.5), "target is not 2R")
check(p["capped"] is False, "a small position must not be flagged capped")

# 2. the notional cap bites and the risk follows the capped size
p2 = sp.plan_for({"chain": "solana", "mint": "M2", "price": 1.0},
                 10_000.0, 1.0, 1.0, 2.0, 10.0)
check(p2["capped"] is True, "a tight stop must trip the notional cap")
check(close(p2["notional_usd"], 1_000.0), "capped notional is not max_notional_pct of equity")
check(close(p2["quantity"], 1_000.0), "capped quantity is inconsistent with the cap")
check(close(p2["risk_usd"], 10.0), "risk_usd must be recomputed for the capped size")

# 3. risk above the per-trade cap is clamped, not honoured
p3 = sp.plan_for({"chain": "solana", "mint": "M3", "price": 1.0},
                 10_000.0, 9.0, 25.0, 2.0, 100.0)
check(close(p3["risk_pct"], 2.0), "risk_pct is not clamped to max_risk_pct")
check(close(p3["risk_usd"], 200.0), "clamped risk_usd is not 2% of equity")

# 4. every refusal names its missing input
for row, needle in [
    ({"chain": "solana", "mint": "M4"}, "price"),
    ({"chain": "solana", "mint": "M5", "price": 0}, "price"),
    ({"chain": "solana", "mint": "M6", "price": "abc"}, "price"),
]:
    s = sp.plan_for(row, 10_000.0, 1.0, 25.0, 2.0, 10.0)
    check(s["status"] == "skipped" and needle in (s["reason"] or ""),
          f"{row['mint']} should skip naming {needle}: {s}")

s = sp.plan_for({"chain": "solana", "mint": "M7", "price": 1.0}, None, 1.0, 25.0, 2.0, 10.0)
check(s["status"] == "skipped" and "equity" in (s["reason"] or ""),
      "no equity must skip naming equity")

s = sp.plan_for({"chain": "solana", "mint": "M8", "price": 1.0}, 10_000.0, 1.0, 150.0, 2.0, 10.0)
check(s["status"] == "skipped" and "stop_pct" in (s["reason"] or ""),
      "an out-of-range stop_pct must skip naming stop_pct")

# 5. actionability filter: only the configured decisions, newest first
rows = [
    {"decision": "surfaced", "ts": 10, "mint": "A"},
    {"decision": "watching", "ts": 20, "mint": "B"},
    {"decision": "surfaced", "ts": 30, "mint": "C"},
    {"decision": None, "ts": 40, "mint": "D"},
]
got = sp.actionable(rows, {"surfaced"})
check([r["mint"] for r in got] == ["C", "A"], f"actionable filter/order wrong: {got}")

print(f"SIGNAL_PIPELINE_OK cases={cases}")
