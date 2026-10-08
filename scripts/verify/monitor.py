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
  2. board page / -> 200 (renders the CryptoRank home slice; the standalone
     /cryptorank page was retired in b8e27c6 -- assert the page that ships)
  3. /api/cryptorank?mode=home     -> 200 + count/rows non-empty + upstream field
  4. /api/cryptorank?mode=coins    -> 200
  5. /api/cryptorank?mode=converter-> 200 (full-list converter path)
  6. /api/cryptorank?mode=newstag&key=defi -> 200 (keyed soft-404 handler)
  7. /api/cryptorank?mode=funding  -> 503 (decoy refusal still armed)

  8. fudcourt-reconciled unit active, AND its own /healthz direct on :3102
     (DR-014). The unit check is here because a dead Rust service silently turns
     /api/reconcile into a 502 -- a failure nothing else in this file would see.
     The probe hits the service DIRECTLY rather than through :3100 because
     /api/reconcile is team-gated: an unauthenticated probe would get a 401 that
     says nothing about whether the service behind it is alive.

  9. fudcourt-data unit active, AND its own /healthz direct on :3101 (R-4). The
     sidecar is covered TRANSITIVELY by checks 3-7 (they fail when it is down),
     but a dead unit + a warm cache = a green monitor over a cold cache = a
     silent outage. So the unit is asserted BY NAME and the :3101/healthz payload
     must report ok:true AND name every expected family (build, chainrank,
     coinank, coinglass, coinmarketcap, khala, llama, news). The probe is DIRECT
     (loopback :3101) so a stale/wrong process on the port cannot masquerade.

  10. CF-mitigated challenge (DR-005): a /api/cryptorank response carrying a
     `cf-mitigated: challenge` header -- or the sidecar's own 403 whose body
     error names it -- is its own failure class, NOT "upstream 200 with empty".
     It is the tell that the pinned Chrome-131 TLS/h2 fingerprint was rotated
     upstream and the sidecar needs a refresh; the FAIL line says exactly that.

  11. /api/cryptorank?mode=prediction -> 200 + non-empty (the prediction-market
     odds feed behind the /risk board; upstream cryptorank.io/prediction-markets).
     A rotated page shape returns 200 with count=0, which this catches.

  12. /api/economy/regime -> 200 + non-empty `dimensions` + a truthy `upstream`
     list (FRED graph CSV + World Bank v2 + BIS WS_CBPOL, all keyless). The macro
     boards under /economy read those three upstreams; a schema change upstream
     returns 200 with empty dimensions -- the silent empty envelope the
     never-fake doctrine forbids -- so the check asserts the list is populated.

  13. The venue families the new desks read (12 endpoint checks): CoinGlass
     markets + statistics, CoinAnk etf + whales + liquidation&interval=1d,
     CoinMarketCap global + exchanges, and CryptoRank rwa / launchpool&key=upcoming
     / categories&key=chain / exchanges&key=cex/spot. These carry the real payload
     under `data` (a list, or an object wrapping list/cryptoCurrencyList/exchanges/
     quotes) and the true upstream row count as `upstreamCount`; the non-empty
     predicate understands both shapes, so a healthy venue response no longer
     reads as "no count/rows in envelope". Every one of them is keyless.

Override target with MONITOR_BASE (used by the failure-path self-test). The two
direct probes are overridable too: SIDECAR_HEALTH / RECONCILE_HEALTH.
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
# The Go data sidecar's own liveness endpoint (loopback, direct, :3101).
SIDECAR_HEALTH = os.environ.get("SIDECAR_HEALTH", "http://127.0.0.1:3101/healthz")
# Every fudcourt unit whose death changes what this board serves. `fudcourt-web`
# answers the pages; `fudcourt-reconciled` is the only backend unit a proxy route
# depends on and would otherwise fail silently (502 with no monitor signal);
# `fudcourt-data` (:3101) serves every /api/<family> route behind the web BFF.
UNITS = ("fudcourt-web", "fudcourt-reconciled", "fudcourt-data")
# Human-readable reason per unit, so a dead sidecar reads as "fudcourt-data is
# down" and not as a generic /api/cryptorank empty-table alarm (R-4).
UNIT_REASON = {
    "fudcourt-web": "fudcourt-web unit is down (the board cannot render)",
    "fudcourt-reconciled": "fudcourt-reconciled unit is down (/api/reconcile -> 502)",
    "fudcourt-data": "fudcourt-data is down (the /api/* data sidecar :3101 is not serving)",
}
# Families the :3101 healthz payload must name (each with a non-empty value). A
# 200 that lacks one is a stale or half-registered build answering on the port.
SIDECAR_FAMILIES = (
    "build", "chainrank", "coinank", "coinglass",
    "coinmarketcap", "khala", "llama", "news",
)
PER_CHECK_TIMEOUT = 25
RETRY_PAUSE = 5
TRANSIENT = {429, 500, 502, 503, 504}

# The DR-005 tell: Cloudflare answered with a challenge (the pinned Chrome-131
# TLS/h2 fingerprint was rotated upstream). A failure class of its own.
CF_CHALLENGE = "cf-mitigated: challenge"

# (name, path, want_status, nonempty) — fixed order = deterministic output
CHECKS = [
    ("board page", "/", 200, False),
    ("mode=home", "/api/cryptorank?mode=home", 200, True),
    ("mode=coins", "/api/cryptorank?mode=coins", 200, False),
    ("mode=converter", "/api/cryptorank?mode=converter", 200, False),
    ("mode=newstag&key=defi", "/api/cryptorank?mode=newstag&key=defi", 200, False),
    ("mode=funding (decoy refusal)", "/api/cryptorank?mode=funding", 503, False),
    ("markets (coingecko)", "/api/markets?seartc&limit=5", 200, True),
    ("news (cointelegraph rss)", "/api/news?limit=5", 200, True),
    ("mode=prediction (risk feed)", "/api/cryptorank?mode=prediction", 200, True),
    ("economy regime (fred/worldbank/bis)", "/api/economy/regime", 200, True),
    ("coinglass markets", "/api/coinglass?mode=markets", 200, True),
    ("coinglass statistics", "/api/coinglass?mode=statistics", 200, True),
    ("coinank etf flows", "/api/coinank?mode=etf", 200, True),
    ("coinank whales", "/api/coinank?mode=whales", 200, True),
    ("coinank liquidations", "/api/coinank?mode=liquidation&interval=1d", 200, True),
    ("coinmarketcap global", "/api/coinmarketcap?mode=global", 200, True),
    ("coinmarketcap exchanges", "/api/coinmarketcap?mode=exchanges", 200, True),
    ("cryptorank rwa", "/api/cryptorank?mode=rwa", 200, True),
    ("cryptorank launchpool upcoming", "/api/cryptorank?mode=launchpool&key=upcoming", 200, True),
    ("cryptorank categories chain", "/api/cryptorank?mode=categories&key=chain", 200, True),
    ("cryptorank exchanges cex/spot", "/api/cryptorank?mode=exchanges&key=cex/spot", 200, True),
    ("board page /chains", "/chains", 200, False),
    ("board page /sectors", "/sectors", 200, False),
    ("board page /coins", "/coins", 200, False),
    ("board page /media", "/media", 200, False),
    ("board page /insights", "/insights", 200, False),
    ("cryptorank blockchains", "/api/cryptorank?mode=blockchains", 200, True),
    ("cryptorank ecosystems", "/api/cryptorank?mode=ecosystems", 200, True),
    ("cryptorank chain ethereum", "/api/cryptorank?mode=chain&key=ethereum", 200, True),
    ("cryptorank tags", "/api/cryptorank?mode=tags", 200, True),
    ("cryptorank tag layer-1", "/api/cryptorank?mode=tag&key=layer-1", 200, True),
    ("cryptorank coin bitcoin", "/api/cryptorank?mode=coin&key=bitcoin", 200, True),
    ("cryptorank listings", "/api/cryptorank?mode=listings", 200, True),
    ("cryptorank media", "/api/cryptorank?mode=media", 200, True),
    ("cryptorank news", "/api/cryptorank?mode=news", 200, True),
    ("cryptorank quarterly", "/api/cryptorank?mode=quarterly", 200, True),
    ("cryptorank aioverview", "/api/cryptorank?mode=aioverview", 200, True),
    ("coinglass openInterest BTC", "/api/coinglass?mode=openInterest&symbol=BTC", 200, True),
    ("coinmarketcap marketPairs bitcoin", "/api/coinmarketcap?mode=marketPairs&slug=bitcoin", 200, True),
]


def _headers(msg):
    """Lower-cased header map from a response/HTTPError message (never raises)."""
    try:
        return {k.lower(): v for k, v in msg.items()}
    except Exception:  # noqa: BLE001
        return {}


def fetch(path):
    """-> (status:int, body:dict|None, neterr:str|None, headers:dict)

    The error body is parsed too: the sidecar surfaces a CF challenge as a 403
    whose JSON `error` names the tell, and check() must be able to see it.
    """
    try:
        req = urllib.request.Request(BASE + path)
        with urllib.request.urlopen(req, timeout=PER_CHECK_TIMEOUT) as r:
            raw = r.read()
            hdrs = _headers(r.headers)
            try:
                return r.status, json.loads(raw), None, hdrs
            except Exception:
                return r.status, None, None, hdrs
    except urllib.error.HTTPError as e:
        raw = b""
        try:
            raw = e.read()
        except Exception:
            pass
        try:
            body = json.loads(raw)
        except Exception:
            body = None
        return e.code, body, None, _headers(e.headers)
    except Exception as e:  # noqa: BLE001
        return 0, None, f"{type(e).__name__}", {}


def check(args):
    name, path, want, nonempty = args
    st, body, neterr, hdrs = fetch(path)
    if (neterr or st in TRANSIENT or st == 0) and st != want:
        time.sleep(RETRY_PAUSE)
        st, body, neterr, hdrs = fetch(path)
    # DR-005: a Cloudflare challenge is a DISTINCT failure class, checked BEFORE
    # the status test so it never degrades into "status 403 (want 200)" or, worse,
    # "upstream 200 with empty rows". Detect it from the response header (the
    # upstream's own reply) or from the sidecar's 403 body, which names the same
    # tell. Either way the message points at the rotation, not at empty data.
    body_err = str(body.get("error") or body.get("detail") or "") if isinstance(body, dict) else ""
    if hdrs.get("cf-mitigated", "").lower() == "challenge" or CF_CHALLENGE in body_err:
        return name, [
            f"FAIL {name}: Cloudflare profile rotation ({CF_CHALLENGE}) -- the "
            "pinned Chrome-131 TLS/h2 fingerprint was rejected upstream; refresh "
            "the fudcourt-data sidecar (DR-005)"
        ]
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
            # Families name their list field differently (CR: rows, markets:
            # coins, news: items, prediction: predictionRows, economy regime:
            # dimensions) -- presence of any non-empty one is enough.
            cnt = body.get("count") if body.get("count") is not None else body.get("total")
            rows = (
                body.get("rows") or body.get("coins") or body.get("items")
                or body.get("predictionRows") or body.get("dimensions")
            )
            # The venue families (coinglass/coinank/coinmarketcap) park the real
            # payload under `data` and stamp the true upstream row count as
            # `upstreamCount` -- neither shape existed when this predicate was
            # written, so a healthy venue response would read "no count/rows".
            data = body.get("data")
            if cnt is None:
                cnt = body.get("upstreamCount")
            if rows is None and isinstance(data, list):
                rows = data
            if isinstance(data, dict):
                for _key in ("list", "cryptoCurrencyList", "exchanges", "quotes"):
                    if isinstance(data.get(_key), list):
                        rows = rows or data[_key]
                        break
                else:
                    # A pure-object family (CoinGlass statistics) carries no row
                    # array at all: a non-empty object IS the payload, and an
                    # empty one is exactly the silent-empty envelope this check
                    # exists to catch.
                    if data and cnt is None:
                        cnt = len(data)
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

# 1. units active (fast, local). Fixed order -> deterministic output. The reason
# string is per-unit so a dead sidecar reads as "fudcourt-data is down".
for _unit_name in UNITS:
    try:
        _unit = subprocess.run(
            ["systemctl", "--user", "is-active", _unit_name],
            capture_output=True, text=True, timeout=15,
        ).stdout.strip()
    except Exception as e:  # noqa: BLE001
        _unit = f"error:{e}"
    if _unit != "active":
        _reason = UNIT_REASON.get(_unit_name, f"{_unit_name} unit is down")
        fails.append(f"FAIL unit {_unit_name}: {_unit or 'unknown'} -- {_reason}")

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

# 1c. the Go data sidecar's own health (direct, loopback :3101). R-4: checks 3-7
# cover it only transitively, so a dead unit over a warm cache reads green.
# Assert ok:true AND every expected family (non-empty). A 200 that is not this
# sidecar's payload -- a stale/wrong process on the port -- is a failure too.
try:
    with urllib.request.urlopen(SIDECAR_HEALTH, timeout=PER_CHECK_TIMEOUT) as r:
        shb = json.loads(r.read())
    if not isinstance(shb, dict):
        fails.append(f"FAIL sidecar health: non-object envelope {str(shb)[:80]}")
    elif shb.get("ok") is not True:
        fails.append(f"FAIL sidecar health: ok != true ({str(shb)[:80]})")
    else:
        _missing = [fam for fam in SIDECAR_FAMILIES if not shb.get(fam)]
        if _missing:
            fails.append(f"FAIL sidecar health: missing families {_missing}")
except Exception as e:  # noqa: BLE001
    fails.append(f"FAIL sidecar health: {type(e).__name__} {e}".strip())

# 2..7 concurrently; results re-ordered by CHECKS order for determinism
with ThreadPoolExecutor(max_workers=len(CHECKS)) as pool:
    results = dict(pool.map(check, CHECKS))
for name, path, want, nonempty in CHECKS:
    fails.extend(results[name])

if fails:
    print("\n".join(fails))
    sys.exit(1)
print("HEALTHY")
