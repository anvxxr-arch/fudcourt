#!/usr/bin/env python3
"""
verify-coinank.py -- executable contract for the coinank futures-data family.
    route (sidecar):   GET http://127.0.0.1:3101/api/coinank?mode=<mode>
    modes:             fundingRate | liquidation | longShort | etf | whales
    upstream:          https://api.coinank.com  (the dashboard's OWN backend)

FROZEN CONTRACT (v1)
  every mode 200 -> {kind, upstream, fetchedAt, auth, [interval], upstreamCode,
                  [upstreamMsg], [upstreamCount], data, derived}
       - `data` is upstream's `data` VERBATIM (never re-shaped).
       - `auth` == "keyless client signature, no decryption" on every response.
       - `upstreamCount` is present and > 0 ONLY for an array payload. For the
         OBJECT payload (mode=whales) the key must be ABSENT -- a 0 would assert
         a measurement upstream never made.
       - `interval` is echoed ONLY by mode=liquidation (it defaults to 1h).
  headers (all modes): X-CA-Upstream == body `upstream`, X-CA-Cache in
                  {MISS,HIT}, Cache-Control: public, max-age=30.
  cache: ?fresh=1 -> MISS, a repeat -> HIT.
  400 (local, never forwarded upstream):
       - mode absent/unknown            -> error "unknown mode"
       - a param the mode does not take -> error "unexpected param"
         (INCLUDING the no-ops: symbol/baseCoin on fundingRate, pageNum/pageSize
          on whales -- accepting a param upstream ignores is a lie)
       - interval outside {1h,2h,4h,6h,12h,1d} -> error "invalid param"
  502: upstream's own refusal (HTTP 200 + success:false + "system error!") is
       carried through with upstream's code and message. Never a 200 with an
       empty table.
  405: POST/PUT/... on the route.

Checks:
  1. ORACLE FIRST: the verifier re-derives the client signature ITSELF and calls
     api.coinank.com directly, then compares row counts (and one value) against
     the adapter's own response. The adapter is never the source of truth about
     upstream -- if its numbers do not match a direct fetch, the mismatch is
     reported in both directions.
  2. envelope + provenance for all 5 modes (auth note, kind, keyless upstream
     host, upstreamCount presence rules, documented first-row key).
  3. the interval allowlist, including the EDGE that motivates it: 1h must carry
     real turnover and 8h must be the all-zero table upstream answers for an
     unsupported interval (so the 400 is a refusal of a real trap, not pedantry).
  4. the full 400 matrix (unknown mode, unscoped param, no-op param, bad
     interval, uppercase interval) + the 405 method guard.
  5. cache observability (MISS -> HIT, fresh=1 -> MISS) and header/body agreement.
  6. healthz names the family, calls it keyless, and distinguishes the scheme
     from coinglass's (decryption vs computed signature).
Anything the sidecar could not be exercised for is reported SKIPPED with the
reason (stale sidecar / endpoint not mounted / unreachable) and the run still
exits non-zero -- never a silent pass.

Usage:
    python3 scripts/verify/verify-coinank.py
    python3 scripts/verify/verify-coinank.py --base http://127.0.0.1:3101
Exit 0 = every required check passed; 1 = a FAIL or a SKIP.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from verifylib import (as_dict, as_list, as_str, check, hget,
                       info, skip)

PASS = 0
FAIL = 0
SKIP = 0
NOTES: list[str] = []
RESULTS: list[dict] = []

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from verifylib import DEFAULT_SIDECAR_BASE as SIDECAR_DEFAULT
UA = "fudcourt-verify-coinank/1.0 (+verification harness)"

# ---- upstream protocol constants (client-shipped; re-derivable from the public
# ---- bundle at s.coinank.com/_nuxt/*.js -- see backend/data/internal/research/
# ---- coinank/sign.go for the derivation). Kept here so the ORACLE can be
# ---- fetched independently of the adapter.
SIGN_UUID = "b2d903dd-b31e-c547-d299-b6d07b7631ab"
SIGN_CLOCK_OFFSET = 2222222222222
SIGN_SUFFIX = "347"
SIGN_PREFIX_LEN = 8
WEB_VERSION = "102"
UPSTREAM = "https://api.coinank.com"

MODES = ["fundingRate", "liquidation", "longShort", "etf", "whales"]
INTERVALS = ["1h", "2h", "4h", "6h", "12h", "1d"]
# intervals measured to return an all-zero table (NOT accepted by the contract)
ZERO_TRAP = ["8h", "24h", "7d", "30d", "1H", "bogus"]
# first-row key each mode's payload must carry (shape, not value)
FIRST_KEY = {"fundingRate": "symbol", "liquidation": "exchangeName",
             "longShort": "coinName", "etf": "date"}
OBJECT_MODE = "whales"
AUTH_NOTE = "keyless client signature, no decryption"
UPSTREAM_PATH = {
    "fundingRate": "/api/fundingRate/current",
    "liquidation": "/api/liquidation/allExchange",
    "longShort": "/api/longshort/all",
    "etf": "/api/etf/etfInflow",
    "whales": "/api/hyper/topPosition",
}


# ------------------------------------------------------- transport helpers
def _open(url: str, timeout: float, headers: dict | None = None) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA,
                                                          "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def api(base: str, qs: str, timeout: float = 90.0) -> dict:
    """GET {base}/api/coinank?{qs}. An HTTPError IS a response -- read its body."""
    url = f"{base}/api/coinank?{qs}" if qs else f"{base}/api/coinank"
    last = {"url": url, "status": 0, "body": None, "hdr": {}, "raw": "", "neterr": "not attempted"}
    for attempt in range(3):
        try:
            st, raw, hdr = _open(url, timeout)
        except Exception as e:  # noqa: BLE001
            last = {"url": url, "status": 0, "body": None, "hdr": {}, "raw": "",
                    "neterr": f"{type(e).__name__}: {e}"}
            time.sleep(1.5 * (attempt + 1))
            continue
        try:
            body = json.loads(raw)
        except Exception:  # noqa: BLE001
            body = None
        last = {"url": url, "status": st, "body": body, "hdr": hdr,
                "raw": raw[:400].decode("utf-8", "replace"), "neterr": None}
        if st in (429, 502, 503, 504) and attempt < 2:
            time.sleep(2.0 * (attempt + 1))
            continue
        return last
    return last


# ------------------------------------------------------------- THE ORACLE
def signature(now_ms: int) -> str:
    """Re-derive the client signature exactly as the bundle does:
    base64( uuid[8:] + uuid[:8] + "|" + str(ms + C) + "347" )."""
    head = SIGN_UUID[:SIGN_PREFIX_LEN]
    rest = SIGN_UUID.replace(head, "", 1)  # first occurrence only, like JS .replace
    payload = f"{rest}{head}|{now_ms + SIGN_CLOCK_OFFSET}{SIGN_SUFFIX}"
    return base64.b64encode(payload.encode()).decode()


def upstream_get(path: str, qs: str = "", timeout: float = 30.0) -> dict:
    """Fetch api.coinank.com DIRECTLY, signing it here -- never via the adapter."""
    url = UPSTREAM + path + (("?" + qs) if qs else "")
    hdr = {
        "accept": "application/json, text/plain, */*",
        "client": "web",
        "coinank-apikey": signature(int(time.time() * 1000)),
        "origin": "https://coinank.com",
        "referer": "https://coinank.com/",
        "token": "",
        "user-agent": UA,
        "web-version": WEB_VERSION,
    }
    try:
        st, raw, _ = _open(url, timeout, hdr)
    except Exception as e:  # noqa: BLE001
        return {"url": url, "status": 0, "body": None, "error": f"{type(e).__name__}: {e}"}
    try:
        body = json.loads(raw)
    except Exception:  # noqa: BLE001
        body = None
    return {"url": url, "status": st, "body": body, "error": None}


def oracle_rows(mode: str, interval: str = "1h") -> tuple[object, str]:
    """(row_count_or_None, detail). Reads upstream directly."""
    path = UPSTREAM_PATH[mode]
    qs = f"interval={interval}" if mode == "liquidation" else ""
    r = upstream_get(path, qs)
    if r["error"]:
        return None, f"oracle unreachable: {r['error']}"
    b = as_dict(r["body"])
    if not b.get("success"):
        return None, f"oracle success={b.get('success')!r} msg={b.get('msg')!r}"
    d = b.get("data")
    if isinstance(d, list):
        return len(d), f"list[{len(d)}]"
    if isinstance(d, dict):
        return len(as_list(d.get("list"))), f"object.list[{len(as_list(d.get('list')))}]"
    return None, f"unexpected data type {type(d).__name__}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("COINANK_BASE", SIDECAR_DEFAULT))
    args = ap.parse_args()
    base = args.base.rstrip("/")
    print(f"--- target {base}/api/coinank (oracle: {UPSTREAM}, signed independently)")
    started = time.time()

    # ================================================== 0. endpoint liveness
    probe = api(base, "mode=etf", timeout=60.0)
    endpoint_ok, endpoint_reason, liveness = False, "", "live"
    if probe["neterr"]:
        endpoint_reason = (f"coinank endpoint unreachable at {base}/api/coinank "
                           f"({probe['neterr']}) -- adapter checks SKIPPED, oracle checks still ran")
        liveness = "unreachable"
    elif probe["status"] == 404 and not probe["body"]:
        endpoint_reason = (f"{base}/api/coinank -> 404 (route not mounted yet) -- "
                           f"adapter checks SKIPPED")
        liveness = "not-mounted"
    elif probe["status"] == 200 and isinstance(probe["body"], dict) and "auth" not in probe["body"]:
        endpoint_reason = (f"{base}/api/coinank answers an envelope without `auth` "
                           f"(keys={sorted(as_dict(probe['body']).keys())[:12]}) -- stale sidecar")
        liveness = "stale"
    else:
        endpoint_ok = True
    print(f"--- endpoint: {liveness}" + (f" ({endpoint_reason})" if endpoint_reason else ""))

    # ============================================ 1. ORACLE (independent)
    print("--- oracle: api.coinank.com fetched DIRECTLY, signed by this verifier")
    oracle: dict[str, object] = {}
    for m in MODES:
        n, det = oracle_rows(m)
        oracle[m] = n
        check(f"oracle: {m} reachable and success:true ({det})", n is not None, det, counted=True)
    # the signature itself: a wrong key answers success:false "system error!"
    sig_probe = upstream_get("/api/etf/etfInflow")
    check("oracle: the independently derived signature is ACCEPTED by upstream",
          as_dict(sig_probe["body"]).get("success") is True,
          f"status={sig_probe['status']} success={as_dict(sig_probe['body']).get('success')!r}", counted=True)
    # the all-zero trap, proven live: 1h real, 8h zero
    o1 = upstream_get(UPSTREAM_PATH["liquidation"], "interval=1h")
    o8 = upstream_get(UPSTREAM_PATH["liquidation"], "interval=8h")
    tt1 = (as_list(as_dict(o1["body"]).get("data")) or [{}])[0]
    tt8 = (as_list(as_dict(o8["body"]).get("data")) or [{}])[0]
    check("oracle: interval=1h returns REAL turnover (the allowlist is not pedantry)",
          isinstance(tt1, dict) and (tt1.get("totalTurnover") or 0) > 0,
          f"totalTurnover={as_dict(tt1).get('totalTurnover')!r}", counted=True)
    check("oracle: interval=8h returns the ALL-ZERO table upstream answers for an unsupported value",
          isinstance(tt8, dict) and (tt8.get("totalTurnover") or 0) == 0
          and as_dict(o8["body"]).get("success") is True,
          f"totalTurnover={as_dict(tt8).get('totalTurnover')!r} success={as_dict(o8['body']).get('success')!r} "
          f"(a pass-through route would render this as a confident zero table)", counted=True)

    # ============================================== 2. the 5 modes
    print("--- adapter: the 5 modes")
    bodies: dict[str, dict] = {}
    for m in MODES:
        qs = f"mode={m}&interval=1h&fresh=1" if m == "liquidation" else f"mode={m}&fresh=1"
        r = api(base, qs)
        b = as_dict(r["body"])
        bodies[m] = {"r": r, "b": b}
        check(f"{m}: HTTP 200", r["status"] == 200, f"got {r['status']} {r['raw'][:120]}", counted=True)
        if r["status"] != 200:
            continue
        check(f"{m}: kind == {m!r}", b.get("kind") == m, f"{b.get('kind')!r}", counted=True)
        check(f"{m}: auth == the keyless-signature note", b.get("auth") == AUTH_NOTE,
              f"{b.get('auth')!r}", counted=True)
        check(f"{m}: upstream is on the KEYLESS host {UPSTREAM}",
              as_str(b.get("upstream")).startswith(UPSTREAM + "/api/"),
              f"{b.get('upstream')!r}", counted=True)
        check(f"{m}: upstream path is the documented one",
              as_str(b.get("upstream")).startswith(UPSTREAM + UPSTREAM_PATH[m]),
              f"{b.get('upstream')!r} vs {UPSTREAM + UPSTREAM_PATH[m]!r}", counted=True)
        check(f"{m}: X-CA-Upstream header == body upstream",
              hget(r["hdr"], "X-CA-Upstream") == b.get("upstream"),
              f"header={hget(r['hdr'], 'X-CA-Upstream')!r} body={b.get('upstream')!r}", counted=True)
        check(f"{m}: X-CA-Cache header is MISS|HIT",
              hget(r["hdr"], "X-CA-Cache") in ("MISS", "HIT"),
              f"{hget(r['hdr'], 'X-CA-Cache')!r}", counted=True)
        check(f"{m}: Cache-Control == public, max-age=30",
              (hget(r["hdr"], "Cache-Control") or "").replace(" ", "") == "public,max-age=30",
              f"{hget(r['hdr'], 'Cache-Control')!r}", counted=True)
        check(f"{m}: fetchedAt is a plausible unix timestamp",
              isinstance(b.get("fetchedAt"), int) and b["fetchedAt"] > 1_600_000_000,
              f"{b.get('fetchedAt')!r}", counted=True)

        if m == OBJECT_MODE:
            check(f"{m}: upstreamCount key ABSENT on an object payload (never 0)",
                  "upstreamCount" not in b, f"upstreamCount={b.get('upstreamCount')!r}", counted=True)
            check(f"{m}: interval key ABSENT (mode takes none)",
                  "interval" not in b, f"interval={b.get('interval')!r}", counted=True)
            d = as_dict(b.get("data"))
            check(f"{m}: data is the upstream object with a non-empty `list`",
                  bool(as_list(d.get("list"))), f"keys={sorted(d.keys())[:6]}", counted=True)
            first = (as_list(d.get("list")) or [{}])[0]
            check(f"{m}: first list element carries 'address'",
                  isinstance(first, dict) and "address" in first,
                  f"keys={sorted(as_dict(first).keys())[:8]}", counted=True)
            check(f"{m}: derived says the payload is an object",
                  "object" in as_str(b.get("derived")), f"{as_str(b.get('derived'))[:120]!r}", counted=True)
        else:
            cnt = b.get("upstreamCount")
            check(f"{m}: upstreamCount is a positive int",
                  isinstance(cnt, int) and cnt > 0, f"upstreamCount={cnt!r}", counted=True)
            rows = as_list(b.get("data"))
            check(f"{m}: data is an array whose length == upstreamCount",
                  bool(rows) and len(rows) == cnt, f"len(data)={len(rows)} upstreamCount={cnt}", counted=True)
            first = rows[0] if rows else {}
            check(f"{m}: first row carries {FIRST_KEY[m]!r}",
                  isinstance(first, dict) and FIRST_KEY[m] in first,
                  f"keys={sorted(as_dict(first).keys())[:8]}", counted=True)
            check(f"{m}: derived states the row count",
                  str(cnt) in as_str(b.get("derived")), f"{as_str(b.get('derived'))[:120]!r}", counted=True)

    # liquidation echoes its effective interval
    lb = bodies["liquidation"]["b"]
    check("liquidation: interval echoed as '1h' and present in the upstream URL",
          lb.get("interval") == "1h" and "interval=1h" in as_str(lb.get("upstream")),
          f"interval={lb.get('interval')!r} upstream={lb.get('upstream')!r}", counted=True)

    # ============================ 3. ADAPTER vs ORACLE (never self-confirming)
    print("--- adapter row counts vs the DIRECT oracle fetch")
    for m in MODES:
        b = bodies[m]["b"]
        want = oracle[m]
        if m == OBJECT_MODE:
            got = len(as_list(as_dict(b.get("data")).get("list")))
        else:
            got = b.get("upstreamCount")
        # counts move between the two fetches, so the assertion is a CLOSENESS
        # band, not equality -- an exact-match check would flake on a live market.
        ok = isinstance(got, int) and isinstance(want, int) and (
            got == want or abs(got - want) <= max(2, int(0.02 * max(want, 1))))
        check(f"{m}: adapter count {got!r} ~= direct oracle count {want!r}", ok,
              f"adapter={got!r} oracle={want!r}", counted=True)

    # ============================================== 4. interval allowlist
    print("--- adapter: interval allowlist")
    for iv in INTERVALS:
        r = api(base, f"mode=liquidation&interval={iv}&fresh=1")
        b = as_dict(r["body"])
        tt = (as_list(b.get("data")) or [{}])[0]
        check(f"liquidation: interval={iv} -> 200 with real turnover",
              r["status"] == 200 and b.get("interval") == iv
              and isinstance(tt, dict) and (tt.get("totalTurnover") or 0) > 0,
              f"status={r['status']} echo={b.get('interval')!r} "
              f"totalTurnover={as_dict(tt).get('totalTurnover')!r}", counted=True)
    for iv in ZERO_TRAP:
        r = api(base, f"mode=liquidation&interval={urllib.parse.quote(iv)}")
        b = as_dict(r["body"])
        check(f"liquidation: interval={iv!r} -> 400 invalid param (the all-zero trap is refused)",
              r["status"] == 400 and b.get("error") == "invalid param",
              f"got {r['status']} error={b.get('error')!r}", counted=True)
    d = as_str(as_dict(api(base, "mode=liquidation&interval=8h")["body"]).get("detail"))
    check("liquidation: the interval refusal names the accepted values and the reason",
          all(x in d for x in ("1h", "1d", "all-zero")), f"detail={d[:200]!r}", counted=True)
    r = api(base, "mode=liquidation")
    check("liquidation: an OMITTED interval defaults to an explicit 1h",
          r["status"] == 200 and as_dict(r["body"]).get("interval") == "1h",
          f"status={r['status']} interval={as_dict(r['body']).get('interval')!r}", counted=True)

    # ============================================== 5. 400 / 405 matrix
    print("--- adapter: refusals")
    for qs, want_err, why in (
            ("", "unknown mode", "mode absent"),
            ("mode=bogus", "unknown mode", "mode unknown"),
            ("mode=REPORTS", "unknown mode", "mode wrong case"),
            ("mode=etf&symbol=BTC", "unexpected param", "unscoped param"),
            ("mode=fundingRate&symbol=BTC", "unexpected param", "NO-OP param (upstream ignores it)"),
            ("mode=fundingRate&baseCoin=BTC", "unexpected param", "NO-OP param (upstream ignores it)"),
            ("mode=whales&pageNum=2", "unexpected param", "NO-OP param (upstream ignores it)"),
            ("mode=whales&pageSize=5", "unexpected param", "NO-OP param (upstream ignores it)"),
            ("mode=etf&interval=1h", "unexpected param", "interval on the wrong mode"),
            ("mode=etf&day=1", "unexpected param", "unknown param"),
    ):
        r = api(base, qs)
        b = as_dict(r["body"])
        check(f"400: {why} -> {want_err!r}", r["status"] == 400 and b.get("error") == want_err,
              f"got {r['status']} error={b.get('error')!r}", counted=True)
    r = api(base, "mode=bogus")
    check("400: the unknown-mode body ships the whole mode table",
          len(as_list(as_dict(r["body"]).get("modes"))) == len(MODES),
          f"modes={as_dict(r['body']).get('modes')!r}", counted=True)
    try:
        req = urllib.request.Request(f"{base}/api/coinank?mode=etf", data=b"{}",
                                     headers={"User-Agent": UA}, method="POST")
        with urllib.request.urlopen(req, timeout=30) as rr:
            pst = rr.status
    except urllib.error.HTTPError as e:
        pst = e.code
    except Exception:  # noqa: BLE001
        pst = 0
    check("405: POST is refused (the family is read-only)", pst == 405, f"got {pst}", counted=True)

    # ============================================== 6. cache + healthz
    print("--- adapter: cache observability + healthz")
    fresh = api(base, "mode=etf&fresh=1")
    repeat = api(base, "mode=etf")
    check("cache: fresh=1 -> MISS", hget(fresh["hdr"], "X-CA-Cache") == "MISS",
          f"{hget(fresh['hdr'], 'X-CA-Cache')!r}", counted=True)
    check("cache: a repeat -> HIT", hget(repeat["hdr"], "X-CA-Cache") == "HIT",
          f"{hget(repeat['hdr'], 'X-CA-Cache')!r}", counted=True)
    # House style (coinglass sibling): cache is TRANSPORT state, header-only.
    # A body `cache` key would be a second, disagreeing spelling.
    check("cache: body carries NO `cache` key (header-only, like coinglass)",
          "cache" not in as_dict(repeat["body"]),
          f"body cache={as_dict(repeat['body']).get('cache')!r}", counted=True)

    try:
        st, raw, _ = _open(f"{base}/healthz", 30.0, {"User-Agent": UA})
        hz = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        hz = {}
        info("healthz", f"unreadable: {type(e).__name__}: {e}")
    got = as_str(hz.get("coinank"))
    check("healthz: names the coinank family", bool(got), f"coinank={got!r}", counted=True)
    check("healthz: labels it keyless", "keyless" in got, f"coinank={got!r}", counted=True)
    check("healthz: distinguishes the scheme from coinglass's decryption",
          "client signature" in got, f"coinank={got!r}", counted=True)
    check("healthz: the cryptorank `build` key is untouched",
          "modes" in as_str(hz.get("build")), f"build={hz.get('build')!r}", counted=True)

    # ============================================== 7. upstream refusal path
    print("--- adapter: an upstream refusal is a 502, never an empty 200")
    # A param upstream requires but we do not send: the documented
    # getNewsList-style endpoint. We do not expose such a mode, so instead probe
    # the contract's own refusal mapping by asking for a mode whose upstream can
    # refuse. news/basis etc. are not wired, so this is asserted structurally:
    # a 200 from any wired mode must never carry data:null.
    null_bad = []
    for m in MODES:
        r = api(base, f"mode={m}&fresh=1")
        if r["status"] == 200 and as_dict(r["body"]).get("data") is None:
            null_bad.append(m)
    check("no wired mode ever answers 200 with data:null (a refusal must be a 502)",
          not null_bad, f"offenders={null_bad}" if null_bad else "5/5 modes carry real data", counted=True)

    # ------------------------------------------------------------- flush
    dur = round(time.time() - started, 1)
    report = {"duration_s": dur, "base": base, "upstream": UPSTREAM,
              "endpoint": liveness, "pass": PASS, "fail": FAIL, "skip": SKIP,
              "info": NOTES, "checks": RESULTS}
    outp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coinank-report.json")
    try:
        with open(outp, "w") as f:
            json.dump(report, f, indent=2, default=str)
    except OSError as e:  # noqa: BLE001
        outp = f"(unwritable: {e})"
    print(f"\nRESULT: {PASS} pass, {FAIL} fail, {SKIP} skipped"
          + (f"  [endpoint {liveness}]" if not endpoint_ok else ""))
    print(f"{PASS} passed, {FAIL} failed, {SKIP} skipped, {len(NOTES)} info ({dur}s) -> {outp}")
    for n in NOTES:
        print(f"  [INFO] {n}")
    if not endpoint_ok:
        print(f"  [SKIP] reason: {endpoint_reason}")
    return 1 if (FAIL or SKIP) else 0


if __name__ == "__main__":
    sys.exit(main())
