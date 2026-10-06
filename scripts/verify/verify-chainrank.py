#!/usr/bin/env python3
"""
Contract check for the chainrank.fyi integration in fudcourt.

Every expectation here was measured live against https://www.chainrank.fyi on
2026-09-27 by reverse-engineering its JS bundles (api-surface-recon skill).
The point is drift detection: if chainrank changes a status code, an envelope
field, a pagination clamp, or starts gating a route differently, this exits
non-zero instead of the UI quietly showing wrong numbers.

What "fully connected" means here: every READ endpoint is proxied and verified;
every WRITE endpoint's contract (schema + gates) is asserted WITHOUT firing it,
because each write has a real side effect on someone else's production service
(their click counters, a pending paymentId row, their CDN).

Usage:
    python3 scripts/verify/verify-chainrank.py [--base http://127.0.0.1:3100]

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
UPSTREAM = "https://www.chainrank.fyi"

from verifylib import call, check, hdr, jload
from verifylib import note_join as note, section
from verifylib import GREEN, RED, DIM, RESET
results: list[tuple[bool, str, str]] = []


def verify_reads(base: str) -> None:
    section("local proxy serves both read endpoints with real data")

    st, h, b = call(f"{base}/api/chainrank?mode=stats")
    stats = jload(b) or {}
    check(st == 200, "GET stats -> 200", note("got", st))
    check(stats.get("kind") == "stats", "stats payload is tagged kind=stats",
          note(str(stats.get("kind"))))
    for f in ("online", "totalClicks", "listings", "totalUsdCents", "topUsdCents", "claimTopCents"):
        check(isinstance(stats.get(f), (int, float)), f"stats.{f} is a number",
              note(type(stats.get(f)).__name__, stats.get(f)))
    check("upstream" in stats and "chainrank.fyi" in str(stats.get("upstream")),
          "stats names its real upstream", note(str(stats.get("upstream"))[:70]))

    st, h, b = call(f"{base}/api/chainrank?mode=listings&page=1&pageSize=5")
    board = jload(b) or {}
    check(st == 200, "GET listings -> 200", note("got", st))
    check(board.get("kind") == "listings", "listings payload is tagged kind=listings",
          note(str(board.get("kind"))))
    check(isinstance(board.get("rows"), list), "envelope has a rows array",
          note("rows", type(board.get("rows")).__name__))
    for f in ("page", "pageSize", "total", "totalPages"):
        check(isinstance(board.get(f), int), f"envelope.{f} is an int",
              note(board.get(f)))


def verify_row_shape(base: str) -> None:
    section("board rows carry the measured fields")

    st, h, b = call(f"{base}/api/chainrank?mode=listings")
    board = jload(b) or {}
    rows = board.get("rows") or []
    if not check(len(rows) > 0, "the live board has at least one row", note("n", len(rows))):
        return
    r = rows[0]
    for f in ("id", "key", "kind", "url", "title", "totalUsdCents", "clicks", "rank"):
        check(f in r, f"row has {f}", note(str(r.get(f))[:60]))
    check(isinstance(r.get("rank"), int) and r["rank"] >= 1, "rank is a 1-based int",
          note(r.get("rank")))
    check(isinstance(r.get("totalUsdCents"), int), "raised amount is in cents (int)",
          note(r.get("totalUsdCents")))

    # Request-varied = a real surface, not a canned body (skill rule).
    st2, _, b2 = call(f"{base}/api/chainrank?mode=listings&pageSize=1")
    b2j = jload(b2) or {}
    check(b2j.get("pageSize") == 1 and len(b2j.get("rows") or []) <= 1,
          "pageSize is honoured: the body varies with the request",
          note("echo pageSize", b2j.get("pageSize")))


def verify_pagination_relay(base: str) -> None:
    """The proxy must relay upstream's OWN clamping, not invent its own.

    Measured upstream: page=0/-1/'abc' -> page=1; pageSize=0 -> 50;
    pageSize=1000 -> 200 (cap). Our rule: no local clamping ever, so these
    bodies must equal what upstream answers."""
    section("pagination is relayed, never re-clamped locally")

    cases = [
        ("page=0", "page", 1),
        ("page=-1", "page", 1),
        ("page=abc", "page", 1),
        ("pageSize=0", "pageSize", 50),
        ("pageSize=1000", "pageSize", 200),
    ]
    for q, field, expect in cases:
        st, _, b = call(f"{base}/api/chainrank?mode=listings&{q}")
        j = jload(b) or {}
        check(st == 200 and j.get(field) == expect,
              f"{q} -> {field}={expect} (upstream's own answer, relayed)",
              note("got", j.get(field), "st", st))


def verify_gates(base: str) -> None:
    """Gate matrix against upstream itself (skill: probe each route separately,
    read the ERROR CODE -- a 200 on one route says nothing about another).

    Only VALIDATION probes are fired: bodies that fail schema checks before any
    write happens. We never send a valid click/presence/quote/confirm/upload --
    each would mutate someone else's production data."""
    section("upstream write gates (validation probes only, no side effects)")

    probes = [
        ("POST click {}", "POST", "/api/click", b"{}", 400),
        ("POST click bad id", "POST", "/api/click",
         json.dumps({"listingId": "x", "sessionId": "s"}).encode(), 404),
        ("POST presence {}", "POST", "/api/presence", b"{}", 400),
        ("POST claim/quote {}", "POST", "/api/claim/quote", b"{}", 400),
        ("POST claim/quote bad usdCents", "POST", "/api/claim/quote",
         json.dumps({"target": "zzz", "usdCents": -5}).encode(), 400),
        ("POST claim/confirm {}", "POST", "/api/claim/confirm", b"{}", 400),
        ("POST upload empty form", "POST", "/api/upload",
         b"--x--\r\nContent-Disposition: form-data\r\n\r\n\r\n--x--\r\n", 400),
    ]
    for label, method, path, payload, expect in probes:
        st, _, b = call(UPSTREAM + path, method=method, payload=payload,
                        ctype="multipart/form-data; boundary=x--" if "upload" in path else "application/json")
        j = jload(b) or {}
        err = str(j.get("error", ""))[:60]
        check(st == expect, f"{label} -> {expect}", note("got", st, err))

    section("upstream method gates (wrong verb -> 405)")
    for method, path in (("POST", "/api/stats"), ("POST", "/api/listings"), ("GET", "/api/click")):
        st, _, b = call(UPSTREAM + path, method=method,
                        payload=b"{}" if method == "POST" else None)
        check(st == 405, f"{method} {path} -> 405", note("got", st))


def verify_proxy_honesty(base: str) -> None:
    section("proxy honesty: loud rejections, cache observable")

    st, _, b = call(f"{base}/api/chainrank?mode=bogus")
    j = jload(b) or {}
    check(st == 400 and "unknown mode" in str(j.get("error")),
          "unknown mode -> 400 naming the field", note("got", st, str(j.get("error"))[:50]))

    # A cache probe needs a key NOTHING else in this run has used, or a second
    # back-to-back run inside the 15s TTL would start warm and the cold-MISS half
    # of this assertion would fail for a reason that has nothing to do with the
    # code under test. A unique, still-valid `pageSize` per process gives that:
    # 200 is the upstream cap and every value in 101..200 is accepted as-is, so a
    # tick-derived pageSize stays a legitimate request while being a fresh key.
    probe_size = 101 + (int(time.time()) % 100)
    st, h, b = call(f"{base}/api/chainrank?mode=listings&pageSize={probe_size}")
    first = hdr(h, "X-Cache")
    st2, h2, _ = call(f"{base}/api/chainrank?mode=listings&pageSize={probe_size}")
    second = hdr(h2, "X-Cache")
    check(first in ("MISS", "COALESCED") and second == "HIT",
          "an identical repeat is served from cache (X-Cache)",
          note(f"pageSize={probe_size}", first, "->", second))

    st, _, b = call(f"{base}/api/chainrank")
    j = jload(b) or {}
    check(st == 200 and j.get("kind") == "stats",
          "mode defaults to stats", note("st", st, j.get("kind")))

    st, _, b = call(f"{base}/api/chainrank?mode=listings&page=9999")
    j = jload(b) or {}
    check(st == 200 and (j.get("rows") or []) == [] and j.get("page") == 9999,
          "an out-of-range page relays upstream's empty rows (not faked)",
          note("rows", len(j.get("rows") or []), "page", j.get("page")))


def verify_site(base: str) -> None:
    section("the site itself (routes the board links to)")
    st, _, _ = call(UPSTREAM + "/")
    check(st == 200, "GET / -> 200", note(st))
    st, _, _ = call(UPSTREAM + "/rules")
    check(st == 200, "GET /rules -> 200", note(st))
    st, _, b = call(UPSTREAM + "/robots.txt")
    body = b.decode("utf-8", "replace") if st == 200 else ""
    check(st == 200 and "Disallow: /api/" in body,
          "robots.txt still disallows /api/ (documented, low-volume client)",
          note("st", st))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    args = ap.parse_args()
    base = args.base.rstrip("/")
    t0 = time.time()

    print(f"{DIM}fudcourt x chainrank contract check -> {base}{RESET}")
    verify_reads(base)
    verify_row_shape(base)
    verify_pagination_relay(base)
    verify_proxy_honesty(base)
    verify_gates(base)
    verify_site(base)

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
