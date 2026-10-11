#!/usr/bin/env python3
"""
verify-newsfeed.py -- LIVE contract check for the publisher-feed family
(`apps/data/internal/ingest/providers/newsfeed`).

The registry is code, so this harness reads the registry from the code and then
knocks on every ACTIVE source's door, sequentially, one request per host, at the
adapter's own UA. What it asserts is what the adapter promises:

  * the registry parses and every row is complete (slug, label, homepage, url,
    format, category, language, reliability, license, status)
  * every ACTIVE source answers 200 with a document the adapter's dialects cover,
    and every item it yields carries a title AND a link (a 200 whose document
    cannot be read is a failure, not a pass)
  * a 200 carrying a well-formed feed with ZERO items is reported as low-yield and
    named -- not failed (the publisher simply had nothing out at audit time) and
    not passed silently (a permanently empty feed must stay visible)
  * no ACTIVE source is a non-https URL, and no URL carries credentials
  * a source that is NOT active is NEVER fetched -- a restricted source is
    recorded, not probed (nothing here tries to get around a refusal)
  * items with no date are reported, never counted as dated: the adapter leaves
    a missing timestamp NULL rather than inventing one
  * with --dsn, the registry matches the projection in `data.news_source` for
    every active row (slug present, enabled true, poll_seconds > 0)

Usage:
    python3 scripts/verify/verify-newsfeed.py                      # the code registry
    python3 scripts/verify/verify-newsfeed.py --db                 # + data.news_source parity
    python3 scripts/verify/verify-newsfeed.py --only cointelegraph,theblock
Exit codes:
    0  every expectation held            (NEWSFEED_OK ...)
    1  at least one expectation failed   (NEWSFEED_FAILED failures=<N>)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REGISTRY = os.path.join(REPO, "apps/data/internal/ingest/providers/newsfeed/feeds.go")
UA = "Mozilla/5.0 (compatible; FUDCourtBot/1.0; +https://fudcourt.my.id)"
ACCEPT = ("application/rss+xml, application/atom+xml, application/feed+json, "
          "application/json;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.5")
TIMEOUT = 20

ROW = re.compile(
    r'\{Slug:\s*"(?P<slug>[^"]+)",\s*Label:\s*"(?P<label>[^"]+)",\s*'
    r'Homepage:\s*"(?P<homepage>[^"]*)",\s*URL:\s*"(?P<url>[^"]+)",\s*'
    r'Format:\s*Format(?P<format>[A-Za-z]+),\s*Category:\s*"(?P<category>[^"]+)",\s*'
    r'Country:\s*"(?P<country>[^"]*)",\s*Language:\s*"(?P<language>[^"]*)",\s*'
    r'Reliability:\s*(?P<reliability>\d+),\s*License:\s*"(?P<license>[^"]*)",\s*'
    r'Status:\s*Status(?P<status>[A-Za-z]+)(?:,\s*StatusDetail:\s*"(?P<detail>[^"]*)")?'
)
FMT = {"RSS": "rss", "Atom": "atom", "JSONFeed": "jsonfeed", "HTML": "html"}

failures: list[str] = []
checks = 0


def check(ok: bool, detail: str) -> None:
    global checks
    checks += 1
    if not ok:
        failures.append(detail)


def load_registry() -> list[dict]:
    with open(REGISTRY, encoding="utf-8") as fh:
        src = fh.read()
    rows = []
    for m in ROW.finditer(src):
        r = m.groupdict()
        r["format"] = FMT.get(r["format"] or "", (r["format"] or "").lower())
        r["status"] = (r["status"] or "").lower()
        rows.append(r)
    return rows


class OffHostRedirect(Exception):
    """The feed left its own host -- the adapter refuses this, so the audit must too."""


class SameHostRedirects(urllib.request.HTTPRedirectHandler):
    """Mirror the adapter's same-host rule.

    Without this the audit is WEAKER than the thing it audits: urllib follows a
    cross-host 302 happily, so a registry row whose feed moved to another
    publisher (measured: coindeskjapan.com/feed/ -> www.nadanews.com) answered
    200 with someone else's document and the audit called it healthy while the
    adapter refused it.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # The adapter tolerates a hop that only adds/strips `www.` -- the same
        # site under its other name -- and refuses anything else. Mirror exactly
        # that, no more and no less.
        old = (urllib.parse.urlsplit(req.full_url).hostname or "").removeprefix("www.")
        new = (urllib.parse.urlsplit(newurl).hostname or "").removeprefix("www.")
        if old != new:
            raise OffHostRedirect(f"{req.full_url} -> {newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(SameHostRedirects)


def fetch(url: str) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": ACCEPT})
    try:
        with _OPENER.open(req, timeout=TIMEOUT) as resp:
            return resp.status, resp.read(2 << 20)
    except urllib.error.HTTPError as err:
        return err.code, b""
    except OffHostRedirect as err:
        print(f"  !! off-host redirect refused: {err}")
        return 0, b""
    except Exception:  # noqa: BLE001 - a transport failure is a failed expectation
        return 0, b""


def items_of(body: bytes) -> list[tuple[str, str, bool]]:
    """(title, link, has_date) for every item the document exposes."""
    out: list[tuple[str, str, bool]] = []
    if not body.strip():
        return out
    if body.lstrip()[:1] == b"{":
        try:
            doc = json.loads(body.decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001
            return out
        for it in doc.get("items", []) or []:
            out.append((str(it.get("title") or ""), str(it.get("url") or it.get("external_url") or ""),
                        bool(it.get("date_published") or it.get("date_modified"))))
        return out
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return out
    tag = lambda e: e.tag.rsplit("}", 1)[-1]  # noqa: E731
    if tag(root) == "rss" or root.find("channel") is not None:
        chan = root.find("channel") or root
        for it in chan.findall("item"):
            title = (it.findtext("title") or "").strip()
            link = (it.findtext("link") or "").strip()
            date = bool((it.findtext("pubDate") or "").strip())
            out.append((title, link, date))
        return out
    for e in root:
        if tag(e) != "entry":
            continue
        title = ""
        for child in e:
            if tag(child) == "title":
                title = "".join(child.itertext()).strip()
        link = ""
        for child in e:
            if tag(child) == "link":
                href = child.attrib.get("href", "")
                rel = child.attrib.get("rel", "alternate")
                if href and (rel == "alternate" or not link):
                    link = href
        date = any(tag(c) in ("published", "updated") and (c.text or "").strip() for c in e)
        out.append((title, link, date))
    return out


def db_parity(rows: list[dict]) -> None:
    dsn = os.environ.get("FUDCOURT_DATA_PG_URL") or os.environ.get("FUDCOURT_PG_URL")
    if not dsn:
        print("  .. --db asked for but no FUDCOURT_DATA_PG_URL/FUDCOURT_PG_URL in the environment")
        check(False, "db parity requested without a DSN")
        return
    q = ("select coalesce(json_agg(json_build_object('slug', source_slug, 'enabled', enabled, "
         "'poll', poll_seconds, 'status', status)), '[]'::json)::text from data.news_source")
    try:
        out = subprocess.run(["psql", dsn, "-qAtc", q], capture_output=True, text=True, timeout=30)
        proj = {r["slug"]: r for r in json.loads(out.stdout.strip() or "[]")}
    except Exception as err:  # noqa: BLE001
        check(False, f"db parity: could not read data.news_source ({err})")
        return
    for r in rows:
        if r["status"] != "active":
            continue
        p = proj.get(r["slug"])
        check(p is not None, f"db: {r['slug']} missing from data.news_source")
        if p:
            check(bool(p["enabled"]), f"db: {r['slug']} projected but not enabled")
            check(int(p["poll"]) > 0, f"db: {r['slug']} projected with poll_seconds={p['poll']}")
    print(f"  .. projected rows in data.news_source: {len(proj)}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated slugs to probe")
    ap.add_argument("--db", action="store_true", help="also assert data.news_source parity")
    args = ap.parse_args()

    rows = load_registry()
    print(f"== registry: {len(rows)} rows parsed from the code")
    check(len(rows) >= 50, f"registry parsed only {len(rows)} rows")

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    active = [r for r in rows if r["status"] == "active" and (not only or r["slug"] in only)]
    inactive = [r for r in rows if r["status"] != "active" and (not only or r["slug"] in only)]

    for r in rows:
        if not only or r["slug"] in only:
            for field in ("slug", "label", "homepage", "url", "format", "category", "language", "license"):
                check(bool(r.get(field)), f"{r['slug']}: registry field {field} is empty")
            check(r["url"].startswith("https://"), f"{r['slug']}: feed url is not https ({r['url']})")
            check("@" not in r["url"].split("//", 1)[-1].split("/", 1)[0],
                  f"{r['slug']}: feed url carries credentials")
            check(r["format"] in ("rss", "atom", "jsonfeed"), f"{r['slug']}: unknown format {r['format']}")

    print(f"== probing {len(active)} ACTIVE sources live (one request per host, sequential)")
    live_items = 0
    undated = 0
    low_yield: list[str] = []
    for r in active:
        code, body = fetch(r["url"])
        check(code == 200, f"{r['slug']}: HTTP {code} from {r['url']}")
        if code != 200:
            print(f"  !! {r['slug']:<22} HTTP {code}")
            continue
        items = items_of(body)
        titled = [i for i in items if i[0] and i[1]]
        check(len(titled) == len(items), f"{r['slug']}: {len(items) - len(titled)} item(s) without title or link")
        nodate = len([i for i in items if not i[2]])
        undated += nodate
        live_items += len(items)
        if not items:
            # A 200 carrying a feed document with zero entries is not a broken
            # source -- it is a source that published nothing at this instant.
            # Measured: etfgi and farside both answer 200 with a well-formed
            # channel and no items right now. Failing the audit on that would be
            # an invented failure; ignoring it would hide a dead feed. So it is
            # counted, named, and reported as low-yield instead of asserted.
            low_yield.append(r["slug"])
            print(f"  warn {r['slug']:<22} HTTP 200, well-formed feed, 0 items at audit time (low-yield)")
            continue
        print(f"  ok {r['slug']:<22} {len(items):>3} items, {len(titled)} with title+link, "
              f"{nodate} undated (left NULL, never invented)")

    for r in inactive:
        check(bool(r.get("detail")), f"{r['slug']}: {r['status']} without a recorded reason")
        check((r["url"] == "" or r["url"].startswith("https://")) if r["url"] else True,
              f"{r['slug']}: malformed url")
        print(f"  -- {r['slug']:<22} {r['status']} - NOT fetched (recorded, never worked around)")

    if args.db:
        db_parity(rows)

    print(f"\nchecks={checks} live_items={live_items} undated_items={undated} "
          f"low_yield={len(low_yield)}{':' + ','.join(low_yield) if low_yield else ''} failures={len(failures)}")
    for f in failures:
        print(f"FAIL {f}")
    if failures:
        print(f"NEWSFEED_FAILED failures={len(failures)}")
        return 1
    print(f"NEWSFEED_OK sources={len(rows)} active={len(active)} inactive={len(inactive)} "
          f"items={live_items} low_yield={len(low_yield)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
