# FUDCourt data-point taxonomy

This document is the provider-independent classification of every data point FUDCourt ingests or plans to ingest: it classifies points by the domain of reality they describe, not by which provider served them. `docs/architecture/data-categorization.md` groups data surfaces by CATEGORY + PROVIDER (MARKET_DATA, coinank, coinglass, cryptorank, coinmarketcap, llama, news, ...); this taxonomy deliberately replaces provider-grouping with domain-grouping for scalability — providers change, get added, and get dropped, while domains do not, so a provider-keyed taxonomy must be rewritten on every provider swap whereas a domain-keyed taxonomy survives it. It is also orthogonal to the code-domain axis of section 3 in `docs/architecture/canonical-model.md`, which lists CODE domains (access, accounts, assets, markets, trading, portfolio, ledger, treasury, onchain, defi, research, news, macro, signals, system) with their owning services and schema dirs: that axis answers which code owns a record, this taxonomy answers what a data point IS, so a point classified as crypto_derivatives / funding rate keeps that classification no matter which code domain stores it. The machine-readable form of this taxonomy is `contracts/schemas/taxonomy/datapoint-taxonomy.json`.

## Dimensions

Every data point carries these 13 dimensions, in this order:

| Dimension | Meaning | Nullable |
|---|---|---|
| type | Classification within the point's domain; drawn from that domain's exact type list | no |
| subtype | Finer classification when one type spans several shapes | yes |
| asset | The asset the point is about (coin, token, FX base, commodity, index) | yes |
| instrument | The concrete instrument for instrument-level points (perp, future, option, bond) | yes |
| venue | Where the point was produced or traded (exchange, chain, aggregator, feed) | yes |
| chain | The blockchain when the point is chain-scoped | yes |
| country | The jurisdiction for macro or news points scoped to a country | yes |
| currency | The currency the value is denominated in | yes |
| timeframe | The period the point covers (1h, 1d, quarter); null for instantaneous points | yes |
| timestamp | When the point is anchored in time (see the time semantics below) | no |
| source | The producing provider, endpoint, or upstream feed that yielded the point | no |
| value | The payload itself: number, string, or structured value | no |
| unit | The unit of the value (USD, percent, wei, tokens) | yes |

Rules:

- Unreported = null, never a fabricated 0 (repo rule): any dimension a source does not report is stored as null; a missing value must never be presented as a zero.
- The timestamp dimension follows the five time semantics in section 4 of `docs/architecture/canonical-model.md`: `occurred_at` (when the fact happened in the world), `observed_at` (when we read the value), `received_at` (when the payload reached our process), `recorded_at` (when the row was written to durable storage), `updated_at` (last mutation of a mutable row).
- A data point lives under exactly one top-level domain key.

## Taxonomy

19 top-level domains in the listed order, 232 types in total. Domain keys are snake_case. The `news` and `events` subsections below render one and the same single News / Events type list — one bullet feeds both top-level keys by decision (see Decision (a)).

### economy (20 types)
- GDP
- CPI / inflation
- PPI
- PCE
- PMI
- unemployment
- payroll / employment
- wages
- retail sales
- industrial production
- consumer confidence
- trade balance
- current account
- foreign reserves
- government debt
- fiscal balance
- money supply
- policy rate
- central bank balance sheet
- economic calendar / release

### fixed_income (11 types)
- treasury yield
- bond price
- coupon
- maturity
- duration
- yield curve
- credit spread
- OAS
- bond auction
- issuance
- default / credit risk

### equities (20 types)
- OHLCV
- tick
- trade
- quote
- bid / ask
- order book
- market cap
- shares outstanding
- EPS
- revenue
- net income
- balance sheet
- cash flow
- valuation ratios
- dividends
- splits
- earnings
- corporate action
- institutional holdings
- insider transactions

### forex (11 types)
- spot price
- OHLCV
- tick
- bid / ask
- spread
- forward
- swap
- cross rate
- reference rate
- volatility
- positioning

### commodities (10 types)
- spot
- futures
- OHLCV
- volume
- open interest
- forward curve
- inventory
- production
- consumption
- supply / demand

### crypto_spot (13 types)
- asset metadata
- price
- OHLCV
- trades
- ticker
- bid / ask
- order book
- volume
- market cap
- circulating supply
- total supply
- dominance
- exchange pairs

### crypto_derivatives (12 types)
- perpetual price
- futures price
- mark price
- index price
- funding rate
- predicted funding
- open interest
- basis
- premium
- liquidation
- long / short ratio
- taker buy/sell ratio

### options (15 types)
- option chain
- strike
- expiry
- call / put
- IV
- historical volatility
- delta
- gamma
- theta
- vega
- skew
- term structure
- put/call ratio
- max pain
- gamma exposure

### dex (13 types)
- token
- pair
- pool
- swap
- pool price
- liquidity
- volume
- fees
- LP position
- ticks
- price impact
- slippage
- liquidity depth

### defi (15 types)
- protocol
- TVL
- chain TVL
- deposits
- borrows
- utilization
- lending rate
- borrowing rate
- APY / APR
- protocol fees
- revenue
- treasury
- yield pool
- bridge volume
- stablecoin TVL

### blockchain (15 types)
- block
- transaction
- input/output
- address
- balance
- contract
- logs
- events
- token transfer
- gas
- gas fee
- validator
- staking
- mempool
- nonce

### onchain (16 types)
- exchange inflow
- exchange outflow
- exchange reserve
- whale activity
- active addresses
- new addresses
- transaction count
- transaction volume
- realized cap
- MVRV
- NUPL
- SOPR
- realized profit/loss
- holder distribution
- miner reserve
- LTH / STH supply

### stablecoins (9 types)
- supply
- circulating supply
- mint
- burn
- peg
- peg deviation
- chain distribution
- exchange reserve
- bridge flow

### funds (8 types)
- NAV
- AUM
- holdings
- inflow
- outflow
- net flow
- shares outstanding
- premium / discount

### positioning (8 types)
- COT
- commercial positions
- non-commercial positions
- leveraged funds
- asset managers
- dealers
- long / short ratio
- futures positioning

### sentiment (7 types)
- fear & greed
- social mentions
- social volume
- social dominance
- sentiment score
- search trend
- news sentiment

### news (10 types)
One News / Events type list; it feeds both the `news` and the `events` top-level keys (Decision (a)).
- news article
- headline
- source
- entity
- asset mentioned
- country
- event type
- sentiment
- importance
- timestamp

### events (10 types)
One News / Events type list; it feeds both the `news` and the `events` top-level keys (Decision (a)).
- news article
- headline
- source
- entity
- asset mentioned
- country
- event type
- sentiment
- importance
- timestamp

### prediction (9 types)
- event
- market
- outcome
- probability
- price
- volume
- liquidity
- order book
- resolution

## Coverage today

In-repo acquisition evidence per domain. "Taxonomy-only" means no in-repo producer exists today — an honest gap, not a coverage claim.

| Domain | In-repo acquisition evidence | Status |
|---|---|---|
| economy | none | Taxonomy-only / no in-repo producer |
| fixed_income | none | Taxonomy-only / no in-repo producer |
| equities | none | Taxonomy-only / no in-repo producer |
| forex | none | Taxonomy-only / no in-repo producer |
| commodities | none | Taxonomy-only / no in-repo producer |
| crypto_spot | coinmarketcap modes listing/global/marketPairs/exchanges (apps/data/internal/research/coinmarketcap), cryptorank modes incl. coins/trending (apps/data/internal/research/cryptorank), plus ccxt venues, DexScreener and CoinGecko feeds per section 3.4 of docs/architecture/data-categorization.md | Producer today |
| crypto_derivatives | coinank modes fundingRate/liquidation/longShort (apps/data/internal/research/coinank), coinglass modes statistics/openInterest/fundingRate/markets (apps/data/internal/research/coinglass) | Producer today |
| options | none | Taxonomy-only / no in-repo producer |
| dex | DexScreener and chain RPC feeds per section 3.4 of docs/architecture/data-categorization.md | Producer today |
| defi | llama modes chains/protocols/historical (apps/data/internal/research/llama) | Producer today |
| blockchain | chain RPC feeds per section 3.4 of docs/architecture/data-categorization.md | Producer today |
| onchain | none for onchain metric types; chainrank only yields research-type market rows (see note below) | Taxonomy-only / no in-repo producer for these types |
| stablecoins | none | Taxonomy-only / no in-repo producer |
| funds | coinank modes etf/whales (apps/data/internal/research/coinank) | Producer today |
| positioning | none | Taxonomy-only / no in-repo producer |
| sentiment | signals route (row route-api-signals, section 3.2 of docs/architecture/data-categorization.md) — sentiment-adjacent only | Sentiment-adjacent evidence; no direct producer |
| news | cryptorank modes incl. news (apps/data/internal/research/cryptorank), Cointelegraph RSS (apps/data/internal/research/news), khala reports (apps/data/internal/research/khala) | Producer today |
| events | none; shares the single News / Events source bullet with news (Decision (a)) | Taxonomy-only / no in-repo producer |
| prediction | cryptorank modes incl. prediction (apps/data/internal/research/cryptorank) | Producer today |

Note on chainrank: its modes stats/listings (apps/data/internal/research/chainrank) produce research-type market rows — a research-domain surface that does not map onto any single top-level domain above.

## Decisions

- (a) One News / Events type list feeds both top-level keys: the single bullet is rendered under both `news` and `events` because the two surfaces classify the same article-level facts; the duplicated subsections are one source list, not two lists that must be kept in sync by hand.
- (b) Domain keys are snake_case and stable: existing keys are not renamed or renumbered; new domains append after `prediction`.
- (c) This taxonomy does NOT replace the code domains of section 3 in `docs/architecture/canonical-model.md` nor the categories in `docs/architecture/data-categorization.md` — it is a third axis: code domain says who owns the record, category/provider says which surface it arrived on, data-point domain says what the point IS.
- (d) `contracts/schemas/taxonomy/datapoint-taxonomy.json` is the machine-readable form of this document; it pins the 19 domains in order, each domain's exact type list, and the 13 dimensions.
