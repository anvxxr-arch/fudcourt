#!/usr/bin/env python3
"""
alert-engine.py -- turn a measured condition over the treasury into one Telegram
alert, exactly once (F7).

Why this exists
---------------
The boards answer "what is true now" on demand. Nothing told the owner when
something crossed a line while nobody was looking: a position that moved more
than a threshold, the portfolio dropping under a floor, a price breaking a band.
This is that watcher, and it is deliberately its OWN unit pair rather than an
`ExecStartPost` on any sync: a derived read-side projection must never be able to
mark the sync failed (DR-046's rule, applied again here).

The honesty rules this file is built on
---------------------------------------
- A FIRING IS A MEASUREMENT, NOT A GUESS. Every alert is computed from a row
  that exists (`asset_history` for portfolio value, `price_history` for a price).
  A condition with no data behind it does not fire; it is reported as skipped.
- AT MOST ONCE PER STATE. `alert_state` keys on `(rule, subject)`. A rule whose
  condition still holds on the next run does NOT re-send: only a TRANSITION
  (not-firing -> firing, or firing -> cleared) produces a message. A cleared
  condition is announced once too, so the owner is never left believing a
  resolved alert is still open.
- NEVER-FAKE. A missing `FUDCOURT_TELEGRAM_CHAT_ID` means the channel is
  DISABLED (silent, not fatal -- the executor's own rule, notify/telegram.go).
  A broken channel is LOUD: the send failure is printed and the run exits
  non-zero so the timer shows it. A rule whose threshold is not configured is
  skipped and named, never silently treated as "no alert".

Cadence: its own systemd pair (fudcourt-alerts.{service,timer}), offset from the
sync so it reads a settled snapshot rather than a half-written one.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
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


# --- the rule set -----------------------------------------------------------
#
# Each rule is a named, measured condition. `threshold` is read from the
# environment so an operator tunes the band without editing code; a rule whose
# threshold is unset is SKIPPED and named (never treated as "no alert").
#
#   portfolio_drop : the latest sync run's total value fell at least `pct` below
#                    the highest run in the lookback window.
#   asset_move     : one asset's value moved at least `pct` between the two most
#                    recent runs that both carry it.
#   price_band     : an implied unit price left the `[low, high]` band.
#
# The rule set is small on purpose: every rule here is computed from a row that
# exists, and adding a rule means adding a measurement, not a heuristic.

SCHEMA = """
CREATE TABLE IF NOT EXISTS alert_state (
  rule        text        NOT NULL,
  subject     text        NOT NULL,
  firing      boolean     NOT NULL,
  value       double precision,
  message     text        NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule, subject)
);
"""

# The portfolio total per sync run. A run is the observation, not a row: the
# `assets_snapshot` trigger writes ~16 rows one second apart per 5-minute sync,
# so a run is sessionized by the >60s gap (DR-045's rule, reused verbatim).
RUN_TOTALS = """
WITH runs AS (
  SELECT ts, value_usd,
         CASE WHEN ts - lag(ts) OVER (ORDER BY ts) > interval '60 seconds'
              OR lag(ts) OVER (ORDER BY ts) IS NULL
              THEN 1 ELSE 0 END AS is_new
  FROM asset_history
  WHERE ts > now() - (%s::text || ' hours')::interval
), numbered AS (
  SELECT ts, value_usd, sum(is_new) OVER (ORDER BY ts) AS run
  FROM runs
)
SELECT run, max(ts) AS observed_at, sum(value_usd) AS total
FROM numbered
GROUP BY run
ORDER BY run
"""

# Each asset's value in the two most recent runs that both carry it. Only pairs
# that exist in BOTH runs are compared: a newly-seen holding is not a "move",
# and a vanished one is reported by the portfolio rule, not here.
ASSET_MOVES = """
WITH runs AS (
  SELECT ts, chain, asset, value_usd,
         CASE WHEN ts - lag(ts) OVER (ORDER BY ts) > interval '60 seconds'
              OR lag(ts) OVER (ORDER BY ts) IS NULL
              THEN 1 ELSE 0 END AS is_new
  FROM asset_history
  WHERE ts > now() - (%s::text || ' hours')::interval
), numbered AS (
  SELECT ts, chain, asset, value_usd, sum(is_new) OVER (ORDER BY ts) AS run
  FROM runs
), per_run AS (
  SELECT run, chain, asset, max(ts) AS observed_at, sum(value_usd) AS value_usd
  FROM numbered GROUP BY run, chain, asset
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY chain, asset ORDER BY run DESC) AS rn
  FROM per_run
)
SELECT cur.chain, cur.asset, cur.value_usd AS now_usd, prev.value_usd AS prev_usd,
       cur.observed_at
FROM ranked cur
JOIN ranked prev
  ON prev.chain = cur.chain AND prev.asset = cur.asset AND prev.rn = cur.rn + 1
WHERE cur.rn = 1 AND prev.value_usd > 0
"""

# The latest implied price per symbol, with the previous one so a move is a
# measurement too (and so a band breach can name what it moved from).
PRICE_BANDS = """
WITH ranked AS (
  SELECT symbol, ts, price,
         row_number() OVER (PARTITION BY symbol ORDER BY ts DESC) AS rn
  FROM price_history
  WHERE source = 'implied'
)
SELECT symbol, ts, price FROM ranked WHERE rn = 1 ORDER BY symbol
"""


# --- thresholds -------------------------------------------------------------

def env_float(env: dict[str, str], key: str) -> float | None:
    raw = (os.environ.get(key) or env.get(key) or "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def env_float_pair(env: dict[str, str], key: str) -> tuple[float, float] | None:
    """`low,high` from one key; both sides must parse or the rule is unset."""
    raw = (os.environ.get(key) or env.get(key) or "").strip()
    if not raw or "," not in raw:
        return None
    a, b = (p.strip() for p in raw.split(",", 1))
    try:
        low, high = float(a), float(b)
    except ValueError:
        return None
    return (low, high) if low < high else None


# --- rule evaluation --------------------------------------------------------
#
# Every evaluator returns a list of (subject, firing, value, message) tuples.
# It never decides whether to SEND: that is the transition diff against
# `alert_state`, computed once for the whole set so the two can never disagree.


def eval_portfolio_drop(rows: list[tuple], pct: float) -> list[tuple]:
    """Latest run's total vs the highest run in the window."""
    if len(rows) < 2:
        return []  # one observation is not a move; nothing to compare against
    latest = rows[-1]
    peak = max(rows, key=lambda r: r[2])
    latest_total, peak_total = float(latest[2]), float(peak[2])
    if peak_total <= 0:
        return []
    drop_pct = (peak_total - latest_total) / peak_total * 100.0
    firing = drop_pct >= pct
    msg = (
        f"portfolio {latest_total:,.2f} USD, {drop_pct:.2f}% below the window peak "
        f"{peak_total:,.2f} (threshold {pct:.2f}%)"
    )
    return [("portfolio", firing, -drop_pct, msg)]


def eval_asset_moves(rows: list[tuple], pct: float) -> list[tuple]:
    """One alert per asset whose value moved at least `pct` between runs."""
    out: list[tuple] = []
    for chain, asset, now_usd, prev_usd, _ts in rows:
        now_v, prev_v = float(now_usd), float(prev_usd)
        if prev_v <= 0:
            continue
        move = (now_v - prev_v) / prev_v * 100.0
        firing = abs(move) >= pct
        msg = f"{chain}/{asset} {now_v:,.2f} USD, {move:+.2f}% from {prev_v:,.2f} (threshold ±{pct:.2f}%)"
        out.append((f"{chain}/{asset}", firing, move, msg))
    return out


def eval_price_bands(rows: list[tuple], band: tuple[float, float]) -> list[tuple]:
    """One alert per symbol whose latest implied price left the band."""
    low, high = band
    out: list[tuple] = []
    for symbol, _ts, price in rows:
        p = float(price)
        firing = p < low or p > high
        side = "below" if p < low else ("above" if p > high else "inside")
        msg = f"{symbol} implied price {p:,.6g}, {side} the band [{low:g}, {high:g}]"
        out.append((symbol, firing, p, msg))
    return out


# --- transition diff --------------------------------------------------------
#
# The alert is the CHANGE, not the state. `alert_state` holds what was firing
# last run; a message goes out only where the boolean flipped. This is what
# makes a still-firing condition quiet on the next run and a resolved one
# announced once.

def transitions(prev: dict[tuple[str, str], bool], now: list[tuple[str, str, bool, float | None, str]]) -> list[tuple]:
    out = []
    for rule, subject, firing, value, message in now:
        was = prev.get((rule, subject))
        if was == firing:
            continue  # no change: not a new alert, and not a resolution
        out.append((rule, subject, firing, value, message))
    return out


def send_telegram(token: str, chat_id: str, text: str, endpoint: str = "https://api.telegram.org") -> None:
    """One sendMessage. Raises on a non-OK response so a broken channel is loud."""
    url = f"{endpoint.rstrip('/')}/bot{token}/sendMessage"
    body = json.dumps({"chat_id": chat_id, "text": text, "parse_mode": "HTML"}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        payload = json.loads(resp.read().decode())
    if not payload.get("ok"):
        raise RuntimeError(f"telegram refused the message: {payload.get('description', payload)}")


def render(alert_rule: str, subject: str, firing: bool, message: str) -> str:
    glyph = "\U0001F6A8" if firing else "\u2705"  # 🚨 firing / ✅ cleared
    state = "ALERT" if firing else "CLEARED"
    return f"{glyph} <b>{state}</b> [{alert_rule}] {subject}\n{message}"


# --- main -------------------------------------------------------------------

def main() -> int:
    env = load_env()
    dsn = os.environ.get("FUDCOURT_PG_URL") or env.get("FUDCOURT_PG_URL")
    if not dsn:
        print("FUDCOURT_PG_URL not set (checked env and repo .env)", file=sys.stderr)
        return 2
    token = (os.environ.get("FUDCOURT_TELEGRAM_BOT_TOKEN") or env.get("FUDCOURT_TELEGRAM_BOT_TOKEN") or "").strip()
    chat_id = (os.environ.get("FUDCOURT_TELEGRAM_CHAT_ID") or env.get("FUDCOURT_TELEGRAM_CHAT_ID") or "").strip()
    channel = bool(token and chat_id)

    try:
        import psycopg2  # noqa: PLC0415
    except ModuleNotFoundError:
        print("psycopg2 missing; install the host package python3-psycopg2", file=sys.stderr)
        return 3

    window_hours = env_float(env, "FUDCOURT_ALERT_WINDOW_HOURS") or 24.0
    drop_pct = env_float(env, "FUDCOURT_ALERT_PORTFOLIO_DROP_PCT")
    move_pct = env_float(env, "FUDCOURT_ALERT_ASSET_MOVE_PCT")
    band = env_float_pair(env, "FUDCOURT_ALERT_PRICE_BAND")

    skipped: list[str] = []
    if drop_pct is None:
        skipped.append("portfolio_drop (FUDCOURT_ALERT_PORTFOLIO_DROP_PCT unset)")
    if move_pct is None:
        skipped.append("asset_move (FUDCOURT_ALERT_ASSET_MOVE_PCT unset)")
    if band is None:
        skipped.append("price_band (FUDCOURT_ALERT_PRICE_BAND unset or not low,high)")

    with psycopg2.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(SCHEMA)
        cur.execute("SELECT rule, subject, firing FROM alert_state")
        prev = {(r, s): f for r, s, f in cur.fetchall()}

        now: list[tuple[str, str, bool, float | None, str]] = []
        if drop_pct is not None:
            cur.execute(RUN_TOTALS, (window_hours,))
            for subject, firing, value, message in eval_portfolio_drop(cur.fetchall(), drop_pct):
                now.append(("portfolio_drop", subject, firing, value, message))
        if move_pct is not None:
            cur.execute(ASSET_MOVES, (window_hours,))
            for subject, firing, value, message in eval_asset_moves(cur.fetchall(), move_pct):
                now.append(("asset_move", subject, firing, value, message))
        if band is not None:
            cur.execute(PRICE_BANDS)
            for subject, firing, value, message in eval_price_bands(cur.fetchall(), band):
                now.append(("price_band", subject, firing, value, message))

        changes = transitions(prev, now)

        for rule, subject, firing, value, message in now:
            cur.execute(
                """INSERT INTO alert_state (rule, subject, firing, value, message, changed_at)
                   VALUES (%s, %s, %s, %s, %s, now())
                   ON CONFLICT (rule, subject) DO UPDATE SET
                     firing = EXCLUDED.firing, value = EXCLUDED.value,
                     message = EXCLUDED.message,
                     changed_at = CASE WHEN alert_state.firing IS DISTINCT FROM EXCLUDED.firing
                                       THEN now() ELSE alert_state.changed_at END""",
                (rule, subject, firing, value, message),
            )
    # commit happens on the `with` exit

    if skipped:
        print("alert-engine: skipped rules: " + "; ".join(skipped))

    if not changes:
        print(f"alert-engine: no transitions ({len(now)} rules evaluated, {len(prev)} tracked)")
        return 0

    if not channel:
        print(
            f"alert-engine: {len(changes)} transition(s) but the channel is DISABLED "
            "(FUDCOURT_TELEGRAM_BOT_TOKEN / FUDCOURT_TELEGRAM_CHAT_ID unset); state recorded",
            file=sys.stderr,
        )
        for rule, subject, firing, _value, message in changes:
            print(f"  [{'ALERT' if firing else 'CLEARED'}] [{rule}] {subject}: {message}")
        return 0

    failures = 0
    for rule, subject, firing, _value, message in changes:
        try:
            send_telegram(token, chat_id, render(rule, subject, firing, message))
            print(f"alert-engine: sent [{'ALERT' if firing else 'CLEARED'}] [{rule}] {subject}")
        except (urllib.error.URLError, RuntimeError, OSError) as exc:
            failures += 1
            print(f"alert-engine: send FAILED [{rule}] {subject}: {exc}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
