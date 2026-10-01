"""DOM audit for the repurpose-aligned surfaces: /tracker (must hit /api/markets, NOT CoinGecko
directly from the browser), /markets. Loud failures and missing rows FAIL.

Run: SWEEP_BASE=http://127.0.0.1:3100 ~/.hermes/cache/scratch/crvenv/bin/python <this>
Drop the /markets check until such a page exists (it was an empty stub dir,
removed 2026-09-28 -- nothing linked it).
"""
import sys
from playwright.sync_api import sync_playwright

import os
BASE = os.environ.get("SWEEP_BASE", "http://127.0.0.1:3100")
FAILS: list[str] = []
PASSES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        PASSES.append(name)
    else:
        FAILS.append(f"{name} -- {detail}")
    print(f"  [{'PASS' if cond else 'FAIL'}] {name} {detail}")


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()

    # ---- /tracker: proxied only, no browser->coingecko direct ----------
    print("== /tracker ==")
    xhrs: list[str] = []
    page.on("request", lambda r: xhrs.append(r.url))
    page.goto(f"{BASE}/tracker", wait_until="networkidle", timeout=60_000)
    page.wait_for_timeout(3_000)
    body = page.inner_text("body")
    check("tracker: no loud error", "Failed" not in body and "HTTP " not in body, body[:120].replace("\n", " "))
    rows = page.locator("tbody tr").count()
    check("tracker: table rows > 0", rows > 0, f"rows={rows}")
    direct = [u for u in xhrs if "coingecko.com" in u]
    check("tracker: NO direct CoinGecko call from browser", not direct, str(direct[:2]))
    check("tracker: fetches proxied /api/markets", any("/api/markets" in u for u in xhrs),
          str([u for u in xhrs if "api/" in u][:2]))

    browser.close()

print(f"\nDOM_AUDIT: {len(PASSES)} passed, {len(FAILS)} failed")
for f in FAILS:
    print("  FAIL:", f)
sys.exit(1 if FAILS else 0)
