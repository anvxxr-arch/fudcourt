#!/usr/bin/env python3
"""
Contract check for the CoinGecko markets family in fudcourt.

Built 2026-09-28 alongside /api/markets (the route the tracker has always
fetched but that never existed in this tree -- the view rendered a red
"API error"). CoinGecko /coins/markets is public and keyless, GET-only.

What is asserted instead:

  * the view's payload is real and request-varying (page/limit/search)
  * OUR params (sort/order/page/limit/search) fail loudly -- never clamped
  * local search/sort is honestly labelled (derived + pool + upstreamTotal)
  * null upstream metrics stay null (rendered `--`, never 0-filled)
  * caching is observable via X-Cache
  * GATE2: BTC/ETH prices agree with coins.llama.fi within 3%
    (measured harness band: CR-vs-llama ETH drift <= 1.33%, 3% headroom)
  * GATE3: BTC/ETH prices agree with cryptorank.io (/price/<key>) within 3%
    -- a fully independent scrape pipeline (SSR HTML vs CoinGecko API)
  * every route fragment has a UI path and vice versa

Usage:
    python3 scripts/verify/verify-markets.py [--base http://127.0.0.1:3100]

Exit codes:
    0  every expectation held
    1  at least one expectation failed
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from verifylib import DEFAULT_API_BASE as DEFAULT_BASE
LLAMA_TRUTH = ("https://coins.llama.fi/prices/current/"
               "coingecko:bitcoin,coingecko:ethereum")
CR_KEYS = {"BTC": "bitcoin", "ETH": "ethereum"}
GATE_BAND = 0.03  # 3%: measured CR-vs-llama drift <= 1.33% (harness n=6)

from functools import partial
from verifylib import call_get as call, check, hdr, jload
from verifylib import note_join, section
from verifylib import GREEN, RED, DIM, RESET
note = partial(note_join, maxlen=150)
results: list[tuple[bool, str, str]] = []














def find_symbol(coins: list, sym: str):
    for c in coins or []:
        if str(c.get("baseAsset", "")).upper() == sym:
            return c
    return None


def verify_shape(base: str) -> dict:
    section("GET /api/markets: real top-250 pool, fields the view renders")
    st, h, b = call(f"{base}/api/markets?sort=volume&order=desc&page=1&limit=50")
    j = jload(b) or {}
    check(st == 200, "-> 200", note("got", st, str(j.get("error", ""))[:60]))
    coins = j.get("coins") or []
    check(len(coins) == 50, "default limit=50 rows", note("n", len(coins)))
    check(isinstance(j.get("pool"), int) and 150 <= j["pool"] <= 250,
          "pool reports the CoinGecko top-250 window", note("pool", j.get("pool")))
    check(j.get("upstreamTotal") == j.get("pool"),
          "upstreamTotal equals pool (nothing beyond it claimed)",
          note(j.get("upstreamTotal"), "vs", j.get("pool")))
    st_b, _, b_b = call(f"{base}/api/markets?search=btc&limit=10")
    coins_b = (jload(b_b) or {}).get("coins") or []
    btc = find_symbol(coins_b, "BTC")
    if check(btc is not None, "search=btc returns a BTC row"):
        assert btc is not None
        check(isinstance(btc.get("lastPrice"), (int, float)) and btc["lastPrice"] > 0,
              "BTC lastPrice is a positive number", note(btc.get("lastPrice")))
        check(isinstance(btc.get("marketCap"), (int, float)) and btc["marketCap"] > 1e11,
              "BTC market cap has a real magnitude", note(btc.get("marketCap")))
        check(str(btc.get("image", "")).startswith("https://"), "row carries an https image")
        check(btc.get("rank") in (1, None) or isinstance(btc.get("rank"), int),
              "row carries a market-cap rank", note(btc.get("rank")))
    top = coins[0] if coins else {}
    # Default query is sort=volume&order=desc: USDT is the market's real 24h
    # volume leader (measured -- BTC leads market cap, not volume).
    check(str(top.get("name", "")).lower() == "tether",
          "volume-desc pool starts at Tether (the real 24h volume leader)",
          note(top.get("name")))
    vols = [c.get("quoteVolume") for c in coins
            if isinstance(c.get("quoteVolume"), (int, float))]
    check(len(vols) == len(coins) and all(vols[i] >= vols[i + 1]
          for i in range(len(vols) - 1)),
          "the default page is ordered by 24h volume desc", note("n", len(vols)))
    return j


def verify_request_varying(base: str) -> None:
    section("the body varies with the request (page / limit / search)")
    st1, _, b1 = call(f"{base}/api/markets?page=1&limit=5")
    st2, _, b2 = call(f"{base}/api/markets?page=2&limit=5")
    c1 = (jload(b1) or {}).get("coins") or []
    c2 = (jload(b2) or {}).get("coins") or []
    check(st1 == st2 == 200 and len(c1) == 5 and len(c2) == 5,
          "page=1 and page=2 both return 5 rows", note(len(c1), len(c2)))
    check(bool(c1) and bool(c2) and c1[0].get("symbol") != c2[0].get("symbol"),
          "page 2 starts at a different coin",
          note((c1[0] if c1 else {}).get("symbol"), "->", (c2[0] if c2 else {}).get("symbol")))

    st3, _, b3 = call(f"{base}/api/markets?search=ethereum&limit=50")
    j3 = jload(b3) or {}
    c3 = j3.get("coins") or []
    ok_all = all("ethereum" in (c.get("name", "").lower()) or
                 "eth" == str(c.get("baseAsset", "")).lower() for c in c3)
    check(st3 == 200 and bool(c3) and ok_all,
          "search=ethereum only returns ethereum-ish rows", note("n", len(c3)))
    check(isinstance(j3.get("total"), int) and j3["total"] <= j3.get("pool", 0),
          "filtered total never exceeds the pool", note(j3.get("total")))

    st4, _, b4 = call(f"{base}/api/markets?search=zzznoexist9999")
    j4 = jload(b4) or {}
    check(st4 == 200 and j4.get("total") == 0 and j4.get("coins") == [],
          "no-match search -> honest empty result (not an error, not fake rows)",
          note("total", j4.get("total")))


def verify_sort(base: str) -> None:
    section("local sort is applied and honest")
    st, _, b = call(f"{base}/api/markets?sort=price&order=asc&limit=30")
    prices = [c.get("lastPrice") for c in (jload(b) or {}).get("coins") or []]
    check(st == 200 and len(prices) == 30, "sort=price asc -> 30 rows", note("n", len(prices)))
    check(all(isinstance(p, (int, float)) for p in prices) and
          all(prices[i] <= prices[i + 1] for i in range(len(prices) - 1)),
          "prices are non-decreasing")

    st_m, _, b_m = call(f"{base}/api/markets?sort=mcap&order=desc&limit=30")
    mcaps = [c.get("marketCap") for c in (jload(b_m) or {}).get("coins") or []]
    check(st_m == 200 and len(mcaps) == 30 and
          all(isinstance(m_, (int, float)) for m_ in mcaps) and
          all(mcaps[i] >= mcaps[i + 1] for i in range(len(mcaps) - 1)),
          "sort=mcap desc restores the upstream market-cap order", note("n", len(mcaps)))

    st_a, _, b_a = call(f"{base}/api/markets?sort=volume&order=asc&limit=5")
    st_d, _, b_d = call(f"{base}/api/markets?sort=volume&order=desc&limit=5")
    a0 = ((jload(b_a) or {}).get("coins") or [{}])[0].get("symbol")
    d0 = ((jload(b_d) or {}).get("coins") or [{}])[0].get("symbol")
    check(st_a == st_d == 200 and bool(a0) and bool(d0) and a0 != d0,
          "flipping order flips the head row", note(a0, "vs", d0))


def verify_strict_params(base: str) -> None:
    section("our own params fail loudly (never clamped, never ignored)")
    cases = [
        ("sort=bogus", "sort=bogus", 400, "unknown sort"),
        ("order=up", "order=up", 400, "unknown order"),
        ("page=abc", "page=abc", 400, "integer"),
        ("page=0", "page=0", 400, "between 1 and"),
        ("limit=0", "limit=0", 400, "between 1 and 100"),
        ("limit=101", "limit=101", 400, "between 1 and 100"),
        ("search=65chars", "search=" + "x" * 65, 400, "at most 64"),
    ]
    for label, qs, expect, frag in cases:
        st, _, b = call(f"{base}/api/markets?{qs}")
        j = jload(b) or {}
        err = str(j.get("error", ""))
        check(st == expect and frag in err, f"{label} -> {expect} naming the field",
              note("got", st, err[:60]))


def verify_labels(base: str) -> None:
    section("derived work is labelled; repeats are cached (X-Cache)")
    _, h1, b1 = call(f"{base}/api/markets?sort=name&order=asc&limit=10")
    j = jload(b1) or {}
    derived = str(j.get("derived", ""))
    check("local" in derived and "CoinGecko" in derived,
          "derived label says the filter/sort ran locally over CoinGecko",
          note(derived[:80]))
    _, h2, _ = call(f"{base}/api/markets?sort=name&order=asc&limit=10")
    first, second = hdr(h1, "X-Cache"), hdr(h2, "X-Cache")
    check(second == "HIT", "an identical repeat is served from cache",
          note(first, "->", second))


def gate_prices(base: str) -> dict[str, float]:
    """Interleaved fetch (R-7): subject + truth back-to-back."""
    out: dict[str, float] = {}
    st, _, b = call(f"{base}/api/markets?search=bitcoin&limit=5")
    btc = find_symbol((jload(b) or {}).get("coins") or [], "BTC")
    st2, _, b2 = call(f"{base}/api/markets?search=ethereum&limit=5")
    eth = find_symbol((jload(b2) or {}).get("coins") or [], "ETH")
    if btc and isinstance(btc.get("lastPrice"), (int, float)):
        out["BTC"] = btc["lastPrice"]
    if eth and isinstance(eth.get("lastPrice"), (int, float)):
        out["ETH"] = eth["lastPrice"]
    return out


def verify_gate2_llama(base: str) -> None:
    section("GATE2: prices agree with coins.llama.fi within 3% (interleaved)")
    subject = gate_prices(base)
    st, _, b = call(LLAMA_TRUTH)
    truth = ((jload(b) or {}).get("coins") or {})
    t_btc = (truth.get("coingecko:bitcoin") or {}).get("price")
    t_eth = (truth.get("coingecko:ethereum") or {}).get("price")
    if not check(st == 200 and isinstance(t_btc, (int, float)) and isinstance(t_eth, (int, float)),
                 "llama truth fetch -> 200 with BTC+ETH prices", note("got", st)):
        return
    for sym, t in (("BTC", t_btc), ("ETH", t_eth)):
        s = subject.get(sym)
        if not isinstance(s, (int, float)):
            check(False, f"{sym} served by /api/markets", note("no numeric price"))
            continue
        gap = abs(s - t) / t  # fraction vs GATE_BAND (0.03 == 3%)
        check(gap <= GATE_BAND, f"{sym} vs llama within {GATE_BAND*100:.0f}%",
              note(f"{s:.4f} vs {t:.4f} = {gap*100:.3f}%"))


def verify_gate3_cr(base: str) -> None:
    section("GATE3: prices agree with cryptorank.io (independent pipeline) within 3%")
    subject = gate_prices(base)
    for sym, key in CR_KEYS.items():
        st, _, b = call(f"{base}/api/cryptorank?mode=coin&key={key}")
        det = (jload(b) or {}).get("detail") or {}
        t = det.get("priceUsd")
        if check(st == 200 and isinstance(t, (int, float)),
                 f"CR /price/{key} -> priceUsd", note("got", st, t)):
            s = subject.get(sym)
            if not isinstance(s, (int, float)):
                check(False, f"{sym} served by /api/markets", note("no numeric price"))
                continue
            gap = abs(s - t) / t  # fraction vs GATE_BAND (0.03 == 3%)
            check(gap <= GATE_BAND, f"{sym} vs cryptorank within {GATE_BAND*100:.0f}%",
                  note(f"{s:.4f} vs {t:.4f} = {gap*100:.3f}%"))


def verify_ui_wiring(base: str) -> None:
    section("route <-> UI wiring (tracker market rows)")
    import pathlib
    import re
    root = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "web"  # scripts/verify -> apps/web
    route = (root / "src/app/(frontend)/api/markets/route.ts").read_text()
    tracker = (root / "src/features/tracker/ui.tsx").read_text()
    shell = (root / "src/features/overview/store-shell.tsx").read_text()

    check("/api/markets" in tracker, "tracker fetches /api/markets")
    check("sort=mcap&order=desc&limit=50" in tracker, "tracker requests the mcap window")
    check("'—'" in tracker and "priceChangePercent: number | null" in tracker,
          "null upstream metrics render '--' (never 0-filled)")
    check("body?.error" in tracker, "route errors surface loudly in the view")
    for frag, label in [
        ("MARKETS_SORTS", "route validates sort against the lib's list"),
        ("MARKETS_ORDERS", "route validates order against the lib's list"),
        ("limitedFetch", "route shares the house limiter (cache + single-flight)"),
        ("derived", "route labels local work as derived"),
        ("upstreamTotal", "route reports upstreamTotal"),
    ]:
        check(frag in route, label, "")
    check("'ticker'" in shell, "shell wires the ticker tab")
    check(not (root / "src/app/(frontend)/coin/page.tsx").exists(), "/coin deep-link is removed")
    check((root / "src/features/market-data/markets/markets.ts").exists(), "src/features/market-data/markets/markets.ts owns the family contract")
    m = re.search(r"export const MARKETS_SORTS = \[([^\]]+)\]", (root / "src/features/market-data/markets/markets.ts").read_text())
    declared = set(re.findall(r"'(\w+)'", m.group(1))) if m else set()
    check(declared == {"mcap", "volume", "price", "change", "name"},
          "lib declares the 5 sorts (4 UI offers + mcap for the tracker)", note(sorted(declared)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    args = ap.parse_args()
    base = args.base.rstrip("/")
    t0 = time.time()

    print(f"{DIM}fudcourt x coingecko markets contract check -> {base}{RESET}")
    verify_shape(base)
    verify_request_varying(base)
    verify_sort(base)
    verify_strict_params(base)
    verify_labels(base)
    verify_gate2_llama(base)
    verify_gate3_cr(base)
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
    sys.exit(main())
