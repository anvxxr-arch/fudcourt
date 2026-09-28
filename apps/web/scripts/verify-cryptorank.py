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
     must yield the same first-row identity + price as the proxy (tolerance 0.1%
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

from difflib import SequenceMatcher

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
    last: tuple[int, dict | None, dict] = (0, None, {})
    for attempt in range(3):
        try:
            r = requests.get(f"{base}/api/cryptorank", params=params, timeout=120)
        except Exception as e:  # noqa: BLE001
            return 0, None, {"error": f"{type(e).__name__}: {e}"}
        try:
            body = r.json()
        except Exception:  # noqa: BLE001
            body = None
        # Transient CF rate-limit surfaces as our loud 502 passthrough
        # ("upstream HTTP 429"): back off and retry the SAME request — a gate
        # may only fail on data, never on a burst wall.
        if r.status_code == 502 and body and "429" in str(body.get("error", "")):
            last = (r.status_code, body, dict(r.headers))
            time.sleep(5 * (attempt + 1))
            continue
        return r.status_code, body, dict(r.headers)
    return last


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


_TRUTH = {"at": 0.0, "data": {}}


def truth_fresh(max_age: float = 20.0) -> dict:
    """R-7 interleaved truth fetch. The old harness snapshotted llama once and
    reused the same dict across minutes of run -> time-skew false fails (once
    "fixed" by widening bounds, which hides real drift). Now every comparison
    re-reads the snapshot, refetched whenever it is older than max_age seconds,
    so truth is bracketed to the subject fetch. The proxy's own cache age
    (cr_fetch TTL 60s) remains the only skew component, bounded by design."""
    now = time.monotonic()
    if not _TRUTH["data"] or now - _TRUTH["at"] > max_age:
        _TRUTH["data"] = ground_truth_prices()
        _TRUTH["at"] = now
    return _TRUTH["data"]


def llama_top_dexs(n: int = 20) -> list[str]:
    """Independent DEX 24h-volume ranking (DefiLlama, no key) -> GATE3 for the
    proxy's DEX board top venue. The old check hard-asserted 'uniswap is #1',
    which is a world-state claim: volume rotates (measured 2026-09-28, CR top =
    pancakeswap-v3-bsc while uniswap led earlier). Ranking membership is the
    falsifiable claim; a fabricated venue matches no llama name."""
    try:
        r = requests.get(
            "https://api.llama.fi/overview/dexs"
            "?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true",
            timeout=30,
        )
        ps = [p for p in (r.json().get("protocols") or [])
              if isinstance(p.get("total24h"), (int, float))]
        ps.sort(key=lambda p: -p["total24h"])
        return [str(p.get("name") or "") for p in ps[:n]]
    except Exception:  # noqa: BLE001
        return []


_ETH_MOVE = {"at": 0.0, "pct": None}


def eth_recent_move_pct(max_age: float = 300.0) -> float | None:
    """Realized |1h| move of ETH in percent, from llama's hourly series (no key).

    Why this exists: the ecosystem detail page ships a CR-side price snapshot
    whose age is not exposed. Compared against a LIVE price the gap is constant
    within a single run but varies across runs (measured 2026-09-28:
    0.467% -> 1.17% -> 1.33%), so any fixed bound is a coin flip on a volatile
    minute. The band scales with the market's ACTUAL 1h movement instead;
    fabrication (measured >=5% off) is still caught, because a fabricated price
    does not track the market at all. Returns None when unfetchable.
    """
    now = time.monotonic()
    if _ETH_MOVE["pct"] is not None and now - _ETH_MOVE["at"] <= max_age:
        return _ETH_MOVE["pct"]
    pct = None
    try:
        t = int(time.time())
        r = requests.get(
            f"https://coins.llama.fi/chart/coingecko:ethereum?start={t - 7200}&span=7200",
            timeout=30,
        )
        pts = (r.json().get("coins", {}).get("coingecko:ethereum", {}) or {}).get("prices") or []
        if len(pts) >= 2:
            a, b = float(pts[0]["price"]), float(pts[-1]["price"])
            if a > 0:
                pct = abs(b - a) / a * 100
    except Exception:  # noqa: BLE001
        pct = None
    _ETH_MOVE["pct"], _ETH_MOVE["at"] = pct, now
    return pct


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
    res: dict = {"ok": False, "error": "no output"}
    for attempt in range(3):
        out = subprocess.run(
            [CR_VENV_PY, "-c", script],
            capture_output=True, text=True, timeout=90,
        )
        try:
            res = json.loads(out.stdout.strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            res = {"ok": False, "error": (out.stderr or out.stdout)[-300:]}
        # transient CF burst wall -> back off, retry the SAME fetch (a gate
        # may only fail on data, never on a rate-limit hiccup)
        if res.get("status") == 429:
            time.sleep(5 * (attempt + 1))
            continue
        return res
    return res


def fetch_publisher_title(url: str) -> dict:
    """Fetch a publisher page in the cr venv (system python has no curl_cffi;
    same subprocess pattern as data_route_probe / independent_upstream_page)
    and return its normalized <title> for ground-truth comparison."""
    script = f"""
import json, re, sys
from curl_cffi import requests as rq
try:
    r = rq.get({url!r}, impersonate="chrome131", timeout=25)
except Exception as e:
    print(json.dumps({{"ok": False, "error": type(e).__name__ + ": " + str(e)}})); sys.exit(0)
m = re.search(r"<title[^>]*>(.*?)</title>", r.text, re.S | re.I)
t = " ".join((m.group(1) if m else "").split()).lower()
print(json.dumps({{"ok": True, "status": r.status_code, "title": t}}))
"""
    out = subprocess.run(
        [CR_VENV_PY, "-c", script],
        capture_output=True, text=True, timeout=60,
    )
    try:
        return json.loads(out.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {"ok": False, "error": (out.stderr or out.stdout)[-300:]}


def fetch_oembed(video_id: str) -> dict:
    """YouTube oembed in the cr venv (media GATE3: the platform itself must
    echo the exact title + channel we ship for that video id)."""
    script = f"""
import json, sys
from curl_cffi import requests as rq
try:
    r = rq.get("https://www.youtube.com/oembed",
               params={{"url": "https://www.youtube.com/watch?v={video_id}", "format": "json"}},
               impersonate="chrome131", timeout=25)
except Exception as e:
    print(json.dumps({{"ok": False, "error": type(e).__name__ + ": " + str(e)}})); sys.exit(0)
if r.status_code != 200:
    print(json.dumps({{"ok": False, "status": r.status_code}})); sys.exit(0)
d = r.json()
print(json.dumps({{"ok": True, "title": d.get("title"), "author": d.get("author_name")}}))
"""
    out = subprocess.run(
        [CR_VENV_PY, "-c", script],
        capture_output=True, text=True, timeout=60,
    )
    try:
        return json.loads(out.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {"ok": False, "error": (out.stderr or out.stdout)[-300:]}


def fetch_cg_global() -> dict:
    """CoinGecko global totals in the cr venv (aioverview GATE3: independent
    aggregator sanity band for the market-cap figure in the digest)."""
    script = """
import json, sys
from curl_cffi import requests as rq
try:
    r = rq.get("https://api.coingecko.com/api/v3/global", impersonate="chrome131", timeout=25)
except Exception as e:
    print(json.dumps({"ok": False, "error": type(e).__name__ + ": " + str(e)})); sys.exit(0)
if r.status_code != 200:
    print(json.dumps({"ok": False, "status": r.status_code})); sys.exit(0)
d = r.json().get("data") or {}
print(json.dumps({"ok": True,
                  "mcap": (d.get("total_market_cap") or {}).get("usd"),
                  "dom": d.get("market_cap_percentage")}))
"""
    out = subprocess.run(
        [CR_VENV_PY, "-c", script],
        capture_output=True, text=True, timeout=60,
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
    gt = truth_fresh()  # R-7 interleave
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
        # R-7 interleave: refetch the subject WITHOUT cache so proxy scrape and
        # independent scrape bracket each other within seconds (was: minutes-old
        # snapshot vs live fetch -> time-skew false fails)
        st_c, coins_f, _ = get(base, "coins", fresh=True)
        coins = (coins_f or {}).get("rows") or coins
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
                    "parity: BTC price matches live upstream (<=0.1%)",
                    # R-7 re-audit 2026-09-28: interleaved fresh subject vs
                    # independent scrape of the SAME source = 0.0000% (n=4).
                    # 0.1% keeps 100x headroom vs measurement while catching
                    # any non-shared-source number (decoy class).
                    diff <= 0.1,
                    f"proxy={mine['priceUsd']} upstream={up['price']} diff={diff:.3f}%",
                )

    # ------------------------------------------- 3b HTML board modes (gated)
    note("HTML board modes: categories / exchanges / coin (3-gate verified)")

    truth = truth_fresh()  # R-7 interleave
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
        eth_t = truth_fresh().get("ETH")  # R-7 interleave
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
        btc_t = truth_fresh().get("BTC")  # R-7 interleave
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
        eth_t = truth_fresh().get("ETH")  # R-7 interleave
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
        _norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())  # noqa: E731
        top_key = (rows[0].get("key") or "") if rows else ""
        _tops = llama_top_dexs()
        _nt = _norm(top_key)
        _hit = next(
            (t for t in _tops if _nt and (_norm(t).startswith(_nt[:10]) or _nt.startswith(_norm(t)[:10]))),
            None,
        )
        # CR lists chain-scoped deployments (e.g. 'uniswap-robinhood') that the
        # llama overview does not break out by chain; the brand token must
        # still exist in llama's independent list -- a fabricated venue has no
        # family anywhere -> still FAIL.
        _fam_tok = _norm((top_key or "").split("-")[0])
        _family = next((t for t in _tops if _fam_tok and len(_fam_tok) >= 4 and _fam_tok in _norm(t)), None)
        check(
            "exchanges?dex: top venue (or its brand) in independent llama top-20 (GATE3)",
            bool(_nt) and (_hit is not None or _family is not None),
            f"top={top_key} llama_hit={_hit} family={_family} n_llama={len(_tops)}",
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
        btc_t = truth_fresh().get("BTC")  # R-7 interleave
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
            t = truth_fresh().get(sym)  # R-7 interleave
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

    # --- news feed (3-gate: 404 / price parity / publisher <title> match)
    up = independent_upstream_page("/news/zzznoexist9999")
    check("news: nonexistent slug -> 404 (independent fetch)",
          up.get("status") == 404, str(up)[:120])

    st, body, hdr = get(base, "news")
    body = body or {}
    if check("news: HTTP 200", st == 200, f"got {st}"):
        rows = body.get("newsRows") or []
        check("news: full page of rows", len(rows) >= 8, f"n={len(rows)}")
        check(
            "news: titles + publisher URLs intact",
            all(r.get("title") and str(r.get("url", "")).startswith("http") for r in rows),
            str([(r.get("title"), r.get("url")) for r in rows[:2]])[:180],
        )
        week_ago = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 7 * 86400))
        dates = [r["date"][:10] for r in rows if isinstance(r.get("date"), str)]
        check(
            "news: dates ISO, newest within 7 days",
            bool(dates) and all(len(d) == 10 for d in dates) and max(dates) >= week_ago,
            f"newest={max(dates) if dates else None}",
        )
        check(
            "news: sentiment tags only bullish/bearish/null",
            all(r.get("status") in ("bullish", "bearish", None) for r in rows),
            str(sorted({str(r.get("status")) for r in rows})),
        )
        check(
            "news: ?page= no-op labelled in slice",
            "?page" in (body.get("slice") or ""),
            str(body.get("slice"))[:170],
        )
        truth = truth_fresh()  # R-7 interleave
        # GATE2: relatedCoins snapshot vs llama, mapped by truth-keyed symbol
        rc = [
            c for r in rows for c in (r.get("relatedCoins") or [])
            if c.get("symbol") in truth and isinstance(c.get("priceUsd"), (int, float))
        ]
        if rc:
            c0 = rc[0]
            t = truth[c0["symbol"]]
            diff = abs(c0["priceUsd"] - t) / t * 100
            check("news: relatedCoin price matches ground truth (<=3%)",
                  diff <= 3,
                  f"{c0['symbol']} mine={c0['priceUsd']} truth={t} diff={diff:.3f}%")
        else:
            info("news: relatedCoin price gate",
                 "no truth-keyed coin in this batch -> price gate skipped this run")

        # GATE3: the publisher's own <title> must match the row we ship
        norm = lambda s: re.sub(r"\s+", " ", s or "").strip().lower()  # noqa: E731
        matched = False
        last_err = ""
        # publisher rows rotate live; some publishers sit behind CF -> widen
        # the candidate pool (the title-match requirement itself is unchanged)
        cands = [x for x in rows if x.get("url") and "cryptorank" not in str(x.get("url"))][:6]
        for r0 in cands:
            res = fetch_publisher_title(r0["url"])
            if not res.get("ok"):
                last_err = str(res)[:140]
                continue
            pub = norm(res.get("title") or "")
            mine = norm(r0.get("title"))
            # CR rotates editorial prefixes ('Crypto-friendly institution ...')
            # -> prefix-50 alone flakes; require EITHER a shared 50-char head
            # OR a >=40-char common run (a fabricated title shares <10).
            _lcs = (SequenceMatcher(None, pub, mine)
                    .find_longest_match(0, len(pub), 0, len(mine)).size) if pub and mine else 0
            if pub and (pub[:50] == mine[:50] or pub.startswith(mine[:50])
                        or mine.startswith(pub[:50]) or _lcs >= 40):
                matched = True
                last_err = f"matched: {str(r0.get('url'))[:90]}"
                break
            last_err = f"status={res.get('status')} pub={pub[:60]!r} vs {mine[:60]!r}"
        check("news: publisher <title> matches shipped row (ground truth)",
              matched, last_err or "no candidate rows")

    # --- tags index + keyed tag detail (3-gate: 404 / price parity / cross-surface)
    st, body, hdr = get(base, "tags")
    body = body or {}
    if check("tags: HTTP 200", st == 200, f"got {st}"):
        trows = body.get("tagRows") or []
        check("tags: >=180 tag rows", len(trows) >= 180, f"n={len(trows)}")
        check(
            "tags: slugs well-formed",
            all(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", t.get("slug") or "")
                for t in trows[:60]),
            str([t.get("slug") for t in trows[:5]]),
        )
        l1 = next((t for t in trows if t.get("slug") == "layer-1"), None)
        check(
            "tags: layer-1 row with mcap + avgPriceChange24h",
            bool(l1) and isinstance(l1.get("marketCap"), (int, float))
            and isinstance(l1.get("change24h"), (int, float)),
            json.dumps(l1)[:170] if l1 else "missing layer-1",
        )

    st, body, hdr = get(base, "tag")
    body = body or {}
    if check("tag: HTTP 200 (default layer-1)", st == 200, f"got {st}"):
        ti = body.get("tag") or {}
        check(
            "tag: meta echoes key",
            ti.get("slug") == "layer-1" and bool(ti.get("name")),
            json.dumps(ti)[:150],
        )
        rows_t = body.get("rows") or []
        check("tag: >=100 coin rows", len(rows_t) >= 100, f"n={len(rows_t)}")
        check(
            "tag: changeSource unavailable (measured 0/N ship chg upstream)",
            body.get("changeSource") == "unavailable",
            str(body.get("changeSource")),
        )
        bt = next((r for r in rows_t if r.get("symbol") == "BTC"), None)
        t_btc = truth_fresh().get("BTC")  # R-7 interleave
        if bt and t_btc and bt.get("priceUsd"):
            d = abs(bt["priceUsd"] - t_btc) / t_btc * 100
            check("tag: BTC matches independent ground truth (<=3%)",
                  d <= 3, f"mine={bt['priceUsd']} truth={t_btc} diff={d:.3f}%")
        else:
            check("tag: BTC row for ground truth", False,
                  f"row={bt and bt.get('priceUsd')} truth={t_btc}")
        check(
            "tag: slice labels breadth + chg absence",
            "gainers" in (body.get("slice") or "")
            and "never faked" in (body.get("slice") or ""),
            str(body.get("slice"))[:170],
        )

    st, body, hdr = get(base, "tag", key="zzznoexist9999")
    check("tag: unknown slug -> 404 (upstream passthrough)", st == 404, f"got {st}")

    st, body, hdr = get(base, "tag", key="BAD SLUG")
    check("tag: malformed key -> 400 (never clamped)", st == 400, f"got {st}")

    # --- node sales (3-gate: 404 / cross-surface keys / Fuse GATE3 date)
    st, body, hdr = get(base, "nodesale")
    body = body or {}
    if check("nodesale: HTTP 200 (default past)", st == 200, f"got {st}"):
        ndrows = body.get("nodesaleRows") or []
        check(
            "nodesale: past rows + honest of-N (upstreamTotal > count)",
            len(ndrows) >= 10
            and isinstance(body.get("upstreamTotal"), int)
            and (body.get("upstreamTotal") or 0) > len(ndrows),
            f"n={len(ndrows)} total={body.get('upstreamTotal')}",
        )
        check(
            "nodesale: row schema (node price range + windows)",
            all("nodePriceFromUsd" in r0 and "when" in r0 for r0 in ndrows[:5]),
            json.dumps(ndrows[0])[:150] if ndrows else "no rows",
        )
        check(
            "nodesale: cross-surface key (MST Blockchain == /price/mst-blockchain)",
            any(r0.get("key") == "mst-blockchain" and r0.get("name") == "MST Blockchain"
                for r0 in ndrows),
            "mst-blockchain row missing",
        )
    st, body, hdr = get(base, "nodesale", key="active")
    body = body or {}
    if check("nodesale?active: HTTP 200", st == 200, f"got {st}"):
        nda = body.get("nodesaleRows") or []
        check("nodesale?active: rows present", len(nda) >= 1, f"n={len(nda)}")
    st, body, hdr = get(base, "nodesale", key="zzz")
    check("nodesale: bad variant -> 400 (never clamped)", st == 400, f"got {st}")

    # launchpool ACTIVE window: every row must contain today
    st, body, hdr = get(base, "launchpool", key="active")
    body = body or {}
    if check("launchpool?active: HTTP 200", st == 200, f"got {st}"):
        lpa = body.get("launchpoolRows") or []
        today = time.strftime("%Y-%m-%d")
        okw = sum(
            1 for rw in lpa
            if rw.get("when") and rw.get("till")
            and str(rw["when"])[:10] <= today <= str(rw["till"])[:10]
        )
        check(
            "launchpool?active: every window contains now",
            len(lpa) >= 1 and okw == len(lpa),
            f"{okw}/{len(lpa)} today={today}",
        )

    # exchange reserve-transparency variant (volume columns absent -> null)
    st, body, hdr = get(base, "exchanges", key="cex-transparency")
    body = body or {}
    if check("exchanges?transparency: HTTP 200", st == 200, f"got {st}"):
        trs = body.get("rows") or []
        check(
            "exchanges?transparency: >=10 rows, all with reported reserves",
            len(trs) >= 10
            and all(isinstance(r0.get("reservesUsd"), (int, float)) for r0 in trs),
            f"n={len(trs)} reserves={[r0.get('reservesUsd') for r0 in trs[:4]]}",
        )
        check(
            "exchanges?transparency: volume null (absent upstream, never 0)",
            all(r0.get("dayVolUsd") is None for r0 in trs),
            str([r0.get("dayVolUsd") for r0 in trs[:6]]),
        )
        check(
            "exchanges?transparency: slice flags non-attestation",
            "not an independent attestation" in (body.get("slice") or "").lower(),
            str(body.get("slice"))[:170],
        )

    # --- ecosystems index + keyed detail (GATE1 404 / GATE2 price parity)
    st, body, hdr = get(base, "ecosystems")
    body = body or {}
    if check("ecosystems: HTTP 200", st == 200, f"got {st}"):
        eor = body.get("ecosystemRows") or []
        check(
            "ecosystems: rows + honest of-N",
            len(eor) >= 10 and (body.get("upstreamTotal") or 0) > len(eor),
            f"n={len(eor)} total={body.get('upstreamTotal')}",
        )
        eth_row = next((x for x in eor if x.get("key") == "ethereum"), None)
        check(
            "ecosystems: ethereum row w/ mcap + tvl",
            bool(eth_row)
            and isinstance(eth_row.get("marketCapUsd"), (int, float))
            and isinstance(eth_row.get("tvlUsd"), (int, float)),
            json.dumps(eth_row)[:150] if eth_row else "missing",
        )
    st, body, hdr = get(base, "ecosystem", fresh=True)  # R-7: subject bracketed to truth
    body = body or {}
    if check("ecosystem: HTTP 200 (default ethereum)", st == 200, f"got {st}"):
        eco_info = body.get("ecosystem") or {}
        coin = eco_info.get("coin") or {}
        t_eth = truth_fresh().get("ETH")  # R-7 interleave
        if coin.get("priceUsd") and t_eth:
            d = abs(coin["priceUsd"] - t_eth) / t_eth * 100
            # R-7 re-audit 2026-09-28 (n=4 interleaved, constant within a run):
            # the gap is a CR price SNAPSHOT vs a live quote -> it scales with
            # market movement (0.467% calm -> 1.33% moving), never with fetch
            # skew. Fixed 1% was a coin flip. Band = |ETH 1h move| + 0.75pp,
            # floored at 1% (calm markets stay tight) and capped at 4% -- below
            # the measured >=5% fabrication class, so detection power holds.
            mv = eth_recent_move_pct()
            band = max(1.0, min(4.0, (mv if mv is not None else 1.0) + 0.75))
            check("ecosystem: native coin price matches ground truth (volatility band, cap 4%)",
                  d <= band,
                  f"mine={coin['priceUsd']} truth={t_eth} diff={d:.4f}% band={band:.2f}% "
                  f"eth1h_move={('n/a' if mv is None else f'{mv:.2f}%')}")
        else:
            check("ecosystem: native coin price for ground truth", False,
                  f"coin={coin} truth={t_eth}")
        check(
            "ecosystem: coins + changeSource unavailable (no price upstream)",
            len(body.get("rows") or []) >= 10
            and body.get("changeSource") == "unavailable",
            f"rows={len(body.get('rows') or [])} src={body.get('changeSource')}",
        )
    st, body, hdr = get(base, "ecosystem", key="zzznoexist9999")
    check("ecosystem: unknown slug -> 404 passthrough", st == 404, f"got {st}")
    st, body, hdr = get(base, "ecosystem", key="BAD SLUG")
    check("ecosystem: malformed key -> 400 (never clamped)", st == 400, f"got {st}")

    # --- rwa index + keyed type/slug detail
    st, body, hdr = get(base, "rwa")
    body = body or {}
    if check("rwa: HTTP 200", st == 200, f"got {st}"):
        rwr = body.get("rwaRows") or []
        check(
            "rwa: rows + honest of-N",
            len(rwr) >= 10 and (body.get("upstreamTotal") or 0) > len(rwr),
            f"n={len(rwr)} total={body.get('upstreamTotal')}",
        )
        gold = next((x for x in rwr if x.get("detailKey") == "commodities/gold"), None)
        check(
            "rwa: gold row w/ plural detailKey + price",
            bool(gold) and isinstance(gold.get("priceUsd"), (int, float))
            and gold.get("priceUsd", 0) > 1000,
            json.dumps(gold)[:150] if gold else "missing gold",
        )
    st, body, hdr = get(base, "rwaasset")
    body = body or {}
    if check("rwaasset: HTTP 200 (default stocks/wendy-s)", st == 200, f"got {st}"):
        ra = body.get("rwaAsset") or {}
        check(
            "rwaasset: price + quote timestamp + exchange metadata",
            isinstance(ra.get("priceUsd"), (int, float))
            and bool(ra.get("quoteUpdatedAt"))
            and bool(ra.get("exchange")),
            json.dumps(ra)[:170],
        )
    st, body, hdr = get(base, "rwaasset", key="commodities/gold")
    body = body or {}
    if check("rwaasset?commodities/gold: HTTP 200", st == 200, f"got {st}"):
        check("rwaasset: gold commodity type echoes key",
              (body.get("rwaAsset") or {}).get("type") == "commodity",
              str((body.get("rwaAsset") or {}).get("type")))
    st, body, hdr = get(base, "rwaasset", key="stocks/zzznoexist9999")
    check("rwaasset: unknown slug -> 404 passthrough", st == 404, f"got {st}")
    st, body, hdr = get(base, "rwaasset", key="zzz/wendy-s")
    check("rwaasset: bad type prefix -> 400 (never clamped)", st == 400, f"got {st}")

    # --- quarterly returns (in-progress quarter vs live ground truth)
    st, body, hdr = get(base, "quarterly")
    body = body or {}
    if check("quarterly: HTTP 200", st == 200, f"got {st}"):
        qb = body.get("quarterlyBtc") or []
        qe = body.get("quarterlyEth") or []
        check("quarterly: BTC >=15 years + ETH >=10 years",
              len(qb) >= 15 and len(qe) >= 10, f"btc={len(qb)} eth={len(qe)}")
        y26 = next((y for y in qb if y.get("year") == 2026), None)
        q3 = (y26 or {}).get("q3") or {}
        t_btc = truth_fresh().get("BTC")  # R-7 interleave
        if q3.get("closeUsd") and t_btc:
            d = abs(q3["closeUsd"] - t_btc) / t_btc * 100
            check("quarterly: in-progress Q3 close near live BTC (<=3%)",
                  d <= 3, f"mine={q3['closeUsd']} truth={t_btc} diff={d:.3f}%")
        else:
            check("quarterly: 2026 Q3 close present", False, str(q3))
        q2 = (y26 or {}).get("q2") or {}
        if q2.get("closeUsd") and q3.get("openUsd"):
            d = abs(q3["openUsd"] - q2["closeUsd"]) / q2["closeUsd"] * 100
            check("quarterly: Q2 close ~ Q3 open (roll continuity <1%)",
                  d < 1, f"q2close={q2['closeUsd']} q3open={q3['openUsd']} diff={d:.3f}%")

    # --- prediction markets (internal coherence + honest window label)
    st, body, hdr = get(base, "prediction")
    body = body or {}
    if check("prediction: HTTP 200", st == 200, f"got {st}"):
        pa = body.get("prediction") or {}
        prow = body.get("predictionRows") or []
        check("prediction: markets table rows w/ external links",
              len(prow) >= 10
              and all(r0.get("externalUrl") for r0 in prow[:10]),
              f"n={len(prow)}")
        check(
            "prediction: row volume24h present (explicit 24h)",
            all(isinstance(r0.get("volume24hUsd"), (int, float)) for r0 in prow[:10]),
            str([r0.get("volume24hUsd") for r0 in prow[:5]]),
        )
        plats = pa.get("platforms") or []
        s_vol = sum(p0.get("volumeUsd") or 0 for p0 in plats)
        check(
            "prediction: platform volumes sum == upstream total (coherent)",
            pa.get("totalVolumeUsd") is not None
            and abs(s_vol - pa["totalVolumeUsd"]) < 2,
            f"sum={s_vol} total={pa.get('totalVolumeUsd')}",
        )
        check(
            "prediction: slice discloses undisclosed window",
            "window NOT disclosed" in (body.get("slice") or ""),
            str(body.get("slice"))[:170],
        )

    # --- converter (full price list: the only no-key surface with ALL coins)
    st, body, hdr = get(base, "converter")
    body = body or {}
    if check("converter: HTTP 200", st == 200, f"got {st}"):
        crw = body.get("converterRows") or []
        check("converter: full coverage (>=4900 rows)", len(crw) >= 4900, f"n={len(crw)}")
        cb = next((r0 for r0 in crw if r0.get("key") == "bitcoin"), None)
        t_btc = truth_fresh().get("BTC")  # R-7 interleave
        if cb and isinstance(cb.get("priceUsd"), (int, float)) and t_btc:
            d = abs(cb["priceUsd"] - t_btc) / t_btc * 100
            check("converter: BTC price matches ground truth (<=3%)",
                  d <= 3, f"mine={cb['priceUsd']} truth={t_btc} diff={d:.4f}%")
        else:
            check("converter: BTC price matches ground truth (<=3%)",
                  False, f"row={cb} truth={t_btc}")
        check("converter: sampled prices strictly positive",
              all(isinstance(r0.get("priceUsd"), (int, float)) and r0["priceUsd"] > 0
                  for r0 in crw[:300]),
              f"bad={sum(1 for r0 in crw[:300] if not (isinstance(r0.get('priceUsd'), (int, float)) and r0['priceUsd'] > 0))}")
        check("converter: no fake 24h (changeSource unavailable)",
              body.get("changeSource") == "unavailable",
              str(body.get("changeSource")))

    # --- media (GATE3 = YouTube oembed echoes our title+channel per video id)
    st, body, hdr = get(base, "media")
    body = body or {}
    if check("media: HTTP 200", st == 200, f"got {st}"):
        mrows = body.get("mediaRows") or []
        check("media: 10 rows of 468 (SSR page-1 slice)",
              len(mrows) == 10 and body.get("upstreamTotal") == 468,
              f"n={len(mrows)} total={body.get('upstreamTotal')}")
        check("media: YouTube-shaped ids",
              all(re.fullmatch(r"[A-Za-z0-9_-]{6,20}", r0.get("id") or "") for r0 in mrows),
              str([r0.get("id") for r0 in mrows[:4]]))
        check("media: slice discloses oembed ground truth",
              "oembed" in (body.get("slice") or ""), str(body.get("slice"))[:170])
        oem_ok, oem_last = False, ""
        for m0 in mrows[:3]:
            res = fetch_oembed(m0["id"])
            if not res.get("ok"):
                oem_last = str(res)[:140]
                continue
            tt = (res.get("title") or "").lower()
            mine = (m0.get("title") or "").lower()
            auth = (res.get("author") or "").lower()
            chan = (m0.get("channelTitle") or "").lower()
            if (tt[:40] == mine[:40] or tt.startswith(mine[:40]) or mine.startswith(tt[:40])) \
                    and auth == chan:
                oem_ok, oem_last = True, f"{m0['id']}: {res.get('title')[:70]!r} / {res.get('author')!r}"
                break
            oem_last = f"{m0['id']}: pub={res.get('title')[:50]!r} vs {mine[:50]!r}"
        check("media: YouTube oembed title+channel match (ground truth)",
              oem_ok, oem_last)

    # --- newstag (soft-404 -> local 404; GATE2 price; GATE3 publisher title)
    st, body, hdr = get(base, "newstag", key="defi")
    body = body or {}
    if check("newstag: HTTP 200 (default defi)", st == 200, f"got {st}"):
        nti = body.get("tag") or {}
        check("newstag: tag meta echoes key",
              nti.get("slug") == "defi" and bool(nti.get("name")),
              json.dumps(nti)[:150])
        nrows = body.get("newsRows") or []
        check("newstag: filtered rows shipped", 1 <= len(nrows) <= 8, f"n={len(nrows)}")
        check("newstag: related-tag chips for navigation",
              len(body.get("relatedTags") or []) >= 10,
              f"n={len(body.get('relatedTags') or [])}")
        check("newstag: slice discloses 404 derivation",
              "404" in (body.get("slice") or ""),
              str(body.get("slice"))[:170])
        # filter actually varies: ids must NOT equal the general feed
        st2, body2, _ = get(base, "news")
        gen_ids = {r0.get("id") for r0 in ((body2 or {}).get("newsRows") or [])
                   if r0.get("id")}
        tag_ids = {r0.get("id") for r0 in nrows if r0.get("id")}
        check("newstag: feed differs from general news (real filter)",
              bool(tag_ids) and tag_ids != gen_ids,
              f"overlap={len(tag_ids & gen_ids)}/{len(tag_ids)}")
        truth = truth_fresh()  # R-7 interleave
        # GATE2: relatedCoins snapshot vs llama
        rc = [
            c for r0 in nrows for c in (r0.get("relatedCoins") or [])
            if c.get("symbol") in truth and isinstance(c.get("priceUsd"), (int, float))
        ]
        if rc:
            c0 = rc[0]
            t = truth[c0["symbol"]]
            d = abs(c0["priceUsd"] - t) / t * 100
            check("newstag: relatedCoin price matches ground truth (<=3%)",
                  d <= 3, f"{c0['symbol']} mine={c0['priceUsd']} truth={t} diff={d:.3f}%")
        else:
            info("newstag: relatedCoin price gate",
                 "no truth-keyed coin in this batch -> price gate skipped this run")
        # GATE3: publisher <title> of a shipped article (same pool as news)
        norm = lambda s: re.sub(r"\s+", " ", s or "").strip().lower()  # noqa: E731
        matched, last_err = False, ""
        cands = [x for x in nrows if x.get("url") and "cryptorank" not in str(x.get("url"))][:6]
        for r0 in cands:
            res = fetch_publisher_title(r0["url"])
            if not res.get("ok"):
                last_err = str(res)[:140]
                continue
            pub = norm(res.get("title") or "")
            mine = norm(r0.get("title"))
            # CR rotates editorial prefixes ('Crypto-friendly institution ...')
            # -> prefix-50 alone flakes; require EITHER a shared 50-char head
            # OR a >=40-char common run (a fabricated title shares <10).
            _lcs = (SequenceMatcher(None, pub, mine)
                    .find_longest_match(0, len(pub), 0, len(mine)).size) if pub and mine else 0
            if pub and (pub[:50] == mine[:50] or pub.startswith(mine[:50])
                        or mine.startswith(pub[:50]) or _lcs >= 40):
                matched, last_err = True, f"matched: {str(r0.get('url'))[:90]}"
                break
            last_err = f"status={res.get('status')} pub={pub[:60]!r} vs {mine[:60]!r}"
        check("newstag: publisher <title> matches shipped row (ground truth)",
              matched, last_err or "no candidate rows")
    st, body, hdr = get(base, "newstag", key="zzznoexist9999")
    check("newstag: unknown slug -> 404 (soft-404 derived, not unfiltered)",
          st == 404 and "tag:null" in str((body or {}).get("error")),
          f"got {st} {str((body or {}).get('error'))[:90]}")
    st, body, hdr = get(base, "newstag", key="BAD KEY")
    check("newstag: malformed key -> 400", st == 400, f"got {st}")

    # --- aioverview (cross-surface coherence vs home + CoinGecko sanity band)
    st, body, hdr = get(base, "aioverview")
    body = body or {}
    if check("aioverview: HTTP 200", st == 200, f"got {st}"):
        ov = body.get("aiOverview") or {}
        mkt = ov.get("market") or {}
        check("aioverview: market summary + timestamp shipped",
              bool(mkt.get("summary")) and bool(mkt.get("updatedAt")),
              json.dumps(mkt)[:150])
        check("aioverview: structured slices shipped",
              len(ov.get("news") or []) >= 1
              and len((ov.get("funding") or {}).get("rounds") or []) >= 1
              and len((ov.get("vesting") or {}).get("unlocks") or []) >= 1,
              f"news={len(ov.get('news') or [])}")
        check("aioverview: slice labels digest as upstream's own words",
              "their words" in (body.get("slice") or ""),
              str(body.get("slice"))[:170])
        txt = mkt.get("summary") or ""
        # upstream digest template rotates ('to $N' -> 'stands at N', no $,
        # U+2011 hyphens) -> anchor on the nouns, not on punctuation
        _mm = re.search(r"market cap[^0-9]{0,40}?([\d][\d,]{6,})", txt)
        _mv = re.search(r"volume[^0-9]{0,60}?([\d][\d,]{6,})", txt)
        m = [_mm.group(1), _mv.group(1)] if _mm and _mv else []
        g = (home or {}).get("global") or {}
        if len(m) >= 2 and g.get("totalMarketCap"):
            ai_mcap, ai_vol = int(m[0].replace(",", "")), int(m[1].replace(",", ""))
            dm = abs(ai_mcap - g["totalMarketCap"]) / g["totalMarketCap"] * 100
            check("aioverview: digest mcap coherent with home global (<=1%)",
                  dm <= 1, f"ai={ai_mcap} home={g['totalMarketCap']} diff={dm:.4f}%")
            if g.get("totalVolume24h"):
                dv = abs(ai_vol - g["totalVolume24h"]) / g["totalVolume24h"] * 100
                # The digest is a TIMESTAMPED snapshot (updatedAt, shipped by
                # upstream); home global is live. Measured 2026-09-28:
                # digest 34.997B @06:00 vs live 39.64B @11:05 = 11.71% over
                # 4.25h (~2.75%/h volume churn). Band = 5% + 3.5%/h of digest
                # age: tight for a fresh digest, still far below fabrication
                # magnitude (decoy class sat 5-15% systematically off), and the
                # independent CoinGecko band below covers magnitude always.
                age_h = 0.0
                try:
                    from datetime import datetime, timezone
                    _ts = str(mkt.get("updatedAt") or "").replace("Z", "+00:00")
                    age_h = max(0.0, (datetime.now(timezone.utc)
                                      - datetime.fromisoformat(_ts)).total_seconds() / 3600)
                except Exception:  # noqa: BLE001
                    age_h = 0.0  # unparseable stamp -> old strict 5% band
                _band = 5.0 + 3.5 * age_h
                check("aioverview: digest volume coherent with home (age-scaled band)",
                      dv <= _band,
                      f"ai={ai_vol} home={g['totalVolume24h']} diff={dv:.4f}% "
                      f"age_h={age_h:.2f} band={_band:.1f}%")
        else:
            check("aioverview: digest mcap+volume parsed", False, txt[:150])
        md = re.search(r"dominance[^0-9]{0,40}(-?[\d.]+)", txt)
        if md and g.get("btcDominance"):
            ai_dom = float(md.group(1))
            dd = abs(ai_dom - g["btcDominance"]) / g["btcDominance"] * 100
            check("aioverview: digest dominance coherent with home (<=1%)",
                  dd <= 1, f"ai={ai_dom} home={g['btcDominance']} diff={dd:.4f}%")
        else:
            check("aioverview: digest dominance coherent with home (<=1%)",
                  False, f"parsed={md.group(1) if md else None}")
        # GATE3: CoinGecko independent total-cap band (methodology diverges;
        # measured 3.55% at wire time -> 5% band, disclosed)
        cg = fetch_cg_global()
        if cg.get("ok") and cg.get("mcap") and len(m) >= 1:
            ai_mcap = int(m[0].replace(",", ""))
            dcg = abs(ai_mcap - cg["mcap"]) / cg["mcap"] * 100
            check("aioverview: CoinGecko total-cap sanity band (<=5%)",
                  dcg <= 5, f"ai={ai_mcap} cg={cg['mcap']} diff={dcg:.3f}%")
        else:
            check("aioverview: CoinGecko total-cap sanity band (<=5%)",
                  False, str(cg)[:140])

    info("avg-roi-by-sector: REJECTED (not wired)",
         "page ships only per-sector ICO/IEO/IDO aggregates (n=146, last 12m) with NO "
         "constituents disclosed -> no falsifiable claim path; offering-type filter is "
         "broken upstream (?type=ico/ieo/ido -> 500, ?offeringType ignored byte-identical); "
         "kept out of CR_MODES (unknown mode -> 400), same class as /ath and /performance")

    # ---------------------------------------------------------------- 4
    note("error contract")
    st, body, hdr = get(base, "hack")
    body = body or {}
    check("unknown mode -> 400", st == 400, f"got {st}")
    check(
        "400 lists allowed modes",
        isinstance(body.get("modes"), list) and len(body["modes"]) == 28,
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
    check("component: nodesale wired",
          "loadMode('nodesale'" in comp and "setNdKey" in comp and "Nodesale" in comp
          and "nodesaleRows" in comp, "")
    check("component: exchanges transparency variant wired",
          "cex-transparency" in comp and "reservesUsd" in comp
          and "Reserves" in comp, "")
    check("component: launchpool active toggle wired",
          "'active', 'Active'" in comp, "")
    check("component: ecosystems wired",
          "loadMode('ecosystems'" in comp and "loadMode('ecosystem'" in comp
          and "setEcoSlug" in comp and "Ecosystem" in comp, "")
    check("component: rwa wired",
          "loadMode('rwa'" in comp and "loadMode('rwaasset'" in comp
          and "setRwaKey" in comp and "RWA" in comp, "")
    check("component: quarterly wired",
          "loadMode('quarterly'" in comp and "setQtrSide" in comp
          and "Quarterly returns" in comp and "quarterlyBtc" in comp, "")
    check("component: prediction wired",
          "loadMode('prediction'" in comp and "Prediction markets" in comp
          and "predictionRows" in comp, "")
    check("component: news feed wired",
          "loadMode('news'" in comp and "Latest news" in comp and "newsRows" in comp, "")
    check("component: tag board wired",
          "loadMode('tag'" in comp and "fetchTagIndex" in comp and "tagRows" in comp, "")
    check("component: converter board wired",
          "loadMode('converter'" in comp and "converterRows" in comp
          and "Full price list" in comp, "")
    check("component: media board wired",
          "loadMode('media'" in comp and "mediaRows" in comp
          and "Media feed" in comp, "")
    check("component: tagged news wired",
          "loadMode('newstag'" in comp and "relatedTags" in comp
          and "Tagged news" in comp, "")
    check("component: ai overview wired",
          "loadMode('aioverview'" in comp and "aiOverview" in comp
          and "AI market overview" in comp, "")
    helper_src = read("scripts/cr_fetch.py")
    check("helper: data-route mode present", "--data-route" in helper_src
          and "_next/data" in helper_src, "")
    check("helper: buildId rotation handled", "force=True" in helper_src
          and "buildid.txt" in helper_src, "")
    lib = read("lib/cryptorank.ts")
    lib_modes = set(re.findall(
        r"'(home|coins|trending|gainers|losers|funding|unlocks|categories|exchanges|coin|listings|blockchains|chain|launchpool|nodesale|news|tags|tag|ecosystems|ecosystem|rwa|rwaasset|quarterly|prediction|converter|media|newstag|aioverview)'", lib))
    check(
        "lib modes == proxy modes (28)",
        lib_modes == {"home", "coins", "trending", "gainers", "losers", "funding",
                      "unlocks", "categories", "exchanges", "coin", "listings",
                      "blockchains", "chain", "launchpool", "nodesale", "news",
                      "tags", "tag", "ecosystems", "ecosystem", "rwa", "rwaasset",
                      "quarterly", "prediction", "converter", "media", "newstag",
                      "aioverview"},
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
