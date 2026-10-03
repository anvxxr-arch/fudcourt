"""DOM audit for the repurpose-aligned surfaces: the crypto section's Prices tab
(must hit /api/markets, NOT CoinGecko directly from the browser). Loud failures
and missing rows FAIL.

The standalone /tracker route folded into /market/crypto as the "Prices" tab, so
this mounts the hub and switches to that tab -- the assertion is unchanged: the
top-250 board must be served by our own proxy, never fetched from coingecko.com
in the browser.

Run: SWEEP_BASE=http://127.0.0.1:3100 ~/.hermes/cache/scratch/crvenv/bin/python <this>
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

    # ---- /market/crypto > Prices: proxied only, no browser->coingecko direct ----
    print("== /market/crypto (Prices tab) ==")
    xhrs: list[str] = []
    page.on("request", lambda r: xhrs.append(r.url))
    page.goto(f"{BASE}/market/crypto", wait_until="networkidle", timeout=60_000)
    page.click('button:has-text("Prices")')
    page.wait_for_selector("tbody tr", timeout=60_000)
    page.wait_for_timeout(3_000)
    body = page.inner_text("body")
    check("prices: no loud error", "Failed" not in body and "HTTP " not in body, body[:120].replace("\n", " "))
    rows = page.locator("tbody tr").count()
    check("prices: table rows > 0", rows > 0, f"rows={rows}")
    direct = [u for u in xhrs if "coingecko.com" in u]
    check("prices: NO direct CoinGecko call from browser", not direct, str(direct[:2]))
    check("prices: fetches proxied /api/markets", any("/api/markets" in u for u in xhrs),
          str([u for u in xhrs if "api/" in u][:2]))

    browser.close()

print(f"\nDOM_AUDIT: {len(PASSES)} passed, {len(FAILS)} failed")
for f in FAILS:
    print("  FAIL:", f)
sys.exit(1 if FAILS else 0)
