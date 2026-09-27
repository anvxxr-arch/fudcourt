#!/usr/bin/env python3
"""
Contract check for the DexScreener integration in fudcourt.

Every expectation here was measured live against api.dexscreener.com. The point
is drift detection: DexScreener retired /latest/dex/pairs/{chain} without
warning, which silently turned a route into a permanent 500. If upstream
changes a status code, drops a field, or starts serving a combination it used
to reject, this exits non-zero instead of the UI quietly showing wrong numbers.

Usage:
    python3 scripts/verify-dex.py [--base http://127.0.0.1:3100]

Exit codes:
    0  every expectation held
    1  at least one expectation failed
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

DEFAULT_BASE = "http://127.0.0.1:3100"

# A real, high-liquidity mint: every measurement below should be populated.
WSOL = "So11111111111111111111111111111111111111112"
# A real but brand-new pump.fun mint: the genuinely sparse case.
PUMP = "5Az92KHhqxtudSbqZ2yrQ3LWfkS3ktKkER3FVVLzpump"

# type -> (expected kind, required query params)
TYPES = {
    "profiles": ("profiles", {}),
    "boosts": ("profiles", {}),
    "boosts-top": ("profiles", {}),
    "search": ("pairs", {"q": "SOL"}),
    "tokens": ("pairs", {"addresses": WSOL}),
    "tokens-v1": ("pairs", {"address": WSOL, "chain": "solana"}),
    "token-pairs": ("pairs", {"address": WSOL, "chain": "solana"}),
    "orders": ("orders", {"address": WSOL}),
}

# Requests that must be refused loudly, never answered 200 with empty data.
REJECTIONS = [
    ("unknown type", "type=bogus", 400),
    ("empty search", "type=search&q=", 400),
    ("invalid mint (tokens)", "type=tokens&addresses=notarealmint", 400),
    ("invalid mint (tokens-v1)", "type=tokens-v1&address=zzz", 400),
    ("invalid mint (token-pairs)", "type=token-pairs&address=zzz", 400),
    ("invalid mint (orders)", "type=orders&address=zzz", 400),
    ("too many addresses", "type=tokens&addresses=" + ",".join([WSOL] * 31), 400),
    # An unknown chain must fail as an unknown CHAIN. Before this was validated
    # it produced "unknown type 'search?q=weth'" -- because the raw query string
    # had leaked into `type` -- which points the caller at the wrong field.
    ("unknown chain (search)", "type=search&q=SOL&chain=hedera", 400),
    ("unknown chain (token-pairs)", f"type=token-pairs&address={WSOL}&chain=nope", 400),
]

# Address families DexScreener really serves. Measured on
# token-profiles/latest/v1: 6 of 30 records were NOT base58 -- robinhood/bsc
# 0x… addresses and a NEAR name. A base58-only validator rejected real tokens
# and aborted the whole profiles->pairs join, so this is a contract, not trivia.
# format -> (address, chain)
ADDRESS_FAMILIES = [
    ("base58 solana", WSOL, "solana"),
    ("hex EVM (bsc)", "0x2259D0Fc599a4cD2CF4861cae52C4F0D65537777", "bsc"),
    ("near name", "rust-334.meme-cooking.near", "near"),
]

# Fields a mature pair is measured to always carry.
REQUIRED_ON_MATURE = ("chainId", "dexId", "url", "pairAddress",
                      "baseToken", "quoteToken", "priceUsd", "volume",
                      "liquidity", "txns")

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
results: list[tuple[bool, str, str]] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    results.append((ok, label, detail))
    print(f"  [{GREEN + 'PASS' + RESET if ok else RED + 'FAIL' + RESET}] {label}"
          + (f"  {DIM}{detail}{RESET}" if detail else ""))
    return ok


def get(url: str, timeout: int = 45):
    """(status, dict | str | None). An HTTPError is a response -- read its body."""
    req = urllib.request.Request(url, headers={"User-Agent": "fudcourt-verify/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body, status = r.read(), r.status
    except urllib.error.HTTPError as e:
        try:
            err = e.read()
        except Exception:
            err = b""
        try:
            return e.code, json.loads(err)
        except Exception:
            return e.code, err[:200].decode("utf-8", "replace")
    except Exception as e:
        return 0, f"{type(e).__name__}: {e}"
    try:
        return status, json.loads(body)
    except Exception:
        return status, body[:200].decode("utf-8", "replace")


def as_dict(body) -> dict:
    """Narrow a body to a dict, or record why it could not be narrowed."""
    if isinstance(body, dict):
        return body
    return {"__unexpected__": (body if isinstance(body, str) else type(body).__name__)[:120]}


def bad(d: dict) -> str | None:
    return d["__unexpected__"] if "__unexpected__" in d else None


def note(*parts) -> str:
    """Coerce mixed-type diagnostic fragments to a printable string."""
    return " ".join(str(p) for p in parts if p)[:160]


def require(status: int, body) -> tuple[dict, str | None]:
    """(narrowed_body, failure_reason). failure_reason is None when usable."""
    d = as_dict(body)
    why = bad(d)
    if why:
        return d, f"body was {why}, not a JSON object"
    if status != 200:
        return d, f"got HTTP {status}: {d.get('error')}"
    return d, None


def section(t):
    print(f"\n{YELLOW}▸ {t}{RESET}")


# --- 1. every type serves real data ---------------------------------------
def verify_types(base):
    section("all 7 types return real data")
    payloads = {}
    for t, (kind, params) in TYPES.items():
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        status, body = get(f"{base}/api/dex?type={t}" + (f"&{qs}" if qs else "") + "&limit=30")
        d = as_dict(body)
        if b := bad(d):
            check(False, f"{t} -> JSON object", b)
            continue
        if status != 200:
            check(False, f"{t} -> 200", f"got {status}: {d.get('error')}")
            continue
        check(d.get("kind") == kind, f"{t} -> kind '{kind}'", f"got {d.get('kind')!r}")
        n = len(d.get("data", [])) if kind == "profiles" else (
            len(d.get("orders", [])) if kind == "orders" else len(d.get("data", []))
        )
        check(n > 0, f"{t} -> {n} records", "empty — a silent fake would look like this")
        check(isinstance(d.get("upstream"), str) and d["upstream"].startswith("https://api.dexscreener.com"),
              f"{t} -> reports its upstream URL", str(d.get("upstream"))[:60])
        payloads[t] = d
        time.sleep(0.8)
    return payloads


# --- 2. the retired endpoint stays retired --------------------------------
def verify_retired(base):
    section("retired endpoint is not silently resurrected")
    # /latest/dex/pairs/{chain} answers 404 + HTML upstream. Our proxy must not
    # offer a `pairs` type that maps to it, or we are back to a permanent 500.
    status, body = get(f"{base}/api/dex?type=pairs&chain=solana")
    d = as_dict(body)
    if b := bad(d):
        check(False, "type=pairs returns JSON", b)
        return
    check(status == 400 and "unknown type" in str(d.get("error", "")),
          "type=pairs is rejected, not mapped to the dead path",
          f"got {status}: {str(d.get('error'))[:60]}")


# --- 3. rejections are loud -----------------------------------------------
def verify_rejections(base):
    section("invalid input is refused loudly (never 200 + empty)")
    for label, query, want in REJECTIONS:
        status, body = get(f"{base}/api/dex?{query}")
        d = as_dict(body)
        b = bad(d)
        if b:
            check(False, f"{label} -> {want}", f"body was {b}")
            continue
        has_error = "error" in d
        empty_ok = not d.get("data")
        check(status == want and has_error and empty_ok,
              f"{label} -> {want} + error + no data",
              f"got {status}, error={has_error}, data_empty={empty_ok}")


# --- 4. mature-pair field presence ---------------------------------------
def verify_pair_shape(base):
    section("mature pair field presence (WSOL)")
    status, body = get(f"{base}/api/dex?type=token-pairs&address={WSOL}&chain=solana&limit=30")
    d, why = require(status, body)
    if why:
        check(False, "token-pairs/WSOL -> 200", why)
        return
    pairs = d.get("data") or []
    if not check(len(pairs) > 0, f"{len(pairs)} pairs returned", "none"):
        return
    missing = [f for f in REQUIRED_ON_MATURE if any(f not in p for p in pairs)]
    check(not missing, f"every pair carries {len(REQUIRED_ON_MATURE)} core fields",
          note("missing:", missing) if missing else "")

    # Nested windows, measured -- these are NOT uniformly present even for WSOL.
    # Measured 2026-09-26 on token-pairs/v1/solana/WSOL (30 pairs):
    #   volume      h24 h6 h1 m5 all present
    #   txns        h24 h6 h1 m5 all present
    #   priceChange h24 h6 always; m5 missing on 13/30, h1 missing on 1/30
    # So priceChange is asserted only on the windows upstream really guarantees.
    # A UI that renders a missing m5 as 0% would be fabricating a flat 5-minute
    # move on 43% of rows.
    for field, windows in (("volume", ("h24", "h6", "h1", "m5")),
                           ("txns", ("h24", "h6", "h1", "m5")),
                           ("priceChange", ("h24", "h6"))):
        got = [p.get(field) or {} for p in pairs]
        bad_w = [w for w in windows if any(w not in v for v in got)]
        check(not bad_w, f"{field} always carries {', '.join(windows)}",
              note("missing on some pair:", bad_w) if bad_w else "")

    # The known-sparse short windows: report, don't assert presence.
    for field, w in (("priceChange", "m5"), ("priceChange", "h1")):
        have = sum(1 for p in pairs if w in (p.get(field) or {}))
        pct = (have / len(pairs)) * 100
        print(f"  {DIM}{field}.{w:4} present on {have}/{len(pairs)} ({pct:.0f}%) "
              f"— absent must render as an em-dash, never 0%{RESET}")

    # buys/sells must both be present wherever a txn window exists
    nobs = sum(1 for p in pairs for v in (p.get("txns") or {}).values()
               if v.get("buys") is None or v.get("sells") is None)
    check(nobs == 0, "every txn window has both buys and sells", f"{nobs} incomplete")

    # the absent-vs-zero distinction must be preservable: report both counts
    z = sum(1 for p in pairs if (p.get("liquidity") or {}).get("usd") == 0)
    a = sum(1 for p in pairs if p.get("liquidity") is None)
    print(f"  {DIM}liquidity.usd == 0 on {z} pairs, absent on {a} pairs "
          f"(a UI coercing absent->0 would misreport {a} rows){RESET}")
    time.sleep(0.8)


# --- 5. fresh-mint sparsity is real --------------------------------------
def verify_sparsity(base):
    section("fresh-mint sparsity (the case a naive UI gets wrong)")
    status, body = get(f"{base}/api/dex?type=tokens&addresses={PUMP}&limit=30")
    d, why = require(status, body)
    if why:
        check(False, "tokens/fresh-mint -> 200", why)
        return
    pairs = d.get("data") or []
    if not check(len(pairs) > 0, f"{len(pairs)} pairs for a fresh mint", "none — the sparse case is unobservable today"):
        return
    for f in ("liquidity", "labels", "priceChange"):
        n = sum(1 for p in pairs if p.get(f) is not None)
        pct = (n / len(pairs)) * 100
        print(f"  {DIM}{f:14} {n}/{len(pairs)} ({pct:.0f}%){RESET}")
    labels = sum(1 for p in pairs if p.get("labels") is not None)
    check(True, f"labels present on {labels}/{len(pairs)} — must render as em-dash when 0")
    time.sleep(0.8)


# --- 6. search ------------------------------------------------------------
def verify_search(base):
    section("search")
    status, body = get(f"{base}/api/dex?type=search&q=bonk&limit=30")
    d, why = require(status, body)
    if why:
        check(False, "search?q=bonk -> 200", why)
        return
    pairs = d.get("data") or []
    check(len(pairs) > 0, f"{len(pairs)} pairs for 'bonk'", "none")
    # every pair must be a real market, not a placeholder
    badp = [p.get("pairAddress") for p in pairs if not p.get("pairAddress") or not p.get("baseToken")]
    check(not badp, "every search result has a pairAddress and baseToken", f"{len(badp)} incomplete")
    time.sleep(0.8)


# --- 7. search chain semantics (the no-op-param trap) ---------------------
def verify_search_chain(base):
    section("search chain filter is honest about being local")
    # Measured: DexScreener search has NO server-side chain filter -- `q=weth`
    # spans 16 chains. So a filtered view must not imply the upstream request
    # was scoped, and the true spread must be reported either way.
    status, body = get(f"{base}/api/dex?type=search&q=weth&limit=30")
    d, why = require(status, body)
    if why:
        check(False, "unfiltered weth search", why)
        return
    seen = d.get("chainsSeen")
    check(isinstance(seen, dict) and len(seen) > 1,
          "unfiltered search reports the true chain spread",
          note(f"{len(seen or {})} chains"))
    check("filteredBy" not in d, "unfiltered search claims no filter was applied")

    time.sleep(1.0)
    status, body = get(f"{base}/api/dex?type=search&q=weth&limit=30&chain=solana")
    d2, why = require(status, body)
    if why:
        check(False, "chain=solana search", why)
        return
    rows = d2.get("data") or []
    check(all(p.get("chainId") == "solana" for p in rows),
          "every filtered row is on the requested chain",
          f"{sum(1 for p in rows if p.get('chainId') != 'solana')} off-chain")
    check(d2.get("filteredBy") == "solana", "response names the applied filter")
    check(d2.get("upstreamTotal", 0) >= d2.get("total", 0),
          "upstreamTotal >= total, so the filter's cost is visible",
          note(d2.get("upstreamTotal"), ">=", d2.get("total")))
    check(isinstance(d2.get("chainsSeen"), dict) and d2["chainsSeen"],
          "filtered response still reports what upstream spanned")

    # A valid filter that matches nothing must say so, not read as "no pairs".
    time.sleep(1.0)
    status, body = get(f"{base}/api/dex?type=search&q=zzzznotarealtokenqq&limit=30&chain=solana")
    d3, why = require(status, body)
    if why:
        check(False, "zero-match search", why)
        return
    check(d3.get("returned") == 0 and isinstance(d3.get("note"), str),
          "zero matches returns an explanatory note, not a silent empty set",
          note("note:", d3.get("note")))


# --- 8. the proxy is honest about upstream --------------------------------
def verify_upstream_honesty(base):
    section("proxy echoes the real upstream, not invented text")
    status, body = get(f"{base}/api/dex?type=search&q=SOL&limit=1")
    d, why = require(status, body)
    if why:
        check(False, "baseline", why)
        return
    up = str(d.get("upstream", ""))
    check("api.dexscreener.com" in up and "/latest/dex/search" in up,
          "upstream URL names the real endpoint", up[:80])
    ts = d.get("fetchedAt")
    check(isinstance(ts, int) and ts > 1_600_000_000,
          "fetchedAt is a real unix timestamp", note("got", ts))


def verify_burst(base: str) -> None:
    """A burst must never be answered 429.

    DexScreener sits behind Cloudflare and answers 10 concurrent requests with
    10x `429 {"type":".../error-1015/","title":"Error 1015: You are being rate
    limited"}`. Measured before the limiter existed; it has to stay 200 after.
    """
    section("a burst is never answered 429 (Cloudflare 1015)")

    qs = f"type=search&q=burst{int(time.time())}&limit=5"
    codes: list[int] = []
    cache_marks: list[str] = []

    def one(_) -> tuple[int, str]:
        req = urllib.request.Request(f"{base}/api/dex?{qs}", headers={"User-Agent": "fudcourt-verify/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.status, r.headers.get("X-Cache", "-")
        except urllib.error.HTTPError as e:
            return e.code, "-"
        except Exception as e:
            return 0, type(e).__name__

    with ThreadPoolExecutor(max_workers=10) as ex:
        for code, mark in ex.map(one, range(10)):
            codes.append(code)
            cache_marks.append(mark)

    check(all(c == 200 for c in codes),
          "10 concurrent identical requests all answer 200",
          note("codes:", sorted(set(codes))))

    # Single-flight: exactly one request may reach upstream, the rest must be
    # marked COALESCED. Ten MISS would mean ten real round-trips -- the exact
    # burst that triggered 1015.
    n_miss = cache_marks.count("MISS")
    n_coal = cache_marks.count("COALESCED")
    check(n_miss == 1,
          "only one of the 10 reaches upstream (single-flight)",
          note("MISS:", n_miss, "COALESCED:", n_coal))
    check(n_miss + n_coal == 10,
          "every coalesced caller is labelled, not left ambiguous",
          note(sorted(set(cache_marks))))

    # A warm repeat must be a HIT and materially faster than a cold fetch.
    t0 = time.time()
    st, _ = get(f"{base}/api/dex?{qs}")
    warm = time.time() - t0
    req = urllib.request.Request(f"{base}/api/dex?{qs}", headers={"User-Agent": "fudcourt-verify/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            mark = r.headers.get("X-Cache", "-")
    except urllib.error.HTTPError:
        mark = "-"
    check(mark == "HIT", "an identical repeat within the TTL is served from cache",
          note("x-cache:", mark, f"{warm*1000:.0f}ms"))
    check(st == 200 and warm < 0.25,
          "a cache hit is fast enough to be a cache hit",
          note(f"{warm*1000:.0f}ms (cold measured ~530ms)"))

    # Distinct queries must NOT collapse: a cache keyed too coarsely would
    # serve one token's data under another's name.
    distinct = [f"type=search&q=dist{i}{int(time.time())}&limit=5" for i in range(6)]
    marks2: list[str] = []
    def one_distinct(q: str) -> str:
        req = urllib.request.Request(f"{base}/api/dex?{q}", headers={"User-Agent": "fudcourt-verify/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.headers.get("X-Cache", "-")
        except urllib.error.HTTPError:
            return "HTTPError"
    with ThreadPoolExecutor(max_workers=6) as ex:
        marks2 = list(ex.map(one_distinct, distinct))
    check(all(m == "MISS" for m in marks2),
          "6 distinct queries are not collapsed into one cached body",
          note(sorted(set(marks2))))


def verify_address_families(base: str) -> None:
    """The proxy must accept every address family DexScreener actually serves.

    Measured on token-profiles/latest/v1: 6 of 30 records were not base58 --
    robinhood/bsc 0x… addresses and one NEAR name. A base58-only validator made
    the profiles->pairs join abort with "2 address(es) are not valid mints" and
    showed an error page instead of 16 real markets. The UI is only as good as
    the widest address the API will take.
    """
    section("every address family DexScreener serves is accepted, not just base58")

    for label, addr, chain in ADDRESS_FAMILIES:
        qs = urllib.parse.urlencode({"type": "token-pairs", "address": addr, "chain": chain})
        status, body = get(f"{base}/api/dex?{qs}")
        d, why = require(status, body)
        if why:
            check(False, f"{label} address is accepted", why)
            continue
        check(status == 200, f"{label} address is accepted", note("got", status))
        check(d.get("returned", 0) >= 1,
              f"{label} address resolves to at least one market",
              note("returned", d.get("returned")))

    # And the rejection path must still be loud: widening the validator must not
    # have turned "malformed" into "empty result".
    for bad in ("notarealmint", "zzz", "0x123", "0xZZZZ" + "a" * 36):
        qs = urllib.parse.urlencode({"type": "token-pairs", "address": bad, "chain": "solana"})
        status, body = get(f"{base}/api/dex?{qs}")
        check(status == 400, f"malformed {bad!r} is still rejected 400", note("got", status))


def verify_ui_wiring(base: str) -> None:
    """Every proxy type must be reachable from the UI, not just from curl.

    Measured 2026-09-27: boosts-top and orders were served (200 in the type
    matrix) but no component requested them -- dead API surface. The proxy can
    drift back into that state with any refactor that drops a mode, so the
    component source is checked against DEX_TYPES here.
    """
    section("every proxy type is reachable from the UI")

    comp = os.path.join(os.path.dirname(__file__), "..", "app", "components", "DexPage.tsx")
    with open(comp, encoding="utf-8") as fh:
        src = fh.read()

    # 'tokens-v1' and 'token-pairs' are chosen via a variable in mint mode, but
    # their literals still live in the source; a mode key like 'boosts-top' must
    # appear as a MODES entry. A bare substring is enough -- the failure mode we
    # are guarding against is a mode being deleted outright.
    for t in TYPES:
        check(t in src, f"type '{t}' has a UI path", note("DexPage.tsx"))

    # And the reverse: no UI mode may point at a type the proxy does not serve.
    # 'pairs' is the profiles->tokens join and 'mint' picks tokens-v1/token-pairs
    # from a toggle -- both internal, neither is a direct type name.
    keys = re.findall(r"\{ key: '([a-z0-9-]+)',", src)
    internal = ("pairs", "mint")
    unknown = [k for k in keys if k not in internal and k not in TYPES]
    check(not unknown, "every UI mode maps to a served type or an internal join",
          note("unmapped:", unknown) if unknown else f"{len(keys)} modes")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    args = ap.parse_args()
    base = args.base.rstrip("/")
    t0 = time.time()

    print(f"{DIM}fudcourt x DexScreener contract check -> {base}{RESET}")
    verify_types(base)
    verify_retired(base)
    verify_rejections(base)
    verify_pair_shape(base)
    verify_sparsity(base)
    verify_search(base)
    verify_search_chain(base)
    verify_upstream_honesty(base)
    verify_burst(base)
    verify_address_families(base)
    verify_ui_wiring(base)

    passed = sum(1 for ok, _, _ in results if ok)
    failed = len(results) - passed
    print()
    if failed:
        print(f"{RED}{failed} FAILED{RESET}, {passed} passed in {time.time()-t0:.1f}s")
        return 1
    print(f"{GREEN}all {passed} checks passed{RESET} in {time.time()-t0:.1f}s")
    return 0


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (used by verify_types)
    sys.exit(main())
