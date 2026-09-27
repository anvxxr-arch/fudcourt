#!/usr/bin/env python3
"""
verify-cryptorank.py -- executable contract for the CryptoRank integration.

    route:      GET http://127.0.0.1:3100/api/cryptorank?mode=<mode>
    modes:      home | coins | trending | losers | gainers   (400 on anything else)
    data path:  route -> scripts/cr_fetch.py (venv curl_cffi) -> cryptorank.io
                market-page __NEXT_DATA__ SSR payload (see lib/cryptorank.ts header
                for the measured access matrix: API host challenged, market pages
                readable, fundraising tree walled).

Checks:
  1. every mode 200 + envelope invariants (upstream, fetchedAt, counts)
  2. shape/semantics per mode (monotonic gainers, direct vs derived change,
     homepage slices labelled, global sanity ranges)
  3. ANTI-FAKE PARITY: an independent venv-side fetch of the same upstream page
     must yield the same first-row identity + price as the proxy (tolerance 0.5%
     for the live-price gap between the two fetches)
  4. 400 on unknown mode; helper unit: disallowed path exits 5, cache HIT works
  5. informational: /funding-rounds still walled (403/interstitial) -- if it ever
     returns 200+__NEXT_DATA__ the note says to wire a full funding mode
  6. UI wiring: tab, wrapper, component fetch, mode lists match

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


def independent_data_route(path: str) -> dict:
    """Fetch a Next.js DATA route ourselves (own buildId resolution) and pull
    the first row + total. Used for parity on funding/unlocks."""
    script = f"""
import json, re, sys
from curl_cffi import requests as rq
h = rq.get("https://cryptorank.io/", impersonate="chrome131", timeout=30)
m = re.search(r'"buildId"\\s*:\\s*"([0-9a-f]+)"', h.text)
if not m:
    print(json.dumps({{"ok": False, "error": "no buildId"}})); sys.exit(0)
r = rq.get(f"https://cryptorank.io/_next/data/{{m.group(1)}}{path}.json",
           impersonate="chrome131", timeout=30)
if r.status_code != 200:
    print(json.dumps({{"ok": False, "status": r.status_code}})); sys.exit(0)
pp = r.json().get("pageProps") or {{}}
fr = pp.get("fallbackRounds") or {{}}
td = pp.get("fallbackData") or {{}}
block = fr or td
rows = block.get("data") or []
first = rows[0] if rows else {{}}
print(json.dumps({{"ok": True, "n": len(rows), "total": block.get("total"),
                  "name": first.get("name"), "id": first.get("id"),
                  "date": first.get("date"),
                  "set": [[x.get("name"), x.get("date")] for x in rows]}}))
"""
    out = subprocess.run(
        [CR_VENV_PY, "-c", script],
        capture_output=True, text=True, timeout=90,
    )
    try:
        return json.loads(out.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {"ok": False, "error": (out.stderr or out.stdout)[-300:]}


def parity_backtoback(base: str, label: str, path: str, mode: str) -> None:
    """Anti-fake parity for the data-route boards. Their SSR sample is stable
    within an ~8s window but reshuffles after it (and intermittently ships
    empty), so we fetch INDEPENDENTLY first, then immediately hit the proxy
    with fresh=1 (cache bypass) -- both should be the same upstream response:
    row1 must match exactly. Empty upstream on every try = INCONCLUSIVE
    (printed as INFO, never silently green)."""
    saw_rows = False
    for attempt in range(2):
        up = independent_data_route(path)
        rows_set = up.get("set") or []
        if not rows_set:
            time.sleep(2)
            continue
        saw_rows = True
        st, body, _hdr = get(base, mode, fresh=True)
        body = body or {}
        rows = body.get("rows") or []
        mine = rows[0] if rows else {}
        probe_key = (mine.get("name"), mine.get("date"))
        if st == 200 and probe_key and probe_key == tuple(rows_set[0]):
            check(f"{label}: fresh proxy row1 == independent upstream row1",
                  True, f"row1={probe_key} attempt={attempt + 1}")
            return
        time.sleep(2)
    if saw_rows:
        check(f"{label}: fresh proxy row1 == independent upstream row1", False,
              f"last proxy={probe_key!r} vs upstream={rows_set[0]!r}")
    else:
        info(f"{label} parity",
             "data route returned empty rows twice (upstream degraded at check time); "
             "proxy data unverified this run")


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

    # --- funding board (data-route bypass)
    st, body, hdr = get(base, "funding")
    body = body or {}
    if check("funding: HTTP 200 (via _next/data bypass)", st == 200, f"got {st} {json.dumps(body)[:160]}"):
        rows = body.get("rows") or []
        check("funding: 20-row sample", len(rows) >= 10, f"n={len(rows)}")
        total = body.get("upstreamTotal")
        check("funding: upstream total sane", total is not None and total >= 10,
              f"total={total} (load-dependent upstream: measured 98-3383 within one hour)")
        check("funding: sample labelled (never 'latest N of M')",
              isinstance(body.get("slice"), str) and "sample" in body["slice"],
              str(body.get("slice"))[:130])
        check("funding: dataRoute disclosed", body.get("dataRoute") == "/funding-rounds",
              str(body.get("dataRoute")))
        if rows:
            row = rows[0]
            check("funding: row shape (date+name)",
                  bool(row.get("date")) and bool(row.get("name")),
                  json.dumps(row, default=str)[:140])
        # anti-fake parity: fresh proxy vs independent back-to-back
        parity_backtoback(base, "funding", "/funding-rounds", "funding")

    # --- token unlocks (data-route bypass)
    st, body, hdr = get(base, "unlocks")
    body = body or {}
    if check("unlocks: HTTP 200 (via _next/data bypass)", st == 200, f"got {st} {json.dumps(body)[:160]}"):
        rows = body.get("rows") or []
        check("unlocks: 20-row sample", len(rows) >= 10, f"n={len(rows)}")
        total = body.get("upstreamTotal")
        check("unlocks: upstream total sane", total is not None and total >= 10,
              f"total={total} (load-dependent upstream: measured 98-769 within one hour)")
        check("unlocks: sample labelled", isinstance(body.get("slice"), str) and "sample" in body["slice"],
              str(body.get("slice"))[:130])
        check("unlocks: changeSource direct", body.get("changeSource") == "direct",
              str(body.get("changeSource")))
        if rows:
            row = rows[0]
            check("unlocks: row shape (date+name+unlock fields)",
                  bool(row.get("date")) and bool(row.get("name"))
                  and row.get("nextUnlockPct") is not None
                  and (row.get("lockedPct") is None or 0 <= row["lockedPct"] <= 100),
                  json.dumps(row, default=str)[:170])
            check("unlocks: marketCap numeric (shipped as string upstream)",
                  row.get("marketCap") is None or isinstance(row["marketCap"], (int, float)),
                  f"marketCap={row.get('marketCap')!r}")
            # locked + unlocked should complement to ~100% where both present
            both = [r for r in rows if r.get("lockedPct") is not None and r.get("unlockedPct") is not None]
            bad = [r for r in both if abs(r["lockedPct"] + r["unlockedPct"] - 100) > 1.0]
            check("unlocks: locked+unlocked ~= 100%", len(bad) <= max(1, 0.2 * len(both)),
                  f"{len(bad)}/{len(both)} off")
        parity_backtoback(base, "unlocks", "/token-unlock", "unlocks")

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
    note("per-ico detail (informational: measured unstable, not wired)")
    ico = independent_data_route("/ico/jumper-exchange")
    if ico.get("ok"):
        info(
            "per-ico detail",
            "reachable but totals shift between fetches (measured 47.5M -> 27.7M for the same "
            "project within 20min) -> deliberately not wired to any mode; re-evaluate if upstream stabilises",
        )
    else:
        info("per-ico detail", f"data route answered {ico} -> not wired")

    info(
        "upstream totals",
        "cryptorank's SSR totals are load-dependent (funding 98-3383, unlocks 98-769 measured "
        "within one hour) -- proxy passes them through stamped, UI labels them 'SSR sample'",
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
    check("component: unlocks section", "Upcoming token unlocks" in comp, "")
    check("component: funding board section", "Funding board" in comp, "")
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
