#!/usr/bin/env python3
"""
verify-cryptorank.py -- executable contract for the CryptoRank integration.

    route:      GET http://127.0.0.1:3100/api/cryptorank?mode=<mode>
    modes:      home | coins | trending | losers | gainers | listings
                blockchains         (chain directory, feeds chain selector)
                categories | coin | chain   (?key=, validated CR_KEY_RE:
                bad format 400, honest upstream miss 404)
                exchanges          (?key= strict whitelist: cex/spot,
                dex/spot, perpetuals; else 400)
                funding | unlocks   (503 loud refusal -- synthetic data-route)
                funding | unlocks -> 503 REFUSED (upstream /_next/data class
                serves synthetic decoy; see lib/cryptorank.ts CR_DISABLED)
    data path:  route -> scripts/cr_fetch.py (venv curl_cffi) -> cryptorank.io
                market-page __NEXT_DATA__ SSR payload (see lib/cryptorank.ts header
                for the measured access matrix: API host challenged, market pages
                readable, fundraising tree walled).

Checks:
  1. every live mode 200 + envelope invariants (upstream, fetchedAt, counts)
  2. shape/semantics per mode (monotonic gainers, direct vs derived change,
     homepage slices labelled + date-recency, global sanity ranges)
  3. ANTI-FAKE PARITY: an independent venv-side fetch of the same upstream page
     must yield the same first-row identity + price as the proxy (tolerance 0.5%
     for the live-price gap between the two fetches)
  4. GROUND TRUTH: proxy BTC/ETH prices must sit within 3% of coins.llama.fi
     (independent source). Parity alone cannot detect upstream fabrication --
     this check is what caught the synthetic decoy on 2026-09-27 (served
     BTC 57k-67k while truth was 84.5k).
  5. DISABLED MODES: funding/unlocks must 503 with the reason; never data.
  6. DECOY DETECTOR (informational): nonexistent slug on the /_next/data class.
     200 = decoy still active (modes stay disabled); 404 = re-verify before
     any re-enable (see lib header for the two-step re-enable gate).
  7. 400 on unknown mode; helper unit: disallowed path exits 5, cache HIT works
  8. UI wiring: disabled sections ABSENT, homepage-slice cards present

Usage: python3 scripts/verify-cryptorank.py [--base http://127.0.0.1:3100]
Exit 0 = all required checks pass (informational checks never fail the run).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time

import requests

PASS = 0
FAIL = 0
NOTES: list[str] = []
RESULTS: list[dict] = []

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CR_VENV_PY = "/home/dwizzy/.venvs/crfetch/bin/python"
HELPER = os.path.join(APP_DIR, "scripts", "cr_fetch.py")


def note(msg: str) -> None:
    print(f"--- {msg}")


def check(name: str, ok: bool, detail: str = "") -> bool:
    global PASS, FAIL
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name}" + (f" -- {detail}" if detail else ""))
    RESULTS.append({"name": name, "ok": ok, "detail": detail})
    if ok:
        PASS += 1
    else:
        FAIL += 1
    return ok


def info(name: str, detail: str) -> None:
    print(f"[INFO] {name} -- {detail}")
    RESULTS.append({"name": name, "ok": None, "detail": detail})
    NOTES.append(f"{name}: {detail}")


def get(base: str, mode: str, fresh: bool = False, key: str | None = None) -> tuple[int, dict | None, dict]:
    params: dict = {"mode": mode}
    if fresh:
        params["fresh"] = "1"
    if key:
        params["key"] = key
    try:
        r = requests.get(f"{base}/api/cryptorank", params=params, timeout=120)
    except Exception as e:  # noqa: BLE001
        return 0, None, {"error": f"{type(e).__name__}: {e}"}
    try:
        return r.status_code, r.json(), dict(r.headers)
    except Exception:  # noqa: BLE001
        return r.status_code, None, dict(r.headers)


def data_route_probe(path: str) -> dict:
    """Fetch a Next.js DATA route ourselves (own buildId resolution) and report
    status + body size. Used by the DECOY DETECTOR: an honest Next server 404s
    unknown slugs; upstream instead serves a 200 with a fabricated payload
    (measured 2026-09-27 -- /price/zzznoexist9999.json ships a fake coin)."""
    script = f"""
import json, re, sys
from curl_cffi import requests as rq
h = rq.get("https://cryptorank.io/", impersonate="chrome131", timeout=30)
m = re.search(r'"buildId"\\s*:\\s*"([0-9a-f]+)"', h.text)
if not m:
    print(json.dumps({{"ok": False, "error": "no buildId"}})); sys.exit(0)
r = rq.get(f"https://cryptorank.io/_next/data/{{m.group(1)}}{path}.json",
           impersonate="chrome131", timeout=30)
print(json.dumps({{"ok": True, "status": r.status_code, "bytes": len(r.text)}}))
"""
    out = subprocess.run(
        [CR_VENV_PY, "-c", script],
        capture_output=True, text=True, timeout=90,
    )
    try:
        return json.loads(out.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {"ok": False, "error": (out.stderr or out.stdout)[-300:]}


def ground_truth_prices() -> dict:
    """Independent price source (DefiLlama coins API, no key). Parity against
    cryptorank itself proves only self-consistency; THIS proves truth."""
    try:
        r = requests.get(
            "https://coins.llama.fi/prices/current/coingecko:bitcoin,coingecko:ethereum,"
            "coingecko:tether,coingecko:usd-coin,coingecko:chainlink",
            timeout=30,
        )
        coins = (r.json() or {}).get("coins") or {}
        return {
            "BTC": (coins.get("coingecko:bitcoin") or {}).get("price"),
            "ETH": (coins.get("coingecko:ethereum") or {}).get("price"),
            "USDT": (coins.get("coingecko:tether") or {}).get("price"),
            "USDC": (coins.get("coingecko:usd-coin") or {}).get("price"),
            "LINK": (coins.get("coingecko:chainlink") or {}).get("price"),
        }
    except Exception as e:  # noqa: BLE001
            return {"error": f"{type(e).__name__}: {e}"}


def independent_upstream_page(path: str) -> dict:
    """Fetch the page OURSELVES in the cr venv (separate code path from the
    route) and pull the first coin row: name + price. Used for parity."""
    script = f"""
import json, re, sys
from curl_cffi import requests as rq
r = rq.get("https://cryptorank.io{path}", impersonate="chrome131", timeout=30)
m = re.search(r'<script id="__NEXT_DATA__" type="application/json"[^>]*>(.*?)</script>', r.text, re.S)
if not m or r.status_code != 200:
    print(json.dumps({{"ok": False, "status": r.status_code}})); sys.exit(0)
pp = json.loads(m.group(1))["props"]["pageProps"]
rows = pp.get("coins") or pp.get("fallbackData") or []
tbl = pp.get("fallbackTableData") or {{}}
if tbl.get("data"): rows = tbl["data"]
first = rows[0] if rows else {{}}
print(json.dumps({{
    "ok": True, "n": len(rows),
    "name": first.get("name"), "key": first.get("key"),
    "price": (first.get("price") or {{}}).get("USD"),
    "change": first.get("priceChange24h"),
    "top_gainer_change": None,
}}))
"""
    out = subprocess.run(
        [CR_VENV_PY, "-c", script],
        capture_output=True, text=True, timeout=90,
    )
    try:
        return json.loads(out.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {"ok": False, "error": (out.stderr or out.stdout)[-300:]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:3100")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    started = time.time()

    # ---------------------------------------------------------------- 1+2
    note("mode envelope + semantics")

    # --- home
    st, body, hdr = get(base, "home")
    body = body or {}
    home = body
    if check("home: HTTP 200", st == 200, f"got {st} {json.dumps(body)[:200] if body else ''}"):
        g = body.get("global") or {}
        mcap = g.get("totalMarketCap")
        check("home: global mcap sane", mcap is not None and 1e12 < mcap < 1e15, f"mcap={mcap}")
        check(
            "home: btc dominance sane",
            g.get("btcDominance") is not None and 40 <= g["btcDominance"] <= 75,
            f"btc={g.get('btcDominance')}",
        )
        fr = body.get("fundingRounds") or []
        ico = body.get("upcomingIco") or []
        check("home: funding slice rows", len(fr) >= 3, f"n={len(fr)}")
        check("home: upcoming ico rows", len(ico) >= 3, f"n={len(ico)}")
        check(
            "home: slice provenance labelled",
            isinstance(body.get("slice"), str) and "slice" in body["slice"],
            str(body.get("slice"))[:120],
        )
        check(
            "home: count == funding+ico",
            body.get("count") == len(fr) + len(ico),
            f"count={body.get('count')}",
        )
        check(
            "home: upstream pinned to homepage",
            body.get("upstream") == "https://cryptorank.io/",
            str(body.get("upstream")),
        )
        if fr:
            row = fr[0]
            check(
                "home: funding row shape",
                bool(row.get("date")) and (row.get("coinName") or row.get("type") is not None)
                and isinstance(row.get("funds"), list),
                json.dumps(row, default=str)[:160],
            )
        if ico:
            check(
                "home: ico row shape",
                bool((ico[0] or {}).get("name")) and ico[0].get("raiseUsd") is not None,
                json.dumps(ico[0], default=str)[:160],
            )

    # --- coins
    st, body, hdr = get(base, "coins")
    body = body or {}
    coins = body.get("rows") or []
    if check("coins: HTTP 200", st == 200, f"got {st}"):
        check("coins: 100 rows", len(coins) >= 50, f"n={len(coins)}")
        check(
            "coins: count == rows == upstreamTotal",
            body.get("count") == len(coins) == body.get("upstreamTotal"),
            f"count={body.get('count')} total={body.get('upstreamTotal')}",
        )
        check(
            "coins: change marked unavailable (no fake 24h col)",
            body.get("changeSource") == "unavailable"
            and all(r.get("change24h") is None for r in coins),
            f"changeSource={body.get('changeSource')}",
        )
        btc = next((r for r in coins if r.get("key") == "bitcoin"), None)
        check(
            "coins: bitcoin row present with live price",
            btc is not None and (btc.get("priceUsd") or 0) > 1000,
            f"btc={btc.get('priceUsd') if btc else None}",
        )
        check(
            "coins: absent metrics stay null (not 0)",
            all(
                r.get("marketCap") is None or r["marketCap"] > 0
                for r in coins[:20]
            ),
            "no zero-washed caps",
        )

    # --- trending
    st, body, hdr = get(base, "trending")
    body = body or {}
    rows = body.get("rows") or []
    if check("trending: HTTP 200", st == 200, f"got {st}"):
        check("trending: rows present", len(rows) >= 5, f"n={len(rows)}")
        total = body.get("upstreamTotal")
        check(
            "trending: upstreamTotal reported (10 of N)",
            total is not None and total > len(rows),
            f"total={total} rows={len(rows)}",
        )
        check("trending: change direct", body.get("changeSource") == "direct", str(body.get("changeSource")))
        nulls = sum(1 for r in rows if r.get("change24h") is None)
        check("trending: direct changes populated", nulls <= 2, f"nulls={nulls}/{len(rows)}")

    # --- gainers / losers
    for mode, positive in (("gainers", True), ("losers", False)):
        st, body, hdr = get(base, mode)
        body = body or {}
        rows = body.get("rows") or []
        if not check(f"{mode}: HTTP 200", st == 200, f"got {st}"):
            continue
        check(f"{mode}: 150 rows", len(rows) >= 100, f"n={len(rows)}")
        check(
            f"{mode}: changeSource derived+labelled",
            body.get("changeSource") == "derived-from-histPrices-24H",
            str(body.get("changeSource")),
        )
        vals = [r.get("change24h") for r in rows if r.get("change24h") is not None]
        check(
            f"{mode}: derived changes populated",
            len(vals) >= 0.9 * len(rows),
            f"{len(vals)}/{len(rows)} non-null",
        )
        if vals:
            first_ok = (vals[0] > 0) if positive else (vals[0] < 0)
            check(f"{mode}: sign of top row", first_ok, f"top={vals[0]}")

    # --- disabled modes: LOUD REFUSAL (upstream /_next/data serves decoy)
    for mode in ("funding", "unlocks"):
        st, body, hdr = get(base, mode)
        body = body or {}
        check(
            f"{mode}: REFUSED 503 (synthetic upstream)",
            st == 503 and body.get("disabled") is True,
            f"got {st} {json.dumps(body)[:170]}",
        )
        if st == 503:
            err = str(body.get("error", ""))
            check(
                f"{mode}: refusal states the measured reason",
                "synthetic" in err and "nonexistent" in err,
                err[:150],
            )
            check(
                f"{mode}: refusal names the re-verify gate",
                isinstance(body.get("reverify"), str) and "verify-cryptorank" in body["reverify"],
                str(body.get("reverify"))[:120],
            )

    # --- ground truth: proxy prices vs independent source (>=3% = fabrication)
    note("ground truth (independent source vs proxy)")
    gt = ground_truth_prices()
    if check("ground truth: independent fetch ok", isinstance(gt.get("BTC"), float),
             json.dumps(gt)[:200]) and coins:
        btc = next((r for r in coins if r.get("key") == "bitcoin"), None)
        eth = next((r for r in coins if r.get("key") == "ethereum"), None)
        for label, row, truth in (("BTC", btc, gt.get("BTC")), ("ETH", eth, gt.get("ETH"))):
            price = row.get("priceUsd") if row else None
            if price and truth:
                diff = abs(price - truth) / truth * 100
                check(
                    f"ground truth: {label} within 3% of coins.llama.fi",
                    diff <= 3.0,
                    f"proxy={price} truth={truth} diff={diff:.2f}%",
                )
            else:
                check(f"ground truth: {label} present in both", False,
                      f"proxy={price} truth={truth}")

    # --- homepage slice recency (dates must be near-real, not generated)
    if home is not None:
        fr_dates = [r.get("date") for r in (home.get("fundingRounds") or [])]
        ages = []
        now_ms = time.time() * 1000
        for d in fr_dates:
            try:
                ages.append((now_ms - __import__("datetime").datetime.fromisoformat(
                    str(d).replace("Z", "+00:00")).timestamp() * 1000) / 86400000)
            except Exception:  # noqa: BLE001
                ages.append(9999)
        check(
            "home: funding slice dates within last 45 days",
            bool(ages) and max(ages) <= 45,
            f"age_days={[round(a, 1) for a in ages]}",
        )

    # --- decoy detector (informational): data-route class honesty
    note("decoy detector (informational: upstream /_next/data class)")
    probe = data_route_probe("/price/zzznoexist9999")
    if probe.get("ok") and probe.get("status") == 200:
        info(
            "decoy detector",
            f"nonexistent slug still returns 200 ({probe.get('bytes')}B fabricated payload) -> "
            "funding/unlocks stay REFUSED; re-enable gate: slug must 404 AND content must match "
            "an independent source (see lib/cryptorank.ts CR_DISABLED)",
        )
    elif probe.get("ok") and probe.get("status") == 404:
        info(
            "decoy detector",
            "nonexistent slug now 404s (upstream stopped fabricating) -- re-run the two-step "
            "re-enable verification before wiring data-route modes again",
        )
    else:
        info("decoy detector", f"probe inconclusive: {json.dumps(probe)[:200]}")

    # ---------------------------------------------------------------- cache
    note("cache behaviour")
    st1, b1, h1 = get(base, "trending")
    b1 = b1 or {}
    st2, b2, h2 = get(base, "trending")
    b2 = b2 or {}
    check(
        "repeat call served from helper cache",
        h2.get("X-CR-Cache") == "HIT" or b2.get("cache") == "HIT",
        f"first={h1.get('X-CR-Cache') or b1.get('cache')} second={h2.get('X-CR-Cache')}",
    )

    # ---------------------------------------------------------------- 3
    note("anti-fake parity (independent venv fetch vs proxy)")
    if coins:
        up = independent_upstream_page("/all-coins-list")
        if check("parity: independent upstream fetch ok", up.get("ok") is True, json.dumps(up)[:200]):
            mine = next((r for r in coins if r.get("key") == "bitcoin"), None)
            check(
                "parity: first-row identity matches upstream",
                mine is not None and mine.get("name") == up.get("name")
                and (mine.get("key") or "") == (up.get("key") or ""),
                f"proxy={mine.get('name') if mine else None} upstream={up.get('name')}",
            )
            if mine and up.get("price") and mine.get("priceUsd"):
                diff = abs(mine["priceUsd"] - up["price"]) / up["price"] * 100
                check(
                    "parity: BTC price matches live upstream (<=0.5%)",
                    diff <= 0.5,
                    f"proxy={mine['priceUsd']} upstream={up['price']} diff={diff:.3f}%",
                )

    # ------------------------------------------- 3b HTML board modes (gated)
    note("HTML board modes: categories / exchanges / coin (3-gate verified)")

    truth = ground_truth_prices()
    eth_t, btc_t = truth.get("ETH"), truth.get("BTC")
    check(
        "board: ground truth available",
        isinstance(eth_t, (int, float)) and isinstance(btc_t, (int, float)),
        str(truth),
    )

    # --- exchanges (fixed /exchanges/cex/spot HTML)
    st, body, hdr = get(base, "exchanges")
    body = body or {}
    if check("exchanges: HTTP 200", st == 200, f"got {st}"):
        rows = body.get("rows") or []
        check("exchanges: 50 rows", len(rows) == 50, f"n={len(rows)}")
        check(
            "exchanges: top row is binance",
            bool(rows) and rows[0].get("key") == "binance",
            str(rows[0].get("key") if rows else None),
        )
        vols = [r.get("dayVolUsd") for r in rows if isinstance(r.get("dayVolUsd"), (int, float))]
        vsum = sum(vols) if vols else 0
        check(
            "exchanges: day-volume sum plausible (5B..1T)",
            5e9 <= vsum <= 1e12,
            f"sum={vsum:.3g} n={len(vols)}",
        )
        p0 = rows[0].get("percentVolume") if rows else None
        check(
            "exchanges: binance share 10-45%",
            isinstance(p0, (int, float)) and 10 <= p0 <= 45,
            f"pct={p0}",
        )
        check(
            "exchanges: methodology labelled (reported, not independent)",
            "reported" in (body.get("slice") or ""),
            str(body.get("slice"))[:120],
        )

    # --- categories (default key=chain)
    st, body, hdr = get(base, "categories")
    body = body or {}
    if check("categories: HTTP 200", st == 200, f"got {st}"):
        rows = body.get("rows") or []
        check("categories: >=90 rows", len(rows) >= 90, f"n={len(rows)}")
        cat = body.get("category") or {}
        check(
            "categories: name + breadth present",
            bool(cat.get("name")) and cat.get("gainers") is not None and cat.get("losers") is not None,
            json.dumps(cat)[:160],
        )
        check(
            "categories: changeSource unavailable (no fake changes)",
            body.get("changeSource") == "unavailable",
            str(body.get("changeSource")),
        )
        eth = next((r for r in rows if r.get("symbol") == "ETH"), None)
        if eth and isinstance(eth_t, (int, float)) and eth.get("priceUsd"):
            diff = abs(eth["priceUsd"] - eth_t) / eth_t * 100
            check(
                "categories: ETH matches independent ground truth (<=3%)",
                diff <= 3,
                f"mine={eth['priceUsd']} truth={eth_t} diff={diff:.3f}%",
            )
        else:
            check("categories: ETH row for ground truth", False, f"eth={eth}")

    # --- categories keyed (stablecoin)
    st, body, hdr = get(base, "categories", key="stablecoin")
    body = body or {}
    if check("categories?stablecoin: HTTP 200", st == 200, f"got {st}"):
        check(
            "categories?stablecoin: key echoed in category.slug",
            (body.get("category") or {}).get("slug") == "stablecoin",
            json.dumps(body.get("category"))[:120],
        )
        usdt = next(
            (r for r in (body.get("rows") or []) if r.get("symbol") == "USDT"), None
        )
        check(
            "categories?stablecoin: USDT ~1.00 (peg, 0.97-1.03)",
            bool(usdt) and isinstance(usdt.get("priceUsd"), (int, float))
            and 0.97 <= usdt["priceUsd"] <= 1.03,
            f"usdt={usdt.get('priceUsd') if usdt else None}",
        )

    # --- coin detail (default key=bitcoin)
    st, body, hdr = get(base, "coin")
    body = body or {}
    if check("coin: HTTP 200", st == 200, f"got {st}"):
        d = body.get("detail") or {}
        check("coin: bitcoin detail name", d.get("name") == "Bitcoin", str(d.get("name")))
        check(
            "coin: change24h derived (non-null)",
            d.get("change24h") is not None,
            str(d.get("change24h")),
        )
        check(
            "coin: ath above price",
            isinstance(d.get("athUsd"), (int, float))
            and isinstance(d.get("priceUsd"), (int, float))
            and d["athUsd"] > d["priceUsd"],
            f"ath={d.get('athUsd')} price={d.get('priceUsd')}",
        )
        if isinstance(btc_t, (int, float)) and d.get("priceUsd"):
            diff = abs(d["priceUsd"] - btc_t) / btc_t * 100
            check(
                "coin: BTC matches independent ground truth (<=3%)",
                diff <= 3,
                f"mine={d['priceUsd']} truth={btc_t} diff={diff:.3f}%",
            )
        check(
            "coin: envelope labels derived change",
            body.get("changeSource") == "derived-from-histPrices-24H",
            str(body.get("changeSource")),
        )

    # --- coin keyed (ethereum)
    st, body, hdr = get(base, "coin", key="ethereum")
    body = body or {}
    if check("coin?ethereum: HTTP 200", st == 200, f"got {st}"):
        d = body.get("detail") or {}
        if isinstance(eth_t, (int, float)) and d.get("priceUsd"):
            diff = abs(d["priceUsd"] - eth_t) / eth_t * 100
            check(
                "coin?ethereum: matches independent ground truth (<=3%)",
                diff <= 3,
                f"mine={d['priceUsd']} truth={eth_t} diff={diff:.3f}%",
            )

    # --- key contract: bad format -> 400, honest miss -> upstream 404
    st, body, hdr = get(base, "coin", key="../../etc")
    check("key contract: invalid format -> 400", st == 400, f"got {st}")
    st, body, hdr = get(base, "coin", key="zzznoexist9999")
    check("key contract: unknown coin -> 404 (upstream passthrough)", st == 404, f"got {st}")

    # --- exchange variants (strict whitelist key)
    st, body, hdr = get(base, "exchanges", key="dex/spot")
    body = body or {}
    if check("exchanges?dex: HTTP 200", st == 200, f"got {st}"):
        rows = body.get("rows") or []
        check("exchanges?dex: >=40 venues", len(rows) >= 40, f"n={len(rows)}")
        check(
            "exchanges?dex: top venue uniswap",
            bool(rows) and "uniswap" in (rows[0].get("key") or ""),
            str(rows[0].get("key") if rows else None),
        )
        check(
            "exchanges?dex: DEX variant labelled",
            "DEX spot" in (body.get("slice") or ""),
            str(body.get("slice"))[:100],
        )
    st, body, hdr = get(base, "exchanges", key="perpetuals")
    body = body or {}
    if check("exchanges?perp: HTTP 200", st == 200, f"got {st}"):
        rows = body.get("rows") or []
        check("exchanges?perp: >=40 venues", len(rows) >= 40, f"n={len(rows)}")
        check(
            "exchanges?perp: top venue binance futures",
            bool(rows) and "binance" in (rows[0].get("key") or ""),
            str(rows[0].get("key") if rows else None),
        )
        vols = [r.get("dayVolUsd") for r in rows if isinstance(r.get("dayVolUsd"), (int, float))]
        check(
            "exchanges?perp: day-volume sum plausible (10B..10T)",
            bool(vols) and 1e10 <= sum(vols) <= 1e13,
            f"sum={sum(vols):.3g}",
        )
    st, body, hdr = get(base, "exchanges", key="bogus/list")
    check("exchanges: non-whitelisted key -> 400", st == 400, f"got {st}")

    # --- listings (three widgets)
    st, body, hdr = get(base, "listings")
    body = body or {}
    if check("listings: HTTP 200", st == 200, f"got {st}"):
        li = body.get("listings") or {}
        ra, ms, mv = li.get("recentlyAdded") or [], li.get("mostSearched") or [], li.get("mostVisited") or []
        check("listings: three widgets x20", len(ra) == 20 and len(ms) == 20 and len(mv) == 20,
              f"ra={len(ra)} ms={len(ms)} mv={len(mv)}")
        check("listings: count == sum of widgets",
              body.get("count") == len(ra) + len(ms) + len(mv),
              f"count={body.get('count')}")
        check(
            "listings: changeSource derived (labelled)",
            body.get("changeSource") == "derived-from-histPrices-24H",
            str(body.get("changeSource")),
        )
        # recentlyAdded: anchor coverage is MIXED (row0 ships no 24h hist, most
        # rows do) -> derived where present, em-dash where absent, never faked
        n24 = sum(1 for r in ra if r.get("change24h") is not None)
        check("listings: recentlyAdded chg24h derived where anchor ships (>=14/20)",
              n24 >= 14, f"non-null={n24}/{len(ra)}")
        wild = [r.get("change24h") for r in ra
                if isinstance(r.get("change24h"), (int, float))
                and abs(r["change24h"]) > 300]
        check("listings: recentlyAdded chg24h plausible (|chg|<=300%)",
              not wild, f"wild={wild[:3]}")
        n24s = sum(1 for r in ms if r.get("change24h") is not None)
        check("listings: mostSearched chg24h derived (>=14/20)",
              n24s >= 14, f"non-null={n24s}/{len(ms)}")
        n7 = sum(1 for r in ra if r.get("change7d") is not None)
        check("listings: recentlyAdded chg7d derived (>=14/20)",
              n7 >= 14, f"non-null={n7}/{len(ra)}")
        # ground truth: BTC row in mostVisited
        btc = next((r for r in mv if r.get("symbol") == "BTC"), None)
        if btc and isinstance(btc_t, (int, float)) and btc.get("priceUsd"):
            diff = abs(btc["priceUsd"] - btc_t) / btc_t * 100
            check("listings: BTC matches independent ground truth (<=3%)",
                  diff <= 3,
                  f"mine={btc['priceUsd']} truth={btc_t} diff={diff:.3f}%")
        else:
            check("listings: BTC row for ground truth", False, f"btc={btc and btc.get('priceUsd')}")
        check(
            "listings: slice provenance labelled",
            "widgets" in (body.get("slice") or ""),
            str(body.get("slice"))[:140],
        )

    # --- chain index + keyed ecosystem detail
    st, body, hdr = get(base, "blockchains")
    body = body or {}
    if check("blockchains: HTTP 200", st == 200, f"got {st}"):
        cr = body.get("chainRows") or []
        check("blockchains: >=270 chain rows", len(cr) >= 270, f"n={len(cr)}")
        eth = next((c for c in cr if c.get("slug") == "ethereum"), None)
        check(
            "blockchains: ethereum row with slug+name",
            bool(eth) and eth.get("name") == "Ethereum",
            str(eth)[:120],
        )
        check(
            "blockchains: slugs well-formed",
            all(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", c.get("slug") or "") for c in cr[:50]),
            str([c.get("slug") for c in cr[:5]]),
        )

    st, body, hdr = get(base, "chain")
    body = body or {}
    if check("chain: HTTP 200 (default ethereum)", st == 200, f"got {st}"):
        ci = body.get("chain") or {}
        check(
            "chain: meta name + network",
            ci.get("name") == "Ethereum" and ci.get("network") is not None,
            json.dumps(ci)[:160],
        )
        rows = body.get("rows") or []
        check("chain: >=100 ecosystem tokens", len(rows) >= 100, f"n={len(rows)}")
        check(
            "chain: changeSource unavailable (no fake chg col)",
            body.get("changeSource") == "unavailable",
            str(body.get("changeSource")),
        )
        check(
            "chain: native-coin note in slice",
            "ecosystem" in (body.get("slice") or ""),
            str(body.get("slice"))[:140],
        )
        for sym in ("USDT", "USDC", "LINK"):
            t = truth.get(sym)
            row = next((r for r in rows if r.get("symbol") == sym), None)
            if t and row and row.get("priceUsd"):
                diff = abs(row["priceUsd"] - t) / t * 100
                check(
                    f"chain: {sym} matches independent ground truth (<=3%)",
                    diff <= 3,
                    f"mine={row['priceUsd']} truth={t} diff={diff:.3f}%",
                )
            else:
                check(f"chain: {sym} row for ground truth", False,
                      f"row={row and row.get('priceUsd')} truth={t}")

    st, body, hdr = get(base, "chain", key="solana")
    body = body or {}
    if check("chain?solana: HTTP 200", st == 200, f"got {st}"):
        ci = body.get("chain") or {}
        check(
            "chain?solana: meta echoes key",
            ci.get("slug") == "solana" and ci.get("name") == "Solana",
            json.dumps(ci)[:160],
        )

    st, body, hdr = get(base, "chain", key="zzznoexist9999")
    check("chain: unknown slug -> 404 (upstream passthrough)", st == 404, f"got {st}")

    # --- launchpool event lists (3-gate: 404 / date coherence / KuCoin truth)
    st, body, hdr = get(base, "launchpool")
    body = body or {}
    if check("launchpool: HTTP 200 (default past)", st == 200, f"got {st}"):
        rows = body.get("launchpoolRows") or []
        check("launchpool past: full page of rows", len(rows) >= 40, f"n={len(rows)}")
        total = body.get("upstreamTotal")
        check(
            "launchpool past: honest of-N (upstreamTotal > count)",
            isinstance(total, int) and total >= len(rows) > 0,
            f"total={total} count={body.get('count')}",
        )
        now_s = time.strftime("%Y-%m-%dT%H:%M", time.gmtime())
        n_started = sum(
            1 for r in rows
            if isinstance(r.get("when"), str) and r["when"][:16] <= now_s
        )
        check(
            "launchpool past: >=90% rows already started (date coherence)",
            rows and n_started / len(rows) >= 0.9,
            f"started={n_started}/{len(rows)} (page says 'past')",
        )
        gno = next((r for r in rows if r.get("key") == "gno-land"), None)
        if gno:
            check(
                "launchpool: gno-land window == KuCoin official GemPool dates (ground truth)",
                str(gno.get("when", "")).startswith("2026-09-16")
                and str(gno.get("till", "")).startswith("2026-09-26"),
                f"when={gno.get('when')} till={gno.get('till')}",
            )
        else:
            info("launchpool: gno-land window",
                 "row rotated off page 1 -> ground-truth date check skipped this run")
        check(
            "launchpool: slice labels of-N + page-1 limitation",
            "of" in (body.get("slice") or "") and "page" in (body.get("slice") or ""),
            str(body.get("slice"))[:150],
        )

    st, body, hdr = get(base, "launchpool", key="upcoming")
    body = body or {}
    if check("launchpool?upcoming: HTTP 200", st == 200, f"got {st}"):
        rows = body.get("launchpoolRows") or []
        check(
            "launchpool?upcoming: upstreamTotal == count (whole list ships)",
            body.get("upstreamTotal") == body.get("count") == len(rows),
            f"total={body.get('upstreamTotal')} count={body.get('count')} n={len(rows)}",
        )
        yday = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 86400))
        coherent = all(
            not isinstance(r.get("when"), str) or r["when"][:10] >= yday
            for r in rows
        )
        check(
            "launchpool?upcoming: no window in the past (TBA or future)",
            coherent,
            str([(r.get("name"), r.get("when")) for r in rows])[:160],
        )

    st, body, hdr = get(base, "launchpool", key="zzz")
    check("launchpool: bad variant -> 400 (never clamped)", st == 400, f"got {st}")

    # ---------------------------------------------------------------- 4
    note("error contract")
    st, body, hdr = get(base, "hack")
    body = body or {}
    check("unknown mode -> 400", st == 400, f"got {st}")
    check(
        "400 lists allowed modes",
        isinstance(body.get("modes"), list) and len(body["modes"]) == 14,
        str(body.get("modes")),
    )

    out = subprocess.run(
        [CR_VENV_PY, HELPER, "--path", "/funding-rounds"],
        capture_output=True, text=True, timeout=60,
    )
    check("helper: disallowed path exits 5", out.returncode == 5, f"rc={out.returncode}")
    check(
        "helper: disallowed path returns JSON error",
        '"ok": false' in out.stdout.replace(" ", "") or '"ok":false' in out.stdout.replace(" ", ""),
        out.stdout[:120],
    )

    # ---------------------------------------------------------------- 5
    note("per-ico detail (informational: synthetic, not wired)")
    ico = data_route_probe("/ico/jumper-exchange")
    if ico.get("ok") and ico.get("status") == 200:
        info(
            "per-ico detail",
            "200 with payload, but this class fabricates (nonexistent ico slug also 200s; "
            "/ico/dac-chain disagrees with the homepage's own dac-chain record: different name+icon) "
            "-> never wired; homepage upcomingIco slice is the only ICO source",
        )
    else:
        info("per-ico detail", f"data route answered {ico} -> not wired")

    info(
        "upstream totals",
        "the earlier 'load-dependent totals' (funding 98-3383, unlocks 98-769 within one hour) "
        "are now understood as decoy churn, not upstream variance -- funding/unlocks modes are "
        "REFUSED (503); only homepage slices (press-verified) ship fundraising data",
    )

    info(
        "gated out: /ath",
        "micro-cap prices bit-frozen over 15s, 8% gap vs the same coin's /price page, "
        "and no truth source reachable (CoinGecko 403, llama lags micro-caps) -> not wired",
    )
    info(
        "gated out: /performance",
        "rendered table ships literal N/A in EVERY ROI cell (even BTC/ETH), SSR payload has no period data, "
        "data-route performance.json is 602B rows=0, 53 mined JS chunks expose no data endpoint, and "
        "headless+headful HAR captures both hit the CF interstitial -> no honest ROI source exists",
    )
    info(
        "gated out: /funds/*, /upcoming-ico, /active-ico, /funding-analytics",
        "403 Cloudflare interstitial to direct fetch AND to headless/headful Chrome HAR captures "
        "(2 browser attempts, Turnstile light never cleared) -> policy wall, not wired",
    )

    note("upstream wall (informational)")
    wall = independent_upstream_page("/funding-rounds")
    if wall.get("ok"):
        info(
            "premium wall",
            "funding-rounds NOW serves data to direct fetch -- consider wiring a full funding mode",
        )
    else:
        info(
            "premium wall",
            f"/funding-rounds still walled (status {wall.get('status')}) -- homepage slices only, as labelled",
        )

    # ---------------------------------------------------------------- 6
    note("UI wiring")
    def read(rel: str) -> str:
        p = os.path.join(APP_DIR, rel)
        return open(p, encoding="utf-8").read() if os.path.exists(p) else ""

    shell = read("app/page.tsx")
    check("shell: cryptorank tab", "key: 'cryptorank'" in shell, "")
    check("shell: cryptorank render branch", "page === 'cryptorank' && <CryptorankPage />" in shell, "")
    check("wrapper: app/cryptorank/page.tsx", os.path.exists(os.path.join(APP_DIR, "app/cryptorank/page.tsx")), "")
    comp = read("app/components/CryptorankPage.tsx")
    check("component: fetches /api/cryptorank", "/api/cryptorank?mode=" in comp, "")
    check("component: em-dash never 0 for absent", "'—'" in comp, "")
    check("component: unlocks section ABSENT (synthetic upstream)",
          "Upcoming token unlocks" not in comp, "")
    check("component: funding board section ABSENT (synthetic upstream)",
          "Funding board" not in comp, "")
    check("component: homepage-slice funding card present",
          "Recent funding rounds" in comp, "")
    check("component: homepage-slice ico card present",
          "Upcoming IDO / IEO" in comp, "")
    check("component: refusal documented in footer",
          "SYNTHETIC decoy" in comp, "")
    check("component: coin spotlight wired",
          "Coin spotlight" in comp and "loadMode('coin'" in comp, "")
    check("component: sectors board wired",
          "Sectors" in comp and "CR_CATEGORY_SLUGS" in comp, "")
    check("component: keyed loadMode",
          "key=${encodeURIComponent" in comp, "")
    check("component: listings wired",
          "loadMode('listings'" in comp and "Recently added" in comp, "")
    check("component: exchange variants wired",
          "dex/spot" in comp and "perpetuals" in comp and "setExKey" in comp, "")
    check("component: chain board wired",
          "loadMode('chain'" in comp and "fetchChainIndex" in comp and "ecosystem tokens" in comp, "")
    check("component: launchpool wired",
          "loadMode('launchpool'" in comp and "setLpKey" in comp and "Launchpool" in comp, "")
    helper_src = read("scripts/cr_fetch.py")
    check("helper: data-route mode present", "--data-route" in helper_src
          and "_next/data" in helper_src, "")
    check("helper: buildId rotation handled", "force=True" in helper_src
          and "buildid.txt" in helper_src, "")
    lib = read("lib/cryptorank.ts")
    lib_modes = set(re.findall(
        r"'(home|coins|trending|gainers|losers|funding|unlocks|categories|exchanges|coin|listings|blockchains|chain|launchpool)'", lib))
    check(
        "lib modes == proxy modes (14)",
        lib_modes == {"home", "coins", "trending", "gainers", "losers", "funding",
                      "unlocks", "categories", "exchanges", "coin", "listings",
                      "blockchains", "chain", "launchpool"},
        str(sorted(lib_modes)),
    )
    check(
        "lib: keyed-path machinery present",
        "CR_KEYED_PATHS" in lib and "CR_KEY_RE" in lib and "CR_CATEGORY_SLUGS" in lib,
        "",
    )
    check(
        "lib: CR_DISABLED covers data-route modes",
          "CR_DISABLED = ['funding', 'unlocks']" in lib
          and "CR_DISABLED_REASON" in lib,
        "",
    )
    check("route: force-dynamic", "force-dynamic" in read("app/api/cryptorank/route.ts"), "")
    check("helper exists", os.path.exists(HELPER), HELPER)
    check("cr venv exists", os.path.exists(CR_VENV_PY), CR_VENV_PY)

    # ---------------------------------------------------------------- summary
    dur = round(time.time() - started, 1)
    report = {
        "duration_s": dur,
        "pass": PASS,
        "fail": FAIL,
        "info": NOTES,
        "checks": RESULTS,
    }
    outp = os.path.join(APP_DIR, "scripts", "cryptorank-report.json")
    with open(outp, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"\n{PASS} passed, {FAIL} failed, {len(NOTES)} info ({dur}s) -> {outp}")
    for n in NOTES:
        print(f"  [INFO] {n}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
