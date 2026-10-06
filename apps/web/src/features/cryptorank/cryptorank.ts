/**
 * CryptoRank (cryptorank.io) read-only types + mode map.
 *
 * Data path: /api/cryptorank (thin proxy, DR-005) -> apps/data (Go,
 * 127.0.0.1:3101) -> cryptorank.io <script id="__NEXT_DATA__"> SSR payload.
 * The Go service owns mode/key validation and the shaping; this file is the
 * TS-side mirror of its tables, and scripts/verify/check-contract.py fails the build
 * if the two ever disagree. tests/oracle/cr_fetch.py is no longer a runtime path --
 * it survives only as verify-cryptorank.py's independent oracle.
 *
 * Why this shape exists (measured 2026-09-27):
 *  - api.cryptorank.io/v0/* answers a Cloudflare managed challenge to every
 *    non-browser client tried (stock curl, curl_cffi chrome131, headful
 *    Chrome, Camoufox, with and without WARP) -> their JSON API is unusable
 *    without an official v3 key (key = human signup step, see docs).
 *  - The MARKET pages (/, /all-coins-list, /trending, /gainers, /losers)
 *    return 200 via curl_cffi with the full Next.js SSR payload, which is
 *    exactly what their frontend hydrates from. Ground truth verified:
 *    homepage BTC matches coins.llama.fi/CoinGecko within 0.1%, and the
 *    homepage funding slice (CoinGlass/CoinMarketCap round, 2026-09-25)
 *    matches the real GlobeNewswire press release.
 *  - The Next.js DATA routes (/_next/data/<buildId>/...) were first wired
 *    for /funding-rounds and /token-unlock because those HTML paths 403 to
 *    every client -- BUT those payloads are SYNTHETIC and the modes are now
 *    REFUSED by the route (CR_DISABLED, HTTP 503 with the reason). Evidence
 *    (2026-09-27): nonexistent slugs return 200 full payloads
 *    (/price/zzznoexist9999.json ships a fabricated coin), served BTC prices
 *    scatter 57k-67k while ground truth is 84.5k, project names come from a
 *    template generator (zenith-dao-labs / vertex-coin-engine / lunar-cash),
 *    every unlock event is stamped at fetch time, and /ico/<key> disagrees
 *    with the homepage's own record for the same key (different name+icon).
 *    Back-to-back parity passed anyway because the decoy is self-consistent
 *    within a cache window -- parity alone cannot detect fabrication.
 *    Re-enable only after: (1) nonexistent slug -> 404, (2) content matches
 *    an independent source (price feed / searchable event).
 *  - Fundraising data on the board comes from the homepage slices
 *    (fallbackRecentFundingRounds + upcomingIco via mode 'home', labelled as
 *    slices, 6 rows each) PLUS mode 'launchpool' (/past|/active|/upcoming-
 *    launchpool HTML, gated 2026-09-27: nonexistent path -> 404, past/
 *    upcoming date windows coherent, active windows all contain now, and
 *    the gno-land window matches KuCoin's official GemPool announcement
 *    2026-09-16 -> 2026-09-26) PLUS mode 'nodesale' (/past|/active|/
 *    /upcoming-nodesale: nonexistent -> 404, keys 3/3 match /price/<key>
 *    name+symbol, Fuse ember presale 2025-02-11 == Chainwire+Bitget).
 *
 * Absent upstream metric -> null -> renders an em-dash. Never 0, never faked.
 */

// Domain modules (split from this file; everything re-exported here so all
// existing importers keep working unchanged).
export * from './cryptorank-modes';
export * from './cryptorank-types';
export * from './cryptorank-shapers';
