# Source Catalog (Phase 0/1 inventory)

Every data source **actually present in this repository**, walked from the code on
2026-10-01. Nothing here is aspirational: a feed appears only if a file in the tree
fetches it, serves it, or stores it. Sources the scope prompt names but the repo does
not implement are listed in [Absent in this repository](#absent-in-this-repository) and
are never invented.

Scope: task brief supplied to this audit; not stored in-repo. The originating session
transcript is `history://source-inventory`.

**Column meanings**

| Column | Meaning |
|---|---|
| `source_id` | stable slug for the *feed* (not the provider, not an account) |
| `source` | feed-level name — what is actually being read |
| `provider` | the organisation/system the feed belongs to |
| `category` | one of the scope prompt's source types |
| `data produced` | concrete fields/entities the feed yields |
| `current code path` | exact file that implements the read/serve |
| `canonical target` | canonical entity the feed must feed (per scope prompt); `(target)` = does not exist yet |
| `freshness` | REALTIME / NEAR_REALTIME / FREQUENT / PERIODIC / STATIC / MANUAL |
| `durability` | EPHEMERAL / SNAPSHOT / EVENT / HISTORICAL / CANONICAL / NONE (not persisted) |
| `auth required` | `keyless` or the *name* of the env var / credential — **never a value** |
| `status` | active (wired + reachable path) / served (data present but no writer) / scaffolded (code exists, no live wiring) / absent |

Provider ≠ account ≠ source, per the scope prompt: **Binance** is a provider,
**Binance Spot balance feed** is a source, a user's Binance key pair is an *account*
(`executor.exchange_accounts`).

---

## 1. Research / market-aggregator feeds (Go `apps/data` sidecar, :3101)

All five families are served by `apps/data/main.go` on
`127.0.0.1:3101` (`/api/cryptorank`, `/api/khala`, `/api/llama`, `/api/news`,
`/api/chainrank`). Cryptorank/DefiLlama/News are also proxied verbatim by the Next
routes in §9; **Khala and ChainRank are sidecar-only** — their Next
`/api/{khala,chainrank}` proxy routes were removed (DR-041), so `:3101` is their only
surface. The Go sidecar is the acquisition layer; the remaining TS feature clients
keep the last-known upstream constants for the fixture/shaper tooling.

### 1.1 CryptoRank (`https://cryptorank.io`)

Code: `apps/data/internal/research/cryptorank/{fetch.go,modes.go}`
(28 modes declared, `ModeCount = len(Modes)`; 26 recorded live, 2 refused-by-design data-route
only). HTML pages are fetched with a Chrome-131 TLS fingerprint **and** HTTP/2 because
`api.cryptorank.io/v0/*` answers a Cloudflare managed challenge to non-browser clients
(cited live measurement in `fetch.go` doc comment).

| source_id | source | provider | category | data produced (concrete) | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `cr-html-home` | CryptoRank homepage SSR payload | CryptoRank | RESEARCH | global mcap/volume/dominance, top coins, gainers/losers slices | `apps/data/internal/research/cryptorank/fetch.go` | MarketOverview (product view) | FREQUENT | NONE (disk cache 60 s) | keyless | active | fixture `home.json.gz` + `MANIFEST.json` |
| `cr-html-coins` | All-coins list page | CryptoRank | RESEARCH | per-coin rank, symbol, price, 24h/7d change, mcap, volume | same | Asset, Price (target) | FREQUENT | NONE | keyless | active | `MANIFEST.json` mode `coins` |
| `cr-html-trending` | Trending page | CryptoRank | RESEARCH | trending coin rows + ranks | same | Asset (enrichment) | FREQUENT | NONE | keyless | active | `MANIFEST.json` mode `trending` |
| `cr-html-gainers` | Gainers page | CryptoRank | RESEARCH | top gainers with % change | same | Price/MarketData (derived) | FREQUENT | NONE | keyless | active | `MANIFEST.json` mode `gainers` |
| `cr-html-losers` | Losers page | CryptoRank | RESEARCH | top losers with % change | same | Price/MarketData (derived) | FREQUENT | NONE | keyless | active | `MANIFEST.json` mode `losers` |
| `cr-html-categories` | Category list (`/categories/chain`) | CryptoRank | RESEARCH | category slug/name, mcap, volume, change per category | same | Asset classification (target) | PERIODIC | NONE | keyless | active | `MANIFEST.json` mode `categories` |
| `cr-html-exchanges` | Exchange list, strict whitelist `cex/spot,dex/spot,perpetuals,cex-transparency` | CryptoRank | RESEARCH | venue name, 24h volume, trust/score fields | same | Venue (target) | PERIODIC | NONE | keyless | active | `modes.go:ExchangeLists`, `MANIFEST.json` mode `exchanges` |
| `cr-html-coin` | One coin page (`/price/<slug>`) | CryptoRank | RESEARCH | coin profile: price, ATH/ATL, supply, links, market rows | same | Asset + Token (target) | FREQUENT | NONE | keyless | active | `modes.go:KeyedPaths`, `MANIFEST.json` `upstreamUrl` `/price/bitcoin` |
| `cr-html-listings` | Exchange listings page | CryptoRank | RESEARCH | new listing rows (coin, venue, date) | same | Instrument listing event (target) | FREQUENT | NONE | keyless | active | `MANIFEST.json` mode `listings` |
| `cr-html-blockchains` | Blockchains list | CryptoRank | RESEARCH | chain list with TVL/mcap metrics | same | Chain (target) | PERIODIC | NONE | keyless | active | `MANIFEST.json` mode `blockchains` |
| `cr-html-chain` | One chain page (`/blockchains/<slug>`) | CryptoRank | RESEARCH | chain profile + metric rows | same | Chain (target) | PERIODIC | NONE | keyless | active | `modes.go:KeyedPaths` |
| `cr-html-launchpool` | Launchpool event lists (`past,upcoming,active`) | CryptoRank | RESEARCH | launchpool events (project, dates, rewards) | same | Research event (target) | PERIODIC | NONE | keyless | active | `modes.go:LPLists`, fixture `launchpool.json.gz` |
| `cr-html-nodesale` | Node-sale event lists (`past,active,upcoming`) | CryptoRank | RESEARCH | node sale events | same | Research event (target) | PERIODIC | NONE | keyless | active | `modes.go:NDLists`, fixture `nodesale.json.gz` |
| `cr-html-news` | CryptoRank news index | CryptoRank | NEWS | article cards (title, source, time, url) | same | NewsArticle (target) | FREQUENT | NONE | keyless | active | `MANIFEST.json` mode `news` |
| `cr-html-tags` / `cr-html-tag` | Tag list and one tag (`/tags/<slug>`) | CryptoRank | RESEARCH | tag taxonomy + tagged coins | same | taxonomy (target) | PERIODIC | NONE | keyless | active | `MANIFEST.json` modes `tags`,`tag` |
| `cr-html-ecosystems` / `cr-html-ecosystem` | Ecosystem list and one ecosystem | CryptoRank | RESEARCH | ecosystem rows (projects, funding, mcap) | same | Protocol/ProtocolEcosystem (target) | PERIODIC | NONE | keyless | active | `MANIFEST.json` modes `ecosystems`,`ecosystem` |
| `cr-html-rwa` / `cr-html-rwaasset` | RWA lists, strict types `bonds,commodities,etfs,stocks` + asset (`/rwa/stocks/<slug>`) | CryptoRank | RESEARCH | RWA instrument rows (price, yield, mcap) | same | Asset with `asset_type` EQUITY/COMMODITY/INDEX (target) | PERIODIC | NONE | keyless | active | `modes.go:RwaTypes/RwaKeyRe` |
| `cr-html-quarterly` | Quarterly-returns chart page | CryptoRank | RESEARCH | quarterly return series per coin/asset | same | Price history / derived (target) | PERIODIC | NONE | keyless | active | `MANIFEST.json` mode `quarterly` |
| `cr-html-prediction` | Prediction-markets page | CryptoRank | RESEARCH | prediction market rows (Kalshi-style) | same | external event (target) | PERIODIC | NONE | keyless | active | `MANIFEST.json` mode `prediction` |
| `cr-html-converter` | Converter page | CryptoRank | RESEARCH | conversion rates for a coin set | same | Price (target) | FREQUENT | NONE | keyless | active | `MANIFEST.json` mode `converter` |
| `cr-html-media` | Media/news-source page | CryptoRank | NEWS | media outlet rows | same | source registry (target) | STATIC-ish | NONE | keyless | active | `MANIFEST.json` mode `media` |
| `cr-html-newstag` | News by tag (`/news/tag/<slug>`) | CryptoRank | NEWS | tagged article rows | same | NewsArticle (target) | FREQUENT | NONE | keyless | active | `MANIFEST.json` mode `newstag` |
| `cr-html-aioverview` | AI-market-overview page | CryptoRank | RESEARCH | AI-sector aggregate rows | same | sector aggregate (target) | FREQUENT | NONE | keyless | active | `MANIFEST.json` mode `aioverview` |
| `cr-data-funding` | `/_next/data/<buildId>/funding-rounds.json` | CryptoRank | RESEARCH | **refused** — upstream serves synthetic decoy | `modes.go:Disabled` + `DisabledReason` | — | — | NONE | keyless | scaffolded (503 by design) | `modes.go:Disabled = {"funding","unlocks"}` |
| `cr-data-unlocks` | `/_next/data/<buildId>/token-unlock.json` | CryptoRank | RESEARCH | **refused**, same reason | same | — | — | NONE | keyless | scaffolded (503) | same |

Measurement caveats kept from the code: `fetch.go:resolveBuildID` walks the Next.js
`buildId` and caches it 1 h; per-route disk cache default TTL 60 s
(`DefaultCacheDir = "~/.cache/crfetch"`), overridable by `FUDCOURT_DATA_*` vars; the
`--ttl 0` `fresh=1` path bypasses single-flight (comment explains the race that forced a
unique temp file).

### 1.2 Khala (`https://www.khala.io`)

Code: `apps/data/internal/research/khala/{fetch.go,modes.go,parse.go,shape.go}`.
Plain `net/http`, no browser fingerprint needed (upstream answers non-browser UA with a
real 200 — measured, quoted at `modes.go:18-21`). Two source URLs: homepage rows and
`sitemap.xml` (auxiliary enumeration, 11 `<loc>` entries).

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `khala-reports` | khala.io homepage report cards, newest-first | Khala | RESEARCH | report slug, title, category, image; **no dates** | `apps/data/internal/research/khala/fetch.go` | ResearchReport (target) | PERIODIC | NONE | keyless | active | `modes.go` modes `reports`; `HomeURL` |
| `khala-report` | One report page `/ <slug>` | Khala | RESEARCH | report body text, headings, authors, external links | same | ResearchReport (target) | STATIC | NONE | keyless | active | `modes.go` mode `report`, `KeyRe` (128-char max, measured) |
| `khala-latest` | homepage rows + per-report fetches to resolve dates | Khala | RESEARCH | newest N reports *with* `published_at` resolved | same | ResearchReport (target) | PERIODIC | NONE | keyless | active | `modes.go` mode `latest`, `LimitMin/LimitMax` 1–50, default 5 |
| `khala-sitemap` | `https://www.khala.io/sitemap.xml` | Khala | RESEARCH | 11 `<loc>` entries → `upstreamTotal` independent of the homepage parse | `apps/data/internal/research/khala/fetch.go` | enumeration metadata | PERIODIC | NONE | keyless | active | `modes.go:SitemapURL` comment |
| `khala-searchindex` | `framerusercontent.com/sites/<id>/searchIndex.json` | Framer (host) | RESEARCH | Framer search index (used by tests/diagnostics only) | `apps/data/internal/research/khala/fetch.go:128` (comment), `fetch_test.go:362` | raw provider payload | PERIODIC | NONE | keyless | scaffolded | test fixture reference |

### 1.3 DefiLlama (`https://api.llama.fi`)

Code: `apps/data/internal/research/llama/{fetch.go,modes.go,shape.go}`. In-memory
per-process TTL cache, default 15 s (`FUDCOURT_DATA_LLAMA_TTL`), keyed on the upstream
URL; bounded by construction at three URLs.

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `llama-chains` | `GET /v2/chains` | DefiLlama | RESEARCH | per-chain TVL rows (list of 467), re-sorted by TVL desc | `apps/data/internal/research/llama/modes.go` | Protocol/Chain TVL (target) | PERIODIC | NONE | keyless | active | `modes.go` mode `chains`, `DerivedChains` |
| `llama-protocols` | `GET /protocols` (8.9 MB) | DefiLlama | RESEARCH | protocol slug/name/category/chains/tvl, trimmed to `top` head (default 50, max 200) | same | Protocol + TVLObservation (target) | PERIODIC | NONE | keyless | active | `modes.go` mode `protocols`, `TopParam` |
| `llama-historical` | `GET /v2/historicalChainTvl` (3290 pts, oldest-first) | DefiLlama | RESEARCH | `{date, tvl}` tail, default 365 days, max 3288 | same | TVLObservation history (target) | PERIODIC | NONE | keyless | active | `modes.go` mode `historical`, `DaysParam` |

### 1.4 News — Cointelegraph RSS

Code: `apps/data/internal/research/news/{fetch.go,modes.go,parse.go,shape.go}`.

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `news-cointelegraph-rss` | `GET https://cointelegraph.com/rss` (~340 KB, one `<channel>`, 30–100 `<item>`) | Cointelegraph | NEWS | title, link, description, pubDate, optional `media:content` image | `apps/data/internal/research/news/modes.go` (`Sources` table, one row) | NewsArticle (target) | FREQUENT | NONE (TTL cache) | keyless | active | `modes.go:PathRSS`, `Sources = [{cointelegraph …}]` |

The table shape is deliberately kept so a second feed is a table row, not a second code
path (`modes.go` comment). No second feed exists.

### 1.5 ChainRank (`https://www.chainrank.fyi`)

Code: `apps/data/internal/research/chainrank/{fetch.go,modes.go,shape.go}`.

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `chainrank-stats` | `GET /api/stats` | ChainRank | MARKET_DATA | `online, totalClicks, listings, totalUsdCents, topUsdCents, claimTopCents` | `apps/data/internal/research/chainrank/modes.go` | internal site metric (not portfolio data) | REALTIME-ish | NONE | keyless | active | `modes.go:Modes = ["stats","listings"]` |
| `chainrank-listings` | `GET /api/listings?page&pageSize` | ChainRank | MARKET_DATA | listing rows + pagination (`total,totalPages`), params relayed untouched | same | site directory listing (not portfolio) | FREQUENT | NONE | keyless | active | `modes.go:UpstreamURL` |
| `chainrank-writes` | `POST /api/click|presence|claim/*|upload` | ChainRank | — | **deliberately not proxied** (writes) | comment in `modes.go` | — | — | NONE | keyless | absent by design | `modes.go` header comment |

**Path note (correction B).** Every path cited in this document was re-verified with
`test -f` / `test -e` against the tree as it stands now. Two regroupings landed while this
audit ran and **all citations use the post-move paths**: `apps/data/internal/{cryptorank,
khala,llama,news,chainrank,paritytest}` → `apps/data/internal/research/*` and
`apps/data/internal/{cache,httpx}` → `apps/data/platform/*`; `apps/api/internal/
{markets,instruments,ledger,portfolio,treasury,transactions,wallets,exchangeaccounts,
credentials,authorization,entitlements,identity}` → `apps/api/internal/
{markets/{instruments,overview}, finance/*, accounts/{exchange,wallets}, access/*}`.
Paths that refer to a directory rather than an exact file were verified as directories.

### 1.6 CoinGlass (`https://capi.coinglass.com`)

Code: `apps/data/internal/research/coinglass/{modes.go,fetch.go}`. Keyless: this is the dashboard's
own backend, whose body is two rounds of AES-128-ECB+PKCS#7 (see the `fudcourt-development` skill §9).
**No `CG-API-KEY`**, and the official `open-api-v4` host is NOT wired.

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `cg-futures-statistics` | `GET /api/futures/home/statistics` | CoinGlass | DERIVATIVES | futures home statistics (encrypted dashboard body) | `apps/data/internal/research/coinglass/modes.go:UpstreamURL` | derivatives aggregate (target) | FREQUENT | NONE | keyless | active | `curl 127.0.0.1:3101/api/coinglass?mode=statistics` → 200 |
| `cg-open-interest` | `GET /api/openInterest/info?symbol=<SYM>` | CoinGlass | DERIVATIVES | open interest for one symbol (keyed) | same | OpenInterest (target) | FREQUENT | NONE | keyless | active | `curl ...mode=openInterest&symbol=BTC` → 200 |
| `cg-funding-rank` | `GET /api/fundingRate/rank` | CoinGlass | DERIVATIVES | funding-rate rank, 50 most extreme ± | same | FundingRate (target) | FREQUENT | NONE | keyless | active | `curl ...mode=fundingRate` → 200 |
| `cg-futures-markets` | `GET /api/futures/v2/coins/markets` | CoinGlass | DERIVATIVES | futures coins markets table | same | Instrument + derivatives metrics (target) | FREQUENT | NONE | keyless | active | `curl ...mode=markets` → 200 |

### 1.7 CoinAnk (`https://api.coinank.com`)

Code: `apps/data/internal/research/coinank/{modes.go,fetch.go}`. Keyless via a client-computed
signature; **no issued key**, and the official `open-api.coinank.com` host is NOT wired. **All five
modes are LIVE** — the upstream gate that refused every call with HTTP 502
`{"code":"403","detail":"CoinAnk refused the request: please sub api to get data"}` **lifted on
2026-10-07**: a direct GET to `api.coinank.com` answers 200 (5/5 stable, no signature required) and the
sidecar serves every mode (fundingRate 886 / liquidation 10 / longShort 726 / etf 708 / whales 50 rows).

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `ca-funding-rate` | `GET /api/fundingRate/current` | CoinAnk | DERIVATIVES | funding rates, 882 symbols × per-exchange maps | `apps/data/internal/research/coinank/modes.go:UpstreamURL` | FundingRate (target) | FREQUENT | NONE | keyless | active | `curl 127.0.0.1:3101/api/coinank?mode=fundingRate` → 200, upstreamCount 886 |
| `ca-liquidation` | `GET /api/liquidation/allExchange` (interval allowlist 1h/2h/4h/6h/12h/1d) | CoinAnk | DERIVATIVES | per-exchange liquidation turnover | same | liquidation metric (target) | FREQUENT | NONE | keyless | active | `curl ...mode=liquidation` → 200, upstreamCount 10 |
| `ca-long-short` | `GET /api/longshort/all` | CoinAnk | DERIVATIVES | long/short ratios across exchanges | same | long/short ratio (target) | FREQUENT | NONE | keyless | active | `curl ...mode=longShort` → 200, upstreamCount 726 |
| `ca-etf-inflow` | `GET /api/etf/etfInflow` | CoinAnk | MARKET_DATA | daily spot-ETF creations/redemptions | same | ETF flow (target) | FREQUENT | NONE | keyless | active | `curl ...mode=etf` → 200, upstreamCount 708 |
| `ca-whales` | `GET /api/hyper/topPosition` | CoinAnk | DERIVATIVES | Hyperliquid top positions by size | same | large-position metric (target) | FREQUENT | NONE | keyless | active | `curl ...mode=whales` → 200, upstreamCount 50 |

### 1.8 CoinMarketCap (`https://api.coinmarketcap.com/data-api/v3`)

Code: `apps/data/internal/research/coinmarketcap/{modes.go,fetch.go}`. Keyless for a **third**
mechanism — neither an encrypted body to decrypt (CoinGlass) nor a computed signature (CoinAnk):
this is the coinmarketcap.com dashboard's own backend and it takes **no credential of any kind**, so
the fetch is a plain `net/http` GET. The documented `pro-api.coinmarketcap.com` (which needs an issued
`X-CMC_PRO_API_KEY`) is NOT wired — a different product, not an alternative transport. All four modes
are live. A refusal is **HTTP 200 with `status.error_code != "0"`** (not an HTTP status), so the handler
surfaces it as a 502 carrying upstream's code; `limit=0` is a **success** envelope with an **empty
list**, so the pagination bounds are validated locally (a bad value is a 400 before any request).

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `cmc-listing` | `GET /cryptocurrency/listing?start&limit` | CoinMarketCap | MARKET_DATA | ranked coin listing (price/market-cap/volume) | `apps/data/internal/research/coinmarketcap/modes.go:UpstreamURL` | Instrument + quote metrics (target) | FREQUENT | NONE (disk cache) | keyless (none) | active | `curl 127.0.0.1:3101/api/coinmarketcap?mode=listing` → 200 |
| `cmc-global` | `GET /global-metrics/quotes/latest` | CoinMarketCap | MARKET_DATA | global market aggregate (object payload) | same | market aggregate (target) | FREQUENT | NONE (disk cache) | keyless (none) | active | `curl ...mode=global` → 200 |
| `cmc-market-pairs` | `GET /cryptocurrency/market-pairs/latest?slug=<SLUG>` | CoinMarketCap | MARKET_DATA | trading pairs for one coin (`slug` required) | same | Instrument markets (target) | FREQUENT | NONE (disk cache) | keyless (none) | active | `curl ...mode=marketPairs&slug=bitcoin` → 200 (no `slug` → 400) |
| `cmc-exchanges` | `GET /exchange/listing?start&limit` | CoinMarketCap | MARKET_DATA | ranked exchange listing (volume/score) | same | venue metrics (target) | FREQUENT | NONE (disk cache) | keyless (none) | active | `curl ...mode=exchanges` → 200 |

---

## 2. Market-data feeds read directly by the Next.js web tier (:3100)

These bypass `apps/data` entirely: the route handler loads a venue client in-process.

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `ticker-ccxt-spot` | ccxt `fetchTicker` on spot markets | per-venue (see list) | MARKET_DATA | last/bid/ask/high/low/24h change/baseVolume/quoteVolume per venue+symbol | `apps/web/src/app/(frontend)/api/ticker/route.ts` + `apps/web/src/features/market/ticker/{client.ts,venues.ts}` | Ticker/Price (target) | REALTIME | EPHEMERAL (in-memory sweep L2) | keyless (public market data) | active | `TICKER_TYPES=['spot','swap','future','option']`; `TICKER_VENUES` table |
| `ticker-ccxt-swap` | perpetuals (`swap`) | per-venue | MARKET_DATA | as above **+ fundingRate, openInterest** | same | Ticker + FundingRate + OpenInterest (target) | REALTIME | EPHEMERAL | keyless | active | `ticker/instrument/route.ts` `Quote` fields |
| `ticker-ccxt-future` | dated futures | per-venue | MARKET_DATA | ticker fields; expiries enumerated from the venue's own market list | same + `features/ticker/instruments.ts` | Instrument (dated) (target) | REALTIME | EPHEMERAL | keyless | active | `ticker/instruments/route.ts` `expiriesFor` |
| `ticker-ccxt-option` | options | per-venue | MARKET_DATA | ticker fields; strike list from the venue's market list | same | Instrument (option) (target) | REALTIME | EPHEMERAL | keyless | active | `instrumentsFor`/`strikesFor` |
| `markets-coingecko` | CoinGecko `/coins/markets` (public, keyless, GET) | CoinGecko | MARKET_DATA | id, symbol, name, image, current_price, 24h change, high/low, volume, mcap | `features/markets/client.ts:13` → `api/markets/route.ts` | Price + Asset market data (target) | FREQUENT | NONE (TTL cache) | keyless | active | `MARKETS_UPSTREAM`, `MARKETS_POOL = 250` |
| `dex-profiles` | DexScreener `GET /token-profiles/latest/v1` | DexScreener | DEX | token profiles (chain, address, url, description) | `features/dex/client.ts:10` → `api/dex/route.ts` | Token + protocol metadata (target) | FREQUENT | NONE | keyless | active | `DEX = 'https://api.dexscreener.com'`, `DEX_TYPES` |
| `dex-boosts` / `dex-boosts-top` | DexScreener boost feeds | DexScreener | DEX | boosted-token rows | same | Token promotion (target) | FREQUENT | NONE | keyless | active | `DEX_TYPES` |
| `dex-search` | DexScreener `GET /latest/dex/search` | DexScreener | DEX | pair search results across chains | same | Instrument (DEX) (target) | FREQUENT | NONE | keyless | active | `DEX_CHAINS` measured list (incl. NEAR) |
| `dex-tokens` / `dex-tokens-v1` | `GET /tokens/v1/{chain}/{address}` | DexScreener | DEX | token pairs + liquidity/fdv for a mint/contract | same | Pool/LiquidityObservation (target) | FREQUENT | NONE | keyless | active | route comment: 200-with-`[]` for an invalid address → local 400 |
| `dex-pairs` / `dex-token-pairs` | DexScreener pairs by chain/token | DexScreener | DEX | pair rows: priceUsd, priceNative, liquidity, volume, txns | same | Price/LiquidityObservation (target) | FREQUENT | NONE | keyless | active | `isMint` accepts base58/hex/NEAR name |
| `dex-orders` | DexScreener orders surface | DexScreener | DEX | (type declared; probe-verified 200 only) | same | — | FREQUENT | NONE | keyless | active | `DEX_TYPES` entry `orders` |
| `signals-data-public` | `https://data-public.vercel.app` signal/sighting feed | self-hosted external service (`fc.dwirijal.my.id` per Khala UA string; vercel host hardcoded) | ALPHA/SIGNALS | signal rows: mint, symbol, mcap, liq, price, ageMin, score, decision, holders, vetoes, socials, sightings, scoreboard buckets | `apps/web/src/app/(frontend)/api/signals/route.ts:7` | Signal (target) | REALTIME-ish | NONE (proxied) | keyless (no auth header in route) | active | `UPSTREAM = 'https://data-public.vercel.app'` |

**ccxt venues actually loaded** (`TICKER_EXCHANGES`, `features/ticker/client.ts:62`):
`okx, bybit, bitget, mexc, phemex, bingx, bitfinex, htx, coinbase, kraken`; per-type
reachability is the measured table `TICKER_VENUES` (`client.ts:103`). Measured exclusions
recorded in-code: **binance** and **kucoin** futures hosts are TLS-intercepted on this
network (certificate validation fails). Venue module files verified present under
`apps/web/node_modules/ccxt/js/src/<id>.js` (all ten).

Provider-vs-source note: `okx` etc. are **providers/venues**; `ticker-ccxt-swap` is the
**source**; the ccxt API key (if one were ever added) would be the **account**.

---

## 3. On-chain / RPC feeds — Rust `apps/reconciler` (5-minute timer)

Two binaries share the crate (`apps/reconciler/src/lib.rs`): `fudcourt-sync` (batch sync,
`src/main.rs`) and `fudcourt-reconciled` (:3102 HTTP, `src/bin/fudcourt-reconciled.rs`).

### 3.1 EVM balances via Alchemy (`https://<host>/v2/{ALCHEMY_KEY}`)

Registry: `apps/reconciler/src/streams.rs`→`chains.rs` (`EVM` table). One source per chain:

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `alchemy-ethereum` | JSON-RPC `eth_getBalance` (native ETH) + `eth_call` `balanceOf` for USDT/USDC | Alchemy | BLOCKCHAIN_RPC | native wei balance, ERC-20 raw balance per token contract | `apps/reconciler/src/streams/sync.rs:219` (`https://{host}/v2/{ALCHEMY}`) | Balance (native + token) (target) | PERIODIC (5 min) | SNAPSHOT (rewrites `assets`) | `ALCHEMY_KEY` | active | `.env:ALCHEMY_KEY`, capture key `rpc|https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY}|…` |
| `alchemy-bsc` | same, chain BSC / BNB | Alchemy | BLOCKCHAIN_RPC | wei + USDT/USDC raw | same | Balance (target) | PERIODIC | SNAPSHOT | `ALCHEMY_KEY` | active | `chains.rs` `bnb-mainnet.g.alchemy.com` |
| `alchemy-polygon` | same, Polygon / POL (row labelled `MATIC`) | Alchemy | BLOCKCHAIN_RPC | wei + USDT/USDC raw | same | Balance (target) | PERIODIC | SNAPSHOT | `ALCHEMY_KEY` | active | `chains.rs` note on POL/MATIC label |
| `alchemy-arbitrum` | same, Arbitrum (native labelled ETH) | Alchemy | BLOCKCHAIN_RPC | wei + USDT/USDC raw | same | Balance (target) | PERIODIC | SNAPSHOT | `ALCHEMY_KEY` | active | `chains.rs` |
| `alchemy-optimism` | same, Optimism | Alchemy | BLOCKCHAIN_RPC | wei + USDT/USDC raw | same | Balance (target) | PERIODIC | SNAPSHOT | `ALCHEMY_KEY` | active | `chains.rs` |
| `alchemy-base` | same, Base (USDC only) | Alchemy | BLOCKCHAIN_RPC | wei + USDC raw | same | Balance (target) | PERIODIC | SNAPSHOT | `ALCHEMY_KEY` | active | `chains.rs` |

Token contracts (canonical, from `chains.rs`): USDT/USDC on Ethereum, BSC,
Polygon, Arbitrum, Optimism; USDC on Base. ERC-20 selector `0x70a08231`.

### 3.2 Solana

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `solana-balance` | JSON-RPC `getBalance` | Solana public RPC (`api.mainnet-beta.solana.com`) | BLOCKCHAIN_RPC | lamports → SOL | `apps/reconciler/src/streams/sync.rs` (`SOLANA_RPC`) | Balance (target) | PERIODIC | SNAPSHOT | keyless | active | `chains.rs:SOLANA_RPC`; capture key `rpc|https://api.mainnet-beta.solana.com|getBalance|…` |
| `solana-token-accounts` | JSON-RPC `getTokenAccountsByOwner` (program `Tokenkeg…`) | Solana public RPC | BLOCKCHAIN_RPC | SPL token accounts → mint, `uiAmount` | same | Balance (target) | PERIODIC | SNAPSHOT | keyless | active | `chains.rs:TOKEN_PROGRAM_ID`; capture key present |

### 3.3 Hyperliquid

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `hyperliquid-state` | `POST https://api.hyperliquid.xyz/info` — `clearinghouseState`, `spotClearinghouseState`, `userFills` | Hyperliquid | DEX/MARKET_DATA | perp positions (`szi`, entry/mark, unrealized PnL, leverage), spot balances, user fills | `apps/reconciler/src/streams/sync.rs` (`HYPERLIQUID_INFO`) | Position + Balance + Fill (target) | PERIODIC | SNAPSHOT | keyless for these info endpoints (wallet address in body) | active | `chains.rs:HYPERLIQUID_INFO`; capture keys `hl|{"type":"clearinghouseState"…}` |

### 3.4 Price oracle used to value the balances

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `llama-coins-prices` | `GET https://coins.llama.fi/prices/current/{ids}` | DefiLlama (coins) | MARKET_DATA | USD price per CoinGecko-slug id (ETH, BNB, POL, SOL, USDT, USDC) | `apps/reconciler/src/streams/sync.rs:77` (`LLAMA_IDS` in `chains.rs`) | Price (target) | PERIODIC | NONE | keyless | active | capture key `prices|https://coins.llama.fi/prices/current/coingecko:ethereum,…` |

Same feed used by the Python oracle path (`tests/oracle/sync-live.py:57`,
`LLAMA_URL`).

**Hard rule preserved in code:** a failed RPC or missing price *raises*; it never
becomes a 0 balance/valuation (`sync.rs` doc header, `jsonrpc.rs`).

---

## 4. CEX execution feeds — Go executor worker (`apps/executor`)

Venue boundary: `internal/exchanges/interface.go` (`Exchange` interface). Adapters:
`binance/`, `bybit/`, `mexc/`, `paper/`. Symbols are normalized through
`internal/exchanges/symbols.go` (`BTC/USDT` canonical ⇄ venue wire form).

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `binance-account` | `GET /api/v3/account` + `GET /fapi/v2/positionRisk` | Binance | CEX | asset free/locked balances; futures position risk rows | `apps/executor/internal/exchanges/binance/binance.go` | Balance + Position (target) | REALTIME | SNAPSHOT (`executor.balance_snapshots` / `positions_snapshots`) | per-account HMAC key (`executor.exchange_accounts.api_key_encrypted`) | active | `DefaultBaseURL = "https://api.binance.com"` |
| `binance-ticker` | `GET /api/v3/ticker/bookTicker` | Binance | CEX/MARKET_DATA | bid/ask book ticker | same | Ticker (target) | REALTIME | EPHEMERAL | keyless | active | adapter path list |
| `binance-orders` | `POST /api/v3/order`, `GET /api/v3/order`, `GET /api/v3/openOrders`, `DELETE /api/v3/order` | Binance | CEX | normalized order (status, executed qty, fills) | same | Order (target) | REALTIME | EVENT (`executor.child_orders`, `execution_events`) | account key | active | `internal/orders/orders.go` |
| `binance-fills` | `GET /api/v3/myTrades` | Binance | CEX | trade prints (price, qty, commission, tradeId) | same | Fill (target) | REALTIME | EVENT (`executor.fills`, unique `(account_id, exchange_trade_id)`) | account key | active | `insertFill` dedup comment |
| `bybit-account` | `/v5/account/wallet-balance`, `/v5/user/query-api-key` | Bybit | CEX | equity/balance rows, key permissions | `.../exchange/bybit/bybit.go` | Balance (target) | REALTIME | SNAPSHOT | per-account key | active | `DefaultBaseURL = "https://api.bybit.com"` |
| `bybit-positions` | `/v5/position/list` (category `linear`) | Bybit | CEX | position rows | same | Position (target) | REALTIME | SNAPSHOT | account key | active |
| `bybit-ticker` | `/v5/market/tickers` (category spot/linear) | Bybit | CEX/MARKET_DATA | bid/ask/last, funding, OI | same | Ticker/FundingRate/OpenInterest (target) | REALTIME | EPHEMERAL | keyless | active |
| `bybit-orders` | `/v5/order/create|cancel|realtime|history` | Bybit | CEX | normalized orders | same | Order (target) | REALTIME | EVENT | account key | active |
| `bybit-fills` | `/v5/execution/list` | Bybit | CEX | executions | same | Fill (target) | REALTIME | EVENT | account key | active |
| `mexc-account` | `/api/v1/contract/account`, `/assets` | MEXC | CEX | futures account assets | `.../exchange/mexc/mexc.go` | Balance (target) | REALTIME | SNAPSHOT | per-account key (+passphrase column exists) | active | `DefaultBaseURL = "https://api.mexc.com"` |
| `mexc-positions` | `/api/v1/contract/position/…` | MEXC | CEX | position rows | same | Position (target) | REALTIME | SNAPSHOT | account key | active |
| `mexc-ticker` | `/api/v1/contract/ticker` | MEXC | CEX/MARKET_DATA | ticker rows | same | Ticker (target) | REALTIME | EPHEMERAL | keyless | active |
| `mexc-orders` | `/api/v1/contract/submit|cancel|order/…` | MEXC | CEX | normalized orders | same | Order (target) | REALTIME | EVENT | account key | active |
| `mexc-fills` | `/api/v1/contract/fills` | MEXC | CEX | fills | same | Fill (target) | REALTIME | EVENT | account key | active |
| `paper-venue` | in-process simulator, **no network** | FUDCourt (self) | INTERNAL | synthetic mark/bid/ask, deterministic fills, fees, slippage | `.../exchanges/paper/{config.go,match.go,paper.go}` | Ticker + Order + Fill (target) | n/a | EVENT (`executor.*`) | none (marks injected as config data, no credentials) | active | `PaperConfig.Marks` — "the paper venue has no order book" |

Venue id ↔ default host are the only hardcoded roots; `Config.BaseURL` overrides
(tests use this). Live trading is gated by `FUDCOURT_EXECUTOR_LIVE`.

---

## 5. Identity feeds (Go `apps/api` :3103)

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `discord-oauth` | OAuth2 authorize + token exchange (`/oauth2/authorize`, `/api/oauth2/token`) | Discord | IDENTITY | access/refresh token, then `/api/v10/users/@me` profile | `apps/api/discord.go:25-27` | Identity/Session (target) | MANUAL/on-login | SESSION (HMAC cookie) | `FUDCOURT_CLIENT_ID` + `FUDCOURT_CLIENT_SECRET` | active | `discordAPI = "https://discord.com/api/v10"` |
| `discord-guild-member` | guild member lookup (roles → tier) | Discord | IDENTITY | member roles → `TEAM`/`ADMIN` tier | `apps/api/discord.go`, `apps/api/internal/access/identity/roles.go` | Authorization (target) | MANUAL/on-login | NONE | `FUDCOURT_BOT_TOKEN`, `FUDCOURT_GUILD_ID`, `FUDCOURT_ROLE_TEAM`, `FUDCOURT_ROLE_ADMIN` | active | role env names in `main.go:60-63` |

Note: `FUDCOURT_DISCORD_API` is a hermetic-test seam that redirects both endpoints
(`main.go:66-71`); unset keeps real `discord.com`.

---

## 6. User-entered / manual sources

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `manual-wallets` | wallet registry written by the UI | FUDCourt (user) | WALLET | `address, label, chain, monitored, alias, emoji, color, notes` | `apps/web/src/app/(frontend)/api/wallets/route.ts` (POST/GET) + `apps/reconciler/src/streams.rs` `WALLETS` seed | Wallet (target) | MANUAL | CANONICAL (`Postgres wallets`) | session cookie (`requireMutationAuth`) | active | `UPDATE wallets SET …` route code |
| `manual-transactions` | transaction ledger entries written by the UI | FUDCourt (user) | MANUAL | `date, chain, asset, event, amount_usd, direction, memo, wallet_to, venue_id, trade_id, hash, url, source` | `.../api/transactions/route.ts` (POST), `.../api/transactions/[id]/route.ts` (PUT/DELETE) | Transaction + LedgerEntry (target) | MANUAL | CANONICAL (`Postgres transactions`) | session cookie | active | `INSERT INTO transactions (…)` route code |
| `treasury-tables` | `accounts`, `journal`, `ledger`, `venues`, `trades` | FUDCourt (user / operator) | MANUAL / INTERNAL | chart of accounts, journal entries, ledger balances, venue registry, trade log | `db/schema/pg-schema.sql`; read via `platform/db/client.ts:getAll()` | LedgerEntry / Venue / Trade (target) | MANUAL | CANONICAL | session cookie for UI writes (no in-app writer found — see *Gaps*) | served | `DASHBOARD_READS` in `apps/web/src/server/db.ts` |
| `computed-networth` | `SUM(value_usd)` over latest `assets` snapshot | FUDCourt (internal) | INTERNAL | net worth, per-asset share | `pg.ts:82` (`netWorth`) | derived PortfolioValuation (target) | NEAR_REALTIME | NONE (computed at read) | keyless (internal) | active | `SELECT SUM(value_usd) as total FROM assets` |
| `reconcile-report` | expected-vs-current reconciliation | FUDCourt (internal) | INTERNAL | per-wallet rows, `walletSummary` totals | `apps/reconciler/src/reconciliation/reconcile.rs` → :3102 `/api/reconcile` → `api/reconcile/route.ts` | derived (target) | PERIODIC (on request) | NONE | keyless (loopback proxy) | active | three SELECTs at `reconcile.rs:207,213,219` |

---

## 7. Internal persistence & infrastructure sources (not external feeds)

These are *stored* sources — the repo both writes and reads them.

| source_id | source | provider | category | data produced | current code path | canonical target | freshness | durability | auth required | status | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `postgres-system-of-record` | Local Postgres 17 + TimescaleDB 2.30.1, database `fudcourt` (`public`) — Docker `postgres-hardened`, `127.0.0.1:5432` | self-hosted | INTERNAL | **single system of record** for `assets`, `transactions`, `wallets`, `accounts`, `journal`, `ledger`, `trades`, `venues` + the `asset_history`/`price_history` hypertables | writers `tests/oracle/sync-live.py` (psycopg2), `apps/reconciler` (Rust `tokio-postgres`, uninstalled), `apps/web/src/server/db.ts`; DDL `db/schema/pg-schema.sql` | (system of record) | NEAR_REALTIME | CANONICAL | `FUDCOURT_PG_URL` | active | pooled `pg()` client (`platform/db/pg.ts`) |
| `postgres-asset-history` | `asset_history` TimescaleDB hypertable | self-hosted | INTERNAL | one row per `assets` INSERT, appended by the `assets_snapshot` trigger (DR-040 — not by application code) | DDL `db/schema/pg-schema.sql:105-128` + trigger `:145-148`; 90-day DELETE in `tests/oracle/sync-live.py` | Balance snapshot (time series) | PERIODIC (per write) | HISTORICAL (90-day retention) | `FUDCOURT_PG_URL` | active | `CREATE TRIGGER assets_snapshot_trg AFTER INSERT ON assets` |
| `postgres-price-history` | `price_history` hypertable | self-hosted | INTERNAL | `(ts, symbol, source, price)` | DDL only: `db/schema/pg-schema.sql:150-160`; retention DELETE in `tests/oracle/sync-live.py` | Price history (target) | — | HISTORICAL | `FUDCOURT_PG_URL` | **served** (no writer found) | grep: only DDL + retention DELETE reference it |
| `executor-postgres` | `executor.*` schema | self-hosted Postgres | INTERNAL | accounts+credentials, executions, plans, child orders, fills, events, snapshots, risk profiles, audit logs | DDL `db/schema/executor-schema.sql`; writers `apps/executor/internal/repository/store.go` + the `apps/executor/internal/repository` package (store.go, credentials.go) | (execution system of record) | REALTIME | CANONICAL/EVENT | `FUDCOURT_EXECUTOR_PG_URL` (Go), Postgres DSN via web env | active | `ensureExecutorSchema()` / `EXECUTOR_DDL` |
| `neon-payload` | Neon Postgres (`DATABASE_URL`, pooled `…neon.tech/neondb`) | Neon | CMS | Payload tables (`posts`, `categories`, `media`, `users`, …) | `apps/web/src/cms/payload.config.ts:44-46`, DDL `src/cms/migrations/20260917_194354.ts` | NewsArticle/CMS content (target) | MANUAL | CANONICAL | `DATABASE_URL`, `PAYLOAD_SECRET` | active | `postgresAdapter({ connectionString: process.env.DATABASE_URL })` |
| `payload-media-files` | Uploaded media on disk (`apps/web/media`) | self-hosted | CMS | image/PDF blobs + metadata | `src/cms/collections/Media.ts` (`staticDir: 'media'`) | MediaAsset (target) | MANUAL | CANONICAL | `PAYLOAD_SECRET` (admin session) | active | Media collection config |
| `valkey-cache` | Valkey/Redis cache & lock | self-hosted | INTERNAL | cached upstream envelopes, executor leases | `apps/data/platform/cache/cache.go`, `apps/executor/internal/platform/lock/valkey.go` | (cache) | REALTIME | EPHEMERAL | `FUDCOURT_DATA_VALKEY_PASSWORD`, `VALKEY_PASSWORD`, `FUDCOURT_VALKEY_URL` | active | `fudcourt-data.service` env line `FUDCOURT_DATA_VALKEY_ADDR` |
| `cr-disk-cache` | On-disk per-route JSON cache `~/.cache/crfetch` (shared with the Python helper) | self-hosted | INTERNAL | cached `HelperOut` envelopes | `apps/data/internal/research/cryptorank/fetch.go` (`DefaultCacheDir`, `writeCache`) | (cache) | REALTIME | EPHEMERAL | keyless | active | `fudcourt-data.service` `FUDCOURT_DATA_CACHE_DIR` |
| `fixtures-recorded` | `tests/fixtures/` (26 `.json.gz` payloads) + `MANIFEST.json` | CryptoRank (recorded 2026-09-27) | RESEARCH (frozen) | 26 raw `HelperOut` payloads, sha256-pinned | `tests/oracle/record-fixtures.ts`, manifest `MANIFEST.json` | raw fixture | STATIC | HISTORICAL | `CR_PYTHON` (path only) | active (test oracle) | `sha256` + `jsonBytes` per mode |
| `fixtures-expected` | `tests/fixtures/expected/` (one JSON per mode) | FUDCourt (frozen envelopes) | INTERNAL | expected envelope output per mode for the Go/TS parity diff | `tests/oracle/dump-envelopes.ts` | test oracle | STATIC | HISTORICAL | keyless | active | `dump:envelopes` script |
| `oracle-capture` | `tests/oracle/fixtures/capture.json` (40 keys) | recorded RPC/price/Hyperliquid responses | INTERNAL (test) | replay bodies keyed `rpc\|<url with ALCHEMY redacted>\|<method>\|<params>` / `prices\|<url>` / `hl\|<body>` | `apps/reconciler/src/oracle.rs` | test oracle | STATIC | HISTORICAL | keyless (keys carry `/v2/{ALCHEMY}` placeholder, never a real key) | active | `capture.json` keys + `oracle.rs` doc |
| `python-sync-oracle` | `tests/oracle/sync-live.py` | FUDCourt (the deployed sync) | INTERNAL | same pipeline as the Rust sync; oracle for cross-implementation gate | `tests/oracle/sync-live.py` | — | PERIODIC | SNAPSHOT | `ALCHEMY_KEY`, `FUDCOURT_PG_URL` | served (the deployed sync) | `fudcourt-sync.service`/`.timer` |
| `cr-fetch-python-helper` | `tests/oracle/cr_fetch.py` | FUDCourt (legacy producer) | INTERNAL | `HelperOut` stdout per mode (the Go service is its port) | `tests/oracle/cr_fetch.py` | — | on demand | NONE | keyless | served (tooling/oracle only) | `records-fixtures.ts` `HELPER` path |
| `payload-seed` | `apps/web/src/cms/seed.ts` | FUDCourt (operator) | CMS | 2 categories + 3 posts + sharp-generated hero images | `src/cms/seed.ts` | NewsArticle/CMS (target) | MANUAL | CANONICAL | `DATABASE_URL` | scaffolded (run by hand: `bunx payload run src/cms/seed.ts`) | file header |

---

## 8. Absent in this repository

The scope prompt names these source types; **no code, config, schema or fixture in this
tree implements them**. They must not be treated as present.

| Named in scope prompt | Category | Status in repo | Evidence of absence |
|---|---|---|---|
| Bank accounts / bank imports / bank statements | BANK | **Absent** | grep for bank/statement/IBAN/CSV-import finds only `accounts.statement` TEXT column (`db/schema/pg-schema.sql`) — a chart-of-accounts label, not a bank feed. No bank client, no import route. |
| Macro providers (DXY, Fed Funds, CPI, US10Y, oil, gold, USDIDR, JPY, GBP) | MACRO | **Absent** | No `macro` package/table/route; `MacroSeries`/`MacroObservation` exist only as prompt vocabulary. |
| DEX wallet positions / LP positions | DEX | **Absent** | DexScreener reads *market* data only; no wallet-position or LP-position reader exists (Hyperliquid spot/perp balances are CEX-style, not LP positions). |
| Dedicated wallet indexers (Etherscan, Covalent, Moralis, Zerion, Bitquery, Solscan-indexer…) | WALLET/BLOCKCHAIN | **Absent** | All balance reads go through Alchemy/solana JSON-RPC by address; the only indexer hosts in the tree are documentation links. |
| Other news providers (CryptoPanic, RSS aggregators, NewsAPI) | NEWS | **Absent** | `news` source table has exactly one row (Cointelegraph); everything else is a 400 by design. |
| CoinGecko as a *price oracle* for portfolio valuation | MARKET_DATA | **Absent** (CoinGecko only in the markets board + ChainRank notes) | Portfolio valuation prices come from `coins.llama.fi` (`LLAMA_IDS`). |
| Binance / KuCoin ticker feeds | MARKET_DATA | **Absent (measured failure)** | Excluded from `TICKER_EXCHANGES` because their futures hosts fail TLS validation on this network (`client.ts:96-99`). |
| Kraken/Coinbase/HTX derivatives beyond the measured table | MARKET_DATA | Partially absent | Only the measured `TICKER_VENUES` pairs are read; anything else is not a source. |
| Treasury on-chain monitoring of an owned treasury wallet | TREASURY | **Absent** | `treasury` is a Go value model only (no writer, no route); no treasury address registry. |
| Cash / manual asset entries as a first-class source | CASH | **Absent** | No cash account model; `assets` rows are chain/wallet balances only. |
| ChainRank write endpoints (click/presence/claim/upload) | MARKET_DATA | **Absent by design** | Deliberately not proxied (`chainrank/modes.go` header). |
| CryptoRank funding / token-unlock data routes | RESEARCH | **Absent by design** (refused 503) | `CR_DISABLED` list + `DisabledReason`. |
| Alchemy NFT / token-metadata / portfolio APIs | BLOCKCHAIN_RPC | **Absent** | Only `eth_getBalance`, `eth_call(balanceOf)` are used. |
| Bank/macro/on-chain *transaction history* indexing | — | **Absent** | `transactions` rows are user-entered; no log-scanning indexer exists. |

`[INFERENCE]` markers are used only where a claim rests on reading code rather than
running it (e.g. statuses of `served` tables with no in-app writer).

---

## 9. Frontend route surface (which upstream each route hits or proxies)

`apps/web/src/app/(frontend)/api/` route files, enumerated with
`find src/app -type f -name route.ts`.

| Route | Serves | Upstream / backend it hits | Auth | Env |
|---|---|---|---|---|
| `GET /api/cryptorank` | CryptoRank envelope | `FUDCOURT_DATA_URL` (Go :3101) `/api/cryptorank` | keyless | `FUDCOURT_DATA_URL` |
| `GET /api/llama` | DefiLlama chains/protocols/historical | Go :3101 `/api/llama` | keyless | `FUDCOURT_DATA_URL` |
| `GET /api/news` | Cointelegraph RSS rows | Go :3101 `/api/news` | keyless | `FUDCOURT_DATA_URL` |
| `GET /api/markets` | CoinGecko markets board | CoinGecko directly | keyless | — |
| `GET /api/dex` | DexScreener proxy | DexScreener directly | keyless | — |
| `GET /api/signals` | signal feed | `https://data-public.vercel.app` | keyless | — |
| `GET /api/ticker`, `/api/ticker/instrument`, `/api/ticker/instruments` | ccxt venue quotes | 10 ccxt venues in-process | keyless | — |
| `GET /api/coins` | coin totals from `assets` | local Postgres (via `query`) | — | `FUDCOURT_PG_URL` |
| `GET /api/all` | dashboard bundle | local Postgres | — | `FUDCOURT_PG_URL` |
| `GET/POST/PUT/DELETE /api/transactions[/:id]` | transaction CRUD | Postgres read + write (DR-040) | session cookie (mutations) | `FUDCOURT_PG_URL` |
| `GET/POST /api/wallets` | wallet metadata edit | Postgres read + write (DR-040) | session cookie (mutations) | same |
| `GET /api/reconcile` | reconciliation board | Rust :3102 `/api/reconcile` | keyless | `RECONCILE_URL` |
| `GET /api/auth/login`, `/api/auth/callback`, `/api/auth/logout` | Discord OAuth | Go :3103 `/api/auth/*` | Discord OAuth | `FUDCOURT_API_URL` |
| `GET/POST /api/admin/members` | member/tier admin | Go :3103 `/api/admin/members` | session + admin tier | `FUDCOURT_API_URL` |
| `/api/executor/**` (accounts, executions, orders, fills, events, preview, settings, emergency, start/pause/resume/cancel) | executor control plane | **`executor.*` Postgres directly from the Next app** (`apps/executor/internal/repository/store.go`) | executor user session | Postgres DSN |
| `/blog/cms/api/[...slug]`, `/blog/cms/api/graphql` | Payload CMS REST/GraphQL | Neon Postgres via Payload | Payload admin session | `DATABASE_URL`, `PAYLOAD_SECRET` |

---

## 10. systemd units → which feed each one runs

`deploy/systemd/*.service|*.timer` (`grep -E "^(Description|ExecStart|EnvironmentFile|Environment|OnCalendar|Unit)="`).
Environment files are named only; **no secret values are reproduced anywhere in this
document**.

| Unit | Runs | Feeds it drives | Env file / inline env (names only) |
|---|---|---|---|
| `fudcourt-web.service` (:3100) | `next start` via bun | §2 market/DEX/ticker/signals feeds, §9 proxies, CMS, executor control plane | `apps/web/.env.local` |
| `fudcourt-data.service` (:3101) | `apps/data/bin/fudcourt-data` | §1 CryptoRank/Khala/DefiLlama/News/ChainRank | `FUDCOURT_DATA_ADDR`, `FUDCOURT_DATA_CACHE_DIR`, `FUDCOURT_DATA_VALKEY_ADDR`, `-…/fudcourt/.env` |
| `fudcourt-api.service` (:3103) | `apps/api/bin/fudcourt-api` (build artifact, absent from a clean tree) | §5 Discord identity | `-…/fudcourt/.env`, `FUDCOURT_API_ADDR` |
| `fudcourt-reconciled.service` (:3102) | Rust `fudcourt-reconciled` | §6 reconcile (reads Postgres) | `.env`, `RECONCILE_ADDR` |
| `fudcourt-sync-rust.service` + `.timer` (5 min) | Rust `fudcourt-sync` | §3 Alchemy/Solana/Hyperliquid/coins.llama.fi → Postgres `assets` (**built, not deployed** — the Python oracle is the deployed sync) | `NODE_ENV=` (unit loads repo `.env` itself) |
| `fudcourt-sync.service` + `.timer` (5 min) | `python3 sync-live.py` | same pipeline, legacy oracle | inline env only |
| `fudcourt-executor.service` | Go `fudcourt-executor` (CEX runtime) | §4 venue order/balance/position feeds | `apps/web/.env.local` |
| `fudcourt-executor-worker.service` | bun `apps/executor` | same feeds, TS runtime — **FALLBACK only** (the Go `fudcourt-executor.service` is the production executor; this unit is retained until the cutover row `verify:executor` (`apps/executor/internal/tests/e2e`) proves green) | `apps/web/.env.local`, `NODE_ENV=production` |
| `RETIRED-fudcourt-pgload.service.txt` | — | retired Turso → Postgres projection unit (DR-040: the projection is gone; Postgres is the single system of record) | tombstone file |
| `RETIRED-fudcourt-apicalls.service.txt` | — | retired CryptoRank sidecar (predecessor of `fudcourt-data`) | tombstone file |
| `RETIRED-fudcourt-blog.service.txt` | — | retired separate blog app (merged by DR-017) | tombstone file |
**Executor runtime ownership (RESOLVED — was the former "two executor runtimes" gap).** The Go
worker (`apps/executor`; unit `fudcourt-executor.service`) **is the production
executor**; the TypeScript worker (`apps/executor`; unit
`fudcourt-executor-worker.service`) is retained **only as a fallback** until the cutover row
`verify:executor` proves green, and is **not** the effective default. Parity rows 1–9 of
`docs/architecture/parity-matrix.md` are `DONE`. `deploy/systemd/fudcourt-executor.service`
also carries a **PROVISIONING GATE** — the Go unit stays masked until
`FUDCOURT_EXECUTOR_MASTER_KEY`, `FUDCOURT_EXECUTOR_PG_URL` and `VALKEY_ADDR` exist (§40 fail-closed
startup; all three live in `apps/web/.env.local`). Evidence: the two unit headers cited in
this table and `docs/architecture/parity-matrix.md` rows 1–9.

---

## 11. Registry summary counts

Counted mechanically from the tables above (`grep -c`/script over this file):

| Section | Rows |
|---|---|
| §1 Research feed rows (CryptoRank 25, Khala 5, DefiLlama 3, News 1, ChainRank 3, CoinGlass 4, CoinAnk 5, CoinMarketCap 4) | **50** |
| §2 Market-data rows read directly by the web tier | **12** |
| §3 On-chain/RPC rows (6 Alchemy chains, Solana ×2, Hyperliquid, coins price) | **10** |
| §4 CEX execution rows (Binance 4, Bybit 5, MEXC 5, paper 1) | **15** |
| §5 Identity rows | **2** |
| §6 Manual/user-entered rows | **5** |
| §7 Internal persistence/infrastructure rows | **14** |
| **Total registry rows** | **108** |
| §8 Absent-in-repo rows | **14** |
| §9 Frontend route rows | **16** |
| §10 systemd unit rows | **11** (the 14 files in `deploy/systemd/` reduce to 11 table rows: the three `.service`+`.timer` pairs `fudcourt-sync`, `fudcourt-sync-rust` and `fudcourt-pgload` each collapse into one row — 6 single-unit rows plus 3 pair rows covering 6 files — and the two `RETIRED-*.service.txt` tombstones appear as their own rows: 6 + 3 + 2 = 11 rows / 6 + 6 + 2 = 14 files) |

Facts behind the counts: CryptoRank declares **28** modes (`ModeCount = len(Modes)`; 26
live-recorded in `MANIFEST.json.liveModes`, 2 refused-by-design); 10 ccxt venues × the
measured `TICKER_VENUES` type table; 6 EVM chains + Solana + Hyperliquid under the
5-minute sync; 3 live CEX venues + 1 paper venue in the executor; **CoinGlass** declares 4 keyless modes (all live), **CoinAnk** 5 keyless modes (all live — the upstream gate lifted 2026-10-07; 886/10/726/708/50 rows), and **CoinMarketCap** 4 keyless modes (all live — keyless by having no credential at all).

`[INFERENCE]` markers are used only where a claim rests on reading code rather than
running it (e.g. tables with no in-repo writer). Every other row cites a file, route or
constant that was read directly.
