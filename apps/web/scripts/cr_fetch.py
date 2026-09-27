#!/usr/bin/env python3
"""
cr_fetch.py -- fetch cryptorank.io content and emit its __NEXT_DATA__ payload
as JSON, for two kinds of routes:

  --path /all-coins-list          HTML pages (market surface; the page itself)
  --data-route /funding-rounds    Next.js DATA routes: /_next/data/<buildId><p>.json
  --data-route /ico/<key>         per-ICO detail (regex-allowlisted)

Why both exist (measured 2026-09-27):
  - api.cryptorank.io/v0/* serves a Cloudflare managed challenge to every
    non-browser client tried (stock curl, curl_cffi chrome131, headful Chrome,
    Camoufox, WARP -- all measured) -> their JSON API is unusable.
  - The MARKET pages return 200 via curl_cffi with the full Next.js SSR
    payload in <script id="__NEXT_DATA__"> (mode: --path).
  - The FUNDRAISING tree (/funding-rounds, /token-unlock, /ico*, /funds*)
    403s as HTML to EVERY client, and their data routes
    /_next/data/<buildId>/....json answer 200 -- but with SYNTHETIC decoy
    payloads (measured 2026-09-27: nonexistent slugs also return 200 with
    fabricated content, prices 30% off ground truth, template-generated
    names). The API REFUSES those modes (lib CR_DISABLED); --data-route is
    kept ONLY so verify-cryptorank.py can detect when upstream stops
    fabricating (re-enable gate: nonexistent slug must 404).
  - buildId rotates on deploys: resolved from the homepage, refreshed
    automatically once on any 404.
  - KNOWN TRAP: a STALE buildId can still get 200 from edge caches serving
    ancient snapshots (measured: BTC prices from months ago). This helper
    refreshes hourly + on 404; always cross-check prices against an
    independent source (harness ground-truth check does).

Usage:
    cr_fetch.py --path /all-coins-list [--ttl 60]
    cr_fetch.py --path /price/bitcoin [--ttl 60]        (keyed, regex-allowlisted)
    cr_fetch.py --data-route /funding-rounds [--ttl 60]  (detector only)

Output: ONE JSON object on stdout:
    {"ok": true,  "path": ..., "status": 200, "pageProps": {...},
     "fetchedAt": 1790000000, "cache": "MISS"|"HIT", "route": "html"|"data"}
    {"ok": false, "path": ..., "error": ..., "status": 403}

Exit codes: 0 ok, 2 usage, 3 upstream non-200, 4 no __NEXT_DATA__/pageProps,
            5 route not allowed.

Caching: per-route file under ~/.cache/crfetch/ with TTL (default 60s). One
process per call, so the file cache IS the cache. Worst-case upstream
politeness: one hit per route per TTL window.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import NoReturn

# HTML-page allowlist -- the route only ever passes one of these; defense in depth.
# The keyed families (price/categories) are regex-allowlisted: their HTML class
# passed the 3-gate decoy detector (nonexistent slug -> 404, prices within
# 0.002-0.25% of coins.llama.fi, cross-surface agreement) -- unlike the
# /_next/data class, which fabricates (see header).
HTML_ALLOWED = {
    "/",
    "/all-coins-list",
    "/trending",
    "/gainers",
    "/losers",
    "/listings",
    "/blockchains",
    "/exchanges/cex/spot",
    "/exchanges/dex/spot",
    "/exchanges/perpetuals",
    "/exchanges/cex-transparency",
    "/past-launchpool",
    "/upcoming-launchpool",
    "/active-launchpool",
    "/past-nodesale",
    "/upcoming-nodesale",
    "/active-nodesale",
    "/news",
    "/tags",
    "/ecosystems",
    "/rwa",
    "/charts/quarterly-returns",
    "/prediction-markets",
}
HTML_ALLOWED_RE = (
    re.compile(r"^/price/[a-z0-9][a-z0-9-]{0,63}$"),
    re.compile(r"^/categories/[a-z0-9][a-z0-9-]{0,63}$"),
    re.compile(r"^/blockchains/[a-z0-9][a-z0-9-]{0,63}$"),
    re.compile(r"^/tags/[a-z0-9][a-z0-9-]{0,63}$"),
    re.compile(r"^/ecosystems/[a-z0-9][a-z0-9-]{0,63}$"),
    re.compile(r"^/rwa/(bonds|commodities|etfs|stocks)/[a-z0-9][a-z0-9-]{0,63}$"),
)

# Data-route allowlist: exact paths + regex for keyed detail routes.
DATA_ALLOWED_EXACT = {
    "/funding-rounds",
    "/token-unlock",
}
DATA_ALLOWED_RE = (
    re.compile(r"^/ico/[a-z0-9][a-z0-9-]{0,63}$"),
)

CACHE_DIR = os.path.expanduser("~/.cache/crfetch")
BASE = "https://cryptorank.io"
ND_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json"[^>]*>(.*?)</script>', re.S
)
BUILD_RE = re.compile(r'"buildId"\s*:\s*"([0-9a-f]+)"')
BUILDID_TTL = 3600  # refresh the buildId at most hourly (rotates on deploy)


def emit(obj: dict, code: int) -> NoReturn:
    print(json.dumps(obj, default=str))
    sys.exit(code)


def cache_file(slug: str) -> str:
    return os.path.join(CACHE_DIR, f"{slug}.json")


def read_cache(cf: str, ttl: int) -> dict | None:
    try:
        st = os.stat(cf)
        if time.time() - st.st_mtime < ttl:
            data = json.load(open(cf))
            data["cache"] = "HIT"
            return data
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return None


def write_cache(cf: str, obj: dict) -> None:
    # Atomic write so concurrent callers never read a half-file.
    tmp = cf + ".tmp"
    json.dump(obj, open(tmp, "w"), default=str)
    os.replace(tmp, cf)


def resolve_buildid(requests_mod, force: bool = False) -> str:
    """buildId of the current deploy, cached on disk; force refresh on 404."""
    bf = os.path.join(CACHE_DIR, "buildid.txt")
    if not force:
        try:
            st = os.stat(bf)
            if time.time() - st.st_mtime < BUILDID_TTL:
                v = open(bf).read().strip()
                if v:
                    return v
        except FileNotFoundError:
            pass
    r = requests_mod.get(BASE + "/", impersonate="chrome131", timeout=30,
                         headers={"Accept": "text/html"})
    m = BUILD_RE.search(r.text)
    if not m:
        emit({"ok": False, "path": "/", "status": r.status_code,
              "error": "could not resolve buildId from homepage"}, 4)
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = bf + ".tmp"
    open(tmp, "w").write(m.group(1))
    os.replace(tmp, bf)
    return m.group(1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", help="HTML page path (HTML allowlist)")
    ap.add_argument("--data-route", dest="data_route",
                    help="Next.js data route path, e.g. /funding-rounds or /ico/<key>")
    ap.add_argument("--ttl", type=int, default=60)
    args = ap.parse_args()

    if bool(args.path) == bool(args.data_route):
        emit({"ok": False, "error": "exactly one of --path / --data-route required"}, 2)

    if args.path:
        if args.path not in HTML_ALLOWED and not any(
            rx.match(args.path) for rx in HTML_ALLOWED_RE
        ):
            emit({"ok": False, "path": args.path, "error": "path not allowed"}, 5)
        route_kind = "html"
        target = args.path
        slug = args.path.strip("/").replace("/", "_") or "root"
    else:
        p = args.data_route
        if p not in DATA_ALLOWED_EXACT and not any(rx.match(p) for rx in DATA_ALLOWED_RE):
            emit({"ok": False, "path": p, "error": "data route not allowed"}, 5)
        route_kind = "data"
        target = p
        slug = "data_" + p.strip("/").replace("/", "_")

    os.makedirs(CACHE_DIR, exist_ok=True)
    cf = cache_file(slug)

    cached = read_cache(cf, args.ttl)
    if cached:
        emit(cached, 0)

    from curl_cffi import requests  # import AFTER cache check: keep HITs cheap

    def fetch_once(buildid: str | None):
        url = (f"{BASE}/_next/data/{buildid}{target}.json" if route_kind == "data"
               else BASE + target)
        return requests.get(url, impersonate="chrome131", timeout=30,
                            headers={"Accept": "text/html,application/json",
                                     "Accept-Language": "en-US,en;q=0.9"})

    buildid = resolve_buildid(requests) if route_kind == "data" else None
    try:
        r = fetch_once(buildid)
        # buildId rotated (deploy between our cache and now): refresh once.
        if route_kind == "data" and r.status_code == 404:
            r = fetch_once(resolve_buildid(requests, force=True))
    except Exception as e:  # network/timeout -- report, never invent
        emit({"ok": False, "path": target, "route": route_kind,
              "error": f"fetch failed: {type(e).__name__}: {e}"}, 3)

    if r.status_code != 200:
        emit({"ok": False, "path": target, "route": route_kind, "status": r.status_code,
              "error": f"upstream HTTP {r.status_code} (Cloudflare wall or stale route)"}, 3)

    page_props = None
    if route_kind == "html":
        m = ND_RE.search(r.text)
        if not m:
            emit({"ok": False, "path": target, "route": "html", "status": 200,
                  "error": "page has no __NEXT_DATA__ (unexpected layout)"}, 4)
        try:
            page_props = json.loads(m.group(1)).get("props", {}).get("pageProps", {})
        except json.JSONDecodeError as e:
            emit({"ok": False, "path": target, "error": f"__NEXT_DATA__ parse error: {e}"}, 4)
    else:
        try:
            body = r.json()
        except json.JSONDecodeError:
            emit({"ok": False, "path": target, "route": "data", "status": 200,
                  "error": "data route returned non-JSON (layout changed?)"}, 4)
        page_props = (body or {}).get("pageProps")
        if not isinstance(page_props, dict):
            emit({"ok": False, "path": target, "route": "data", "status": 200,
                  "error": "data route JSON has no pageProps"}, 4)

    out = {
        "ok": True,
        "path": target,
        "route": route_kind,
        "status": 200,
        "pageProps": page_props,
        "fetchedAt": int(time.time()),
        "cache": "MISS",
        "htmlBytes": len(r.text),
    }
    write_cache(cf, out)
    emit(out, 0)


if __name__ == "__main__":
    main()
