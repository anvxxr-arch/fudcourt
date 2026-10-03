#!/usr/bin/env python3
"""fudcourt cryptorank upstream/app smoke (PLAN SG-3.1, R-4).

Deterministic monitor for the Hermes cron `monitor=` slot:
- NO timestamps, fixed check ORDER -> byte-stable when healthy (silent tick)
- HEALTHY on one line when every check passes
- FAIL lines (stable per failure mode) when something is broken -> wakes agent
- Checks run CONCURRENTLY (a cold cryptorank cache makes serial checks hang);
  wall time = slowest check, not the sum. Per-check timeout 25s, one retry
  after 5s ONLY for transient statuses (429/5xx/network).

Checks:
  1. fudcourt-web unit active
  2. board page /cryptorank -> 200
  3. /api/cryptorank?mode=home     -> 200 + count/rows non-empty + upstream field
  4. /api/cryptorank?mode=coins    -> 200
  5. /api/cryptorank?mode=converter-> 200 (full-list converter path)
  6. /api/cryptorank?mode=newstag&key=defi -> 200 (keyed soft-404 handler)
  7. /api/cryptorank?mode=funding  -> 503 (decoy refusal still armed)

  8. /api/khala?mode=reports       -> 200 + non-empty rows + upstream field
     (ONE cheap probe for the whole khala family; the shape/dates/400/404
     contract lives in scripts/verify/verify-khala.py -- this only proves the khala
     sidecar path is alive and still answering with data)
  9. fudcourt-reconciled unit active, AND its own /healthz direct on :3102
     (DR-014). The unit check is here because a dead Rust service silently turns
     /api/reconcile into a 502 -- a failure nothing else in this file would see.
     The probe hits the service DIRECTLY rather than through :3100 because
     /api/reconcile is team-gated: an unauthenticated probe would get a 401 that
     says nothing about whether the service behind it is alive.
Override target with MONITOR_BASE (used by the failure-path self-test).
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = os.environ.get("MONITOR_BASE", "http://127.0.0.1:3100")
# The Rust reconcile service's own liveness endpoint (loopback, direct).
RECONCILE_HEALTH = os.environ.get("RECONCILE_HEALTH", "http://127.0.0.1:3102/healthz")
# Every fudcourt unit whose death changes what this board serves. `fudcourt-web`
# answers the pages; `fudcourt-reconciled` is the only backend unit a proxy route
# depends on and would otherwise fail silently (502 with no monitor signal).
UNITS = ("fudcourt-web", "fudcourt-reconciled")
PER_CHECK_TIMEOUT = 25
RETRY_PAUSE = 5
TRANSIENT = {429, 500, 502, 503, 504}

# (name, path, want_status, nonempty) — fixed order = deterministic output
CHECKS = [
    ("board page", "/cryptorank", 200, False),
    ("mode=home", "/api/cryptorank?mode=home", 200, True),
    ("mode=coins", "/api/cryptorank?mode=coins", 200, False),
    ("mode=converter", "/api/cryptorank?mode=converter", 200, False),
    ("mode=newstag&key=defi", "/api/cryptorank?mode=newstag&key=defi", 200, False),
    ("mode=funding (decoy refusal)", "/api/cryptorank?mode=funding", 503, False),
    ("markets (coingecko)", "/api/markets?search=btc&limit=5", 200, True),
    ("news (cointelegraph rss)", "/api/news?limit=5", 200, True),
    ("khala reports", "/api/khala?mode=reports", 200, True),
]


def fetch(path):
    """-> (status:int, body:dict|None, neterr:str|None)"""
    try:
        req = urllib.request.Request(BASE + path)
        with urllib.request.urlopen(req, timeout=PER_CHECK_TIMEOUT) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw), None
            except Exception:
                return r.status, None, None
    except urllib.error.HTTPError as e:
        try:
            e.read()
        except Exception:
            pass
        return e.code, None, None
    except Exception as e:  # noqa: BLE001
        return 0, None, f"{type(e).__name__}"


def check(args):
    name, path, want, nonempty = args
    st, body, neterr = fetch(path)
    if (neterr or st in TRANSIENT or st == 0) and st != want:
        time.sleep(RETRY_PAUSE)
        st, body, neterr = fetch(path)
    problems = []
    if st != want:
        problems.append(f"FAIL {name}: status {st} (want {want})" + (f" [{neterr}]" if neterr else ""))
        return name, problems
    if nonempty:
        if not isinstance(body, dict):
            problems.append(f"FAIL {name}: non-object envelope")
        else:
            # envelope shapes differ per mode: home has count/global (no rows),
            # list modes carry rows. Empty data MUST still fail loudly.
            # Families name their list field differently (CR: rows,
            # markets: coins, news: items, khala: rows) -- presence of any is
            # enough. `upstream` is a scalar string on khala (not an array).
            cnt = body.get("count") if body.get("count") is not None else body.get("total")
            rows = body.get("rows") or body.get("coins") or body.get("items")
            if cnt is None and rows is None:
                problems.append(f"FAIL {name}: no count/rows in envelope")
            elif cnt is not None and int(cnt) < 1:
                problems.append(f"FAIL {name}: count=0 (upstream 200 but no data)")
            elif rows is not None and len(rows) < 1:
                problems.append(f"FAIL {name}: empty rows (upstream 200 but no data)")
            if not body.get("upstream"):
                problems.append(f"FAIL {name}: missing upstream field in envelope")
    return name, problems


fails = []

# 1. units active (fast, local). Fixed order -> deterministic output.
for _unit_name in UNITS:
    try:
        _unit = subprocess.run(
            ["systemctl", "--user", "is-active", _unit_name],
            capture_output=True, text=True, timeout=15,
        ).stdout.strip()
    except Exception as e:  # noqa: BLE001
        _unit = f"error:{e}"
    if _unit != "active":
        fails.append(f"FAIL unit {_unit_name}: {_unit or 'unknown'}")

# 1b. the Rust service's own health (direct, loopback). A 200 that is not THIS
# service's envelope is a failure too: something else answering on the port would
# otherwise read as healthy.
try:
    with urllib.request.urlopen(RECONCILE_HEALTH, timeout=PER_CHECK_TIMEOUT) as r:
        hb = json.loads(r.read())
    if hb.get("service") != "reconcile" or hb.get("ok") is not True:
        fails.append(f"FAIL reconcile health: unexpected envelope {str(hb)[:80]}")
except Exception as e:  # noqa: BLE001
    fails.append(f"FAIL reconcile health: {type(e).__name__} {e}".strip())

# 2..7 concurrently; results re-ordered by CHECKS order for determinism
with ThreadPoolExecutor(max_workers=len(CHECKS)) as pool:
    results = dict(pool.map(check, CHECKS))
for name, path, want, nonempty in CHECKS:
    fails.extend(results[name])

if fails:
    print("\n".join(fails))
    sys.exit(1)
print("HEALTHY")
