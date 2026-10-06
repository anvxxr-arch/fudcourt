#!/usr/bin/env python3
"""
Contract check for the Rust `/api/reconcile` service (DR-014).

Two things are being proved here and they are different:

1. THE SERVICE'S OWN CONTRACT, against the live Postgres database: the three routes
   (healthz / api/reconcile / 404), the method refusal, the payload shape, and the
   arithmetic INVARIANTS that hold for any dataset -- `expected = in_sum - out_sum`,
   `diff = current - expected`, rows sorted by |diff| descending, `walletSummary`
   agreeing with the rows it summarises, and `current_total` counting only the
   stablecoin legs (the route's documented quirk, preserved not "fixed").

2. PARITY WITH THE ORIGINAL TS SHAPER, which is what makes the port trustworthy
   rather than merely plausible. The shaper is run in-process on the same rows via
   `bun apps/web/…` is the historical invocation; the probe now lives at
   `scripts/verify/parity-reconcile.ts` and is run with cwd=apps/web so the
   app's `@/…` imports resolve. The two payloads are diffed section
   by section, JSON key order included. If bun is unavailable the parity half is
   SKIPPED loudly -- never silently downgraded to "passed".

An invariant check over the REAL rows is stronger than a fixture: it is checked
against whatever the database currently holds, so it keeps working when the data
changes (which is the entire reason this service exists).

Usage:
    python3 scripts/verify/verify-reconcile.py [--base http://127.0.0.1:3102] [--no-parity]
Exit codes:
    0  every expectation held
    1  at least one expectation failed
"""
from __future__ import annotations
import argparse
import json
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:3102"
from functools import partial
from verifylib import call_plain as call, check, jload
from verifylib import note_join
from verifylib import GREEN, RED, DIM, RESET
note = partial(note_join, maxlen=200)
results: list[tuple[bool, str, str]] = []
skipped: list[str] = []










def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--no-parity", action="store_true",
                    help="skip the in-process TS parity half (it needs bun + the live DB)")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    print(f"Rust /api/reconcile contract check -- base {base}")

    # ---------------------------------------------------------------- healthz
    st, h, b = call(f"{base}/healthz")
    j = jload(b) or {}
    check(st == 200, "GET /healthz -> 200", note("got", st))
    check(j.get("ok") is True, "/healthz reports ok", note("got", j.get("ok")))
    check(j.get("service") == "reconcile", "/healthz names the service", note("got", j.get("service")))
    check(isinstance(j.get("rows"), int), "/healthz carries a live row count",
          note("rows", j.get("rows")))
    health_rows = j.get("rows")

    # ------------------------------------------------------------ the refusal
    st, _, b = call(f"{base}/nope")
    check(st == 404, "an unserved path -> 404", note("got", st))
    st, _, b = call(f"{base}/api/reconcile", method="POST")
    check(st == 405, "POST /api/reconcile -> 405", note("got", st))
    j = jload(b) or {}
    check(j.get("error") == "method not allowed", "the 405 names the refusal",
          note("got", str(j.get("error"))[:40]))

    # -------------------------------------------------------- the real payload
    t0 = time.time()
    st, h, b = call(f"{base}/api/reconcile")
    dt = time.time() - t0
    check(st == 200, "GET /api/reconcile -> 200", note("got", st, f"{dt:.2f}s"))
    check(h.get("Content-Type") == "application/json", "the body is JSON",
          note("got", h.get("Content-Type")))
    check(h.get("Cache-Control") == "no-store", "the response is not cacheable",
          note("got", h.get("Cache-Control")))
    body = jload(b)
    if not isinstance(body, dict):
        check(False, "the body parses as a JSON object", note("got", b[:80]))
        return finish()
    check(True, "the body parses as a JSON object", note(f"{len(b)} bytes"))

    for k in ("rows", "wallets", "walletSummary", "source"):
        check(k in body, f"the body carries `{k}`")
    check(body.get("source") == "rust", "`source` names the implementation",
          note("got", body.get("source")))

    rows = body.get("rows")
    wallets = body.get("wallets")
    summary = body.get("walletSummary")
    if not isinstance(rows, list) or not isinstance(summary, dict) or not isinstance(wallets, list):
        check(False, "rows/walletSummary/wallets have the right JSON types")
        return finish()
    check(True, "rows/walletSummary/wallets have the right JSON types",
          note(f"{len(rows)} rows, {len(wallets)} wallets, {len(summary)} summaries"))

    # The healthz row count and the payload row count are two independent reads of
    # the same table, so agreement here is a real cross-check rather than a echo.
    check(isinstance(health_rows, int) and health_rows == len(rows),
          "healthz row count matches the payload", note(health_rows, "vs", len(rows)))

    # ------------------------------------------------------- row-level invariants
    need = ("wallet", "asset", "current", "in_sum", "out_sum", "expected", "diff")
    missing = [k for r in rows[:50] for k in need if k not in r]
    check(not missing, "every row carries all seven fields", note("missing", missing[:5]))

    arith_ok, arith_bad = True, None
    for r in rows:
        if abs(r["expected"] - (r["in_sum"] - r["out_sum"])) > 1e-9:
            arith_ok, arith_bad = False, ("expected", r)
            break
        if abs(r["diff"] - (r["current"] - r["expected"])) > 1e-9:
            arith_ok, arith_bad = False, ("diff", r)
            break
    check(arith_ok, "expected = in_sum - out_sum AND diff = current - expected", note(str(arith_bad or "")[:120]))

    diffs = [abs(r["diff"]) for r in rows]
    check(diffs == sorted(diffs, reverse=True), "rows are sorted by |diff| descending",
          note("first 3:", [round(d, 2) for d in diffs[:3]]))

    # A stored 0 is REAL data (the sync's rule is that a FAILED RPC never becomes
    # 0, so a 0 here means the balance was genuinely read as zero). What can be
    # asserted without ground truth is that the board is not ZEROED -- an empty or
    # all-zero payload is the shape a silent upstream failure takes.
    nonzero = [r for r in rows if r["current"] or r["in_sum"] or r["out_sum"]]
    check(bool(nonzero), "the board carries real values (not an all-zero payload)",
          note(f"{len(nonzero)}/{len(rows)} rows non-zero"))
    # A row with no transaction history must have expected 0 -- anything else would
    # be an expectation conjured from nothing.
    phantom = [r for r in rows if r["in_sum"] == 0 and r["out_sum"] == 0 and r["expected"] != 0]
    check(not phantom, "a row with no transaction history has expected == 0",
          note("count", len(phantom), str(phantom[:1])[:80]))

    # ---------------------------------------------------- summary agrees with rows
    recomputed: dict[str, dict[str, float]] = {}
    for r in rows:
        s = recomputed.setdefault(r["wallet"], {"current_total": 0.0, "expected_total": 0.0, "diff_total": 0.0})
        if r["asset"] in ("USDC", "USDT"):
            s["current_total"] += r["current"]
        s["expected_total"] += r["expected"]
        s["diff_total"] += r["diff"]
    same_keys = set(recomputed) == set(summary)
    check(same_keys, "walletSummary keys are exactly the wallets the rows mention",
          note("rows:", len(recomputed), "summary:", len(summary)))
    mismatch = []
    for w, s in recomputed.items():
        got = summary.get(w) or {}
        for k, v in s.items():
            if abs(float(got.get(k, 0)) - v) > 1e-9:
                mismatch.append((w, k, v, got.get(k)))
    check(not mismatch, "every walletSummary total equals the rows it summarises",
          note(str(mismatch[:2])[:120]))

    # The stablecoin-only quirk: if any wallet holds a non-stablecoin leg, its
    # current_total must EXCLUDE that leg. Asserting the quirk is the point -- a
    # reader who "fixes" it would silently re-score every wallet.
    nonstable = [(r["wallet"], r["asset"], r["current"]) for r in rows
                 if r["asset"] not in ("USDC", "USDT") and r["current"] != 0]
    if nonstable:
        w0 = nonstable[0][0]
        rows_current_all = sum(r["current"] for r in rows if r["wallet"] == w0)
        rows_current_stable = sum(r["current"] for r in rows if r["wallet"] == w0 and r["asset"] in ("USDC", "USDT"))
        got = float((summary.get(w0) or {}).get("current_total", -1))
        check(abs(got - rows_current_stable) < 1e-9 and abs(got - rows_current_all) > 1e-9,
              "current_total counts ONLY the stablecoin legs (documented quirk)",
              note(w0[:10], "stable", round(rows_current_stable, 2), "all", round(rows_current_all, 2), "got", got))
    else:
        skipped.append("no wallet currently holds a non-stablecoin leg, so the stablecoin-only quirk is not observable")
        print(f"  [{DIM}SKIP{RESET}] current_total stablecoin-only quirk  {DIM}{skipped[-1]}{RESET}")

    # The wallets echo is the raw SELECT, so it must still carry its six columns.
    wneed = ("address", "label", "alias", "emoji", "color", "chain")
    wmissing = [k for w in wallets for k in wneed if k not in w]
    check(not wmissing, "the wallets echo carries every selected column",
          note("missing", wmissing[:5]))

    # ------------------------------------------------------------ TS parity half
    if args.no_parity:
        skipped.append("--no-parity was passed")
        print(f"  [{DIM}SKIP{RESET}] parity vs the TS shaper  {DIM}--no-parity{RESET}")
    else:
        # The probe moved to scripts/verify/ with this harness (it is the parity half
        # of a repo-wide gate) but still imports the app's `@/…` modules. Bun resolves
        # tsconfig `paths` relative to the ENTRYPOINT, so running a repo-root file with
        # cwd=apps/web is not enough — the app tsconfig must be named explicitly
        # (verified: without this flag bun fails with "Cannot find module
        # '@/platform/db/client'").
        probe = pathlib.Path(__file__).resolve().parent / "parity-reconcile.ts"
        web = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "web"
        if not probe.exists():
            check(False, "the parity probe exists", note(str(probe)))
        else:
            t0 = time.time()
            r = subprocess.run(
                ["bun", "--tsconfig-override", str(web / "tsconfig.json"), str(probe), base],
                cwd=str(web),
                capture_output=True, text=True, timeout=180,
            )
            out = (r.stdout or "") + (r.stderr or "")
            # Bun prints an informational `Internal error: directory mismatch …` on
            # stderr when the entrypoint and cwd differ; it is not the verdict, so the
            # reported tail is the last REAL line of the probe's own output.
            lines = [l for l in out.splitlines() if not l.startswith("Internal error:")]
            tail = lines[-1] if lines else ""
            check(r.returncode == 0, "the live TS shaper and the Rust service agree on every section",
                  note(f"{time.time() - t0:.1f}s", tail[:140]))
            for line in lines:
                if line.startswith(("FAIL", "PARITY")):
                    print(f"    {DIM}{line[:180]}{RESET}")

    return finish()


def finish() -> int:
    passed = sum(1 for ok, _, _ in results if ok)
    failed = [(lbl, det) for ok, lbl, det in results if not ok]
    report = {
        "base": DEFAULT_BASE,
        "pass": passed, "fail": len(failed), "skipped": skipped,
        "failures": [{"label": l, "detail": d} for l, d in failed],
    }
    print()
    if failed:
        print(f"{RED}{len(failed)} FAILED{RESET}, {passed} passed"
              + (f", {len(skipped)} skipped" if skipped else ""))
        for lbl, det in failed:
            print(f"  {RED}x{RESET} {lbl}  {DIM}{det}{RESET}")
    else:
        print(f"{GREEN}all {passed} checks passed{RESET}"
              + (f", {len(skipped)} skipped" if skipped else ""))
    out = pathlib.Path(__file__).resolve().parent / "reconcile-report.json"
    out.write_text(json.dumps(report, indent=1) + "\n")
    print(f"  {DIM}report -> {out}{RESET}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
