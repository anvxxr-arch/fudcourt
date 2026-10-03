#!/usr/bin/env python3
"""
verify-coinmarketcap.py -- executable contract for the coinmarketcap family.
    route (sidecar):   GET http://127.0.0.1:3101/api/coinmarketcap?mode=<mode>
    modes:             listing | global | marketPairs | exchanges
    upstream:          https://api.coinmarketcap.com/data-api/v3
                       (the coinmarketcap.com DASHBOARD's own backend)

FROZEN CONTRACT (v1)
  every mode 200 -> {kind, upstream, fetchedAt, auth, [slug], [start], [limit],
                     [upstreamCode], [upstreamMsg], [upstreamCount], data, derived}
       - `data` is upstream's `data` VERBATIM (never re-shaped).
       - `auth` == "keyless dashboard endpoint, no credential, no signature".
       - `upstreamCount` is present ONLY when the payload carries an array at the
         mode's known path. For the OBJECT payload (mode=global) the key must be
         ABSENT -- a 0 would assert a count upstream never published.
       - `start`/`limit` are echoed ONLY by the paginated modes (listing,
         exchanges, marketPairs); `slug` ONLY by marketPairs.
  headers (all modes): X-CMC-Upstream == body `upstream`, X-CMC-Cache in
                  {MISS,HIT}, Cache-Control: public, max-age=30.
  cache: ?fresh=1 -> MISS, a repeat -> HIT.
  400 (local, never forwarded upstream):
       - mode absent/unknown            -> error "unknown mode"
       - a param the mode does not take -> error "unexpected param"
         (INCLUDING a known param sent to the wrong mode -- upstream IGNORES an
          unrecognised query param, so accepting one would be a lie)
       - limit outside [1,1000] or non-integer -> error "invalid param"
         (upstream answers limit=0 with a SUCCESS envelope carrying an EMPTY
          list; the bound is local so that trap is unreachable)
       - start outside [1,100000]       -> error "invalid param"
       - mode=marketPairs without a valid slug -> error "invalid param"
  502: upstream's own refusal (HTTP 200 + status.error_code != "0") is carried
       through with upstream's code and message. Never a 200 with an empty table.
  405: POST/PUT/... on the route.

Checks:
  1. ORACLE FIRST: the verifier fetches api.coinmarketcap.com/data-api/v3 DIRECTLY
     and compares row counts against the adapter's own response. The adapter is
     never the source of truth about upstream.
  2. envelope + provenance for all 4 modes (auth note, kind, keyless upstream
     host, upstreamCount presence rules, pagination echo rules).
  3. the local 400 matrix, including the two measured traps: limit=0 (a success
     envelope with an empty list) and a param upstream would silently ignore.
  4. the 502 mapping for a real upstream refusal (a slug upstream rejects).
  5. cache observability (MISS -> HIT, fresh=1 -> MISS) and header/body agreement.
  6. healthz names the family, calls it keyless, and distinguishes the scheme
     from coinglass's (decryption) and coinank's (computed signature).
Anything the sidecar could not be exercised for is reported SKIPPED with the
reason and the run still exits non-zero -- never a silent pass.

Usage:
    python3 scripts/verify/verify-coinmarketcap.py
    python3 scripts/verify/verify-coinmarketcap.py --base http://127.0.0.1:3101
Exit 0 = every required check passed; 1 = a FAIL or a SKIP.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

PASS = 0
FAIL = 0
SKIP = 0
NOTES: list[str] = []
RESULTS: list[dict] = []

SIDECAR_DEFAULT = "http://127.0.0.1:3101"
UA = "fudcourt-verify-coinmarketcap/1.0 (+verification harness)"
UPSTREAM = "https://api.coinmarketcap.com/data-api/v3"

MODES = ["listing", "global", "marketPairs", "exchanges"]
AUTH_NOTE = "keyless dashboard endpoint, no credential, no signature"
# mode -> (upstream path, array path inside data or None for an object)
MODE_SHAPE = {
    "listing": ("/cryptocurrency/listing?start=1&limit=100", "cryptoCurrencyList"),
    "global": ("/global-metrics/quotes/latest", None),
    "exchanges": ("/exchange/listing?start=1&limit=100", "exchanges"),
    "marketPairs": ("/cryptocurrency/market-pairs/latest?slug=bitcoin&start=1&limit=100", "marketPairs"),
}
PAGINATED = ["listing", "exchanges", "marketPairs"]


# --------------------------------------------------------------- reporting
def check(name: str, ok: bool, detail: str = "") -> bool:
    global PASS, FAIL
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name}" + (f" -- {detail}" if detail else ""))
    RESULTS.append({"name": name, "ok": bool(ok), "detail": detail})
    if ok:
        PASS += 1
    else:
        FAIL += 1
    return bool(ok)


def skip(name: str, detail: str) -> None:
    global SKIP
    print(f"[SKIP] {name} -- {detail}")
    RESULTS.append({"name": name, "ok": None, "detail": detail})
    SKIP += 1


def info(name: str, detail: str) -> None:
    print(f"[INFO] {name} -- {detail}")
    RESULTS.append({"name": name, "ok": None, "detail": detail})
    NOTES.append(f"{name}: {detail}")


# ------------------------------------------------------- transport helpers
def _open(url: str, timeout: float, headers: dict | None = None) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, headers=headers or {
        "User-Agent": UA, "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def api(base: str, qs: str, timeout: float = 90.0) -> dict:
    """GET {base}/api/coinmarketcap?{qs}. An HTTPError IS a response -- read its body."""
    url = f"{base}/api/coinmarketcap?{qs}" if qs else f"{base}/api/coinmarketcap"
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


def hget(hdr: dict, name: str) -> str | None:
    for k, v in hdr.items():
        if k.lower() == name.lower():
            return v
    return None


def as_dict(v) -> dict:
    return v if isinstance(v, dict) else {}


def as_list(v) -> list:
    return v if isinstance(v, list) else []


# ------------------------------------------------------------- THE ORACLE
def oracle_get(path: str, timeout: float = 30.0) -> dict:
    """Fetch api.coinmarketcap.com/data-api/v3 DIRECTLY -- never via the adapter."""
    url = UPSTREAM + path
    st, raw, _ = _open(url, timeout, headers={
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": UA,
    })
    try:
        return {"status": st, "body": json.loads(raw)}
    except Exception:  # noqa: BLE001
        return {"status": st, "body": None}


def oracle_count(mode: str) -> int | None:
    """Row count straight from upstream, or None when it is not measurable."""
    path, array = MODE_SHAPE[mode]
    o = oracle_get(path)
    if o["status"] != 200 or not isinstance(o["body"], dict):
        return None
    data = o["body"].get("data")
    if array is None:
        return None  # object payload: no count by design
    rows = as_dict(data).get(array)
    return len(rows) if isinstance(rows, list) else None


# ------------------------------------------------------------------ checks
def check_oracle(base: str) -> None:
    """1. The adapter's counts must match a DIRECT upstream fetch."""
    print("\n== 1. ORACLE: adapter counts vs a direct api.coinmarketcap.com fetch ==")
    for mode in MODES:
        r = api(base, f"mode={mode}" + ("&slug=bitcoin" if mode == "marketPairs" else ""))
        if r["status"] != 200 or not isinstance(r["body"], dict):
            skip(f"oracle:{mode}", f"adapter status={r['status']} (body: {r['raw'][:120]})")
            continue
        want = oracle_count(mode)
        if want is None:
            # object payload (global): the adapter must also carry no count.
            got = r["body"].get("upstreamCount", None)
            check(f"oracle:{mode}", got is None,
                  f"object payload: adapter upstreamCount={got!r}, want absent")
            continue
        got = r["body"].get("upstreamCount")
        # A live market moves between the two calls; a small band is honest.
        ok = isinstance(got, int) and abs(got - want) <= max(2, want // 50)
        check(f"oracle:{mode}", ok, f"adapter={got} direct={want}")


def check_envelope(base: str) -> None:
    """2. Envelope + provenance for all 4 modes."""
    print("\n== 2. envelope + provenance (all 4 modes) ==")
    for mode in MODES:
        qs = f"mode={mode}" + ("&slug=bitcoin" if mode == "marketPairs" else "")
        r = api(base, qs)
        if r["status"] != 200 or not isinstance(r["body"], dict):
            skip(f"envelope:{mode}", f"status={r['status']} body={r['raw'][:120]}")
            continue
        b = r["body"]
        check(f"envelope:{mode}:kind", b.get("kind") == mode, f"kind={b.get('kind')!r}")
        check(f"envelope:{mode}:auth", b.get("auth") == AUTH_NOTE, f"auth={b.get('auth')!r}")
        check(f"envelope:{mode}:upstream-host",
              as_dict(b).get("upstream", "").startswith(UPSTREAM + "/"),
              f"upstream={b.get('upstream')!r}")
        check(f"envelope:{mode}:data-present", b.get("data") is not None, "data present")
        check(f"envelope:{mode}:fetchedAt", isinstance(b.get("fetchedAt"), int),
              f"fetchedAt={b.get('fetchedAt')!r}")
        check(f"envelope:{mode}:derived-verbatim", "verbatim" in as_dict(b).get("derived", ""),
              f"derived={b.get('derived')!r}")
        # count presence rules
        array = MODE_SHAPE[mode][1]
        if array is None:
            check(f"envelope:{mode}:no-count", "upstreamCount" not in b,
                  "object payload must carry no upstreamCount")
        else:
            check(f"envelope:{mode}:count", isinstance(b.get("upstreamCount"), int)
                  and b["upstreamCount"] > 0, f"upstreamCount={b.get('upstreamCount')!r}")
        # pagination echo rules
        if mode in PAGINATED:
            check(f"envelope:{mode}:pagination-echo",
                  isinstance(b.get("start"), int) and isinstance(b.get("limit"), int),
                  f"start={b.get('start')!r} limit={b.get('limit')!r}")
        else:
            check(f"envelope:{mode}:no-pagination",
                  "start" not in b and "limit" not in b,
                  "global must not echo pagination")
        # slug echo rule
        if mode == "marketPairs":
            check(f"envelope:{mode}:slug-echo", b.get("slug") == "bitcoin",
                  f"slug={b.get('slug')!r}")
        else:
            check(f"envelope:{mode}:no-slug", "slug" not in b, "slug is marketPairs-only")
        # cache is header-only, never a body key
        check(f"envelope:{mode}:cache-header-only", "cache" not in b,
              "cache must not be a body key")


def check_local_400(base: str) -> None:
    """3. The local 400 matrix -- the two measured traps included."""
    print("\n== 3. local 400 matrix (never forwarded upstream) ==")
    cases = [
        ("unknown mode", "mode=nope", "unknown mode"),
        ("mode absent", "", "unknown mode"),
        ("limit=0 (empty-list trap)", "mode=listing&limit=0", "invalid param"),
        ("limit=abc", "mode=listing&limit=abc", "invalid param"),
        ("limit=99999 (9.6MB page)", "mode=listing&limit=99999", "invalid param"),
        ("limit=-1", "mode=listing&limit=-1", "invalid param"),
        ("start=0", "mode=listing&start=0", "invalid param"),
        ("start=100001", "mode=listing&start=100001", "invalid param"),
        ("slug on listing (upstream ignores it)", "mode=listing&slug=bitcoin", "unexpected param"),
        ("limit on global", "mode=global&limit=10", "unexpected param"),
        ("unknown param", "mode=listing&bogus=1", "unexpected param"),
        ("marketPairs without slug", "mode=marketPairs", "invalid param"),
        ("marketPairs bad slug", "mode=marketPairs&slug=Bit%20Coin", "invalid param"),
    ]
    for label, qs, want_err in cases:
        r = api(base, qs)
        b = as_dict(r["body"])
        ok = r["status"] == 400 and b.get("error") == want_err
        check(f"400:{label}", ok, f"status={r['status']} error={b.get('error')!r} want {want_err!r}")


def check_upstream_502(base: str) -> None:
    """4. A real upstream refusal maps to 502 with upstream's code -- never an empty 200."""
    print("\n== 4. upstream refusal -> 502 ==")
    r = api(base, "mode=marketPairs&slug=zzz-not-a-real-coin-xyz&limit=2")
    b = as_dict(r["body"])
    check("502:bogus-slug-status", r["status"] == 502, f"status={r['status']}")
    check("502:bogus-slug-error", b.get("error") == "upstream refused", f"error={b.get('error')!r}")
    check("502:bogus-slug-code", b.get("code") not in (None, "", "0"),
          f"upstream code={b.get('code')!r} (must carry upstream's own code)")


def check_cache(base: str) -> None:
    """5. Cache observability + header/body agreement."""
    print("\n== 5. cache + header/body agreement ==")
    qs = "mode=exchanges&limit=7"
    r1 = api(base, qs)
    check("cache:cold-MISS", hget(r1["hdr"], "X-CMC-Cache") == "MISS",
          f"X-CMC-Cache={hget(r1['hdr'], 'X-CMC-Cache')!r}")
    r2 = api(base, qs)
    check("cache:warm-HIT", hget(r2["hdr"], "X-CMC-Cache") == "HIT",
          f"X-CMC-Cache={hget(r2['hdr'], 'X-CMC-Cache')!r}")
    r3 = api(base, qs + "&fresh=1")
    check("cache:fresh-MISS", hget(r3["hdr"], "X-CMC-Cache") == "MISS",
          f"X-CMC-Cache={hget(r3['hdr'], 'X-CMC-Cache')!r}")
    # header/body agreement
    if isinstance(r2["body"], dict):
        check("cache:header-body-agreement",
              hget(r2["hdr"], "X-CMC-Upstream") == r2["body"].get("upstream"),
              "X-CMC-Upstream must equal body upstream")
        check("cache:cache-control",
              (hget(r2["hdr"], "Cache-Control") or "").startswith("public, max-age="),
              f"Cache-Control={hget(r2['hdr'], 'Cache-Control')!r}")
        check("cache:limit-honored", r2["body"].get("limit") == 7,
              f"body limit={r2['body'].get('limit')!r} (requested 7)")


def check_healthz(base: str) -> None:
    """6. healthz names the family and states its keyless scheme."""
    print("\n== 6. healthz ==")
    st, raw, _ = _open(f"{base}/healthz", 15.0)
    try:
        h = json.loads(raw)
    except Exception:  # noqa: BLE001
        h = {}
    fams = h.get("families", h if isinstance(h, dict) else {})
    val = as_dict(fams).get("coinmarketcap", "")
    check("healthz:family-present", bool(val), f"coinmarketcap={val!r}")
    check("healthz:keyless-no-credential", "keyless" in str(val) and "no credential" in str(val),
          f"value={val!r}")
    # the three keyless schemes must read differently
    check("healthz:scheme-distinct",
          "decryption" not in str(val) and "signature" not in str(val),
          "coinmarketcap must not claim decryption (coinglass) or a signature (coinank)")


def check_method_guard(base: str) -> None:
    """7. Non-GET on the route."""
    print("\n== 7. method guard ==")
    req = urllib.request.Request(f"{base}/api/coinmarketcap?mode=listing", method="POST",
                                 headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            st = r.status
    except urllib.error.HTTPError as e:
        st = e.code
    check("405:POST", st == 405, f"POST -> {st}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=SIDECAR_DEFAULT)
    args = ap.parse_args()
    base = args.base.rstrip("/")
    print(f"verify-coinmarketcap: base={base}")

    # The sidecar must be reachable at all before anything is meaningful.
    try:
        st, _, _ = _open(f"{base}/healthz", 10.0)
        if st != 200:
            skip("sidecar:reachable", f"healthz -> {st}")
    except Exception as e:  # noqa: BLE001
        skip("sidecar:reachable", f"{type(e).__name__}: {e}")

    check_oracle(base)
    check_envelope(base)
    check_local_400(base)
    check_upstream_502(base)
    check_cache(base)
    check_healthz(base)
    check_method_guard(base)

    print(f"\n== RESULT: {PASS} pass / {FAIL} fail / {SKIP} skip ==")
    if NOTES:
        for n in NOTES:
            print(f"  note: {n}")
    return 0 if (FAIL == 0 and SKIP == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
