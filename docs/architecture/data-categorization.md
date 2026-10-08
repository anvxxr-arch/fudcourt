# Data Categorization (refresh 2026-10-02)

A **current, evidence-backed categorization of every data surface in the tree**, assembled from four
independent enumeration passes (one per slice) and cross-checked against the live services. It exists
because the 2026-10-01 catalog set — `source-catalog.md`, `data-catalog.md`, `data-classification.md`,
`database-classification.md`, `domain-map.md` — predates the two newest acquisition families:
**`coinglass` and `coinank` appear zero times in all five**, so their surfaces were uncategorized.

Method: each slice was walked independently; every row carries a real command or `file:line` as
evidence; no row was invented — a surface that is absent is recorded `absent`/`dead`, never omitted or
guessed. The machine-readable form (with the full `code_path` and `evidence` per row) is
`data-categorization.json` beside this file; the `path` column here is the primary file, verified to
exist.

## 1. Slices

| slice | rows | enumerates |
|---|---|---|
| `acq` | 58 | Go data sidecar acquisition surface — every family and every mode |
| `routes` | 45 | HTTP route handlers under `apps/web/src/app/**` — method, domain, auth tier, proxy target |
| `db` | 41 | Persistence objects across the three stores (Postgres+TimescaleDB, `executor` schema, Payload/Neon) |
| `feeds` | 11 | Non-sidecar upstream feeds the app reads directly (ccxt venues, chain RPCs, DexScreener, CoinGecko, CMS, signals) |
| **total** | **155** | |

## 2. Status and category roll-up

| status | rows |  | category | rows |
|---|---|---|---|---|
| `active` | 137 | | `MARKET_DATA` | 39 |
| `dead` | 8 | | `TRADING` | 26 |
| `dark` | 7 | | `PORTFOLIO` | 14 |
| `scaffolded` | 3 | | `RESEARCH` | 16 |
|  |  | | `NEWS` | 16 |
|  |  | | `SYSTEM` | 12 |
|  |  | | `DERIVATIVES` | 12 |
|  |  | | `ACCESS` | 8 |
|  |  | | `ONCHAIN` | 6 |
|  |  | | `DEFI` | 6 |

## 3. The categorization

### 3.1 `acq` — Go data sidecar acquisition surface — every family and every mode

| id | name | category | layer | auth | freshness | durability | sensitivity | status | path |
|---|---|---|---|---|---|---|---|---|---|
| acq-cryptorank-home | cryptorank mode=home: CryptoRank homepage market overview (HTML SSR -> __NEXT_DATA__) — upstream https://cryptorank.io/ | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-coins | cryptorank mode=coins: CryptoRank all-coins list — upstream https://cryptorank.io/all-coins-list | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-trending | cryptorank mode=trending: CryptoRank trending coins — upstream https://cryptorank.io/trending | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-gainers | cryptorank mode=gainers: CryptoRank top gainers — upstream https://cryptorank.io/gainers | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-losers | cryptorank mode=losers: CryptoRank top losers — upstream https://cryptorank.io/losers | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-funding | cryptorank mode=funding: CryptoRank funding-rounds (REFUSED: synthetic decoy upstream) — upstream https://cryptorank.io/funding-rounds (Next.js data-route, DISABLED) | RESEARCH | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | dead | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-unlocks | cryptorank mode=unlocks: CryptoRank token-unlock (REFUSED: synthetic decoy upstream) — upstream https://cryptorank.io/token-unlock (Next.js data-route, DISABLED) | RESEARCH | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | dead | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-categories | cryptorank mode=categories: CryptoRank category index/detail (keyed) — upstream https://cryptorank.io/categories/<key> | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-exchanges | cryptorank mode=exchanges: CryptoRank exchange lists (whitelisted venue list) — upstream https://cryptorank.io/exchanges/<list> | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-coin | cryptorank mode=coin: CryptoRank coin price page (keyed slug) — upstream https://cryptorank.io/price/<slug> | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-listings | cryptorank mode=listings: CryptoRank exchange listings — upstream https://cryptorank.io/listings | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-blockchains | cryptorank mode=blockchains: CryptoRank chain index (278 chains) — upstream https://cryptorank.io/blockchains | ONCHAIN | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-chain | cryptorank mode=chain: CryptoRank chain ecosystem detail (keyed) — upstream https://cryptorank.io/blockchains/<key> | ONCHAIN | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-launchpool | cryptorank mode=launchpool: CryptoRank launchpool event lists — upstream https://cryptorank.io/{past\|active\|upcoming}-launchpool | RESEARCH | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-nodesale | cryptorank mode=nodesale: CryptoRank node-sale event lists — upstream https://cryptorank.io/{past\|active\|upcoming}-nodesale | RESEARCH | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-news | cryptorank mode=news: CryptoRank news aggregator feed — upstream https://cryptorank.io/news | NEWS | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-tags | cryptorank mode=tags: CryptoRank tag taxonomy index — upstream https://cryptorank.io/tags | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-tag | cryptorank mode=tag: CryptoRank tag detail (keyed) — upstream https://cryptorank.io/tags/<key> | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-ecosystems | cryptorank mode=ecosystems: CryptoRank ecosystem index (106) — upstream https://cryptorank.io/ecosystems | ONCHAIN | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-ecosystem | cryptorank mode=ecosystem: CryptoRank ecosystem detail (keyed) — upstream https://cryptorank.io/ecosystems/<key> | ONCHAIN | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-rwa | cryptorank mode=rwa: CryptoRank RWA index (209) — upstream https://cryptorank.io/rwa | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-rwaasset | cryptorank mode=rwaasset: CryptoRank RWA asset detail (keyed type/slug) — upstream https://cryptorank.io/rwa/<type>/<slug> | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-quarterly | cryptorank mode=quarterly: CryptoRank BTC/ETH quarterly returns — upstream https://cryptorank.io/charts/quarterly-returns | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-prediction | cryptorank mode=prediction: CryptoRank prediction-market aggregates — upstream https://cryptorank.io/prediction-markets | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-converter | cryptorank mode=converter: CryptoRank full price list (~4,975 coins) — upstream https://cryptorank.io/converter | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-media | cryptorank mode=media: CryptoRank media/video aggregator — upstream https://cryptorank.io/media | NEWS | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-newstag | cryptorank mode=newstag: CryptoRank news tag feed (soft-404 guarded) — upstream https://cryptorank.io/news/tag/<slug> | NEWS | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-cryptorank-aioverview | cryptorank mode=aioverview: CryptoRank AI market overview digest — upstream https://cryptorank.io/ai-market-overview | RESEARCH | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-family-cryptorank | CryptoRank acquisition family (28 modes over cryptorank.io HTML SSR; funding/unlocks locally disabled) | MARKET_DATA | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/cryptorank/modes.go` |
| acq-khala-reports | khala mode=reports: khala research-report list (newest-first, no dates) — upstream https://www.khala.io/ (homepage rows) | RESEARCH | PARSED | keyless | PERIODIC | NONE | PUBLIC | active | `apps/data/internal/research/khala/modes.go` |
| acq-khala-report | khala mode=report: khala single report by key=<slug> — upstream https://www.khala.io/<slug> | RESEARCH | PARSED | keyless | PERIODIC | NONE | PUBLIC | active | `apps/data/internal/research/khala/modes.go` |
| acq-khala-latest | khala mode=latest: khala newest N reports WITH dates (the news surface) — upstream https://www.khala.io/ (newest N with per-report dates) | RESEARCH | PARSED | keyless | PERIODIC | NONE | PUBLIC | active | `apps/data/internal/research/khala/modes.go` |
| acq-family-khala | khala.io research-report acquisition family (3 modes; Framer static site, no dates on the list) | RESEARCH | PARSED | keyless | PERIODIC | NONE | PUBLIC | active | `apps/data/internal/research/khala/modes.go` |
| acq-llama-chains | llama mode=chains: DeFiLlama chain TVL list (re-sorted by tvl desc) — upstream https://api.llama.fi/v2/chains | DEFI | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/llama/modes.go` |
| acq-llama-protocols | llama mode=protocols: DeFiLlama protocol TVL list (head of 8.9MB body) — upstream https://api.llama.fi/protocols | DEFI | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/llama/modes.go` |
| acq-llama-historical | llama mode=historical: DeFiLlama historical chain TVL (oldest-first tail) — upstream https://api.llama.fi/v2/historicalChainTvl | DEFI | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/llama/modes.go` |
| acq-family-llama | DeFiLlama (api.llama.fi) acquisition family (3 modes; plain net/http, no key, no disabled modes) | DEFI | NORMALIZED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/llama/modes.go` |
| acq-news-cointelegraph | news source=cointelegraph: Cointelegraph RSS feed items — upstream https://cointelegraph.com/rss | NEWS | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/news/modes.go` |
| acq-family-news | Cointelegraph RSS acquisition family (1 feed; one upstream document, ~340KB text/xml) | NEWS | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/news/modes.go` |
| acq-chainrank-stats | chainrank mode=stats: chainrank.fyi leaderboard aggregate counters — upstream https://www.chainrank.fyi/api/stats | RESEARCH | RAW | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/chainrank/modes.go` |
| acq-chainrank-listings | chainrank mode=listings: chainrank.fyi board rows (pagination relayed verbatim) — upstream https://www.chainrank.fyi/api/listings?page&pageSize | RESEARCH | RAW | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/chainrank/modes.go` |
| acq-family-chainrank | chainrank.fyi acquisition family (2 read modes; RAW passthrough; writes NOT proxied) | RESEARCH | RAW | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/chainrank/modes.go` |
| acq-coinglass-statistics | coinglass mode=statistics: CoinGlass futures home statistics (encrypted dashboard body) — upstream https://capi.coinglass.com/api/futures/home/statistics | DERIVATIVES | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinglass/modes.go` |
| acq-coinglass-openInterest | coinglass mode=openInterest: CoinGlass open interest for one symbol (keyed symbol) — upstream https://capi.coinglass.com/api/openInterest/info?symbol=<SYM> | DERIVATIVES | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinglass/modes.go` |
| acq-coinglass-fundingRate | coinglass mode=fundingRate: CoinGlass funding-rate rank (50 most extreme +/-) — upstream https://capi.coinglass.com/api/fundingRate/rank | DERIVATIVES | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinglass/modes.go` |
| acq-coinglass-markets | coinglass mode=markets: CoinGlass futures coins markets table — upstream https://capi.coinglass.com/api/futures/v2/coins/markets | DERIVATIVES | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinglass/modes.go` |
| acq-family-coinglass | CoinGlass acquisition family (4 keyless modes; encrypted dashboard body, NO CG-API-KEY; official open-api-v4 NOT wired) | DERIVATIVES | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinglass/modes.go` |
| acq-coinank-fundingRate | coinank mode=fundingRate: CoinAnk funding rates (882 symbols x per-exchange maps) — upstream https://api.coinank.com/api/fundingRate/current | DERIVATIVES | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinank/modes.go` |
| acq-coinank-liquidation | coinank mode=liquidation: CoinAnk per-exchange liquidation turnover (interval allowlist) — upstream https://api.coinank.com/api/liquidation/allExchange?interval=<1h\|2h\|4h\|6h\|12h\|1d> | DERIVATIVES | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinank/modes.go` |
| acq-coinank-longShort | coinank mode=longShort: CoinAnk long/short ratios across exchanges — upstream https://api.coinank.com/api/longshort/all | DERIVATIVES | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinank/modes.go` |
| acq-coinank-etf | coinank mode=etf: CoinAnk daily spot-ETF creations/redemptions — upstream https://api.coinank.com/api/etf/etfInflow | MARKET_DATA | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinank/modes.go` |
| acq-coinank-whales | coinank mode=whales: CoinAnk Hyperliquid top positions by size — upstream https://api.coinank.com/api/hyper/topPosition | DERIVATIVES | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinank/modes.go` |
| acq-family-coinank | CoinAnk acquisition family (5 keyless modes; client-computed signature, NO issued key; official open-api.coinank.com NOT wired) | DERIVATIVES | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinank/modes.go` |
| acq-coinmarketcap-listing | coinmarketcap mode=listing: CoinMarketCap ranked coin list (start/limit paginated; local bounds [1,1000]) — upstream https://api.coinmarketcap.com/data-api/v3/cryptocurrency/listing | MARKET_DATA | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinmarketcap/modes.go` |
| acq-coinmarketcap-global | coinmarketcap mode=global: CoinMarketCap global metrics (dominance/supply, object payload) — upstream https://api.coinmarketcap.com/data-api/v3/global-metrics/quotes/latest | MARKET_DATA | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinmarketcap/modes.go` |
| acq-coinmarketcap-marketPairs | coinmarketcap mode=marketPairs: CoinMarketCap per-exchange pairs for one coin (slug required) — upstream https://api.coinmarketcap.com/data-api/v3/cryptocurrency/market-pairs/latest?slug=<SLUG> | MARKET_DATA | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinmarketcap/modes.go` |
| acq-coinmarketcap-exchanges | coinmarketcap mode=exchanges: CoinMarketCap ranked exchange list (start/limit paginated) — upstream https://api.coinmarketcap.com/data-api/v3/exchange/listing | MARKET_DATA | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinmarketcap/modes.go` |
| acq-family-coinmarketcap | CoinMarketCap acquisition family (4 keyless modes; dashboard backend api.coinmarketcap.com/data-api/v3, NO credential of any kind; documented pro-api.coinmarketcap.com with X-CMC_PRO_API_KEY NOT wired) | MARKET_DATA | PARSED | keyless | FREQUENT | NONE | PUBLIC | active | `apps/data/internal/research/coinmarketcap/modes.go` |

### 3.2 `routes` — HTTP route handlers under `apps/web/src/app/**` — method, domain, auth tier, proxy target

| id | name | category | layer | auth | freshness | durability | sensitivity | status | path |
|---|---|---|---|---|---|---|---|---|---|
| route-blog-cms-api-graphql-playground | GET /blog/cms/api/graphql-playground — Payload GraphQL playground (CMS, generated) | RESEARCH | CANONICAL | keyless | STATIC | CANONICAL | PUBLIC | active | `apps/web/src/app/blog/(payload)/cms/api/graphql-playground/route.ts` |
| route-blog-cms-api-graphql | POST\|OPTIONS /blog/cms/api/graphql — Payload GraphQL endpoint (CMS, generated) | RESEARCH | CANONICAL | keyless | STATIC | CANONICAL | PUBLIC | active | `apps/web/src/app/blog/(payload)/cms/api/graphql/route.ts` |
| route-blog-cms-api-rest | GET\|POST\|DELETE\|PATCH\|PUT\|OPTIONS /blog/cms/api/[...slug] — Payload REST catch-all (CMS, generated); public read path /blog/cms/api/posts | RESEARCH | CANONICAL | keyless | STATIC | CANONICAL | PUBLIC | active | `apps/web/src/app/blog/(payload)/cms/api/[...slug]/route.ts` |
| route-api-admin-members | GET\|POST /api/admin/members — admin guild-member list + role grant/revoke (PROXY -> Go api :3103 handleAdminMembers) | ACCESS | PRODUCT_VIEW | session:admin | REALTIME | NONE | INTERNAL | active | `apps/web/src/app/(frontend)/api/admin/members/route.ts` |
| route-api-all | GET /api/all — full treasury snapshot (wallets+assets+transactions) from Postgres | PORTFOLIO | PRODUCT_VIEW | session:team | REALTIME | CANONICAL | INTERNAL | active | `apps/web/src/app/(frontend)/api/all/route.ts` |
| route-api-coins | GET /api/coins — distinct assets grouped by total USD value from Postgres | PORTFOLIO | PRODUCT_VIEW | session:team | REALTIME | CANONICAL | INTERNAL | active | `apps/web/src/app/(frontend)/api/coins/route.ts` |
| route-api-wallets | GET\|POST /api/wallets — wallet table read + alias/metadata update (Postgres); POST uses requireMutationAuth('team') | PORTFOLIO | CANONICAL | session:team | REALTIME | CANONICAL | INTERNAL | active | `apps/web/src/app/(frontend)/api/wallets/route.ts` |
| route-api-transactions | GET\|POST\|DELETE\|PUT /api/transactions — transaction ledger read/filter + bulk insert/delete/update (Postgres) | PORTFOLIO | CANONICAL | session:team | REALTIME | CANONICAL | INTERNAL | active | `apps/web/src/app/(frontend)/api/transactions/route.ts` |
| route-api-transactions-id | PUT\|PATCH\|DELETE /api/transactions/[id] — single-row ledger edit/delete (Postgres) | PORTFOLIO | CANONICAL | session:team | REALTIME | CANONICAL | INTERNAL | active | `apps/web/src/app/(frontend)/api/transactions/[id]/route.ts` |
| route-api-reconcile | GET /api/reconcile — wallet reconciliation (PROXY -> Rust fudcourt-reconciled :3102) | PORTFOLIO | CANONICAL | session:team | FREQUENT | CANONICAL | INTERNAL | active | `apps/web/src/app/(frontend)/api/reconcile/route.ts` |
| route-api-auth-login | GET /api/auth/login — OAuth login redirect (PROXY -> Go api :3103 handleAuthLogin, Discord authorize) | ACCESS | PRODUCT_VIEW | keyless | REALTIME | NONE | SECRET | active | `apps/web/src/app/(frontend)/api/auth/login/route.ts` |
| route-api-auth-callback | GET /api/auth/callback — OAuth code->session exchange (PROXY -> Go api :3103 handleAuthCallback) | ACCESS | PRODUCT_VIEW | keyless | REALTIME | NONE | SECRET | active | `apps/web/src/app/(frontend)/api/auth/callback/route.ts` |
| route-api-auth-logout | GET\|POST /api/auth/logout — session cookie retire (PROXY -> Go api :3103 handleAuthLogout) | ACCESS | PRODUCT_VIEW | keyless | REALTIME | NONE | SECRET | active | `apps/web/src/app/(frontend)/api/auth/logout/route.ts` |
| route-api-coinglass | GET /api/coinglass — CoinGlass derivatives surfaces (PROXY -> Go data fudcourt-data :3101) | DERIVATIVES | NORMALIZED | keyless | NEAR_REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/coinglass/route.ts` |
| route-api-coinank | GET /api/coinank — CoinAnk derivatives surfaces (PROXY -> Go data fudcourt-data :3101; upstream LIVE) | DERIVATIVES | NORMALIZED | keyless | NEAR_REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/coinank/route.ts` |
| route-api-coinmarketcap | GET /api/coinmarketcap — CoinMarketCap market surfaces (PROXY -> Go data fudcourt-data :3101) | MARKET_DATA | NORMALIZED | keyless | NEAR_REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/coinmarketcap/route.ts` |
| route-api-cryptorank | GET /api/cryptorank — crypto research board (market caps, listings, ecosystems, RWA) (PROXY -> Go data fudcourt-data :3101) | MARKET_DATA | NORMALIZED | keyless | NEAR_REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/cryptorank/route.ts` |
| route-api-llama | GET /api/llama — DeFiLlama chains/protocols TVL (PROXY -> Go data fudcourt-data :3101) | DEFI | NORMALIZED | keyless | NEAR_REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/llama/route.ts` |
| route-api-news | GET /api/news — Cointelegraph RSS headline feed (PROXY -> Go data fudcourt-data :3101) | NEWS | NORMALIZED | keyless | NEAR_REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/news/route.ts` |
| route-api-dex | GET /api/dex — DexScreener DEX pairs/profiles/boosts (direct external proxy) | DEFI | NORMALIZED | keyless | NEAR_REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/dex/route.ts` |
| route-api-markets | GET /api/markets — CoinGecko top-250 market-cap board (direct external proxy, local search/sort/page) | MARKET_DATA | NORMALIZED | keyless | NEAR_REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/markets/route.ts` |
| route-api-market-stock | GET /api/market/stock — Yahoo Finance stock/indices board (direct external proxy) | MARKET_DATA | NORMALIZED | keyless | NEAR_REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/market/stock/route.ts` |
| route-api-market-commodity | GET /api/market/commodity — Yahoo Finance front-month futures board (direct external proxy) | MARKET_DATA | NORMALIZED | keyless | NEAR_REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/market/commodity/route.ts` |
| route-api-market-forex | GET /api/market/forex — curated FX majors from exchangerate-api (direct external proxy, pairs derived locally) | MARKET_DATA | DERIVED | keyless | PERIODIC | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/market/forex/route.ts` |
| route-api-market-macro | GET /api/market/macro — global macro board: US curve + DXY + volatility (Yahoo), 33 BIS policy rates, 10 FRED US indicators, 8-economy World Bank comparison; spreads derived locally | MARKET_DATA | DERIVED | keyless | NEAR_REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/market/macro/route.ts` |
| route-api-market-indonesia | GET /api/market/indonesia — Indonesia macro board: live rupiah crosses + IDX indices (Yahoo), BI-Rate (BIS), 19 annual World Bank indicators | MARKET_DATA | DERIVED | keyless | NEAR_REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/market/indonesia/route.ts` |
| route-api-signals | GET /api/signals — trading signals feed + scoreboard (direct external proxy -> data-public.vercel.app) | TRADING | NORMALIZED | keyless | REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/signals/route.ts` |
| route-api-ticker | GET /api/ticker — cross-venue CEX ticker board (spot/swap/future/option) via CCXT | MARKET_DATA | NORMALIZED | keyless | REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/ticker/route.ts` |
| route-api-ticker-instruments | GET /api/ticker/instruments — listed instruments/expiries/strikes for a symbol (CCXT) | MARKET_DATA | NORMALIZED | keyless | REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/ticker/instruments/route.ts` |
| route-api-ticker-instrument | GET /api/ticker/instrument — price for one specific instrument across venues (CCXT) | MARKET_DATA | NORMALIZED | keyless | REALTIME | SNAPSHOT | PUBLIC | active | `apps/web/src/app/(frontend)/api/ticker/instrument/route.ts` |
| route-api-executor-accounts | GET\|POST /api/executor/accounts — BYOK exchange account list/connect (secrets sealed server-side) | TRADING | PRODUCT_VIEW | session:team | REALTIME | CANONICAL | SECRET | active | `apps/web/src/app/(frontend)/api/executor/accounts/route.ts` |
| route-api-executor-accounts-id | GET\|DELETE /api/executor/accounts/[id] — one masked-key account read / revoke | TRADING | PRODUCT_VIEW | session:team | REALTIME | CANONICAL | SECRET | active | `apps/web/src/app/(frontend)/api/executor/accounts/[id]/route.ts` |
| route-api-executor-accounts-id-test | POST /api/executor/accounts/[id]/test — live credential validation | TRADING | PRODUCT_VIEW | session:team | REALTIME | NONE | SECRET | active | `apps/web/src/app/(frontend)/api/executor/accounts/[id]/test/route.ts` |
| route-api-executor-emergency | POST /api/executor/emergency — Emergency Stop (halt strategies, cancel managed orders; never closes positions) | TRADING | PRODUCT_VIEW | session:team | REALTIME | EVENT | USER_PRIVATE | active | `apps/web/src/app/(frontend)/api/executor/emergency/route.ts` |
| route-api-executor-executions | GET\|POST /api/executor/executions — execution history / create with immutable input snapshot | TRADING | PRODUCT_VIEW | session:team | REALTIME | CANONICAL | USER_PRIVATE | active | `apps/web/src/app/(frontend)/api/executor/executions/route.ts` |
| route-api-executor-executions-id | GET /api/executor/executions/[id] — execution + immutable plan | TRADING | PRODUCT_VIEW | session:team | REALTIME | CANONICAL | USER_PRIVATE | active | `apps/web/src/app/(frontend)/api/executor/executions/[id]/route.ts` |
| route-api-executor-executions-id-cancel | POST /api/executor/executions/[id]/cancel — cancel execution + managed child orders | TRADING | PRODUCT_VIEW | session:team | REALTIME | EVENT | USER_PRIVATE | active | `apps/web/src/app/(frontend)/api/executor/executions/[id]/cancel/route.ts` |
| route-api-executor-executions-id-pause | POST /api/executor/executions/[id]/pause | TRADING | PRODUCT_VIEW | session:team | REALTIME | EVENT | USER_PRIVATE | active | `apps/web/src/app/(frontend)/api/executor/executions/[id]/pause/route.ts` |
| route-api-executor-executions-id-resume | POST /api/executor/executions/[id]/resume | TRADING | PRODUCT_VIEW | session:team | REALTIME | EVENT | USER_PRIVATE | active | `apps/web/src/app/(frontend)/api/executor/executions/[id]/resume/route.ts` |
| route-api-executor-executions-id-start | POST /api/executor/executions/[id]/start | TRADING | PRODUCT_VIEW | session:team | REALTIME | EVENT | USER_PRIVATE | active | `apps/web/src/app/(frontend)/api/executor/executions/[id]/start/route.ts` |
| route-api-executor-executions-id-events | GET /api/executor/executions/[id]/events — immutable event log | TRADING | PRODUCT_VIEW | session:team | REALTIME | EVENT | USER_PRIVATE | active | `apps/web/src/app/(frontend)/api/executor/executions/[id]/events/route.ts` |
| route-api-executor-executions-id-fills | GET /api/executor/executions/[id]/fills — deduped fill history | TRADING | PRODUCT_VIEW | session:team | REALTIME | HISTORICAL | USER_PRIVATE | active | `apps/web/src/app/(frontend)/api/executor/executions/[id]/fills/route.ts` |
| route-api-executor-executions-id-orders | GET /api/executor/executions/[id]/orders — child orders | TRADING | PRODUCT_VIEW | session:team | REALTIME | CANONICAL | USER_PRIVATE | active | `apps/web/src/app/(frontend)/api/executor/executions/[id]/orders/route.ts` |
| route-api-executor-preview | POST /api/executor/preview — dry run only, nothing created, no external order | TRADING | PRODUCT_VIEW | session:team | REALTIME | NONE | USER_PRIVATE | active | `apps/web/src/app/(frontend)/api/executor/preview/route.ts` |
| route-api-executor-settings | GET\|PUT /api/executor/settings — per-user risk profile | TRADING | PRODUCT_VIEW | session:team | REALTIME | CANONICAL | USER_PRIVATE | active | `apps/web/src/app/(frontend)/api/executor/settings/route.ts` |

### 3.3 `db` — Persistence objects across the three stores (Postgres+TimescaleDB, `executor` schema, Payload/Neon)

| id | name | category | layer | auth | freshness | durability | sensitivity | status | path |
|---|---|---|---|---|---|---|---|---|---|
| pg-accounts | public.accounts — chart of accounts (treasury system of record, DR-040) | PORTFOLIO | CANONICAL | FUDCOURT_PG_URL | STATIC | CANONICAL | INTERNAL | dead | `db/schema/pg-schema.sql` |
| pg-assets | public.assets — latest synced wallet balances (treasury system of record, DR-040) | PORTFOLIO | CANONICAL | FUDCOURT_PG_URL | FREQUENT | SNAPSHOT | INTERNAL | active | `db/schema/pg-schema.sql` |
| pg-journal | public.journal — double-entry journal lines (treasury system of record, DR-040) | PORTFOLIO | CANONICAL | FUDCOURT_PG_URL | STATIC | CANONICAL | INTERNAL | dead | `db/schema/pg-schema.sql` |
| pg-ledger | public.ledger — running balance per account (treasury system of record, DR-040) | PORTFOLIO | CANONICAL | FUDCOURT_PG_URL | STATIC | CANONICAL | INTERNAL | dead | `db/schema/pg-schema.sql` |
| pg-trades | public.trades — executed trade log (treasury system of record, DR-040) | TRADING | CANONICAL | FUDCOURT_PG_URL | STATIC | EVENT | INTERNAL | dead | `db/schema/pg-schema.sql` |
| pg-transactions | public.transactions — user-entered on-chain/ledger movements (treasury system of record, DR-040) | PORTFOLIO | CANONICAL | FUDCOURT_PG_URL | MANUAL | CANONICAL | INTERNAL | active | `db/schema/pg-schema.sql` |
| pg-venues | public.venues — exchange/venue registry (treasury system of record, DR-040) | TRADING | CANONICAL | FUDCOURT_PG_URL | STATIC | CANONICAL | PUBLIC | dead | `db/schema/pg-schema.sql` |
| pg-wallets | public.wallets — watched-wallet registry + UI metadata (treasury system of record, DR-040) | PORTFOLIO | CANONICAL | FUDCOURT_PG_URL | MANUAL | CANONICAL | USER_PRIVATE | active | `db/schema/pg-schema.sql` |
| pg-asset-history | public.asset_history — TimescaleDB hypertable, one row per `assets` INSERT (assets_snapshot trigger) | PORTFOLIO | DERIVED | FUDCOURT_PG_URL | FREQUENT | HISTORICAL | INTERNAL | active | `db/schema/pg-schema.sql` |
| pg-price-history | public.price_history — TimescaleDB hypertable, intended compact price series (NO PRODUCER) | MARKET_DATA | CANONICAL | FUDCOURT_PG_URL | PERIODIC | HISTORICAL | PUBLIC | dead | `db/schema/pg-schema.sql` |
| pg-signal-plans | public.signal_plans — risk-sized paper plans keyed `(chain, mint)`, one per surfaced signal, written by `fudcourt-signals.timer` (DR-050) | TRADING | DERIVED | FUDCOURT_PG_URL | PERIODIC | SNAPSHOT | INTERNAL | active | `scripts/tools/signal-pipeline.py` |
| pg-canonical-reference | public.canonical_reference — (provider, provider_id) -> canonical_id resolution table, artifact-derived cache | SYSTEM | DERIVED | FUDCOURT_PG_URL | MANUAL | SNAPSHOT | INTERNAL | scaffolded | `db/schema/pg-schema.sql` |
| pg-canonical-reference-miss | public.canonical_reference_miss — known-but-unresolved provider identifiers (artifact `misses`) | SYSTEM | DERIVED | FUDCOURT_PG_URL | MANUAL | SNAPSHOT | INTERNAL | scaffolded | `db/schema/pg-schema.sql` |
| executor-schema-object | executor Postgres schema namespace (CREATE SCHEMA) | SYSTEM | CANONICAL | FUDCOURT_EXECUTOR_PG_URL | STATIC | NONE | INTERNAL | active | `db/schema/executor-schema.sql` |
| executor-exchange-accounts | executor.exchange_accounts — CEX account merged with AES-256-GCM credential envelope | ACCESS | CANONICAL | FUDCOURT_EXECUTOR_PG_URL | MANUAL | CANONICAL | SECRET | active | `db/schema/executor-schema.sql` |
| executor-executions | executor.executions — execution aggregate (plan snapshot refs + runtime state) | TRADING | CANONICAL | FUDCOURT_EXECUTOR_PG_URL | REALTIME | CANONICAL | USER_PRIVATE | active | `db/schema/executor-schema.sql` |
| executor-execution-plans | executor.execution_plans — immutable creation-time plan snapshot (jsonb) | TRADING | CANONICAL | FUDCOURT_EXECUTOR_PG_URL | REALTIME | SNAPSHOT | USER_PRIVATE | active | `db/schema/executor-schema.sql` |
| executor-child-orders | executor.child_orders — one row per venue order (client_order_id + exchange_order_id) | TRADING | CANONICAL | FUDCOURT_EXECUTOR_PG_URL | REALTIME | EVENT | USER_PRIVATE | active | `db/schema/executor-schema.sql` |
| executor-fills | executor.fills — executed fills, dedup on (account_id, exchange_trade_id) | TRADING | CANONICAL | FUDCOURT_EXECUTOR_PG_URL | REALTIME | EVENT | USER_PRIVATE | active | `db/schema/executor-schema.sql` |
| executor-execution-events | executor.execution_events — append-only execution event log (no UPDATE/DELETE path) | TRADING | CANONICAL | FUDCOURT_EXECUTOR_PG_URL | REALTIME | EVENT | USER_PRIVATE | active | `db/schema/executor-schema.sql` |
| executor-balance-snapshots | executor.balance_snapshots — periodic reconciliation balance snapshots (jsonb payload) | TRADING | CANONICAL | FUDCOURT_EXECUTOR_PG_URL | PERIODIC | HISTORICAL | USER_PRIVATE | active | `db/schema/executor-schema.sql` |
| executor-positions-snapshots | executor.positions_snapshots — periodic reconciliation position snapshots (jsonb payload) | TRADING | CANONICAL | FUDCOURT_EXECUTOR_PG_URL | PERIODIC | HISTORICAL | USER_PRIVATE | active | `db/schema/executor-schema.sql` |
| executor-risk-profiles | executor.risk_profiles — one risk profile per user (jsonb, upsert) | TRADING | CANONICAL | FUDCOURT_EXECUTOR_PG_URL | MANUAL | CANONICAL | USER_PRIVATE | active | `db/schema/executor-schema.sql` |
| executor-audit-logs | executor.audit_logs — executor action audit trail (jsonb payload) | SYSTEM | CANONICAL | FUDCOURT_EXECUTOR_PG_URL | REALTIME | EVENT | USER_PRIVATE | active | `db/schema/executor-schema.sql` |
| neon-users | users — Payload CMS editor accounts (email + password digest) | ACCESS | CANONICAL | DATABASE_URL | MANUAL | CANONICAL | SECRET | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-users-sessions | users_sessions — Payload admin sessions (cascades on user delete) | ACCESS | CANONICAL | DATABASE_URL | REALTIME | EPHEMERAL | SECRET | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-posts | posts — CMS editorial posts (Lexical content jsonb, drafts/published) | NEWS | CANONICAL | DATABASE_URL | MANUAL | CANONICAL | PUBLIC | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-posts-tags | posts_tags — Payload child array of post tags | NEWS | CANONICAL | DATABASE_URL | MANUAL | CANONICAL | PUBLIC | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-posts-rels | posts_rels — Payload polymorphic join (post -> category) | NEWS | CANONICAL | DATABASE_URL | MANUAL | CANONICAL | PUBLIC | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-posts-v | posts_v — Payload draft-version history for posts | NEWS | CANONICAL | DATABASE_URL | MANUAL | HISTORICAL | INTERNAL | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-posts-v-version-tags | posts_v_version_tags — version child of post tags | NEWS | CANONICAL | DATABASE_URL | MANUAL | HISTORICAL | INTERNAL | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-posts-v-rels | posts_v_rels — version join (post version -> category) | NEWS | CANONICAL | DATABASE_URL | MANUAL | HISTORICAL | INTERNAL | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-media | media — upload asset metadata (bytes live on disk apps/web/media) | NEWS | CANONICAL | DATABASE_URL | MANUAL | CANONICAL | PUBLIC | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-categories | categories — editorial content categories (not market categories) | NEWS | CANONICAL | DATABASE_URL | MANUAL | CANONICAL | PUBLIC | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-payload-kv | payload_kv — Payload framework key/value store | SYSTEM | CANONICAL | DATABASE_URL | STATIC | CANONICAL | INTERNAL | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-payload-locked-documents | payload_locked_documents — Payload document-lock table | SYSTEM | CANONICAL | DATABASE_URL | REALTIME | EPHEMERAL | INTERNAL | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-payload-locked-documents-rels | payload_locked_documents_rels — Payload lock join table | SYSTEM | CANONICAL | DATABASE_URL | REALTIME | EPHEMERAL | INTERNAL | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-payload-preferences | payload_preferences — Payload per-user UI preferences | SYSTEM | CANONICAL | DATABASE_URL | MANUAL | CANONICAL | INTERNAL | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-payload-preferences-rels | payload_preferences_rels — Payload preferences join table | SYSTEM | CANONICAL | DATABASE_URL | MANUAL | CANONICAL | INTERNAL | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-payload-migrations | payload_migrations — Payload CMS migration ledger | SYSTEM | CANONICAL | DATABASE_URL | MANUAL | CANONICAL | INTERNAL | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-enum-posts-status | enum_posts_status — Postgres enum (draft\|published) | SYSTEM | CANONICAL | DATABASE_URL | STATIC | NONE | INTERNAL | active | `apps/web/src/cms/migrations/20260917_194354.ts` |
| neon-enum-posts-v-version-status | enum__posts_v_version_status — Postgres enum (draft\|published) for post versions | SYSTEM | CANONICAL | DATABASE_URL | STATIC | NONE | INTERNAL | active | `apps/web/src/cms/migrations/20260917_194354.ts` |

### 3.4 `feeds` — Non-sidecar upstream feeds the app reads directly (ccxt venues, chain RPCs, DexScreener, CoinGecko, CMS, signals)

| id | name | category | layer | auth | freshness | durability | sensitivity | status | path |
|---|---|---|---|---|---|---|---|---|---|
| ccxt-venue-vocabulary | ccxt venue vocabulary — static canonical reference registry of 11 CEX venue ids (binance, bybit, mexc, okx, bitget, phemex, bingx, bitfinex, htx, coinbase, kraken) | MARKET_DATA | CANONICAL | keyless | STATIC | CANONICAL | PUBLIC | scaffolded | `apps/api/internal/markets/reference/seed.go` |
| ccxt-exchange-ticker | CCXT direct exchange ticker feed — 10 keyless CEX venues (okx, bybit, bitget, mexc, phemex, bingx, bitfinex, htx, coinbase, kraken) over spot/swap/future/option | MARKET_DATA | RAW | keyless | REALTIME | EPHEMERAL | PUBLIC | active | `apps/web/src/features/market/ticker/client.ts` |
| dexscreener-api | DexScreener public DEX API — token-profiles, token-boosts, boosts-top, search, tokens, token-pairs, orders | MARKET_DATA | RAW | keyless | REALTIME | EPHEMERAL | PUBLIC | active | `apps/web/src/features/market/dex/client.ts` |
| coingecko-markets | CoinGecko /coins/markets top-250 pool (keyless public API) | MARKET_DATA | RAW | keyless | FREQUENT | EPHEMERAL | PUBLIC | active | `apps/web/src/features/market/coingecko-markets.ts` |
| alchemy-evm-rpc | Alchemy EVM JSON-RPC — eth_getBalance / eth_call across Ethereum, BSC, Polygon, Arbitrum, Optimism, Base | ONCHAIN | RAW | ALCHEMY_KEY | PERIODIC | SNAPSHOT | PUBLIC | active | `apps/reconciler/src/streams/sync.rs` |
| solana-rpc | Solana mainnet-beta JSON-RPC — getBalance, getTokenAccountsByOwner (SPL) | ONCHAIN | RAW | keyless | PERIODIC | SNAPSHOT | PUBLIC | active | `apps/reconciler/src/chains.rs` |
| hyperliquid-info | Hyperliquid info API — spotClearinghouseState, clearinghouseState, userFills (positions + realized PnL) | PORTFOLIO | RAW | keyless | PERIODIC | SNAPSHOT | PUBLIC | active | `apps/reconciler/src/chains.rs` |
| payload-cms-content | Payload CMS content store — Neon Postgres (posts, categories, media metadata) | NEWS | CANONICAL | DATABASE_URL | MANUAL | CANONICAL | PUBLIC | active | `apps/web/src/cms/payload.config.ts` |
| payload-cms-users | Payload CMS admin users — Neon Postgres auth collection | ACCESS | CANONICAL | DATABASE_URL | MANUAL | CANONICAL | USER_PRIVATE | active | `apps/web/src/cms/collections/Users.ts` |
| payload-cms-media-files | Payload CMS media uploads on local disk (apps/web/media) | NEWS | RAW | session | MANUAL | CANONICAL | PUBLIC | active | `apps/web/src/cms/collections/Media.ts` |
| signals-feed | FUDCourt signals feed (data-public.vercel.app) — index / feed / page / scoreboard modes | RESEARCH | RAW | keyless | FREQUENT | EPHEMERAL | PUBLIC | active | `apps/web/src/app/(frontend)/api/signals/route.ts` |

## 4. Findings (each independently verified against the live tree)

**F1 — the two newest families were uncategorized.** `coinglass` and `coinank` appear **0 times** in
each of the five 2026-10-01 catalog docs (grep count per doc). Both are now categorized in `acq`.

**F2 — `coinglass` is live and active.** `/healthz` reports `"coinglass":"4 modes (keyless)"`; the
keyless probes `statistics`, `fundingRate` and `markets` return HTTP 200. `openInterest` returns 400
because it requires a symbol parameter — a validation refusal, not an upstream wall.

**F3 — `coinank` is dark.** All five modes return HTTP 502 carrying the upstream body
`{"code":"403","detail":"CoinAnk refused the request: please sub api to get data"}`. The sidecar
wires it correctly; the upstream refuses. Status `dark`, nothing broken on our side.
**Resolved 2026-10-07.** The upstream gate lifted: a direct GET to `api.coinank.com` answers **200**
(5/5 stable, no signature required) and the sidecar serves every mode — fundingRate 886 / liquidation
10 / longShort 726 / etf 708 / whales 50 rows. Status flipped `dark` → `active` across the catalogs;
the five families are now surfaced by the `/derivatives`, `/etf` and `/whales` public boards.

**F4 — `coinglass`/`coinank` are unreachable through the web app.** The sidecar exposes
`/api/coinglass` (`apps/data/main.go:231`) and `/api/coinank` (`:234`) on `:3101`, but
**0 of the 42** `route.ts` handlers under `apps/web/src/app` proxy them. Corroborated by the
contract gate, whose per-family proxy-parity list covers cryptorank, llama and news —
not coinglass or coinank.
**Resolved 2026-10-03.** All three keyless families now have a thin web proxy route —
`api/{coinglass,coinank,coinmarketcap}/route.ts` — so **3 of the 43** `route.ts` handlers under
`apps/web/src/app` relay them (`:3101`, verbatim), and the contract gate's per-family
proxy-parity list now covers all six research families (CG/CN/CMC mode tables kept TS↔Go equal).
`coinank` stays `dark` through the new route: the proxy answers upstream's 502 as written.

**F5 — the `markets` surface is unwired.** `apps/api/internal/markets/**` contributes vocabulary
and types only: `apps/api/main.go` imports no markets package and `curl :3103/api/markets` →
**404**. The only live ccxt feed is `apps/web/src/features/market/ticker/**` (`:3100/api/ticker` → 200).

**F6 — the deployed balance sync is the Python oracle, not Rust.**
`systemctl --user show fudcourt-sync.service -p ExecStart` →
`/usr/bin/python3 tests/oracle/sync-live.py` (active, exit 0); `fudcourt-sync-rust.{service,timer}` are
not installed. The Alchemy / Solana / Hyperliquid feeds are active **through the Python reader**;
`apps/reconciler/src/**` is not the running consumer.

**F7 — the dead tables are confirmed writer-less from the tree.** No `INSERT` targets `accounts`,
`journal`, `ledger`, `trades`, `venues` or `price_history` anywhere in source — only `SELECT`s in
`apps/web/src/server/db.ts` and one 90-day retention `DELETE FROM price_history`
(`pg.ts:208`). `status=dead` is therefore verified independently, not copied from DR-036.

**F8 — defense-in-depth note, NOT a vulnerability.** `requiredTierForPath('/api/admin/members')`
returns `null`: the middleware tier table covers the `/admin` **page** prefix and six team API paths,
not the `/api/admin/*` API path. The route
(`apps/web/src/app/(frontend)/api/admin/members/route.ts`) is a documented thin proxy that holds no
auth logic by design, and the Go upstream **does** enforce the tier — an unauthenticated
`curl :3103/api/admin/members` returns **401** `{"detail":"requires admin tier"}`. No bypass exists;
recorded because the middleware table not covering the path is a real (non-exploitable) asymmetry.

**F9 — the idle `cryptorank` modes are now consumed, except the two decoys (2026-10-08).** After the
TIER-1 boards (F3), the `acq` `cryptorank` modes `blockchains`, `chain`, `ecosystems`, `tags`, `tag`,
`coins`, `listings`, `coin`, `media`, `news`, `newstag`, `quarterly` and `aioverview` were served
end-to-end at `:3101` with **0** boards reading them. Five public boards now consume them —
`/chains`, `/sectors`, `/coins`, `/media`, `/insights` (DR-051) — so the family's live rows are
surfaced. The two modes left dark are `funding` and `unlocks`: both are **DISABLED** upstream
(`status: dead` in §3.1 — a synthetic decoy), and a board over a decoy would publish fabricated rows.
`chainrank`/`khala` stay retired (DR-041). The monitor covers the new surfaces with 18 checks
(5 board pages + 13 mode reads) from the repo script, so no cron edit was needed.

**F10 — the last four idle modes are consumed; no live row is left unwired (2026-10-08).** After F9,
four `acq` modes still carried real rows with no board reading them: `cryptorank` `converter`
(the full price list — every coin CryptoRank tracks, priced) and the keyed `ecosystem` and
`rwaasset` details, plus `coinank` `fundingRate` (the per-symbol funding matrix). Two new public
boards consume the list modes — `/screener` (`converter`) and `/funding` (`coinank` `fundingRate`)
— and the two keyed details become drill-downs inside the boards that already list their index:
`/chains` gains a per-`ecosystem` section and `/breadth` gains a per-`rwaasset` section (the key is
the row's own `detailKey`). With this, **every live `acq` mode that carries rows is read by a
surface**; the only modes still dark are the two DISABLED decoys (`funding`, `unlocks`) and the
retired families (`chainrank`/`khala`, DR-041). `converter` and `fundingRate` are the two widest
datasets in the app — ~5.4k priced coins vs the 100-row `coins` board, and 885 symbols across ~11
USDT venues vs CoinGlass's 50 most extreme. Never-fake holds: `converter` ships no change column
(`changeSource: 'unavailable'`) so the board states that rather than printing a flat 0, and every
`fundingRate` (a FRACTION upstream) renders ×100 as a percent with a null rate as `—`. The monitor
gains 6 checks (2 board pages + the `converter`, `ecosystem`, `rwaasset` and `fundingRate` reads).

## 5. Verification

```
python3 -c "import json;print(len(json.load(open('docs/architecture/data-categorization.json'))))"  # 155
curl -s http://127.0.0.1:3101/healthz                                  # 8 families, 28 cryptorank modes
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3100/api/coinglass?mode=statistics'   # 200 (web proxy)
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3100/api/coinank?mode=fundingRate'     # 200 (web proxy)
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3100/api/coinmarketcap?mode=global'    # 200 (web proxy)
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3101/api/coinglass?mode=statistics'  # 200
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3101/api/coinank?mode=fundingRate'    # 200
find apps/web/src/app \( -name 'route.ts' -o -name 'route.tsx' \) | wc -l              # 43
grep -rn coinglass apps/web/src/app | wc -l                        # 6 (client.ts + route.ts, not "no web proxy")
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3103/api/markets                      # 404
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3103/api/admin/members                # 401
```
