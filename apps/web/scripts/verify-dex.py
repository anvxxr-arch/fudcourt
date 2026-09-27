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
import re
import sys
import time
import urllib.error
import urllib.request

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
    "token-pairs": ("pairs", {"address": WSOL, "chain": "solana"}),
    "orders": ("orders", {"address": WSOL}),
}

# Requests that must be refused loudly, never answered 200 with empty data.
REJECTIONS = [
    ("unknown type", "type=bogus", 400),
    ("empty search", "type=search&q=", 400),
    ("invalid mint (tokens)", "type=tokens&addresses=notarealmint", 400),
    ("invalid mint (token-pairs)", "type=token-pairs&address=zzz", 400),
    ("invalid mint (orders)", "type=orders&address=zzz", 400),
    ("too many addresses", "type=tokens&addresses=" + ",".join([WSOL] * 31), 400),
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


# --- 7. the proxy is honest about upstream --------------------------------
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
    verify_upstream_honesty(base)

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
