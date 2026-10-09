#!/usr/bin/env python3
"""fudcourt CoinAnk re-probe: watch the keyless surface come back from the wall.

WHY THIS EXISTS
  The CoinAnk family is wired and shipped, but its keyless upstream currently
  refuses EVERY mode with
      {"code":"403","detail":"CoinAnk refused the request: please sub api to get data"}
  That is not our bug and there is nothing to fix: the family stays dark until
  CoinAnk lifts the wall or its signature changes. This monitor re-probes it on
  a schedule and SPEAKS ONLY WHEN SOMETHING CHANGES.

DETERMINISM (the cron contract)
  No timestamps, no durations, no payload bytes, fixed check order. While every
  mode is still refused the output is ONE byte-stable line, so the Hermes cron
  `monitor=` slot hashes it unchanged and stays silent. The moment a mode stops
  refusing, the bytes change and the agent is woken to notify.

OUTPUT
  STILL_REFUSED <mode>=<code> ...   every mode still refused        -> exit 0
                                    <code> is upstream's refusal code, or
                                    `stale`: the sidecar served its labelled
                                    last-good body while the wall is up --
                                    still refused, NOT a recovery.
  RECOVERED <mode>=<status> ...     at least one mode now answers   -> exit 0
  FAIL <what>                       anything else: sidecar down, an
                                    unknown shape, a non-refusal 5xx -> exit 1

  Override the target with MONITOR_BASE (used by the failure-path self-test).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

# The data sidecar, not the web app: the family lives behind
# /api/coinank on :3101, and probing it proves the whole path (fetch -> decode
# -> envelope), not just that a port is open.
BASE = os.environ.get("MONITOR_BASE", "http://127.0.0.1:3101")

# Declaration order == the family's own mode table (coinank/modes.go). Fixed
# order is part of the determinism contract.
MODES = ("fundingRate", "liquidation", "longShort", "etf", "whales")

TIMEOUT = 20
RETRY_PAUSE = 5
TRANSIENT = {0, 429, 500, 502, 503, 504}


def probe(mode):
    """-> (status:int, body:dict|None, neterr:str|None)."""
    # fresh=1: since the per-mode TTLs + STALE fallback landed, a cached read
    # could answer 200 while the wall is still up; this probe must ask upstream.
    url = f"{BASE}/api/coinank?mode={mode}&fresh=1"
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=TIMEOUT) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw), None
            except Exception:  # noqa: BLE001
                return r.status, None, "non-json body"
    except urllib.error.HTTPError as e:
        raw = b""
        try:
            raw = e.read()
        except Exception:  # noqa: BLE001
            pass
        try:
            return e.code, json.loads(raw), None
        except Exception:  # noqa: BLE001
            return e.code, None, None
    except Exception as e:  # noqa: BLE001
        return 0, None, type(e).__name__


def refused(body):
    """Is this envelope CoinAnk's own `please sub api` refusal?"""
    if not isinstance(body, dict):
        return False
    if str(body.get("code")) == "403":
        return True
    if body.get("error") == "upstream refused":
        return True
    return "sub api" in str(body.get("detail", ""))


still, recovered, fails = [], [], []

for mode in MODES:
    st, body, neterr = probe(mode)
    # One retry, ONLY for a transient transport/status error. A 200 is an
    # answer and a refusal is deterministic: neither is retried (retrying the
    # refusal would double every tick's cost for an unchanged result).
    if st != 200 and not refused(body) and (neterr is not None or st in TRANSIENT):
        time.sleep(RETRY_PAUSE)
        st, body, neterr = probe(mode)

    if st == 200:
        # A 200 is only a recovery if it actually carries a body; a 200 with an
        # empty envelope would be a silent-empty regression, which is a FAIL.
        if isinstance(body, dict) and body.get("stale"):
            # The sidecar's labelled last-good fallback: upstream is still
            # refusing, so this is STILL_REFUSED, not a recovery.
            still.append(f"{mode}=stale")
        elif isinstance(body, dict) and body:
            recovered.append(f"{mode}={st}")
        else:
            fails.append(f"FAIL {mode}: 200 with an empty/non-object envelope")
    elif refused(body):
        code = body.get("code") if isinstance(body, dict) else "403"
        still.append(f"{mode}={code}")
    else:
        detail = neterr or (json.dumps(body)[:120] if body is not None else "no body")
        fails.append(f"FAIL {mode}: status {st} {detail}")

if fails:
    print("\n".join(fails))
    sys.exit(1)

if recovered:
    # The wake case: state the transition, then the modes still dark.
    print("RECOVERED " + " ".join(recovered))
    if still:
        print("STILL_REFUSED " + " ".join(still))
    sys.exit(0)

# The nothing-to-do case: one stable line, byte-identical every tick.
print("STILL_REFUSED " + " ".join(still))
