#!/usr/bin/env python3
"""
cr_fetch.py -- fetch a cryptorank.io page and emit its __NEXT_DATA__ as JSON.

Why this exists: cryptorank.io's own API host (api.cryptorank.io/v0/*) serves a
Cloudflare managed challenge to every non-browser client (stock curl, curl_cffi
chrome131, headful Chrome, Camoufox, WARP -- all measured 2026-09-27), and a
subset of pages (/funding-rounds, /ico*, /token-unlock, /funds*, /insights...)
is additionally walled to EVERY client including real browsers mid-session.

What does work (measured): curl_cffi chrome131 against the MARKET pages returns
200 with the full Next.js SSR payload in <script id="__NEXT_DATA__">. That SSR
JSON is the same data their frontend hydrates from -- so this helper is the
fetch layer for fudcourt's /api/cryptorank route.

Usage:
    cr_fetch.py --path /all-coins-list [--ttl 60]

Output: ONE JSON object on stdout:
    {"ok": true,  "path": ..., "status": 200, "pageProps": {...},
     "fetchedAt": 1790000000, "cache": "MISS"|"HIT"}
    {"ok": false, "path": ..., "error": ..., "status": 403}

Exit codes: 0 ok, 2 usage, 3 upstream non-200, 4 no __NEXT_DATA__, 5 path not allowed.

Caching: per-path file under ~/.cache/crfetch/ with TTL (default 60s). One
process per call, so the file cache IS the cache. Worst-case upstream politeness:
one hit per path per TTL window.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import NoReturn

# Allowlist -- the route only ever passes one of these; defense in depth.
ALLOWED = {
    "/",
    "/all-coins-list",
    "/trending",
    "/gainers",
    "/losers",
}

CACHE_DIR = os.path.expanduser("~/.cache/crfetch")
ND_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json"[^>]*>(.*?)</script>', re.S
)
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)


def emit(obj: dict, code: int) -> NoReturn:
    print(json.dumps(obj, default=str))
    sys.exit(code)


def cache_file(path: str) -> str:
    slug = path.strip("/").replace("/", "_") or "root"
    return os.path.join(CACHE_DIR, f"{slug}.json")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", required=True)
    ap.add_argument("--ttl", type=int, default=60)
    args = ap.parse_args()

    if args.path not in ALLOWED:
        emit({"ok": False, "path": args.path, "error": "path not allowed"}, 5)

    os.makedirs(CACHE_DIR, exist_ok=True)
    cf = cache_file(args.path)

    # Fresh disk cache? -> HIT, no network.
    try:
        st = os.stat(cf)
        if time.time() - st.st_mtime < args.ttl:
            data = json.load(open(cf))
            data["cache"] = "HIT"
            emit(data, 0)
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    from curl_cffi import requests  # import AFTER cache check: keep HITs cheap

    url = "https://cryptorank.io" + args.path
    try:
        r = requests.get(url, impersonate="chrome131", timeout=30,
                         headers={"Accept": "text/html", "Accept-Language": "en-US,en;q=0.9"})
    except Exception as e:  # network/timeout -- report, never invent
        emit({"ok": False, "path": args.path, "error": f"fetch failed: {type(e).__name__}: {e}"}, 3)

    if r.status_code != 200:
        emit({"ok": False, "path": args.path, "status": r.status_code,
              "error": f"upstream HTTP {r.status_code} (Cloudflare wall)"}, 3)

    m = ND_RE.search(r.text)
    if not m:
        emit({"ok": False, "path": args.path, "status": 200,
              "error": "page has no __NEXT_DATA__ (unexpected layout)"}, 4)

    try:
        nd = json.loads(m.group(1))
        page_props = nd.get("props", {}).get("pageProps", {})
    except json.JSONDecodeError as e:
        emit({"ok": False, "path": args.path, "error": f"__NEXT_DATA__ parse error: {e}"}, 4)

    out = {
        "ok": True,
        "path": args.path,
        "status": 200,
        "pageProps": page_props,
        "fetchedAt": int(time.time()),
        "cache": "MISS",
        "htmlBytes": len(r.text),
    }
    # Atomic write so concurrent callers never read a half-file.
    tmp = cf + ".tmp"
    json.dump(out, open(tmp, "w"), default=str)
    os.replace(tmp, cf)
    emit(out, 0)


if __name__ == "__main__":
    main()
