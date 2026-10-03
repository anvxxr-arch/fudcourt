#!/usr/bin/env python3
"""Computed-style fingerprint harness for the fudcourt web app.

Modes:

    capture --base-url URL --out FILE
    compare --base-url URL --baseline FILE [--routes a,b,c] [--out-json FILE]
            [--budget FILE] [--strict]
    routes  --check [--app-dir DIR] [--json]

ROUTE COVERAGE (`routes --check`). The harness only guarantees the routes in
`ROUTES`; a route the tree adds is invisible to it until someone edits the list.
That is exactly how this file drifted: a rival workstream rewrote the product IA
(the `/ticker`, `/llama`, `/dex`, `/trench`, `/tracker` pages became a `/market`
hub) and edited `ROUTES` with it, so the harness silently covered a different
surface than the one the token migration was proven against. `routes --check`
closes that: it derives the app's page routes from the tree
(`src/app/**/page.tsx`), strips route groups `(frontend)`, `(public)`,
`(dashboard)`, `(admin)`, the blog's Payload group and the blog's own
`(payload)` group, keeps dynamic segments literally (`[ticker]`), and FAILS
(exit 1) naming every derived page route that the harness does not probe and
does not list in `EXCLUDED_ROUTES` (below, each entry with the reason it cannot
be probed). It always prints `ROUTES: covered=N probed=P excluded=E missing=M
app=N`. `--app-dir` points it at another checkout (default: this file's repo).

`capture` visits each route, waits for `networkidle` plus a fixed settle, then
records up to 400 computed-style probes in DOM order from
`document.querySelectorAll('*')`, filtered to elements with a non-zero visible
box. No text content is recorded.

`compare` re-captures live and classifies every probe:

  * join key is `(tag, path)` where `path` is a structural address
    (`html>body>div[0]>table[2]>tbody[0]>tr[4]`). A flat document-order index is
    NOT stable: this app's boards insert/remove live rows, which shifts every
    downstream element's index while its tag can still coincide, producing
    hundreds of phantom diffs. The structural path fixes that.
  * a baseline probe with no live match at the same `(tag, path)` — or whose tag
    differs — is SKIPPED. Live-data row-count changes are the expected source of
    skips and must never fail the run.
  * a matched probe with any compared property differing is a DIFF.

FLAKINESS. Two captures of the SAME build must compare clean. One computed
property is genuinely volatile in this app: `color` is bound to live values (a
24h % cell or a price renders green or red by the direction of the latest tick),
so it flips between captures while the element and its CSS rule are identical.
It is not chrome and not a migration signal, so `VOLATILE_PROPS` (below) ignores
it by default. `--strict` disables that ignore-list — the token-migration
cutover uses `--strict` together with `--budget`, because there the colour IS
what is under test and the intended re-points are authorized per-row instead of
skipped wholesale. Every other computed property MUST be stable same-build.

BUDGET. `compare --budget FILE` classifies each DIFF as EXPECTED or UNEXPECTED:

    {"expected": [{"route": "/ticker", "prop": "fontSize",
                   "from": "11.5px", "to": "12px", "reason": "normalization row 4"}],
     "rules":    [{"route": "*", "prop": "color", "reason": "palette re-point (globally authorized)"}]}

A diff matches an entry when route and prop match exactly (or the entry uses
`*`); `from`/`to` are optional and, when present, must equal the baseline/live
values. `rules` are the same shape (the route:`*` / prop:`*` shorthand is not
special beyond `*` matching). Without `--budget`, behaviour is unchanged. With
`--budget`, at most 50 UNEXPECTED diffs are printed, then
`FINGERPRINT: compared=N skipped=M expected=E unexpected=U`; exit 1 iff U > 0.
Every EXPECTED diff must cite the normalization-table row in its `reason`; an
UNEXPECTED diff is a migration bug, not noise.

Interpreter: run with an interpreter that has playwright installed and a
Chromium build available, e.g.

    /home/dwizzy/farming/.venv/bin/python frontend/web/tests/design/fingerprint.py ...
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

# The routes this harness PROBES. Kept in lockstep with the app tree by
# `routes --check` (see the docstring): a page route the tree grows must be
# either added here or listed in EXCLUDED_ROUTES with its reason.
#
# Reconciled 2026-10-02 against the post-IA-rework tree (the `/market` hub
# replaced `/ticker`, `/llama`, `/dex`, `/trench`, `/tracker`). Additions are
# the routes that IA serves which the migration-era list never named: `/blog`,
# `/blog/[slug]`, and a concrete coin for the dynamic `/market/ticker/[ticker]`.
# The last is the design system's own surface too — it is `TickerDetailPage`
# (`src/features/ticker/detail`), the chrome the retired standalone `/ticker`
# page used, now mounted under the hub — so leaving it unprobed would have
# exempted the largest surviving ticker surface from the fingerprint guarantee.
# A concrete instrument is used because the route 404s on an unknown symbol
# (`TICKER_COIN` allowlist in the page); `BTC` is one the app quotes (verified:
# `/market/ticker/BTC` → 200 on the deployed unit). `/blog/[slug]` is likewise
# probed at a slug that exists in the CMS.
ROUTES = [
    "/", "/market", "/market/crypto", "/market/trench", "/market/forex",
    "/market/stock", "/market/commodity", "/market/ticker/BTC", "/news",
    "/scoreboard", "/signals", "/login",
    "/blog", "/blog/never-fake-rules",
]
# Page routes that EXIST in the app tree but are NOT probed, each with the
# reason. `routes --check` fails if a page route is in neither ROUTES nor this
# map — so a route cannot be dropped from the fingerprint surface silently.
# These are the only legitimate non-probes: a probe needs a RENDERED page, and
# these never render one to an anonymous harness (they redirect to `/login`,
# merged from `TIER_PAGES` in `src/platform/auth/guard.ts`, enforced by
# `src/middleware.ts` and confirmed live: `/member`, `/team/*`, `/executor`,
# `/admin` all answered 307 to an anonymous request). The harness has NO cookie
# or session mechanism (grep `cookies` in this file: none), so a session-gated
# page cannot be captured without adding auth — which would put a signed
# session into a committed test tool. That is a deliberate boundary, not a gap
# to paper over: the ledger (`docs/architecture/design-debt.md`) records these
# as routes with no pixel-level guarantee.
EXCLUDED_ROUTES: dict[str, str] = {
    "/admin": "session-gated: TIER_PAGES '/admin'->admin (src/platform/auth/guard.ts); the middleware redirects an anonymous request to /login (live probe 307), so there is no rendered page to fingerprint",
    "/member": "session-gated: TIER_PAGES '/member'->member; the guard's own comment notes it is enforced in middleware like the others (live probe 307)",
    "/executor": "session-gated: TIER_PAGES '/executor'->team (CEX Executor, PRD section 108); live probe 307",
    "/executor/[id]": "session-gated: under the TIER_PAGES '/executor'->team prefix; live probe of the prefix 307",
    "/executor/accounts": "session-gated: under the TIER_PAGES '/executor'->team prefix; live probe of the prefix 307",
    "/executor/history": "session-gated: under the TIER_PAGES '/executor'->team prefix; live probe of the prefix 307",
    "/executor/new": "session-gated: under the TIER_PAGES '/executor'->team prefix; live probe of the prefix 307",
    "/executor/settings": "session-gated: under the TIER_PAGES '/executor'->team prefix; live probe of the prefix 307",
    "/team/balance": "session-gated: under the TIER_PAGES '/team'->team prefix (treasury surface); live probe 307",
    "/team/portfolio": "session-gated: under the TIER_PAGES '/team'->team prefix; live probe 307",
    "/team/reconciliation": "session-gated: under the TIER_PAGES '/team'->team prefix; live probe 307",
    "/team/transactions": "session-gated: under the TIER_PAGES '/team'->team prefix; live probe 307",
    "/team/wallets": "session-gated: under the TIER_PAGES '/team'->team prefix; live probe 307",
    "/blog/cms/admin/[[...segments]]": "third-party surface: the Payload admin SPA under src/app/blog/(payload)/**, which styles itself through its own stylesheets and is already colour-exempt in the token gate (COLOR_EXEMPT_DIRS 'src/app/blog/(payload)'); it is not product chrome",
}
# Route groups are URL-invisible path segments. (frontend)/(public)/(dashboard)/
# (admin) are this app's product groups; (payload) is the blog's Payload group
# and its `/cms/**` path prefix is what the derived route keeps.
ROUTE_GROUPS = {"(frontend)", "(public)", "(dashboard)", "(admin)", "(payload)"}

MAX_PROBES = 400
SETTLE_MS = 3000
NAV_TIMEOUT_MS = 60000

# Ordered exactly as specified so JSON key order is deterministic.
# `i` and `tag` name the probe for the report; `path` is the stable join key
# and is stored but never compared.
PROPS = [
    "i", "tag", "path", "fontSize", "fontFamily", "fontWeight", "lineHeight",
    "letterSpacing", "color", "backgroundColor", "borderTopWidth",
    "borderTopColor", "borderRadius", "padding", "margin", "gap", "textAlign",
]
COMPARED_PROPS = [p for p in PROPS if p not in ("i", "tag", "path")]

# The harness ignore-list, measured (not assumed) from three same-build captures
# of the frozen build H3Jf_xoah_HRz03Pdpv_z on 2026-10-02 (fpS1/fpS2/fpS3):
#   * `color` (all routes): bound to live values — a 24h % cell or a price
#     renders green or red by the direction of the latest tick — so it flips
#     between captures while the element and its style rule stay identical.
#   * `/signals` {fontWeight, backgroundColor, borderRadius}: a live status-dot
#     widget renders active/inactive by signal state, changing exactly these
#     three (700<->400, transparent<->rgb(28,58,49), 0px<->50%). Distinct-path
#     diffs, not a join artefact.
#   * `/market/trench` {padding}: a live expand/collapse or badge state changes
#     the padding of two rows between captures. (Measured on the old /trench
#     blotter, which now lives under this hub section.)
# No settle time removes any of these: they are content/state, not chrome.
# Measured across all 6 pairs of four same-build captures (fpS1..fpS4): the
# ONLY unstable (route, prop) pairs were /, /signals, /signals {fontWeight,
# backgroundColor, borderRadius}, /market/trench {padding} and the now-retired
# /ticker, /dex, /tracker `color` (those three are redirects into the hub since
# the boards folded into /market/{crypto,trench}; their `color` volatility is
# covered by the `*` entry). Every other (route, prop) pair was stable in all 6
# pairs, so it is compared and MAY NOT be ignored. `--strict` disables this
# whole list; the migration cutover runs `--strict --budget` so the intended
# re-points are authorized per-row instead of being skipped wholesale.
VOLATILE_PROPS: dict[str, frozenset[str]] = {
    "*": frozenset({"color"}),
    "/signals": frozenset({"fontWeight", "backgroundColor", "borderRadius"}),
    "/market/trench": frozenset({"padding"}),
}


def props_to_compare(strict: bool, route: str) -> list[str]:
    if strict:
        return list(COMPARED_PROPS)
    ignored = VOLATILE_PROPS.get("*", frozenset()) | VOLATILE_PROPS.get(route, frozenset())
    return [p for p in COMPARED_PROPS if p not in ignored]


# Structural address of each element: `tag[nth-of-same-tag-sibling]` from
# <html>, joined by '>'. Independent of text content, so a table that gains or
# loses a live-data row does not shift every downstream element's identity the
# way a flat document-order index does.
_PATH_JS = """
  const pathOf = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      const p = n.parentNode;
      if (!p) break;
      let idx = 0;
      for (const sib of p.children) {
        if (sib.tagName === n.tagName) { if (sib === n) break; idx++; }
      }
      parts.push(n.tagName.toLowerCase() + '[' + idx + ']');
      n = p;
    }
    parts.push('html');
    return parts.reverse().join('>');
  };
"""

_COLLECT_JS = """
() => {
  const out = [];
  const els = document.querySelectorAll('*');
  %s
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0) continue;
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      path: pathOf(el),
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      borderTopWidth: cs.borderTopWidth,
      borderTopColor: cs.borderTopColor,
      borderRadius: cs.borderRadius,
      padding: cs.padding,
      margin: cs.margin,
      gap: cs.gap,
      textAlign: cs.textAlign,
    });
    if (out.length >= %d) break;
  }
  return out;
}
""" % (_PATH_JS, MAX_PROBES)


def _probe(raw: dict[str, Any], index: int) -> dict[str, Any]:
    p = {"i": index, "tag": raw["tag"], "path": raw.get("path", "")}
    for k in COMPARED_PROPS:
        p[k] = raw.get(k, "")
    return {k: p[k] for k in PROPS}


def capture(base_url: str, routes: list[str], out_path: str) -> dict[str, Any]:
    base_url = base_url.rstrip("/")
    result: dict[str, Any] = {
        "base_url": base_url,
        "captured_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "routes": {},
    }
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        for route in routes:
            url = base_url + route
            try:
                page.goto(url, wait_until="networkidle", timeout=NAV_TIMEOUT_MS)
            except Exception as exc:  # networkidle can time out on polling pages
                print(f"  ! {route}: networkidle wait failed ({exc}); keeping partial DOM",
                      file=sys.stderr)
            page.wait_for_timeout(SETTLE_MS)
            raw = page.evaluate(_COLLECT_JS)
            result["routes"][route] = [_probe(r, i) for i, r in enumerate(raw)]
            print(f"  captured {route}: {len(result['routes'][route])} probes")
        browser.close()
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2, ensure_ascii=False, sort_keys=False)
        fh.write("\n")
    return result


def _capture_memory(base_url: str, routes: list[str]) -> dict[str, list[dict[str, Any]]]:
    base_url = base_url.rstrip("/")
    out: dict[str, list[dict[str, Any]]] = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        for route in routes:
            url = base_url + route
            try:
                page.goto(url, wait_until="networkidle", timeout=NAV_TIMEOUT_MS)
            except Exception as exc:
                print(f"  ! {route}: networkidle wait failed ({exc}); keeping partial DOM",
                      file=sys.stderr)
            page.wait_for_timeout(SETTLE_MS)
            raw = page.evaluate(_COLLECT_JS)
            out[route] = [_probe(r, i) for i, r in enumerate(raw)]
            print(f"  captured {route}: {len(out[route])} probes")
        browser.close()
    return out


def _index(probes: list[dict[str, Any]]) -> dict[tuple[str, str], list[dict[str, Any]]]:
    idx: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for pr in probes:
        idx.setdefault((pr["tag"], pr["path"]), []).append(pr)
    return idx


def _load_budget(path: str) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    entries = (data.get("expected", []) or []) + (data.get("rules", []) or [])
    for e in entries:
        if "route" not in e or "prop" not in e:
            raise SystemExit(f"budget entry missing route/prop: {e!r}")
    return entries


def _entry_matches(entry: dict[str, Any], route: str, prop: str,
                   base_val: str, live_val: str) -> bool:
    if entry["route"] not in ("*", route):
        return False
    if entry["prop"] not in ("*", prop):
        return False
    if "from" in entry and entry["from"] != base_val:
        return False
    if "to" in entry and entry["to"] != live_val:
        return False
    return True


def compare(base_url: str, baseline_path: str, routes: list[str],
            out_json: str | None, budget_path: str | None = None,
            strict: bool = False) -> int:
    budget_entries = _load_budget(budget_path) if budget_path else []
    with open(baseline_path, encoding="utf-8") as fh:
        baseline = json.load(fh)
    # Refuse a pre-structural baseline: without `path`, join keys would collapse
    # to (tag, "") and compare tag order, reintroducing the positional bug.
    for _bp in baseline.get("routes", {}).values():
        if _bp and "path" not in _bp[0]:
            raise SystemExit(
                f"{baseline_path} is a legacy (index-based) capture without 'path'; "
                "re-capture the baseline with the current harness (see doc section E.4).")
        break
    live = _capture_memory(base_url, routes)
    compared = skipped = diffs = 0
    expected = unexpected = 0
    diff_lines: list[str] = []
    unexpected_lines: list[str] = []
    for route in routes:
        props = props_to_compare(strict, route)
        base_probes = baseline.get("routes", {}).get(route)
        if base_probes is None:
            print(f"  ! route {route} absent from baseline — skipped entirely", file=sys.stderr)
            continue
        base_idx = _index(base_probes)
        live_idx = _index(live.get(route, []))
        for key, bgroup in base_idx.items():
            lgroup = live_idx.get(key, [])
            for pos, bp in enumerate(bgroup):
                if pos >= len(lgroup):          # live-data row removed at this address
                    skipped += 1
                    continue
                lp = lgroup[pos]
                compared += 1
                for prop in props:
                    if bp.get(prop) == lp.get(prop):
                        continue
                    diffs += 1
                    line = (f"{route}[{bp['i']}] {prop}: "
                            f"{bp.get(prop)!r} != {lp.get(prop)!r}")
                    if budget_path:
                        if any(_entry_matches(e, route, prop, str(bp.get(prop)),
                                              str(lp.get(prop))) for e in budget_entries):
                            expected += 1
                            continue
                        unexpected += 1
                        if len(unexpected_lines) < 50:
                            unexpected_lines.append(line)
                    elif len(diff_lines) < 50:
                        diff_lines.append(line)
    if budget_path:
        for line in unexpected_lines:
            print(line)
        if unexpected > len(unexpected_lines):
            print(f"... {unexpected - len(unexpected_lines)} more diffs suppressed")
        print(f"FINGERPRINT: compared={compared} skipped={skipped} "
              f"expected={expected} unexpected={unexpected}")
    else:
        for line in diff_lines:
            print(line)
        if diffs > len(diff_lines):
            print(f"... {diffs - len(diff_lines)} more diffs suppressed")
        print(f"FINGERPRINT: compared={compared} skipped={skipped} diffs={diffs}")
    if out_json:
        with open(out_json, "w", encoding="utf-8") as fh:
            json.dump({"base_url": base_url, "baseline": baseline_path,
                       "budget": budget_path, "strict": strict,
                       "volatile_props_ignored": (
                           {} if strict
                           else {k: sorted(v) for k, v in VOLATILE_PROPS.items()}),
                       "compared": compared, "skipped": skipped, "diffs": diffs,
                       "expected": expected, "unexpected": unexpected,
                       "diff_lines": diff_lines, "unexpected_lines": unexpected_lines},
                      fh, indent=2)
    return 1 if (unexpected if budget_path else diffs) > 0 else 0


def _is_dynamic(segment: str) -> bool:
    return len(segment) >= 2 and segment.startswith("[") and segment.endswith("]")


def _derive_page_routes(app_dir: Path) -> list[str]:
    """Every page route the app tree serves, from `**/page.tsx`.

    Route groups are URL-invisible in Next.js, so any `(name)` segment is
    stripped — that is what honours `(frontend)`, `(public)`, `(dashboard)`,
    `(admin)` and the blog's `(payload)`. Dynamic segments are kept LITERALLY
    (`[ticker]`, `[[...segments]]`): the comparison below, not this function,
    decides which concrete probe covers a dynamic route.
    """
    routes: set[str] = set()
    for page in sorted(app_dir.rglob("page.tsx")):
        segments = [s for s in page.relative_to(app_dir).parent.parts
                    if not (s.startswith("(") and s.endswith(")"))]
        routes.add("/" + "/".join(segments) if segments else "/")
    return sorted(routes)


def _probe_matches_route(probe: str, route: str) -> bool:
    """True when `probe` (a concrete probe path) addresses `route`, where a
    dynamic `route` segment matches any one probe segment (`[ticker]` matches
    `BTC`). Segment counts must be equal, so `[ticker]` never matches
    `/market/ticker/BTC/x` and a catch-all does not swallow siblings."""
    p_segs = [s for s in probe.split("/") if s]
    r_segs = [s for s in route.split("/") if s]
    if len(p_segs) != len(r_segs):
        return False
    return all(_is_dynamic(r) or p == r for p, r in zip(p_segs, r_segs))


def check_routes(app_dir: Path, as_json: bool = False, strict: bool = False) -> int:
    """`routes --check`: the anti-drift gate for this harness's own coverage.

    The harness only guarantees what `ROUTES` names. When the product IA changes
    and `ROUTES` is edited to match, the harness silently starts covering a
    different surface than the one it was proven against — nothing detects it.
    This derives the app's real page routes from the tree and fails when one is
    neither probed nor explicitly excluded (EXCLUDED_ROUTES, each with a reason).
    `--strict` additionally fails on the reverse rot: a probe (or an exclusion)
    that no longer corresponds to any page route in the tree.
    """
    app_routes = _derive_page_routes(app_dir)
    probed = [r for r in app_routes if any(_probe_matches_route(p, r) for p in ROUTES)]
    excluded = [r for r in app_routes if r in EXCLUDED_ROUTES]
    missing = [r for r in app_routes if r not in probed and r not in excluded]
    stale_probes = [p for p in ROUTES if not any(_probe_matches_route(p, r) for r in app_routes)]
    stale_exclusions = [k for k in EXCLUDED_ROUTES if k not in app_routes]
    summary = (f"ROUTES: covered={len(ROUTES)} probed={len(probed)} "
               f"excluded={len(excluded)} missing={len(missing)} app={len(app_routes)}")
    if as_json:
        print(json.dumps({
            "app_dir": str(app_dir), "app_routes": app_routes, "routes": ROUTES,
            "probed": probed, "excluded": {k: EXCLUDED_ROUTES[k] for k in excluded},
            "missing": missing, "stale_probes": stale_probes,
            "stale_exclusions": stale_exclusions,
        }, indent=2))
        print(summary)
    else:
        print(summary)
        for route in missing:
            print(f"  MISSING {route} — not in ROUTES and not in EXCLUDED_ROUTES")
        if stale_probes:
            print(f"  stale probes (no page route in the tree): {', '.join(stale_probes)}")
        if stale_exclusions:
            print(f"  stale exclusions (no page route in the tree): {', '.join(stale_exclusions)}")
        for route in probed:
            covered_by = [p for p in ROUTES if _probe_matches_route(p, route)]
            print(f"  probe   {route}"
                  + (f"  (via {', '.join(covered_by)})" if route != covered_by[0] else ""))
        for route in excluded:
            print(f"  exclude {route} — {EXCLUDED_ROUTES[route]}")
    if missing:
        print(f"ROUTES_FAIL: {len(missing)} app page route(s) neither probed nor excluded — "
              "add each to ROUTES, or to EXCLUDED_ROUTES with the reason it cannot be probed")
        return 1
    if strict and (stale_probes or stale_exclusions):
        print("ROUTES_FAIL: "
              f"{len(stale_probes)} stale probe(s), {len(stale_exclusions)} stale exclusion(s) — "
              "the harness names routes the tree no longer serves")
        return 1
    print(f"ROUTES_OK: ROUTES matches the app tree (app={len(app_routes)} "
          f"covered={len(ROUTES)} excluded={len(excluded)})")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="mode", required=True)

    c = sub.add_parser("capture")
    c.add_argument("--base-url", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--routes", default=None)

    m = sub.add_parser("compare")
    m.add_argument("--base-url", required=True)
    m.add_argument("--baseline", required=True)
    m.add_argument("--routes", default=None)
    m.add_argument("--out-json", default=None)
    m.add_argument("--budget", default=None,
                   help="JSON budget: {expected:[{route,prop,from,to,reason}], rules:[...]}")
    m.add_argument("--strict", action="store_true",
                   help="compare every property incl. volatile ones (color)")

    r = sub.add_parser("routes")
    r.add_argument("--check", action="store_true",
                   help="derive the app's page routes from the tree and fail on drift (required)")
    r.add_argument("--app-dir", default=None,
                   help="the src/app directory to derive from (default: this file's repo)")
    r.add_argument("--json", action="store_true", help="emit the derivation as JSON")
    r.add_argument("--strict", action="store_true",
                   help="also fail when a probe/exclusion names a route the tree no longer serves")
    args = ap.parse_args(argv)
    if args.mode == "routes":
        if not args.check:
            ap.error("routes requires --check")
        app_dir = (Path(args.app_dir) if args.app_dir
                   else Path(__file__).resolve().parents[2] / "src" / "app")
        if not app_dir.is_dir():
            print(f"ROUTES_FAIL: no app directory at {app_dir}")
            return 1
        return check_routes(app_dir, args.json, args.strict)
    routes = [r.strip() for r in args.routes.split(",")] if args.routes else ROUTES
    if not routes or routes == [""]:
        routes = ROUTES

    if args.mode == "capture":
        capture(args.base_url, routes, args.out)
        return 0
    return compare(args.base_url, args.baseline, routes, args.out_json,
                   args.budget, args.strict)


if __name__ == "__main__":
    raise SystemExit(main())
