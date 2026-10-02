# CryptoRank — Data-Type Inventory (what exists vs what we scrape)

Recon for the `fudcourt-data` sidecar's `cryptorank` family. **Two completely
different surfaces**, and the repo currently uses only the second one:

| Surface | Host | Auth | Yields |
|---|---|---|---|
| **Public API v3** | `https://api.cryptorank.io` | `X-Api-Key` header | **81 documented endpoints**, typed JSON, real tiers |
| **HTML scrape (keyless)** | `https://cryptorank.io` | none | the **28 modes** in `frontend/web/src/features/cryptorank/client.ts` |

Captured live **2026-10-02** from `docs.cryptorank.io` (`llms.txt` index +
`openapi.json`, 1.0 MB) and the public sitemaps. Every row below is transcribed
from that spec — nothing here is inferred from the marketing pages.

**The headline finding:** there is a **free tier**. `Sandbox` = $0/mo,
**10,000 credits/month, 10 req/min**, and it covers **21 of the 81 endpoints** —
including the currency list, global market snapshot, fear & greed, blockchains,
ecosystems, exchanges map, funds map, fiat list. A key costs nothing to obtain;
the keyless HTML path exists only because no key was issued.

---

## 1. Plans (verbatim from `migration/plans-and-limits`)

| Plan | $/mo | $/yr | Rate limit (req/min) | Credits / month |
|---|---|---|---|---|
| Sandbox | $0 | $0 | 10 | 10,000 |
| Basic | $29 | $290 | 30 | 100,000 |
| Advanced | $149 | $1,490 | 60 | 600,000 |
| Pro | $475 | $4,750 | 100 | 2,000,000 |
| Business | $949 | $9,490 | 200 | 5,000,000 |
| Enterprise | custom | custom | custom | custom |

- Credentials: **`X-Api-Key` on every request**. No anonymous tier.
- v2 applied a flat 100 req/min on all plans; **v3 sets per-plan RPM** (10→200),
  so a Basic key is *slower* than v2 was.
- Credit cost: **1 credit per request** on 75 of 81 endpoints; `GET /v3/ping` and
  `GET /v3/status` are **Free** (4 endpoints carry no published cost badge).
- `GET /v3/status` returns plan, RPM and the **live credit usage for the billing
  period** — the documented way to build adaptive throttling.

---

## 2. The free tier, exhaustively (Sandbox · $0 · 21 endpoints)

These are usable **today** on a free key, 10,000 credits/month = ~333/day at
1 credit each:

| Method | Path | What it returns |
|---|---|---|

Coverage of the free tier: the whole **market read path** (currency list/profile/
map/trending/categories), **global indices** (market snapshot, fear & greed,
altcoin season), **blockchains** (list/map/profile), **ecosystem + tag + fund +
person + launchpad + exchange + drophunting maps**, and the **fiat list**.

What the free tier does **not** give: token unlocks/vesting (Pro), funding rounds
feed (Pro), token holders (Advanced), OHLCV (Advanced), proof-of-reserves
(Advanced), fund/Persons profiles (Business).

---

## 3. Full endpoint catalogue (81 endpoints, 16 tags)

Tier is the *minimum plan* required. Field lists are the top-level object keys
resolved from the spec's 120 component schemas.

### Currencies (18)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/currencies/categories` | Sandbox | 1 credit per request | Coin Categories — fields: `data, status, id, name, slug` |
| `GET` | `/v3/currencies/derivatives` | Advanced | 1 credit per request | Global Derivatives Snapshot — fields: `data, status, activeDerivativesExchangesCount, futuresShare, perpetualShare, totalOpenInterest, totalVolume24h` |
| `GET` | `/v3/currencies/gainers-losers` | Basic | 1 credit per request | Top Gainers & Losers — fields: `data, status, category, id, imageUrl, marketCap, name, price, pricePercentChange, rank, slug, symbol, volume24h` |
| `GET` | `/v3/currencies/historical` | Advanced | 1 credit per request | Historical Market Data — fields: `data, meta, status, circulatingSupply, id, marketCap, name, price, slug, storedTime, symbol, volume24h, volume24hBase` |
| `GET` | `/v3/currencies/list` | Sandbox | 1 credit per request | Currency List with Market Data — fields: `data, meta, status, circulatingSupply, id, imageUrl, marketCap, name, price, priceChangePercent24h, rank, slug, symbol, volume24h` |
| `GET` | `/v3/currencies/map` | Sandbox | 1 credit per request | Currency Map (ID Reference) — fields: `data, status, id, name, slug, symbol` |
| `GET` | `/v3/currencies/search` | Basic | 1 credit per request | Currency Search — fields: `data, status, id, imageUrl, name, rank, slug, symbol` |
| `GET` | `/v3/currencies/tags` | ? | ? | Coin Tags — fields: `data, status, id, name, slug` |
| `GET` | `/v3/currencies/trending` | Sandbox | 1 credit per request | Trending Currencies — fields: `data, status, category, high24h, id, imageUrl, listingDate, low24h, marketCap, name, price, priceChangePercent24h, rank, slug …` |
| `GET` | `/v3/currencies/{id}` | Sandbox | 1 credit per request | Currency Profile — fields: `data, status, category, circulatingPercent, circulatingSupply, description, fullyDilutedValuation, high24hUsd, id, imageUrl, lifecycle, links, listingDate, low24hUsd …` |
| `GET` | `/v3/currencies/{id}/analytics/returns` | Advanced | 1 credit per request | Periodic Returns — fields: `data, status, closingPrice, date, pricePercentChange` |
| `GET` | `/v3/currencies/{id}/contracts` | Basic | 1 credit per request | Currency Contracts — fields: `data, status, address, blockchainId, blockchainName, blockchainSlug, decimals, explorerUrl` |
| `GET` | `/v3/currencies/{id}/holders` | Advanced | 1 credit per request | Token Holders — fields: `data, meta, status, address, amount, isContract, label, percentOfSupply, rank, value` |
| `GET` | `/v3/currencies/{id}/holders/summary` | Advanced | 1 credit per request | Token Holders Summary — fields: `data, status, blockchainId, concentration, contractsShare, holdersCount, snapshotDate, tierDistribution, top100Share, totalSupply, walletsShare` |
| `GET` | `/v3/currencies/{id}/ohlcv` | Advanced | 1 credit per request | Historical OHLCV — fields: `data, meta, status, avg, circulatingSupply, circulatingSupplyChangePercent, close, high, low, open, priceChangePercent, time, volume, volumeChangePercent` |
| `GET` | `/v3/currencies/{id}/performance` | Advanced | 1 credit per request | Currency Performance — fields: `data, status, athDate, athMarketCapUsd, athPriceUsd, atlDate, atlPriceUsd, fromAthPercent, fromAtlPercent, icoRoi, slug, vcAvgRoi` |
| `GET` | `/v3/currencies/{id}/sparkline` | Basic | 1 credit per request | Price & Volume Chart — fields: `data, status, price, time, volume` |
| `GET` | `/v3/currencies/{id}/tokenomics` | Advanced | 1 credit per request | Tokenomics Summary — fields: `data, status, circulatingPercent, circulatingSupply, fullyDilutedValuation, maxSupply, nextUnlockDate, nextUnlockPercentOfMcap, nextUnlockPercentOfSupply, nextUnlockTokenAmount, nextUnlockValue, totalLockedAmount, totalLockedPercent, totalSupply …` |

### Vesting & Token Unlocks (9)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/currencies/upcoming-token-unlocks` | Pro | 1 credit per request | Upcoming Token Unlocks — fields: `data, meta, status, circulatingSupply, id, imageUrl, marketCap, name, percentOfMcap, percentOfSupply, price, symbol, time, unlockTokens …` |
| `GET` | `/v3/currencies/{id}/vesting/allocations` | Pro | 1 credit per request | Vesting Allocations — fields: `data, status, allocationName, groupDominance, lockedPercent, lockedTokens, nextUnlockDate, nextUnlockTokenAmount, nextUnlockValue, percentOfSupply, totalTokens, unlockedAmount, unlockedPercent, vestingType` |
| `GET` | `/v3/currencies/{id}/vesting/chart` | Pro | 1 credit per request | Token Emission Chart — fields: `data, status, series, untracked` |
| `GET` | `/v3/currencies/{id}/vesting/events` | Pro | 1 credit per request | Unlock Events — fields: `data, meta, status, allocationName, cumulativeUnlockedPercent, cumulativeUnlockedTokens, cumulativeUnlockedValue, percentOfAllocation, percentOfMcap, percentOfSupply, time, unlockTokens, unlockValue` |
| `GET` | `/v3/currencies/{id}/vesting/schedule` | Pro | 1 credit per request | Vesting Schedule Chart — fields: `data, status, rounds, untracked` |
| `GET` | `/v3/currencies/{id}/vesting/vc-pressure` | Pro | 1 credit per request | VC Dump Pressure — fields: `data, status, circulatingSupply, dominance, dumpPressure, investors, nextUnlockDate, priceChangePercent24h, profit, unlock, unlocked30d` |
| `GET` | `/v3/token-unlocks/dynamics` | Advanced | 1 credit per request | Token Unlock Dynamics — fields: `data, status, date, totalUnlockValue` |
| `GET` | `/v3/token-unlocks/dynamics/by-category` | Advanced | 1 credit per request | Token Unlock Dynamics by Category — fields: `data, status, breakdown, date, totalUnlockValue` |
| `GET` | `/v3/token-unlocks/dynamics/by-token` | Pro | 1 credit per request | Token Unlock Dynamics by Token — fields: `data, status, breakdown, date, totalUnlockValue` |

### Funding Rounds (4)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/funding-rounds/list` | Pro | 1 credit per request | Funding Rounds Feed — fields: `data, meta, status, allInvestors, category, currencyId, date, dateAccuracy, id, raised, type` |
| `GET` | `/v3/funding-rounds/most-active-investors` | Advanced | 1 credit per request | Most Active Investors — fields: `data, status, id, imageUrl, leadInvestments, name, slug, tier, totalDeployed, totalInvestments` |
| `GET` | `/v3/funding-rounds/trends` | Advanced | 1 credit per request | Fundraising Trends (Aggregate) — fields: `data, status, avgRoundSize, date, medianRoundSize, roundsCount, totalRaised` |
| `GET` | `/v3/funding-rounds/{id}` | Business | 1 credit per request | Funding Round Detail — fields: `data, status, category, currencyId, date, description, id, imageUrl, leadInvestors, otherInvestors, raised, sourceUrl, type, valuation` |

### Funds (8)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/funds/list` | Advanced | 1 credit per request | Funds List with Metrics — fields: `data, meta, status, category, fundingRoundsCount, id, imageUrl, leadInvestmentsCount, name, retailRoi, slug, tier` |
| `GET` | `/v3/funds/map` | Sandbox | 1 credit per request | Funds Map (ID Reference) — fields: `data, status, id, name, slug` |
| `GET` | `/v3/funds/{id}` | Advanced | 1 credit per request | Fund Profile (Summary) — fields: `data, status, avgRoundSize, category, description, fundingRoundsCount, id, imageUrl, jurisdiction, leadInvestmentsCount, links, name, portfolioCount, preferredStage …` |
| `GET` | `/v3/funds/{id}/co-investors` | Business | 1 credit per request | Fund Co-Investors — fields: `data, status, id, imageUrl, jointRoundsCount, lastJointRoundDate, name, slug, tier` |
| `GET` | `/v3/funds/{id}/country` | Pro | 1 credit per request | Fund Investments by Country — fields: `data, status, country, countryCode, investmentsCount, percentOfTotal` |
| `GET` | `/v3/funds/{id}/focus-area` | Pro | 1 credit per request | Fund Focus Area — fields: `data, status, category, investmentsCount, percentOfTotal` |
| `GET` | `/v3/funds/{id}/stages` | Pro | 1 credit per request | Fund Investments by Stage — fields: `data, status, avgRoundSize, count, percentOfTotal, stage` |
| `GET` | `/v3/funds/{id}/top-investments` | Pro | 1 credit per request | Fund Top Investments — fields: `data, status, currencyId, imageUrl, isLead, latestRoundDate, marketCap, name, retailRoi, symbol, totalInvested` |

### Exchanges (6)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/exchanges/list` | Basic | 1 credit per request | Exchanges List with Volume — fields: `data, meta, status, adjustedVolume24h, currenciesCount, id, imageUrl, name, pairsCount, reportedVolume24h, slug, type` |
| `GET` | `/v3/exchanges/map` | Sandbox | 1 credit per request | Exchanges Map — fields: `data, status, id, name, slug, type` |
| `GET` | `/v3/exchanges/{id}` | Basic | 1 credit per request | Exchange Profile — fields: `data, status, adjustedVolume24h, blockchain, currenciesCount, description, futuresContractsCount, hasProofOfReserves, id, imageUrl, jurisdiction, links, marketShare, name …` |
| `GET` | `/v3/exchanges/{id}/reserves` | Advanced | 1 credit per request | Exchange Proof of Reserves — fields: `data, status, cleanReserves, id, name, reserves, slug, sourceUrl, stablecoinsPercent, amount, currencyId, percentOfTotal, symbol` |
| `GET` | `/v3/exchanges/{id}/volume-chart` | Basic | 1 credit per request | Exchange Volume Chart — fields: `data, status, adjustedVolume, reportedVolume, time` |
| `GET` | `/v3/exchanges/{id}/volume-chart/monthly` | Advanced | ? | Exchange Monthly Volume Chart — fields: `data, status, adjustedVolume, adjustedVolumeBtc, reportedVolume, reportedVolumeBtc, time` |

### Blockchains (5)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/blockchains/list` | Sandbox | 1 credit per request | Blockchain List with Market Data — fields: `data, meta, status, explorerUrl, id, marketCap, marketCapDominance, name, nativeCurrencyId, slug, symbol` |
| `GET` | `/v3/blockchains/map` | Sandbox | 1 credit per request | Blockchain Map (ID Reference) — fields: `data, status, id, name, slug` |
| `GET` | `/v3/blockchains/{id}` | Sandbox | 1 credit per request | Blockchain Profile — fields: `data, status, explorerUrl, gainersVsLosers, id, imageUrl, marketCap, marketCapDominance, name, nativeCurrencyId, slug, symbol, volume24h` |
| `GET` | `/v3/blockchains/{id}/tvl/change` | Basic | 1 credit per request | Blockchain TVL Change — fields: `data, status, tvlChange` |
| `GET` | `/v3/blockchains/{id}/tvl/chart` | Basic | 1 credit per request | Blockchain TVL Chart — fields: `data, status, time, totalTvl, tvl` |

### Global (7)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/global/altcoin-index` | Sandbox | 1 credit per request | Altcoin Season Index — fields: `data, status, classification, currentValue, lastMonthValue, lastWeekValue, yearlyHighDate, yearlyHighValue, yearlyLowDate, yearlyLowValue, yesterdayValue` |
| `GET` | `/v3/global/altcoin-index/chart` | Basic | 1 credit per request | Altcoin Season Chart — fields: `data, status, altcoinsMarketCap, classification, time, value` |
| `GET` | `/v3/global/dominance` | Basic | 1 credit per request | BTC & ETH Dominance — fields: `data, status, btcDominance, btcDominanceChangePercent24h, ethDominance, ethDominanceChangePercent24h, othersDominance` |
| `GET` | `/v3/global/dominance/chart` | Basic | 1 credit per request | Dominance Chart by Group (BTC, ETH, TOP-10 MCap, etc.) — fields: `data, status, dominance, time` |
| `GET` | `/v3/global/fear-greed` | Sandbox | 1 credit per request | Fear & Greed Index — fields: `data, status, classification, currentValue` |
| `GET` | `/v3/global/fear-greed/chart` | Basic | 1 credit per request | Fear & Greed Chart — fields: `data, status, classification, time, value` |
| `GET` | `/v3/global/market` | Sandbox | 1 credit per request | Global Market Snapshot — fields: `data, status, activeCurrencies, activeExchanges, activeTickers, btcMarketCap, ethMarketCap, marketCapChangePercent24h, totalMarketCap, totalVolume24h` |

### Ecosystems (3)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/ecosystems/list` | Sandbox | 1 credit per request | Ecosystems Map — fields: `data, status, id, name, projectsCount, slug, tags` |
| `GET` | `/v3/ecosystems/tags` | Sandbox | 1 credit per request | Ecosystems Tags — fields: `data, status, id, name, projectsCount, slug` |
| `GET` | `/v3/ecosystems/{id}` | Advanced | 1 credit per request | Ecosystem Profile — fields: `data, status, funds, id, imageUrl, links, marketCap, marketCapChangePercent24h, name, newProjectsCount, projectsCount, shortDescription, slug, tags …` |

### Launchpads (3)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/launchpads/list` | ? | ? | Launchpads List with Metrics — fields: `data, meta, status, avgRoi, id, imageUrl, name, rank, salesCount, slug, totalRaised, type` |
| `GET` | `/v3/launchpads/map` | Sandbox | 1 credit per request | Launchpads Map — fields: `data, status, id, name, slug` |
| `GET` | `/v3/launchpads/{id}` | Advanced | 1 credit per request | Launchpad Profile — fields: `data, status, athRoi, blockchains, currentRoi, description, foundedDate, id, imageUrl, latestSaleDate, links, name, nativeTokenMarketCap, nativeTokenVolume24h …` |

### Public Sales (3)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/public-sales/list` | Pro | 1 credit per request | Public Sales List — fields: `data, meta, status, athRoi, blockchains, category, currencyId, currencyName, currencySlug, currencySymbol, currentMarketCap, date, id, imageUrl …` |
| `GET` | `/v3/public-sales/trends` | Advanced | 1 credit per request | Public Sales Trends (Aggregate) — fields: `data, status, date, icoCount, idoCount, ieoCount, salesCount, totalRaised` |
| `GET` | `/v3/public-sales/{id}` | ? | ? | Public Sale Detail — fields: `data, status, athRoi, blockchains, category, currencyId, currencyName, currencySlug, currencySymbol, date, description, id, imageUrl, initialMarketCap …` |

### Drophunting (4)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/drophunting/list` | Advanced | 1 credit per request | Drophunting Activities List — fields: `data, meta, status, activityStatus, currencyId, id, imageUrl, lastStatusUpdate, name, rewardType, slug, symbol` |
| `GET` | `/v3/drophunting/map` | Sandbox | 1 credit per request | Drophunting Map — fields: `data, status, id, name, slug` |
| `GET` | `/v3/drophunting/{id}` | Pro | 1 credit per request | Drophunting Activity Profile — fields: `data, status, activityStatus, currencyId, description, estimatedCost, estimatedTimeMinutes, hasBackers, hasFundingRounds, hasTasks, id, imageUrl, lastStatusUpdate, links …` |
| `GET` | `/v3/drophunting/{id}/tasks` | Business | 1 credit per request | Drophunting Tasks — fields: `data, status, blockchains, buttonUrl, cost, endDate, estimatedTimeMinutes, id, mainText, startDate, title, types` |

### Persons (5)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/persons/list` | Pro | 1 credit per request | Persons List — fields: `data, meta, status, categories, id, name, projectsCount, slug` |
| `GET` | `/v3/persons/map` | Sandbox | 1 credit per request | Persons Map — fields: `data, status, id, name, slug` |
| `GET` | `/v3/persons/{id}` | Business | 1 credit per request | Person Profile — fields: `data, status, categories, description, fundingRoundsCount, id, imageUrl, links, name, primaryPosition, projectsCount, slug` |
| `GET` | `/v3/persons/{id}/education` | Business | 1 credit per request | Person Educations — fields: `data, status, fieldOfStudy, institutionName, yearFrom, yearTo` |
| `GET` | `/v3/persons/{id}/positions` | Business | 1 credit per request | Person Positions — fields: `data, status, entityId, entityName, entitySlug, entityType, isCurrent, jobs, yearFrom, yearTo` |

### News (2)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/news/feed` | Advanced | 1 credit per request | News Feed — fields: `data, meta, status, assignedFunds, assignedTokens, hasMainText, heroText, id, language, previewImage, publishedDate, source, sourceUrl, tags …` |
| `GET` | `/v3/news/{id}/main-text` | Advanced | 1 credit per request | News Detail — fields: `data, status, id, mainText` |

### Tickers (1)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/tickers` | Basic | 1 credit per request | Tickers — fields: `data, meta, status, ask, baseSymbol, bid, exchangeId, exchangeName, exchangeType, high24hUsd, id, lastPrice, lastUpdated, low24hUsd …` |

### Fiat (1)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/fiat/list` | Sandbox | 1 credit per request | Supported Fiat Currency List — fields: `data, status, id, name, price, slug, symbol` |

### System (2)

| Method | Path | Tier | Cost | What it returns |
|---|---|---|---|---|
| `GET` | `/v3/ping` | Sandbox | Free | API Health Check — fields: `serverTime` |
| `GET` | `/v3/status` | Sandbox | Free | API Plan & Usage Status — fields: `credits, currentPeriodEnd, currentPeriodStart, endpoints, plan, rateLimitPerMinute` |

---

## 4. Tier distribution

| Tier | Endpoints |
|---|---|

*Cost:* **GET** × Sandbox, **GET** × Basic, **GET** × Advanced, **GET** × ?, **GET** × Pro, **GET** × Business  (total 81 endpoints).

---

## 5. MCP server (not usable without Pro)

`https://api.cryptorank.io/mcp` — a **single authenticated remote MCP server**
exposing the catalogue as MCP tools, for Claude/ChatGPT/Claude Desktop/Cursor/
Windsurf. Verbatim: *"There is no keyless tier and no local server — all access
goes through your CryptoRank Public API key on the PRO plan or higher."*
Auth is OAuth against the CryptoRank account. **Irrelevant to us at $0.**

---

## 6. The keyless HTML path (what the repo actually runs)

`frontend/web/src/features/cryptorank/client.ts` ships **28 modes** scraped from
`https://cryptorank.io` HTML + the `__NEXT_DATA__` SSR payload, served by the Go
sidecar on `:3101`:

```
home · coins · trending · gainers · losers
funding · unlocks                                  <- REFUSED (synthetic data-route class)
categories · exchanges · coin                      <- live HTML, 3-gate verified
listings · blockchains · chain · launchpool · nodesale
news · tags · tag · ecosystems · ecosystem
rwa · rwaasset · quarterly · prediction · converter
media · newstag · aioverview
```

Protection measured on this path (2026-09-29 → 2026-10-02):

- `api.cryptorank.io/v0` (the scraped internal API) needs a **bespoke TLS
  fingerprint** (Chrome 131 + HTTP/2) — this is why `fetch.go` carries its own
  stack instead of `net/http` defaults.
- `/funds/*`, `/upcoming-ico`, `/active-ico`, `/funding-analytics` return a
  **403 Cloudflare interstitial** to direct fetch *and* to headless/headful
  Chrome HAR captures (2 attempts, Turnstile never cleared).
- `/performance` ships literal `N/A` in every ROI cell — no honest source exists.
- `/ath` micro-cap prices are bit-frozen over 15 s with an 8 % gap vs the same
  coin's `/price` page.

**Mapping: the 21 free Sandbox endpoints cover almost exactly what the keyless
market modes scrape today** — `currencies/list`+`map`+`<built-in function id>` ≈ `coins`/`coin`,
`currencies/trending` ≈ `trending`, `global/*` ≈ `home`, `blockchains/*` ≈
`blockchains`/`chain`, `exchanges/map` + `exchanges/list` ≈ `exchanges`,
`funds/map` ≈ (funding slices), `fiat/list` ≈ converter quotes. The API adds
**typed fields, no CF wall, and a documented credit budget** in place of HTML
parsing and interstitial roulette.

---

## 7. v2 → v3 migration

`docs.cryptorank.io/migration/endpoints-mapping` (366 KB, captured to
`/tmp/cr_migration_endpoints-mapping`) carries **before/after recipes for every
v2 call plus a full endpoint reference**, and `GET /v3/status` reports the
resolved plan/limits. Relevant if any consumer still speaks v2; the v3 surface
above is the current contract.

---

## 8. Integration notes for `fudcourt-data`

1. **Get a Sandbox key.** $0, 10,000 credits/month, and it covers the market read
   path that today costs us HTML parsing + a bespoke TLS stack. Key issuance is a
   human step (signup), not an automation target — this is a decision, not a
   scrape.
2. If the key lands, the honest shape is a **new acquisition family**
   (`internal/research/cryptorankapi` or similar) speaking plain JSON, with the
   existing HTML family kept for the modes the free tier cannot serve
   (unlocks/vesting = Pro, holders/OHLCV = Advanced).
3. Never mix the two silently: a mode served from the API and the same mode
   served from HTML must not disagree. Re-run the existing decoy/parity gates
   (`api-surface-recon` discipline, `cryptorank-mode-audit.md`) before wiring.
4. Poll `GET /v3/status` for credit burn; 10 k/month is ~333/day, and the
   `paginated` endpoints (`/currencies/list`, `/blockchains/list`) consume 1
   credit **per page**, not per dataset.
5. Do **not** build against the MCP server — Pro-gated ($475/mo).

---

## 9. Provenance

| Artifact | Source | Size |
|---|---|---|
| `/tmp/cr_openapi.json` | `docs.cryptorank.io` OpenAPI 3.0 spec (Cryptorank API V3 3.0.0), 81 paths / 120 schemas | 1.0 MB |
| `/tmp/cr_llms.txt` | `docs.cryptorank.io/llms.txt` doc index + per-endpoint tier/cost badges | 27 KB |
| `/tmp/cr_migration_endpoints-mapping` | v2→v3 endpoint mapping + recipes | 366 KB |
| `docs.cryptorank.io/mcp-server.md` | MCP server requirements | live fetch |
| `cryptorank.io/sitemap*.xml` | 12 sitemap families | live fetch |
