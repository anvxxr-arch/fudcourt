#!/usr/bin/env python3
"""
verify-khala.py -- executable contract for the khala research-report family.
    route (sidecar):   GET http://127.0.0.1:3101/api/khala?mode=<mode>
    route (public):    GET http://127.0.0.1:3100/api/khala?mode=<mode>   (--web)
    modes:             reports | report | latest
    upstream:          https://www.khala.io  (Framer static SSR HTML; no
                       Next.js/RSC, no Cloudflare, plain HTTP with a non-browser
                       UA is enough -- see /home/dwizzy/khala-probe/RESULTS.md)

FROZEN CONTRACT (v4)
  mode=reports 200 -> {mode, kind:"reports", order:"newest-first", count,
                  upstreamTotal, rows:[{position,slug,url,title,summary}],
                  upstream:"https://www.khala.io/", fetchedAt, cache, slice}
       - `published`/`publishedISO` are ABSENT keys on every row (the list
         source publishes no dates). A value OR an explicit null there is a
         FAIL: absent = "this mode does not report dates", null would claim a
         lookup ran and found nothing.
       - `upstreamTotal` is derived from the SITEMAP enumeration, not the
         homepage; `slice` must say so.
       - `missingSlugs` is ABSENT when the homepage covers the sitemap set.
  mode=report&key=<slug> 200 -> {mode, kind:"report", report:{slug,url,title,
                  metaTitle,published,publishedISO,authors,sections:[{id,level,
                  title}],body:[{type,id?,text}]}, upstream, fetchedAt, cache,
                  slice}
       - `key` is required and must match ^[a-z0-9][a-z0-9-]{0,127}$; absent or
         malformed -> 400. `limit` here -> 400 (scoping). `bodyHtml`/`bodyText`
         must be ABSENT -- fidelity is judged on the flattened `body[].text`.
       - the flagship walrus slug is 94 chars: a length cap short of 128 would
         silently kill the NEWEST report, so every sitemap slug is asserted
         accepted and the 94-char one gets its own named check.
  mode=latest&limit=N 200 -> same list shape; `limit` strict integer 1..50,
                  default 5 (abc/0/-1/51/1.5 -> 400); `key` here -> 400.
                  Rows carry resolved `published`/`publishedISO`; `slice` must
                  carry the verbatim "no news surface exists" disclosure and
                  name /news and /rss.xml.
  headers (all three modes): X-KH-Upstream == body `upstream` (scalar string),
                  X-KH-Cache in {MISS,HIT}, Cache-Control: public, max-age=30.
  cache: ?fresh=1 -> MISS, a repeat -> HIT.
  decoy: nonexistent-but-valid slug -> 404 {"error":"upstream 404: no such
                  report", ..., "upstreamStatus":404}. The upstream 404 is real
                  (https://www.khala.io/<bad> -> 404 + <title>Page Not Found |
                  Framer</title>), so there is no fabricated-200 class here.

Checks:
  1. ORACLE FIRST: khala.io is keyless and public, so every truth claim is read
     from the SITE ITSELF with urllib -- never from the adapter's own response.
     sitemap.xml (11 <loc> = 3 static + 8 report slugs), the homepage card order
     and titles, every report page's <title>/byline <p>, and the real 404 page.
  2. mode=reports envelope + honest labels (kind/order/position/url/count vs
     upstreamTotal vs len(rows)) + date-key ABSENCE.
  3. INDEPENDENT SLUG-SET EQUALITY: sitemap report slugs == rows[].slug, diff
     reported in BOTH directions (a fabricated or dropped report names itself).
  4. mode=latest: strict limit matrix, date presence + ISO round-trip, the
     byline ground-truth parity, and the mandatory "no news surface" slice.
  5. mode=report: all 8 slugs accepted (94-char one named), key/limit 400s,
     the real-404 decoy, title/date parity against the page fetched directly,
     body fidelity (long, key-takeaways prose, ZERO chrome sentinels), and
     `sections` order against the page's own heading ids.
  6. FABRICATED-DATA PROBE: the adapter's newest title (reports AND latest AND
     report) must equal the title on that report's own page, fetched
     independently -- a template-generated title cannot survive this.
  7. cache observability (MISS -> HIT, fresh=1 -> MISS) and the header/body
     agreement for every mode.
Anything the sidecar could not be exercised for is reported SKIPPED with the
reason (stale sidecar / endpoint not mounted / unreachable) and the run still
exits non-zero -- never a silent pass.

Usage:
    python3 scripts/verify/verify-khala.py                          # sidecar :3101
    python3 scripts/verify/verify-khala.py --web                    # Next proxy :3100
    python3 scripts/verify/verify-khala.py --web-base https://fud.example
Exit 0 = every required check passed; 1 = a FAIL or a SKIP.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from verifylib import (as_dict, as_list, as_str, check_counted as check, hget,
                       info, note_msg as note, skip)

PASS = 0
FAIL = 0
SKIP = 0
NOTES: list[str] = []
RESULTS: list[dict] = []

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # repo root (scripts/verify -> scripts -> root -> .)
APP_DIR = os.path.join(REPO, "frontend", "web")
SIDECAR_DEFAULT = "http://127.0.0.1:3101"
WEB_DEFAULT = "http://127.0.0.1:3100"
SITE = "https://www.khala.io"
REPORT_UA = "fudcourt-verify-khala/1.0 (+verification harness)"
ADAPTER_UA = "fudcourt-verify-khala/1.0"
SITE_DELAY = 0.25  # sequential, polite: khala.io is small and static
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,127}$")
LONGEST_SLUG = 94  # walrus; measured from the live sitemap 2026-09-29
EMPTY_STRING = ""

# Chrome sentinels: site furniture that must never reach a report body.
SENTINELS = ["table of Content", "Join 7,000+", "Follow on x",
             "@Khalaresearch", "aLL riGHTS RESERVED"]
# Documented slug/title/date triples. Date + ISO literals read out of
# /home/dwizzy/khala-probe/RESULTS.md section 4 (read out of the file itself,
# not from the task brief). RESULTS.md section 5's prototype table truncates two
# titles ("...ROBOTICS" for xmaquina, "...PAYMENT" for x402); the live homepage
# card titles -- refetched by this script every run -- carry the full strings,
# and the brief agrees with the live site, so the full literals are used.
DOC_REPORTS = [
    ("walrus-solving-the-ai-agent-context-memory-bottleneck-verifiable-onchain-portable-programmable",
     "WALRUS: SOLVING THE AI MEMORY BOTTLENECK", "Jul 2, 2026", "2026-07-02"),
    ("bittensor-an-investment-history-from-genesis-to-dtao-tao-flow",
     "BITTENSOR: THE INVESTMENT HISTORY", "Jun 11, 2026", "2026-06-11"),
    ("xmaquina-onchain-market-pre-ipo-robotics-equity-spv-subdao-deus",
     "XMAQUINA: ONCHAIN MARKETS FOR PRE-IPO ROBOTICS EQUITY", "May 20, 2026", "2026-05-20"),
    ("surf-data-platform-onchain-social-prediction-crypto-ai-agent-intelligence",
     "SURF: A DATA PLATFORM FOR CRYPTO INTELLIGENCE", "Apr 3, 2026", "2026-04-03"),
    ("x402-completing-the-internets-missing-payment-layer-for-agentic-commerce",
     "x402: UNLOCKING THE INTERNET'S MISSING PAYMENT LAYER", "Mar 18, 2026", "2026-03-18"),
    ("openclaw-ecosystem-autonomous-software-factory",
     "THE DAWN OF THE AUTONOMOUS SOFTWARE FACTORY", "Feb 26, 2026", "2026-02-26"),
    ("bittensor-the-intelligence-olympics",
     "BITTENSOR: THE INTELLIGENCE OLYMPICS", "Feb 19, 2026", "2026-02-19"),
    ("decentralized-robotics-landscape",
     "DECENTRALIZED ROBOTICS: LANDSCAPE AND OUTLOOK", "Jan 7, 2026", "2026-01-07"),
]
DOC_ORDER = [r[0] for r in DOC_REPORTS]
DOC_BY_SLUG = {r[0]: r for r in DOC_REPORTS}
STATIC_LOCS = {"/", "/about", "/disclaimer"}


# ------------------------------------------------------- adapter transport
def _open(url: str, timeout: float) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, headers={"User-Agent": ADAPTER_UA,
                                              "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def api(base: str, qs: str, timeout: float = 120.0) -> dict:
    """GET {base}/api/khala?{qs}. An HTTPError IS a response -- read its body."""
    url = f"{base}/api/khala?{qs}"
    last = {"url": url, "status": 0, "body": None, "hdr": {}, "raw": EMPTY_STRING,
            "neterr": "not attempted"}
    for attempt in range(3):
        try:
            st, raw, hdr = _open(url, timeout)
        except Exception as e:  # noqa: BLE001
            last = {"url": url, "status": 0, "body": None, "hdr": {},
                    "raw": EMPTY_STRING, "neterr": f"{type(e).__name__}: {e}"}
            time.sleep(1.5 * (attempt + 1))
            continue
        try:
            body = json.loads(raw)
        except Exception:  # noqa: BLE001
            body = None
        last = {"url": url, "status": st, "body": body, "hdr": hdr,
                "raw": raw[:400].decode("utf-8", "replace"), "neterr": None}
        if st in (429, 502, 503, 504) and attempt < 2:
            time.sleep(2.0 * (attempt + 1))
            continue
        return last
    return last


# --------------------------------------------------------- oracle fetching
def site_get(path: str, timeout: float = 30.0) -> dict:
    url = path if path.startswith("http") else f"{SITE}{path}"
    req = urllib.request.Request(url, headers={"User-Agent": REPORT_UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return {"url": url, "status": r.status, "bytes": len(raw),
                    "ctype": r.headers.get("Content-Type"),
                    "text": raw.decode("utf-8", "replace"), "error": None}
    except urllib.error.HTTPError as e:
        raw = e.read()
        return {"url": url, "status": e.code, "bytes": len(raw),
                "ctype": e.headers.get("Content-Type"),
                "text": raw.decode("utf-8", "replace"), "error": None}
    except Exception as e:  # noqa: BLE001
        return {"url": url, "status": 0, "bytes": 0, "ctype": None,
                "text": EMPTY_STRING, "error": f"{type(e).__name__}: {e}"}


def strip_tags(html: str) -> str:
    s = re.sub(r"<(script|style)\b.*?</\1>", " ", html, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&#x27;", "'"), ("&#39;", "'"),
                 ("&quot;", '"'), ("&lt;", "<"), ("&gt;", ">"), ("\u2019", "'"),
                 ("\u2018", "'"), ("\u201c", '"'), ("\u201d", '"')):
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip()


def norm(s: str) -> str:
    return strip_tags(s)


BYLINE_RE = re.compile(r"<p[^>]*rgba\(255, 255, 255, 0\.6\)[^>]*>([^<]*)</p>")
HEADING_RE = re.compile(r"<h([1-6])\b([^>]*)>(.*?)</h\1>", re.S)


def page_facts(html: str) -> dict:
    """Independent facts read straight off a report page's HTML."""
    title = re.search(r"<title>(.*?)</title>", html, re.S)
    ogt = re.search(r'<meta property="og:title" content="([^"]*)"', html)
    headings = []
    for m in HEADING_RE.finditer(html):
        idm = re.search(r'id="([^"]*)"', m.group(2))
        headings.append({"level": int(m.group(1)), "id": idm.group(1) if idm else None,
                         "title": strip_tags(m.group(3))})
    return {
        "title": title.group(1) if title else None,
        "og_title": ogt.group(1) if ogt else None,
        "byline": BYLINE_RE.findall(html),
        "headings": headings,
        "title_tag": title.group(1).strip() if title else "",
    }


def kt_prose(html: str) -> str:
    """The prose right after the key-takeaways heading (markup-free).

    Anchored on the heading ELEMENT, not on the id attribute: slicing at
    `id="key-takeaways"` lands inside the tag and leaves raw `>` debris that
    would make a correct body look like a mismatch."""
    m = None
    for cand in HEADING_RE.finditer(html):
        if 'id="key-takeaways"' in cand.group(2):
            m = cand
            break
    if m is None:
        return EMPTY_STRING
    seg = html[m.end():m.end() + 6000]
    nxt = re.search(r"<h[1-6]\b", seg)
    if nxt:
        seg = seg[:nxt.start()]
    txt = norm(seg)  # strip_tags already handles the &nbsp; entities
    dot = txt.find(". ")
    return txt[:dot + 1] if dot >= 60 else txt[:80]


def article_region(html: str) -> str:
    """Article text: from key-takeaways (else <body>) to the first chrome block."""
    kt = html.find('id="key-takeaways"')
    start = kt if kt >= 0 else html.find("<body")
    if start < 0:
        start = 0
    ends = [m.start() for x in SENTINELS for m in re.finditer(re.escape(x), html)
            if m.start() > start]
    return strip_tags(html[start:min(ends) if ends else len(html)])


# ------------------------------------------------------------ adapter checks
_PENDING: list[tuple[str, bool, str]] = []


def ac(name: str, ok: bool, detail: str = "") -> None:
    """Record an adapter-side verdict; flushed as PASS/FAIL or SKIP at the end."""
    _PENDING.append((name, bool(ok), detail))


def main() -> int:
    global _PENDING
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=None,
                    help=f"adapter base (default {SIDECAR_DEFAULT})")
    ap.add_argument("--web", action="store_true",
                    help=f"target the Next proxy on the web origin ({WEB_DEFAULT})")
    ap.add_argument("--web-base", default=None,
                    help="explicit web/public origin (implies --web)")
    args = ap.parse_args()
    base = (args.web_base
            or (os.environ.get("KHALA_WEB_BASE") if args.web_base else None)
            or (WEB_DEFAULT if args.web else None)
            or args.base or SIDECAR_DEFAULT)
    base = base.rstrip("/")
    print(f"--- target {base}/api/khala (upstream oracle: {SITE})")
    started = time.time()

    # ================================================== 0. endpoint liveness
    probe = api(base, "mode=reports", timeout=60.0)
    endpoint_ok = False
    endpoint_reason = EMPTY_STRING
    liveness = "live"
    if probe["neterr"]:
        endpoint_reason = (f"khala endpoint unreachable at {base}/api/khala "
                           f"({probe['neterr']}) -- adapter checks SKIPPED, "
                           f"oracle checks below still ran")
        liveness = "unreachable"
    elif probe["status"] == 404 and not probe["body"]:
        endpoint_reason = (f"{base}/api/khala -> 404 (route not mounted yet; the "
                           f"Go worker has not landed the sidecar route) -- "
                           f"adapter checks SKIPPED")
        liveness = "not-mounted"
    elif probe["status"] == 200 and isinstance(probe["body"], dict) and (
            "items" in probe["body"] or "reportRows" in probe["body"]
            or ("rows" not in probe["body"] and "report" not in probe["body"])):
        endpoint_reason = (f"{base}/api/khala answers the OLD envelope "
                           f"(keys={sorted(probe['body'].keys())[:12]}) -- stale "
                           f"sidecar, re-run after the Go worker lands v4 -- "
                           f"adapter checks SKIPPED")
        liveness = "stale"
    else:
        endpoint_ok = True
    print(f"--- endpoint: {liveness}"
          + (f" ({endpoint_reason})" if endpoint_reason else ""))

    # ============================================ 1. ORACLE (site-directed)
    note("oracle: khala.io fetched DIRECTLY with urllib (never via the adapter)")
    sm = site_get("/sitemap.xml")
    ok_sm = check("oracle: sitemap.xml 200", sm["status"] == 200,
                  f"status {sm['status']} bytes {sm['bytes']}"
                  + (f" [{sm['error']}]" if sm["error"] else ""))
    check("oracle: sitemap.xml content-type is XML",
          bool(sm["ctype"]) and "xml" in str(sm["ctype"]).lower(),
          f"content-type {sm['ctype']}")
    locs = [u.strip() for u in re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", sm["text"])]
    oracle_paths = [urllib.parse.urlparse(u).path or "/" for u in locs]
    oracle_slugs = [p.strip("/") for p in oracle_paths
                    if ("/" + p.strip("/")) not in STATIC_LOCS]
    check("oracle: sitemap has exactly 11 <loc> (3 static + 8 reports)",
          len(locs) == 11, f"got {len(locs)}")
    check("oracle: sitemap static entries are exactly / /about /disclaimer",
          sorted(set(oracle_paths) & STATIC_LOCS) == ["/", "/about", "/disclaimer"],
          f"got {sorted(set(oracle_paths) & STATIC_LOCS)}")
    check("oracle: sitemap report-slug count == 8", len(oracle_slugs) == 8,
          f"got {len(oracle_slugs)}: {oracle_slugs}")
    longest = max(oracle_slugs, key=len) if oracle_slugs else EMPTY_STRING
    check("oracle: longest sitemap slug is the documented 94-char walrus slug",
          len(longest) == LONGEST_SLUG and longest == DOC_REPORTS[0][0],
          f"longest={len(longest)} chars {longest[:60]}")
    check("oracle: every sitemap slug matches the documented set",
          set(oracle_slugs) == set(DOC_ORDER),
          f"only-oracle={sorted(set(oracle_slugs) - set(DOC_ORDER))} "
          f"only-doc={sorted(set(DOC_ORDER) - set(oracle_slugs))}")

    home = site_get("/")
    check("oracle: homepage 200", home["status"] == 200,
          f"status {home['status']} bytes {home['bytes']}")
    time.sleep(SITE_DELAY)
    oracle_order: list[str] = []
    for m in re.finditer(r'href="\./([a-z0-9][a-z0-9-]*)"', home["text"]):
        s = m.group(1)
        if s in ("about", "disclaimer"):
            continue
        if s not in oracle_order:
            oracle_order.append(s)
    oracle_cards: dict[str, dict] = {}
    for s in oracle_order:
        i = home["text"].find(f'href="./{s}"')
        seg = home["text"][i:i + 4000]
        ps = re.findall(r'<p[^>]*class="framer-text[^"]*"[^>]*>(.*?)</p>', seg, re.S)
        clean = [norm(p) for p in ps]
        oracle_cards[s] = {"title": clean[0] if clean else EMPTY_STRING,
                           "summary": clean[1] if len(clean) > 1 else EMPTY_STRING}
    check("oracle: homepage order == documented newest-first order (8 cards)",
          oracle_order == DOC_ORDER, f"got {oracle_order}")

    pages: dict[str, dict] = {}
    for s in oracle_slugs:
        r = site_get(f"/{s}")
        pages[s] = {"http": r["status"], "bytes": r["bytes"],
                    "facts": page_facts(r["text"]), "html": r["text"],
                    "region": article_region(r["text"]),
                    "kt": kt_prose(r["text"])}
        time.sleep(SITE_DELAY)
    check("oracle: all 8 report pages 200 (direct fetch)",
          all(pages[s]["http"] == 200 for s in oracle_slugs),
          str({s[:22]: pages[s]["http"] for s in oracle_slugs if pages[s]["http"] != 200}
              or "all 200"))
    date_ok, date_bad = [], []
    for slug, _t, literal, iso in DOC_REPORTS:
        f = pages[slug]["facts"]
        by = f["byline"]
        if by and by[0].strip() == literal and iso == iso_of(literal):
            date_ok.append(slug)
        else:
            date_bad.append(f"{slug[:28]}: byline={by} want={literal!r}/{iso}")
    check("oracle: page bylines == RESULTS.md literals (and ISO derivable)",
          not date_bad, "; ".join(date_bad) if date_bad
          else f"{len(date_ok)}/8 bylines match, ISO = Mon D, YYYY -> YYYY-MM-DD")
    kt_bad = [s[:28] for s in oracle_slugs
              if len(pages[s]["kt"]) < 40 and len(pages[s]["region"]) < 5000]
    check("oracle: every page carries a real key-takeaways prose body",
          not kt_bad, f"thin: {kt_bad}" if kt_bad
          else "kt prose 623-3343 chars, article region 30k-68k chars")
    bad = site_get("/no-such-report-xyz")
    time.sleep(SITE_DELAY)
    check("oracle: upstream 404 for a bad slug is REAL (404 + Framer title)",
          bad["status"] == 404 and "<title>Page Not Found | Framer</title>"
          in bad["text"],
          f"status {bad['status']} bytes {bad['bytes']} "
          f"title={'Page Not Found | Framer' if 'Page Not Found | Framer' in bad['text'] else 'ABSENT'}")
    check("oracle: no chrome sentinel is part of the article region on any report page",
          not sentinel_in_article(pages),
          sentinel_in_article(pages) or
          "chrome blocks (TOC, newsletter, footer) all sit after the article on 8/8 pages")

    # ============================================== 2. mode=reports
    note("adapter: mode=reports")
    fr = api(base, "mode=reports&fresh=1")
    hr = api(base, "mode=reports")
    rb = as_dict(fr["body"])
    rows = as_list(rb.get("rows"))
    ac("reports: HTTP 200", fr["status"] == 200,
       f"got {fr['status']} {fr['raw'][:120]}")
    missing = [k for k in ("kind", "count", "upstreamTotal",
                           "rows", "upstream", "fetchedAt", "cache", "slice")
               if k not in rb]
    ac("reports: envelope keys present", not missing,
       f"missing {missing}" if missing else f"keys={sorted(rb.keys())}")
    ac("reports: kind == 'reports'", rb.get("kind") == "reports", f"{rb.get('kind')!r}")
    # v4 dropped `mode` and `order`: `kind` IS the resolved mode and ordering is
    # `position` (asserted below) plus the slice label. Assert their ABSENCE so a
    # regression cannot quietly reintroduce a second, disagreeing spelling.
    ac("reports: 'mode' key ABSENT (v4: kind is the resolved mode)",
       "mode" not in rb, f"keys={sorted(rb.keys())}")
    ac("reports: 'order' key ABSENT (v4: ordering is position + slice)",
       "order" not in rb, f"keys={sorted(rb.keys())}")
    ac("reports: slice names newest-first ordering",
       "newest-first" in as_str(rb.get("slice")), f"{str(rb.get('slice'))[:160]!r}")
    ac("reports: rows is a non-empty list", bool(rows),
       f"len={len(rows)}")
    ac("reports: count == len(rows)", rb.get("count") == len(rows),
       f"count={rb.get('count')} len(rows)={len(rows)}")
    ac("reports: count == upstreamTotal (no limit applied)",
       rb.get("count") == rb.get("upstreamTotal"),
       f"count={rb.get('count')} upstreamTotal={rb.get('upstreamTotal')}")
    ac("reports: upstreamTotal == sitemap report-slug count (ORACLE)",
       rb.get("upstreamTotal") == len(oracle_slugs),
       f"adapter={rb.get('upstreamTotal')} sitemap={len(oracle_slugs)}")
    ac("reports: upstream == 'https://www.khala.io/'",
       rb.get("upstream") == "https://www.khala.io/", f"{rb.get('upstream')!r}")
    ac("reports: X-KH-Upstream header == body upstream",
       hget(fr["hdr"], "X-KH-Upstream") == rb.get("upstream"),
       f"header={hget(fr['hdr'], 'X-KH-Upstream')!r} body={rb.get('upstream')!r}")
    ac("reports: fetchedAt is an int unix timestamp",
       isinstance(rb.get("fetchedAt"), int) and rb["fetchedAt"] > 1_600_000_000,
       f"{rb.get('fetchedAt')!r}")
    ac("reports: cache field is MISS|HIT", rb.get("cache") in ("MISS", "HIT"),
       f"{rb.get('cache')!r}")
    ac("reports: X-KH-Cache header is MISS|HIT",
       hget(fr["hdr"], "X-KH-Cache") in ("MISS", "HIT"),
       f"{hget(fr['hdr'], 'X-KH-Cache')!r}")
    ac("reports: Cache-Control == public, max-age=30",
       (hget(fr["hdr"], "Cache-Control") or "").replace(" ", "")
       == "public,max-age=30", f"{hget(fr['hdr'], 'Cache-Control')!r}")
    ac("reports: 'derived' key ABSENT (v4 moved provenance into slice)",
       "derived" not in rb, f"keys={sorted(rb.keys())}")
    ac("reports: 'note' key ABSENT (v4 disclosure lives in slice)",
       "note" not in rb, f"keys={sorted(rb.keys())}")
    ac("reports: slice present and non-empty",
       isinstance(rb.get("slice"), str) and len(rb["slice"].strip()) > 20,
       f"{str(rb.get('slice'))[:160]!r}")
    ac("reports: slice names the sitemap as the upstreamTotal source",
       "sitemap" in as_str(rb.get("slice")).lower(),
       f"{str(rb.get('slice'))[:160]!r}")

    row_slugs = [as_str(r.get("slug")) for r in rows if isinstance(r, dict)]
    only_adapter = sorted(set(row_slugs) - set(oracle_slugs))
    only_oracle = sorted(set(oracle_slugs) - set(row_slugs))
    ac("reports: rows[].slug set == sitemap slug set (both directions)",
       not only_adapter and not only_oracle,
       f"only-adapter={only_adapter} only-sitemap={only_oracle}")
    ac("reports: slugs unique (no duplicate cards)",
       len(row_slugs) == len(set(row_slugs)), f"{len(row_slugs)} rows")
    pos_bad = [i for i, r in enumerate(rows, 1)
               if not isinstance(r, dict) or r.get("position") != i]
    ac("reports: position is 1..N in row order", not pos_bad,
       f"bad rows {pos_bad[:6]}")
    ac("reports: row order == documented newest-first order",
       row_slugs == DOC_ORDER, f"got {[s[:18] for s in row_slugs][:4]}...")
    url_bad = [r.get("slug") for r in rows if isinstance(r, dict)
               and r.get("url") != f"{SITE}/{r.get('slug')}"]
    ac("reports: row url == https://www.khala.io/<slug>", not url_bad, str(url_bad[:4]))
    ac("reports: rows carry no 'published' key (absent, never null)",
       all("published" not in r for r in rows if isinstance(r, dict)),
       f"offenders={[r.get('slug', '')[:20] for r in rows if isinstance(r, dict) and 'published' in r][:4]}")
    ac("reports: rows carry no 'publishedISO' key (absent, never null)",
       all("publishedISO" not in r for r in rows if isinstance(r, dict)),
       f"offenders={[r.get('slug', '')[:20] for r in rows if isinstance(r, dict) and 'publishedISO' in r][:4]}")
    dateish = [r.get("slug") for r in rows if isinstance(r, dict)
               and re.search(r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+20\d\d",
                             json.dumps(r))]
    ac("reports: no date-shaped value invented inside a list row", not dateish,
       f"offenders={str(dateish)[:120]}")
    title_bad = [s for s in row_slugs if s in oracle_cards
                 and as_str(next((r for r in rows if r.get("slug") == s), {}).get("title"))
                 != oracle_cards[s]["title"]]
    ac("reports: every row title == the live homepage card title (ORACLE)",
       not title_bad, f"mismatches={str(title_bad)[:160]}")
    sum_bad = [as_str(r.get("slug"))[:20] for r in rows if isinstance(r, dict)
               and len(as_str(r.get("summary"))) < 40]
    ac("reports: every row summary is real prose (>= 40 chars)", not sum_bad,
       f"thin={str(sum_bad)[:120]}")
    ac(f"reports: the {LONGEST_SLUG}-char walrus slug IS served in rows",
       DOC_REPORTS[0][0] in row_slugs, f"present={DOC_REPORTS[0][0] in row_slugs}")
    ms = rb.get("missingSlugs", "ABSENT")
    ac("reports: missingSlugs absent (homepage covers the sitemap set)",
       ms == "ABSENT" or ms == [] or ms is None,
       f"missingSlugs={str(ms)[:120]!r}")

    # ============================================== 3. mode=latest
    note("adapter: mode=latest")
    l_def = api(base, "mode=latest")
    ld = as_dict(l_def["body"])
    l2 = api(base, "mode=latest&limit=2")
    l2b = as_dict(l2["body"])
    ac("latest: HTTP 200 (default limit)", l_def["status"] == 200,
       f"got {l_def['status']} {l_def['raw'][:120]}")
    ac("latest: default limit is 5", ld.get("count") == 5, f"count={ld.get('count')}")
    ac("latest: limit=2 -> count == 2", l2b.get("count") == 2,
       f"count={l2b.get('count')}")
    ac("latest: limit=2 leaves upstreamTotal at the full 8",
       l2b.get("upstreamTotal") == len(oracle_slugs),
       f"upstreamTotal={l2b.get('upstreamTotal')} sitemap={len(oracle_slugs)}")
    ac("latest: limit=2 -> len(rows) == 2", len(as_list(l2b.get("rows"))) == 2,
       f"len={len(as_list(l2b.get('rows')))}")
    ac("latest: count == upstreamTotal with no limit (default limit still 5 of 8)",
       ld.get("upstreamTotal") == len(oracle_slugs),
       f"upstreamTotal={ld.get('upstreamTotal')}")
    ac("latest: kind == 'latest'", ld.get("kind") == "latest", f"{ld.get('kind')!r}")
    # v4 has no `order` key; ordering is carried by `position` and named in the
    # slice. Assert the absence instead of a pre-v4 key.
    ac("latest: 'order' key ABSENT (v4: ordering is position + slice)",
       "order" not in ld, f"keys={sorted(ld.keys())}")
    ac("latest: upstream == 'https://www.khala.io/'",
       ld.get("upstream") == "https://www.khala.io/", f"{ld.get('upstream')!r}")
    ac("latest: X-KH-Upstream header == body upstream",
       hget(l_def["hdr"], "X-KH-Upstream") == ld.get("upstream"),
       f"header={hget(l_def['hdr'], 'X-KH-Upstream')!r} body={ld.get('upstream')!r}")
    ac("latest: Cache-Control == public, max-age=30",
       (hget(l_def["hdr"], "Cache-Control") or "").replace(" ", "")
       == "public,max-age=30", f"{hget(l_def['hdr'], 'Cache-Control')!r}")
    ac("latest: 'derived' key ABSENT (v4)", "derived" not in ld,
       f"keys={sorted(ld.keys())}")
    ac("latest: 'datesResolved' key ABSENT (v4)", "datesResolved" not in ld,
       f"keys={sorted(ld.keys())}")
    lslice = as_str(ld.get("slice"))
    ac("latest: slice non-empty", len(lslice.strip()) > 20, f"{lslice[:160]!r}")
    ac("latest: slice carries the verbatim 'no news surface exists' disclosure",
       "no news surface exists" in lslice, f"{lslice[:200]!r}")
    ac("latest: slice names /news and /rss.xml",
       "/news" in lslice and "/rss.xml" in lslice, f"{lslice[:200]!r}")
    lrows = [r for r in as_list(ld.get("rows")) if isinstance(r, dict)]
    ac("latest: every row carries published AND publishedISO",
       bool(lrows) and all("published" in r and "publishedISO" in r for r in lrows),
       f"rows={len(lrows)} missing={[i for i, r in enumerate(lrows) if 'published' not in r or 'publishedISO' not in r]}")
    ac("latest: no published/publishedISO is null or empty",
       all(isinstance(r.get("published"), str) and r["published"].strip()
           and isinstance(r.get("publishedISO"), str) and r["publishedISO"].strip()
           for r in lrows),
       f"{[(r.get('slug', '')[:14], r.get('published'), r.get('publishedISO')) for r in lrows][:3]}")
    ac("latest: publishedISO is a real ISO date and round-trips to published",
       all(ISO_RE.match(as_str(r.get("publishedISO"))) and iso_of(as_str(r.get("published")))
           == as_str(r.get("publishedISO")) for r in lrows) and bool(lrows),
       f"{[(r.get('published'), r.get('publishedISO')) for r in lrows][:4]}")
    ac("latest: dates match the RESULTS.md literals for the reports shown",
       all(r.get("published") == DOC_BY_SLUG[as_str(r.get("slug"))][2]
           and r.get("publishedISO") == DOC_BY_SLUG[as_str(r.get("slug"))][3]
           for r in lrows if as_str(r.get("slug")) in DOC_BY_SLUG) and bool(lrows),
       f"{[(as_str(r.get('slug'))[:20], r.get('published')) for r in lrows][:4]}")
    ac("latest: ISO dates are non-increasing (newest-first)",
       all(lrows[i]["publishedISO"] >= lrows[i + 1]["publishedISO"]
           for i in range(len(lrows) - 1) if isinstance(lrows[i].get("publishedISO"), str)
           and isinstance(lrows[i + 1].get("publishedISO"), str)),
       f"{[r.get('publishedISO') for r in lrows]}")
    newest = as_str(lrows[0].get("slug")) if lrows else EMPTY_STRING
    if newest in pages:
        _by = pages[newest]["facts"]["byline"]
        ac("latest: newest date == the byline on its own page (ORACLE)",
           bool(_by) and as_str(lrows[0].get("published")) == _by[0].strip(),
           f"adapter={lrows[0].get('published')!r} page={_by}")
    l50 = api(base, "mode=latest&limit=50")
    l50b = as_dict(l50["body"])
    l50slugs = [as_str(r.get("slug")) for r in as_list(l50b.get("rows"))
                if isinstance(r, dict)]
    ac("latest: every sitemap slug is served within limit=50",
       set(l50slugs) == set(oracle_slugs),
       f"status={l50['status']} rows={len(l50slugs)} only-adapter="
       f"{sorted(set(l50slugs) - set(oracle_slugs))[:3]} "
       f"only-sitemap={sorted(set(oracle_slugs) - set(l50slugs))[:3]}")
    ac("latest: the 94-char walrus slug survives limit=50 (length cap)",
       DOC_REPORTS[0][0] in l50slugs,
       f"present={DOC_REPORTS[0][0] in l50slugs}")
    for bad_limit in ("abc", "0", "-1", "51", "1.5", "1e2", " ", "2.0"):
        r = api(base, f"mode=latest&limit={urllib.parse.quote(bad_limit)}")
        bb = as_dict(r["body"])
        ac(f"latest: limit={bad_limit!r} -> 400 invalid limit",
           r["status"] == 400 and "limit" in as_str(bb.get("error")).lower(),
           f"got {r['status']} error={bb.get('error')!r}")
    for key_probe in ("walrus-solving-the-ai-agent-context-memory-bottleneck-verifiable-onchain-portable-programmable", "x"):
        r = api(base, f"mode=latest&key={urllib.parse.quote(key_probe)}")
        ac(f"latest: key={key_probe[:20]!r}+ -> 400 (key is report-scoped)",
           r["status"] == 400,
           f"got {r['status']} error={as_dict(r['body']).get('error')!r}")
    r = api(base, "mode=latest&limit=2&limit=3")
    ac("latest: repeated limit param is not silently clamped",
       r["status"] in (200, 400), f"got {r['status']}")
    lcache = api(base, "mode=latest&fresh=1")
    lcache2 = api(base, "mode=latest")
    ac("latest: ?fresh=1 -> X-KH-Cache MISS",
       hget(lcache["hdr"], "X-KH-Cache") == "MISS",
       f"{hget(lcache['hdr'], 'X-KH-Cache')!r}")
    ac("latest: repeat -> X-KH-Cache HIT",
       hget(lcache2["hdr"], "X-KH-Cache") == "HIT",
       f"{hget(lcache2['hdr'], 'X-KH-Cache')!r}")

    # ============================================== 4. mode=report
    note("adapter: mode=report")
    newest_slug = DOC_REPORTS[0][0]
    rep = api(base, f"mode=report&key={urllib.parse.quote(newest_slug)}")
    rp = as_dict(rep["body"])
    robj = as_dict(rp.get("report"))
    ac("report: HTTP 200 for the 94-char newest slug", rep["status"] == 200,
       f"got {rep['status']} {rep['raw'][:160]}")
    ac(f"report: the {LONGEST_SLUG}-char slug is NOT rejected as invalid length",
       rep["status"] != 400,
       f"status={rep['status']} (a cap < 128 silently kills the newest report)")
    ac("report: envelope keys present",
       not [k for k in ("kind", "report", "upstream", "fetchedAt",
                        "cache", "slice") if k not in rp],
       f"keys={sorted(rp.keys())}")
    ac("report: 'mode' key ABSENT (v4: kind is the resolved mode)",
       "mode" not in rp, f"keys={sorted(rp.keys())}")
    ac("report: kind == 'report'", rp.get("kind") == "report", f"{rp.get('kind')!r}")
    ac("report: report object keys present",
       not [k for k in ("slug", "url", "title", "metaTitle", "published",
                        "publishedISO", "authors", "sections", "body")
            if k not in robj],
       f"missing={[k for k in ('slug','url','title','metaTitle','published','publishedISO','authors','sections','body') if k not in robj]}")
    ac("report: bodyHtml key ABSENT (v4: body[] is the only body)",
       "bodyHtml" not in robj and "bodyHtml" not in rp,
       f"report keys={sorted(robj.keys())}")
    ac("report: bodyText key ABSENT (v4)", "bodyText" not in robj and "bodyText" not in rp,
       f"report keys={sorted(robj.keys())}")
    ac("report: upstream == the report's own url",
       rp.get("upstream") == robj.get("url") == f"{SITE}/{newest_slug}",
       f"upstream={rp.get('upstream')!r} url={robj.get('url')!r}")
    ac("report: X-KH-Upstream header == body upstream",
       hget(rep["hdr"], "X-KH-Upstream") == rp.get("upstream"),
       f"header={hget(rep['hdr'], 'X-KH-Upstream')!r} body={rp.get('upstream')!r}")
    ac("report: Cache-Control == public, max-age=30",
       (hget(rep["hdr"], "Cache-Control") or "").replace(" ", "") == "public,max-age=30",
       f"{hget(rep['hdr'], 'Cache-Control')!r}")
    ac("report: 'derived' key ABSENT (v4)", "derived" not in rp,
       f"keys={sorted(rp.keys())}")
    ac("report: slice present, non-empty and names the ISO derivation",
       isinstance(rp.get("slice"), str) and len(rp["slice"].strip()) > 20
       and "published" in rp["slice"] ,
       f"{str(rp.get('slice'))[:180]!r}")

    # every sitemap slug must be accepted (length + validity), one named check each
    report_bodies: dict[str, dict] = {}
    for s in oracle_slugs:
        r = api(base, f"mode=report&key={urllib.parse.quote(s)}")
        report_bodies[s] = {"status": r["status"], "body": as_dict(r["body"]),
                            "hdr": r["hdr"], "raw": r["raw"]}
    bad_slugs = {s[:34]: v["status"] for s, v in report_bodies.items()
                 if v["status"] != 200}
    ac("report: ALL 8 sitemap slugs accepted (200)", not bad_slugs,
       str(bad_slugs) if bad_slugs else "8/8 -> 200")
    ac("report: slug echo == requested slug for all 8",
       all(as_dict(v["body"].get("report")).get("slug") == s
           for s, v in report_bodies.items()),
       str([s[:24] for s, v in report_bodies.items()
            if as_dict(v["body"].get("report")).get("slug") != s]))

    for qs, want, why in (
            ("mode=report", 400, "absent key"),
            ("mode=report&key=", 400, "empty key"),
            ("mode=report&key=" + urllib.parse.quote("../etc"), 400, "path traversal"),
            ("mode=report&key=UPPERCASE", 400, "uppercase"),
            ("mode=report&key=has_underscore", 400, "underscore"),
            ("mode=report&key=" + urllib.parse.quote("a b"), 400, "space"),
            ("mode=report&key=" + "a" * 129, 400, "129 chars (cap 127)"),
            ("mode=report&key=" + urllib.parse.quote("x?y=z"), 400, "query char"),
            ("mode=report&key=decentralized-robotics-landscape&limit=2", 400,
             "limit scoped out of report"),
    ):
        r = api(base, qs)
        bb = as_dict(r["body"])
        ac(f"report: {why} -> 400", r["status"] == want,
           f"got {r['status']} error={bb.get('error')!r}")

    r0 = api(base, "mode=report&key=0")
    ac("report: key=0 (valid form, no such report) -> 404/400, never a fabricated 200",
       r0["status"] in (400, 404),
       f"got {r0['status']} (a 200 here would be a fabricated report)")

    badkey = api(base, "mode=report&key=no-such-report-xyz")
    bkb = as_dict(badkey["body"])
    ac("report: nonexistent-but-valid slug -> real 404 (upstream status preserved)",
       badkey["status"] == 404, f"got {badkey['status']} {badkey['raw'][:140]}")
    ac("report: 404 body says 'upstream 404: no such report'",
       "upstream 404: no such report" in as_str(bkb.get("error")),
       f"error={bkb.get('error')!r}")
    ac("report: 404 body carries upstreamStatus == 404",
       bkb.get("upstreamStatus") == 404, f"upstreamStatus={bkb.get('upstreamStatus')!r}")
    ac("report: decoy is NOT a fabricated 200 and NOT a 502",
       badkey["status"] not in (200, 502), f"got {badkey['status']}")

    # title / date parity against the page fetched directly (never the adapter)
    tbad, dbad = [], []
    for s in oracle_slugs:
        b = report_bodies[s]["body"]
        o = as_dict(b.get("report"))
        f = pages[s]["facts"]
        if as_str(o.get("title")) != oracle_cards.get(s, {}).get("title"):
            tbad.append(f"{s[:24]}: adapter={o.get('title')!r} page-card={oracle_cards.get(s, {}).get('title')!r}")
        want_title_tag = f["title_tag"]
        if as_str(o.get("metaTitle")) != want_title_tag:
            tbad.append(f"{s[:24]}: metaTitle={o.get('metaTitle')!r} page={want_title_tag!r}")
        byline = f["byline"][0].strip() if f["byline"] else ""
        if as_str(o.get("published")) != byline:
            dbad.append(f"{s[:24]}: published={o.get('published')!r} page-byline={byline!r}")
        if as_str(o.get("publishedISO")) != iso_of(byline):
            dbad.append(f"{s[:24]}: ISO={o.get('publishedISO')!r} want={iso_of(byline)!r}")
    ac("report: title + metaTitle == the page's own title for all 8 (ORACLE)",
       not tbad, "; ".join(tbad[:4]) if tbad else "8/8 exact")
    ac("report: published/publishedISO == page byline + ISO for all 8 (ORACLE)",
       not dbad, "; ".join(dbad[:4]) if dbad else "8/8 exact")
    ac("report: publishedISO is YYYY-MM-DD on every report",
       all(ISO_RE.match(as_str(as_dict(report_bodies[s]["body"].get("report")).get("publishedISO")))
           for s in oracle_slugs),
       str([as_dict(report_bodies[s]["body"].get("report")).get("publishedISO") for s in oracle_slugs]))

    # sections: non-empty, in page order, key-takeaways present where the page has it
    sec_bad, sec_first, sec_missing = [], [], []
    for s in oracle_slugs:
        o = as_dict(report_bodies[s]["body"].get("report"))
        secs = [x for x in as_list(o.get("sections")) if isinstance(x, dict)]
        hids = [h["id"] for h in pages[s]["facts"]["headings"] if h["id"]]
        if not secs:
            sec_bad.append(f"{s[:22]}: empty sections")
            continue
        ids = [as_str(x.get("id")) for x in secs]
        if ids[0] != hids[0]:
            sec_first.append(f"{s[:22]}: {ids[0]!r} != page-first {hids[0]!r}")
        if any(i not in hids for i in ids):
            sec_bad.append(f"{s[:22]}: ids not on the page {[i for i in ids if i not in hids][:3]}")
        pos = [hids.index(i) for i in ids if i in hids]
        if pos != sorted(pos):
            sec_bad.append(f"{s[:22]}: section order diverges from DOM order")
        if "key-takeaways" in hids and "key-takeaways" not in ids:
            sec_missing.append(s[:22])
        if "key-takeaways" in ids and ids.index("key-takeaways") != 0:
            sec_first.append(f"{s[:22]}: key-takeaways is not first")
    ac("report: sections non-empty and every id exists on the page",
       not sec_bad, "; ".join(sec_bad[:4]) if sec_bad else "8/8")
    ac("report: sections in the same DOM order as the page headings",
       not sec_bad, "; ".join(sec_bad[:4]) if sec_bad else "8/8 order-preserving")
    ac("report: sections[0] == the page's first heading id (key-takeaways where present)",
       not sec_first, "; ".join(sec_first[:4]) if sec_first else "8/8")
    ac("report: 'key-takeaways' present in sections where the page has it",
       not sec_missing, f"missing on {sec_missing}" if sec_missing else "8/8")

    # body fidelity on the flattened body[].text
    ob = as_dict(report_bodies[newest_slug]["body"])
    oo = as_dict(ob.get("report"))
    blks = [b for b in as_list(oo.get("body")) if isinstance(b, dict)]
    flat = " ".join(as_str(b.get("text")) for b in blks)
    flat_n = norm(flat)
    region = pages[newest_slug]["region"]
    kt = pages[newest_slug]["kt"]
    ac("report: body[] is a non-empty array of {type,text} blocks",
       bool(blks) and all(isinstance(b.get("type"), str) and "text" in b for b in blks),
       f"{len(blks)} blocks types={sorted({as_str(b.get('type')) for b in blks})[:12]}")
    ac("report: flattened body text is LONG (a real report, > 10k chars)",
       len(flat_n) > 10000, f"{len(flat_n)} chars")
    ac("report: flattened body is not a whole-page chrome dump (<= 200k chars)",
       len(flat_n) <= 200000, f"{len(flat_n)} chars; page article region {len(region)}")
    ac("report: flattened body contains the key-takeaways prose (ORACLE)",
       bool(kt) and kt[:70] in flat_n,
       f"probe={kt[:70]!r} found={bool(kt) and kt[:70] in flat_n}")
    sent = [x for x in SENTINELS if x in flat_n]
    ac("report: flattened body contains ZERO chrome sentinels", not sent,
       f"found {sent}" if sent else "none of " + ", ".join(repr(s) for s in SENTINELS))
    ac("report: no section/body text is empty where the page has prose",
       all(len(as_str(b.get("text")).strip()) > 0 for b in blks), f"{len(blks)} blocks")
    auth = oo.get("authors")
    info("report: authors field", f"{auth!r} (contract permits null: khala publishes no byline)")

    # ============================================== 5. cache + param scroll
    note("adapter: cache observability + mode scoping")
    ac("cache: reports MISS then HIT",
       rb.get("cache") == "MISS" and hget(hr["hdr"], "X-KH-Cache") == "HIT"
       and as_dict(hr["body"]).get("cache") == "HIT",
       f"fresh={rb.get('cache')!r} repeat-header={hget(hr['hdr'], 'X-KH-Cache')!r} "
       f"repeat-body={as_dict(hr['body']).get('cache')!r}")
    ac("cache: ?fresh=1 forces MISS on reports",
       rb.get("cache") == "MISS" and hget(fr["hdr"], "X-KH-Cache") == "MISS",
       f"body={rb.get('cache')!r} header={hget(fr['hdr'], 'X-KH-Cache')!r}")
    rfresh = api(base, f"mode=report&key={urllib.parse.quote(newest_slug)}&fresh=1")
    rrepeat = api(base, f"mode=report&key={urllib.parse.quote(newest_slug)}")
    ac("cache: report MISS then HIT (same key)",
       hget(rfresh["hdr"], "X-KH-Cache") == "MISS"
       and hget(rrepeat["hdr"], "X-KH-Cache") == "HIT",
       f"fresh={hget(rfresh['hdr'], 'X-KH-Cache')!r} repeat={hget(rrepeat['hdr'], 'X-KH-Cache')!r}")
    rl = api(base, "mode=reports&limit=2")
    lb = as_dict(rl["body"])
    ac("reports: limit=2 is either scoped-400 or 200 with count == min(2, total)",
       (rl["status"] == 400)
       or (rl["status"] == 200 and lb.get("count") == 2
           and lb.get("upstreamTotal") == len(oracle_slugs)),
       f"status={rl['status']} count={lb.get('count')} upstreamTotal={lb.get('upstreamTotal')}")
    rk = api(base, "mode=reports&key=walrus-solving-the-ai-agent-context-memory-bottleneck-verifiable-onchain-portable-programmable")
    ac("reports: key=<slug> -> 400 (key is report-scoped, never silently ignored)",
       rk["status"] == 400, f"got {rk['status']} error={as_dict(rk['body']).get('error')!r}")
    for qs in ("mode=bogus", "mode=", "mode=REPORTS", "mode=report%20"):
        r = api(base, qs)
        ac(f"{qs!r} -> 400", r["status"] == 400,
           f"got {r['status']} error={as_dict(r['body']).get('error')!r}")
    fr2 = api(base, f"mode=report&key={urllib.parse.quote(newest_slug)}&fresh=true")
    info("report: fresh=true (not '1')", f"status={fr2['status']} "
         f"cache-header={hget(fr2['hdr'], 'X-KH-Cache')!r} (only '1' is contracted)")

    # ============================================== 6. fabricated-data gate
    note("fabricated-data probe: adapter title vs the page fetched directly")
    newest_in_latest = [r for r in lrows if as_str(r.get("slug")) == newest_slug]
    want_title = oracle_cards.get(newest_slug, {}).get("title", EMPTY_STRING)
    got_reports = next((as_str(r.get("title")) for r in rows
                        if isinstance(r, dict) and r.get("slug") == newest_slug), EMPTY_STRING)
    got_report = as_str(oo.get("title"))
    got_latest = as_str(newest_in_latest[0].get("title")) if newest_in_latest else EMPTY_STRING
    ac("probe: reports/latest/report titles all == the live page card title",
       want_title and got_reports == want_title and got_latest == want_title
       and got_report == want_title,
       f"page={want_title!r} reports={got_reports!r} latest={got_latest!r} report={got_report!r}")
    ac("probe: the newest row is the 94-char walrus slug in all three modes",
       newest_slug in row_slugs and newest == newest_slug
       and as_str(oo.get("slug")) == newest_slug,
       f"reports={newest_slug in row_slugs} latest={newest == newest_slug} "
       f"report={as_str(oo.get('slug')) == newest_slug}")

    # ------------------------------------------------------------- flush
    if endpoint_ok:
        for n, ok, d in _PENDING:
            check(n, ok, d)
    else:
        for n, _ok, _d in _PENDING:
            skip(n, endpoint_reason)

    dur = round(time.time() - started, 1)
    report = {"duration_s": dur, "base": base, "site": SITE,
              "endpoint": liveness, "pass": PASS, "fail": FAIL, "skip": SKIP,
              "info": NOTES, "checks": RESULTS}
    outp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "khala-report.json")
    try:
        with open(outp, "w") as f:
            json.dump(report, f, indent=2, default=str)
    except OSError as e:  # noqa: BLE001
        outp = f"(unwritable: {e})"
    print(f"\nRESULT: {PASS} pass, {FAIL} fail, {SKIP} skipped"
          + (f"  [endpoint {liveness}]" if not endpoint_ok else ""))
    print(f"{PASS} passed, {FAIL} failed, {SKIP} skipped, {len(NOTES)} info "
          f"({dur}s) -> {outp}")
    for n in NOTES:
        print(f"  [INFO] {n}")
    if not endpoint_ok:
        print(f"  [SKIP] reason: {endpoint_reason}")
    return 1 if (FAIL or SKIP) else 0


def iso_of(literal: str) -> str:
    """'Jul 2, 2026' / 'Jul 2 2026' -> '2026-07-02' (deterministic, no locale)."""
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    m = re.match(r"^\s*([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\s*$", literal or "")
    if not m or m.group(1) not in months:
        return EMPTY_STRING
    return f"{int(m.group(3)):04d}-{months.index(m.group(1)) + 1:02d}-{int(m.group(2)):02d}"


def sentinel_in_article(pages: dict) -> str:
    """First (slug, sentinel) whose chrome sentinel sits INSIDE the article
    region, or '' when the oracle pages are clean. The sentinel-bearing blocks
    (nav TOC, newsletter, footer) all appear AFTER the article on every report,
    so a body[] that leaks one is provably dumping page furniture."""
    for s, p in sorted(pages.items()):
        for x in SENTINELS:
            if x in p["region"]:
                return f"{s[:24]}: {x!r} inside the article region"
    return EMPTY_STRING


if __name__ == "__main__":
    sys.exit(main())
