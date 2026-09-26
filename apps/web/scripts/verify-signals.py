#!/usr/bin/env python3
"""
Contract check for the data-public.vercel.app integration in fudcourt.

Everything asserted here was measured against the live upstream, not guessed.
The point is drift detection: if upstream changes a status code, renames a
field, drops a metric, or starts serving a combination it used to reject, this
exits non-zero instead of the UI quietly rendering wrong numbers.

Usage:
    python3 scripts/verify-signals.py [--base http://127.0.0.1:3100]

Exit codes:
    0  every expectation held
    1  at least one expectation failed

Loud failure only: a failed assertion prints what was expected, what arrived,
and never substitutes a default that could be mistaken for real data.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:3100"
UPSTREAM = "https://data-public.vercel.app"

# --- the measured contract -------------------------------------------------
# chain support is NOT uniform across modes: index rejects `all` upstream.
CHAIN_BY_MODE = {
    "index": {"solana", "robinhood"},
    "feed": {"solana", "robinhood", "all"},
    "page": {"solana", "robinhood", "all"},
    "scoreboard": {"solana", "robinhood"},
}

# Out-of-range page handling, measured against upstream (see verify_clamp):
#   n < 2 -> 400 "bad chain or page"   |   n > 10 -> 404 "no such page"
# An earlier proxy silently clamped these and answered 200 with someone
# else's rows, so these are asserted explicitly -- a regression here means the
# UI could show page 2's data while claiming to show something else.
PAGE_REJECTED = {0: 400, 1: 400, -1: 400, 11: 404, 12: 404}

# metrics that are genuinely absent on some/all rows -- absence must render as
# "not present", never be coerced to 0. Recorded as expected-null, not a count.
SPARSE_METRICS = ("liq", "score", "holdersCount", "topHolderPct", "sightings", "price")

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"

results: list[tuple[bool, str, str]] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    results.append((ok, label, detail))
    mark = f"{GREEN}PASS{RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"  [{mark}] {label}" + (f"  {DIM}{detail}{RESET}" if detail else ""))
    return ok


def get(url: str, timeout: int = 40) -> tuple[int, dict | str | None]:
    """Returns (status, parsed-json | raw-text | None). Never raises on HTTP."""
    req = urllib.request.Request(url, headers={"User-Agent": "fudcourt-verify/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        # An HTTPError IS a response: the body carries the `error` message we
        # want to assert on. Discarding it makes every rejection look like a
        # dead server, which is a false failure, not a real signal.
        try:
            err_body = e.read()
        except Exception:
            err_body = b""
        try:
            return e.code, json.loads(err_body)
        except Exception:
            return e.code, err_body[:200].decode("utf-8", "replace")
    except Exception as e:
        return 0, f"{type(e).__name__}: {e}"
    try:
        return status, json.loads(body)
    except Exception:
        return status, body[:200].decode("utf-8", "replace")


def as_dict(body: object) -> dict:
    """
    Narrow a response body to a dict, or fail loudly.

    Every assertion below depends on a JSON *object* arriving. If a body is a
    string (HTML error page, empty body) or None, the honest move is to say so
    -- not to carry on and report a confusing downstream AttributeError.
    """
    if isinstance(body, dict):
        return body
    preview = body if isinstance(body, str) else type(body).__name__
    return {"__unexpected__": preview[:120]}


def unexpected(body: dict) -> str | None:
    """Return a description when the body is not a usable JSON object."""
    if "__unexpected__" in body:
        return f"body was {body['__unexpected__']!r}, not a JSON object"
    return None


def section(title: str) -> None:
    print(f"\n{YELLOW}▸ {title}{RESET}")


# --- 1. mode x chain status matrix ----------------------------------------
def verify_matrix(base: str) -> None:
    section("mode x chain status matrix (matches upstream validation)")
    for mode in ("index", "feed", "page"):
        for chain in ("solana", "robinhood", "all"):
            q = f"&chain={chain}" + ("&n=2" if mode == "page" else "")
            status, body = get(f"{base}/api/signals?type={mode}{q}")
            data = as_dict(body)
            bad = unexpected(data)
            if bad:
                check(False, f"{mode}/{chain} returned a JSON object", bad)
                continue
            supported = chain in CHAIN_BY_MODE[mode]
            if supported:
                check(status == 200 and not data.get("error"),
                      f"{mode}/{chain} -> 200, no error key", f"got {status}")
            else:
                check(status == 400 and "error" in data,
                      f"{mode}/{chain} -> 400 with a message (unsupported upstream)",
                      f"got {status}")

    for label, query in (("unknown mode", "type=bogus"),
                         ("unknown chain", "type=index&chain=base")):
        status, body = get(f"{base}/api/signals?{query}")
        data = as_dict(body)
        bad = unexpected(data)
        check(not bad and status == 400 and "error" in data,
              f"{label} -> 400 with a message",
              bad or f"got {status}")


# --- 2. page validation ----------------------------------------------------
def verify_clamp(base: str) -> None:
    section("page validation (mirrors upstream: 400 below 2, 404 above 10)")
    for n in sorted(PAGE_REJECTED):
        want = PAGE_REJECTED[n]
        status, body = get(f"{base}/api/signals?type=page&chain=solana&n={n}")
        data = as_dict(body)
        bad = unexpected(data)
        if bad:
            check(False, f"n={n} -> {want}", f"body was {bad}")
            continue
        ok = status == want and "error" in data
        check(ok, f"n={n} -> {want} with an error (never a clamped 200)",
              f"got {status}" + (f" {data.get('error')!r}" if status != want else ""))

    for n in (2, 5, 10):
        status, body = get(f"{base}/api/signals?type=page&chain=solana&n={n}")
        data = as_dict(body)
        bad = unexpected(data)
        if bad or status != 200:
            check(False, f"n={n} -> 200", bad or f"got {status}")
            continue
        check(data.get("page") == n, f"n={n} served verbatim (page={data.get('page')})",
              f"asked {n}, got page {data.get('page')!r}")


# --- 3. payload shape -------------------------------------------------------
def verify_shapes(base: str) -> None:
    section("row payload shape")
    status, body = get(f"{base}/api/signals?type=index&chain=solana")
    data = as_dict(body)
    bad = unexpected(data)
    if bad or status != 200:
        check(False, "index/solana -> 200", bad or f"got {status}")
        return

    rows = data.get("rows")
    if not isinstance(rows, list) or not rows:
        check(False, "index returns a non-empty rows array",
              f"rows={type(rows).__name__}")
        return
    check(True, "index returns a non-empty rows array", f"{len(rows)} rows")
    rows = [r for r in rows if isinstance(r, dict)]
    if len(rows) != len(data["rows"]):
        check(False, "every entry in rows is an object",
              f"{len(data['rows']) - len(rows)} non-object entries")
        return
    check(True, "every entry in rows is an object")

    required = ("id", "ts", "kind", "chain", "mint", "symbol", "mcap", "url")
    missing = [f for f in required if any(f not in r for r in rows)]
    check(not missing, f"every row carries {', '.join(required)}",
          f"missing in some rows: {missing}" if missing else "")

    # sparsity is a real property of the data, not a bug -- but it must be
    # observed, otherwise a future "coerce missing to 0" regression is invisible.
    print(f"  {DIM}metric presence across {len(rows)} index rows:{RESET}")
    for m in SPARSE_METRICS:
        present = sum(1 for r in rows if m in r)
        pct = (present / len(rows)) * 100
        note = "" if present == len(rows) else "  <- must render as absent, not 0"
        print(f"    {DIM}{m:14} {present}/{len(rows)} ({pct:.1f}%){note}{RESET}")

    zero_liq = sum(1 for r in rows if r.get("liq") == 0)
    check(True, f"liq==0 on {zero_liq} rows (informational — distinguish real 0 from absent)")


# --- 4. scoreboard is a different payload family ---------------------------
def verify_scoreboard(base: str) -> None:
    section("scoreboard payload family")
    status, body = get(f"{base}/api/signals?type=scoreboard")
    data = as_dict(body)
    bad = unexpected(data)
    if bad or status != 200:
        check(False, "scoreboard -> 200", bad or f"got {status}")
        return

    check(data.get("kind") == "scoreboard", "kind == 'scoreboard'", f"got {data.get('kind')!r}")
    chains = data.get("chains")
    check(isinstance(chains, dict) and bool(chains), "chains is a non-empty object",
          f"got {type(chains).__name__}")
    check("rows" not in data or data["rows"] == [],
          "scoreboard carries no `rows` (would be a mis-wired normalizer)",
          "found a rows key")
    if not isinstance(chains, dict) or not chains:
        return

    bad_buckets = []
    for chain, board in chains.items():
        series = board.get("series") if isinstance(board, dict) else None
        if not isinstance(series, list) or not series:
            bad_buckets.append(f"{chain}: empty or non-list series")
            continue
        for s in series:
            if not isinstance(s, dict) or not all(k in s for k in ("run", "flat", "dump", "unknown", "n")):
                bad_buckets.append(f"{chain}: series point missing keys")
                continue
            parts = s["run"] + s["flat"] + s["dump"] + s["unknown"]
            if parts != s["n"]:
                bad_buckets.append(f"{chain} {s.get('day')}: parts={parts} != n={s['n']}")
    check(not bad_buckets, "bucket identity run+flat+dump+unknown == n holds on every series point",
          "; ".join(bad_buckets[:3]))


# --- 5. merged view ---------------------------------------------------------
def verify_merged(base: str) -> None:
    section("merged chain view")
    status, body = get(f"{base}/api/signals?type=feed&chain=all")
    data = as_dict(body)
    bad = unexpected(data)
    if bad or status != 200:
        check(False, "feed/all -> 200", bad or f"got {status}")
        return

    counts = data.get("counts")
    if not isinstance(counts, dict):
        check(False, "merged counts is an object", f"got {type(counts).__name__}")
        return
    rh, sol = counts.get("rh"), counts.get("sol")
    check(isinstance(rh, int) and isinstance(sol, int),
          "merged counts split into rh and sol", f"rh={rh!r} sol={sol!r}")

    rows = [r for r in (data.get("rows") or []) if isinstance(r, dict)]
    observed = {r.get("chain") for r in rows}
    check(len(observed) > 1 and observed <= {"solana", "robinhood", None},
          "merged rows carry a per-row chain tag", f"observed {observed}")
    if isinstance(rh, int) and isinstance(sol, int):
        check(rh + sol == counts.get("rows"), "rh + sol == total rows",
              f"{rh}+{sol} vs {counts.get('rows')!r}")


# --- 6. failure is loud ----------------------------------------------------
def verify_failure_loud(base: str) -> None:
    section("failure is loud (never an empty success)")
    # Rejections must be loud: a 4xx with a message, never a 200 with no rows.
    for label, query, want in (("bad mode", "type=bogus", 400),
                               ("bad chain", "type=index&chain=base", 400),
                               ("n below range", "type=page&chain=solana&n=0", 400),
                               ("n above range", "type=page&chain=solana&n=11", 404)):
        status, body = get(f"{base}/api/signals?{query}")
        data = as_dict(body)
        bad = unexpected(data)
        check(not bad and status == want and "error" in data,
              f"{label} -> {want} carrying an `error` field",
              bad or f"status {status}")

    status, body = get(f"{base}/api/signals?type=index&chain=solana")
    data = as_dict(body)
    if unexpected(data) is None and status == 200:
        check(isinstance(data.get("rows"), list) and "error" not in data,
              "success responses carry rows and no error key")
    else:
        check(False, "success baseline reachable",
              f"status {status} — upstream appears down, other results unreliable")


# --- 7. upstream reachability ---------------------------------------------
def verify_upstream() -> None:
    section("upstream reachability")
    for path in ("/api/index?chain=solana", "/api/feed?chain=robinhood",
                 "/api/page?chain=solana&n=2", "/api/scoreboard"):
        status, _ = get(UPSTREAM + path)
        check(status == 200, f"upstream {path} -> 200", f"got {status}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--skip-upstream", action="store_true")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    started = time.time()

    print(f"{DIM}fudcourt x data-public contract check -> {base}{RESET}")

    verify_matrix(base)
    verify_clamp(base)
    verify_shapes(base)
    verify_scoreboard(base)
    verify_merged(base)
    verify_failure_loud(base)
    if not args.skip_upstream:
        verify_upstream()

    passed = sum(1 for ok, _, _ in results if ok)
    failed = len(results) - passed
    dur = time.time() - started

    print()
    if failed:
        print(f"{RED}{failed} FAILED{RESET}, {passed} passed in {dur:.1f}s")
        print(f"{DIM}An upstream contract change or a regression in the proxy.{RESET}")
        return 1
    print(f"{GREEN}all {passed} checks passed{RESET} in {dur:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
