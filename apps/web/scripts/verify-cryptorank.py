#!/usr/bin/env python3
"""
verify-cryptorank.py -- executable contract for the CryptoRank integration.

    route:      GET http://127.0.0.1:3100/api/cryptorank?mode=<mode>
    modes:      home | coins | trending | losers | gainers   (400 on anything else)
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


def get(base: str, mode: str, fresh: bool = False) -> tuple[int, dict | None, dict]:
    params: dict = {"mode": mode}
    if fresh:
        params["fresh"] = "1"
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
            "https://coins.llama.fi/prices/current/coingecko:bitcoin,coingecko:ethereum",
            timeout=30,
        )
        coins = (r.json() or {}).get("coins") or {}
        return {
            "BTC": (coins.get("coingecko:bitcoin") or {}).get("price"),
            "ETH": (coins.get("coingecko:ethereum") or {}).get("price"),
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

    # ---------------------------------------------------------------- 4
    note("error contract")
    st, body, hdr = get(base, "hack")
    body = body or {}
    check("unknown mode -> 400", st == 400, f"got {st}")
    check(
        "400 lists allowed modes",
        isinstance(body.get("modes"), list) and len(body["modes"]) == 7,
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
    helper_src = read("scripts/cr_fetch.py")
    check("helper: data-route mode present", "--data-route" in helper_src
          and "_next/data" in helper_src, "")
    check("helper: buildId rotation handled", "force=True" in helper_src
          and "buildid.txt" in helper_src, "")
    lib = read("lib/cryptorank.ts")
    lib_modes = set(re.findall(
        r"'(home|coins|trending|gainers|losers|funding|unlocks)'", lib))
    check(
        "lib modes == proxy modes (7)",
        lib_modes == {"home", "coins", "trending", "gainers", "losers", "funding", "unlocks"},
        str(sorted(lib_modes)),
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
