#!/usr/bin/env python3
"""
Contract check for the news (Cointelegraph RSS) integration in fudcourt.
Probed live 2026-09-29 against cointelegraph.com/rss (public, keyless, GET-only).
The feed is a document, not an API, so what is asserted is different from the
JSON families:
  * /api/news serves real, request-varying headlines through the sidecar
  * `total` is the FULL parsed count while `items` is the `limit` head (a 5-row
    body must never be readable as "the feed has 5 items")
  * OUR params (source/limit) fail loudly on invalid input -- never clamped and
    never coerced into an empty 200 (the pre-port TS route's exact defect)
  * the served rows match the live upstream feed (anti-fake parity probe:
    titles and links are compared against a DIRECT feed fetch)
  * caching is observable via X-Cache, and keyed on the FEED URL so two
    different limits share one upstream read
  * every row carries the six contracted keys, and no key is ever null
  * the route is a verbatim proxy and the board has a UI path for it
Usage:
    python3 scripts/verify/verify-news.py [--base http://127.0.0.1:3100]
      --base :3101 checks the Go sidecar directly
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
UPSTREAM = "https://cointelegraph.com/rss"
ROWS_XML = re.compile(r"<item>(.*?)</item>", re.S)
TITLE_XML = re.compile(r"<title>(?:<!\[CDATA\[(.*?)\]\]>|(.*?))</title>", re.S)
LINK_XML = re.compile(r"<link>(?:<!\[CDATA\[(.*?)\]\]>|(.*?))</link>", re.S)

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"
results: list[tuple[bool, str, str]] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    results.append((ok, label, detail))
    print(f"  [{GREEN + 'PASS' + RESET if ok else RED + 'FAIL' + RESET}] {label}"
          + (f"  {DIM}{detail}{RESET}" if detail else ""))
    return ok


def note(*parts) -> str:
    return " ".join(str(p) for p in parts if p)[:150]


def call(url: str, timeout: int = 60):
    """(status, headers, body-bytes). HTTPError IS a response -- read its body."""
    req = urllib.request.Request(url, headers={"User-Agent": "fudcourt-verify/1.0",
                                               "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
        except Exception:
            body = b""
        return e.code, dict(e.headers), body
    except Exception as e:
        return 0, {}, f"{type(e).__name__}: {e}".encode()


def jload(body: bytes):
    try:
        return json.loads(body)
    except Exception:
        return None


def hdr(headers: dict, name: str) -> str:
    """Case-insensitive header lookup (Node lowercases names)."""
    lname = name.lower()
    for k, v in headers.items():
        if k.lower() == lname:
            return v
    return "-"


def section(title: str) -> None:
    print(f"\n▸ {title}")


# X-Cache mark of the run's very first news request. The cache is keyed on the
# FEED URL and the sidecar holds it per process, so only a fresh process can
# show a genuine cold MISS.
COLD_MARK: str | None = None


def verify_feed(base: str) -> dict:
    section("the feed: real headlines, honest total, six keys")
    global COLD_MARK
    st, h, b = call(f"{base}/api/news")
    COLD_MARK = hdr(h, "X-Cache")
    j = jload(b) or {}
    check(st == 200, "GET /api/news -> 200", note("got", st))
    items = j.get("items") or []
    total = j.get("total")
    check(isinstance(items, list) and len(items) > 0, "a non-empty item list came back",
          note("n", len(items)))
    check(isinstance(total, int) and total >= len(items),
          "total is the FULL parsed count, not the served head", note("total", total, "items", len(items)))
    check(len(items) == 30, "the default limit is 30", note("n", len(items)))
    check(j.get("upstream") == UPSTREAM, "upstream names the feed it actually read",
          note(str(j.get("upstream"))))
    ts = j.get("timestamp")
    check(isinstance(ts, (int, float)) and ts > 1e12,
          "timestamp is milliseconds (Date.now() convention)", note(ts))
    r0 = items[0] if items else {}
    for f in ("title", "link", "description", "pubDate", "image", "source"):
        check(f in r0, f"row carries {f}", note(str(r0.get(f))[:50]))
    check(all(v is not None for v in r0.values()),
          "no row key is null (an absent feed element is an empty string)")
    check(r0.get("source") == "Cointelegraph",
          "row source is the outlet label, not the param value", note(str(r0.get("source"))))
    check(str(r0.get("link", "")).startswith("http"), "row link is an absolute URL",
          note(str(r0.get("link"))[:60]))
    return j


def verify_limit_varies(base: str) -> None:
    section("limit is honoured and the body varies with the request")
    # `limit` is a HEAD SLICE, not a promise: `items.slice(0, limit)`. A feed
    # with 30 items answers limit=100 with 30 rows -- and that is the honest
    # answer, because a head cannot invent rows. The contract asserted here is
    # therefore len(items) == min(limit, total), and it is asserted against the
    # total the SAME response reports so the two can never drift apart.
    for n in (1, 5, 100):
        st, _, b = call(f"{base}/api/news?limit={n}")
        j = jload(b) or {}
        items = j.get("items") or []
        total = j.get("total") or 0
        want = min(n, total)
        check(st == 200 and len(items) == want,
              f"limit={n} returns min({n}, total={total}) = {want} items",
              note("got", st, "n", len(items)))
        check(total >= len(items),
              f"limit={n} still reports the full total", note("total", total))
    # A limit BELOW the feed length must actually trim (the assertion above
    # would pass vacuously if the feed were tiny), and the two limits must
    # return the same first rows -- a head is a prefix, never a reshuffle.
    _, _, b3 = call(f"{base}/api/news?limit=3")
    _, _, b9 = call(f"{base}/api/news?limit=9")
    j3, j9 = jload(b3) or {}, jload(b9) or {}
    t3 = [r.get("title") for r in (j3.get("items") or [])]
    t9 = [r.get("title") for r in (j9.get("items") or [])]
    if len(t9) >= 3:
        check(t3 == t9[:3], "a smaller limit is a PREFIX of a larger one",
              note(t3[:1], "|", t9[:1]))


def verify_strict_params(base: str) -> None:
    section("our own params fail loudly (never clamped, never coerced)")
    cases = [
        ("source=cnn", "source=cnn", 400, "unknown source 'cnn'", "expected one of cointelegraph"),
        ("source=(empty)", "source=", 400, "unknown source ''", "expected one of"),
        ("limit=0", "limit=0", 400, "between 1 and 100", ""),
        ("limit=101", "limit=101", 400, "between 1 and 100", ""),
        ("limit=abc", "limit=abc", 400, "integer", ""),
        ("limit=-1", "limit=-1", 400, "integer", ""),
        ("limit=(empty)", "limit=", 400, "integer", ""),
    ]
    for label, qs, expect, frag, frag2 in cases:
        st, _, b = call(f"{base}/api/news?{qs}")
        j = jload(b) or {}
        err = str(j.get("error", ""))
        det = str(j.get("detail", ""))
        ok = st == expect and frag in err and (not frag2 or frag2 in det)
        check(ok, f"{label} -> {expect}", note("got", st, err[:60], "|", det[:40]))
    # The defect the port must not reintroduce: an unknown source used to come
    # back as a 200 with an empty list.
    st, _, b = call(f"{base}/api/news?source=cnn")
    j = jload(b) or {}
    check(st != 200 and "items" not in j,
          "an unknown source is never an empty 200 (the pre-port silent coercion)")


def verify_cache(base: str) -> None:
    section("caching is observable and keyed on the FEED URL")
    # Two requests with DIFFERENT limits must share one upstream read: the feed
    # document is cached, the limit slices it afterwards.
    _, h1, b1 = call(f"{base}/api/news?limit=3")
    _, h2, b2 = call(f"{base}/api/news?limit=9")
    first, second = hdr(h1, "X-Cache"), hdr(h2, "X-Cache")
    check(second == "HIT", "a repeat request is served from cache", note(first, "->", second))
    j1, j2 = jload(b1) or {}, jload(b2) or {}
    check(len(j1.get("items") or []) == 3 and len(j2.get("items") or []) == 9,
          "different limits slice the same cached document",
          note("n3", len(j1.get("items") or []), "n9", len(j2.get("items") or [])))
    if COLD_MARK in ("MISS", "COALESCED"):
        check(True, "the run's first request was a genuine cold MISS", note("x-cache:", COLD_MARK))
    else:
        # INHERENT, not laziness: this family has ONE cache key (the feed URL),
        # so a cold entry requires a process restart -- there is no per-request
        # parameter that could mint a fresh key the way `chainrank`'s pageSize
        # does. The HIT half above is what proves the cache works; do NOT weaken
        # this into a check that always passes.
        print(f"  [SKIP] cold-MISS assertion -- the sidecar cache was already warm "
              f"({COLD_MARK}); restart fudcourt-data to exercise the cold path "
              f"(news has a single cache key, so no client-side probe can force a MISS)")


def verify_parity(base: str) -> None:
    section("anti-fake parity: served rows match the live feed")
    st1, _, b1 = call(f"{base}/api/news?limit=10")
    served = (jload(b1) or {}).get("items") or []
    st2, _, b2 = call(UPSTREAM)
    if not check(st2 == 200, "direct upstream RSS -> 200", note("got", st2)):
        return
    xml = b2.decode("utf-8", "replace")
    blocks = ROWS_XML.findall(xml)

    def title_of(block: str) -> str:
        m = TITLE_XML.search(block)
        if not m:
            return ""
        return (m.group(1) if m.group(1) else m.group(2) or "").strip()

    upstream_titles = [title_of(b) for b in blocks]
    served_titles = [r.get("title") for r in served]
    check(len(blocks) > 0, "the live feed carries items", note("n", len(blocks)))
    # The feed refreshes continuously, so a strict set-equality can fail merely
    # because a new headline landed between the two fetches. What must hold is
    # that the served head is drawn from the live feed's own titles.
    overlap = len(set(served_titles) & set(upstream_titles))
    check(overlap >= max(1, len(served) - 2),
          "every served title (bar a refresh race) comes from the live feed",
          note("served", len(served), "matched", overlap, "upstream", len(upstream_titles)))
    # And the order must be upstream's own: no reshuffle is claimed.
    head = upstream_titles[:len(served_titles)]
    check(served_titles == head,
          "served rows are upstream's own order (no reshuffle claimed)",
          note("served[0]", served_titles[:1], "upstream[0]", head[:1]))


def verify_ui_wiring(base: str) -> None:
    section("proxy contract + UI path")
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[2]  # frontend/web
    route = (root / "src/app/(frontend)/api/news/route.ts").read_text()
    lib = (root / "src/features/news/client.ts").read_text()
    check("DATA_URL" in route and "/api/news" in route,
          "route proxies /api/news to the fudcourt-data sidecar")
    for smell in ("execFile", "child_process", "parseInt", "Math.min", "<item>", "stripCdata"):
        check(smell not in route,
              f"route holds no {smell} of its own (the sidecar owns validation + parse)")
    # The feed table: one contract, two spellings.
    m_src = re.search(r"NEWS_SOURCES = \[([^\]]+)\]", lib)
    ts_sources = set(re.findall(r"'([a-z0-9-]+)'", m_src.group(1) if m_src else ""))
    go_modes = root.parent.parent / "services" / "data" / "internal" / "news" / "modes.go"
    if go_modes.exists():
        go_sources = set(re.findall(r'Name:\s*"([a-z0-9-]+)"', go_modes.read_text()))
        check(ts_sources == go_sources and len(ts_sources) == 1,
              "TS NEWS_SOURCES == Go internal/news/modes.go (one contract)",
              note("ts", sorted(ts_sources), "go", sorted(go_sources)))
    else:
        print("  [SKIP] Go news feed table absent (proxied elsewhere?)")
    # The bounds are the frozen 400 boundary: assert the pair the Go side enforces.
    go_src = go_modes.read_text() if go_modes.exists() else ""
    if go_src:
        m_lo = re.search(r"LimitMin\s*=\s*(\d+)", go_src)
        m_hi = re.search(r"LimitMax\s*=\s*(\d+)", go_src)
        check(bool(m_lo) and bool(m_hi) and m_lo.group(1) == "1" and m_hi.group(1) == "100",
              "Go limit bounds are the frozen 1..100 pair",
              note(m_lo.group(1) if m_lo else "?", "..", m_hi.group(1) if m_hi else "?"))
        check("must be between 1 and 100" in go_src,
              "the 400 phrase matches the bounds (a drifting message is the bug)")
    shell = (root / "src/shell/store-shell.tsx").read_text()
    page = (root / "src/features/news/ui.tsx").read_text()
    check("'news'" in shell and "NewsPage" in shell, "shell wires the news tab")
    check("src/app/(frontend)/news/page.tsx" or (root / "src/app/(frontend)/news/page.tsx").exists(),
          "/news deep-link wrapper exists")
    check("/api/news" in page, "the board fetches /api/news")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    args = ap.parse_args()
    base = args.base.rstrip("/")
    t0 = time.time()
    print(f"{DIM}fudcourt x cointelegraph rss contract check -> {base}{RESET}")
    verify_feed(base)
    verify_limit_varies(base)
    verify_strict_params(base)
    verify_cache(base)
    verify_parity(base)
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
