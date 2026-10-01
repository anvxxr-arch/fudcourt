# Data Classification Matrix (Phase 1)

The matrix answers, for every major dataset in the tree: *what type of data is this, where
should it live, who owns it, how long is it kept, how fresh must it be, is it sensitive, and
what canonical model does it map to.*

Companion documents: `docs/architecture/source-catalog.md` (which feeds exist) and
`docs/architecture/data-catalog.md` (per-dataset detail). Entity names, owners, class
vocabulary and the duplicate-concept decisions **D1–D6 / D-US1–D-US5 / D-CANON** are
`docs/architecture/canonical-model.md`'s (§2, §3, §6, §7); where this matrix assumes a name or
owner that document does not state, the row is repeated in §4.

Scope: task brief supplied to this audit; not stored in-repo. Originating session transcript:
`history://source-inventory`. **Path note:** all paths are post-move
(`backend/data/internal/research/*`, `backend/data/platform/*`,
`backend/api/internal/{markets/{instruments,overview},finance/*,accounts/*,access/*}`),
verified with `test -f`.

---

## 1. Dimensions

| Dimension | Values used here |
|---|---|
| **layer** | RAW / PARSED / NORMALIZED / CANONICAL / ENRICHED / DERIVED / PRODUCT_VIEW (canonical-model.md §1) |
| **ownership** | exactly one owner, or **unowned — no in-repo writer** |
| **frequency** | REALTIME / NEAR_REALTIME / FREQUENT / PERIODIC / STATIC / MANUAL |
| **mutability** | append-only / mutable (updated in place) / overwrite-per-run |
| **durability** | EPHEMERAL / SNAPSHOT / EVENT / HISTORICAL / CANONICAL (canonical-model.md §6.2 adds D1–D5) |
| **time semantics** | occurred_at / observed_at / received_at / recorded_at / updated_at (canonical-model.md §4) |
| **identity** | canonical id + `(provider, provider_id)` mapping, or the de-facto key (**symbols are not identity**) |
| **sensitivity** | PUBLIC / INTERNAL / USER_PRIVATE / SECRET (canonical-model.md §6.3 adds S0–S5) |

## 2. The matrix

### 2.1 Market / reference / market-data

| dataset | domain | source | layer | ownership | frequency | mutability | durability | time semantics | identity | sensitivity |
|---|---|---|---|---|---|---|---|---|---|---|
| Asset (as a symbol column) | assets | CoinGecko / CryptoRank / chain RPCs / manual | NORMALIZED | **unowned** — nearest `backend/api/internal/finance` (consumers only) | per request / per sync | mutable | CANONICAL (as a column) | recorded_at (`assets.updated_at`); occurred_at ✗ | symbol string; **no `asset_id`, no mapping table** (D-CANON) | INTERNAL |
| Token (`chain:address`) | onchain / assets | DexScreener, Solana/EVM RPC | PARSED | **unowned** — nearest `frontend/web/src/features/dex` (read-only) | per request / per sync | append-only (never rewritten) | NONE (dex) | observed_at ✗ | raw address; `[INFERENCE]` intended `chain:address` | PUBLIC |
| Chain | onchain | Solana/EVM RPC, Hyperliquid, CryptoRank, ChainRank | NORMALIZED | split: `accounts/wallets` validates, `backend/sync` enumerates | static + per sync | mutable (registry table) | CANONICAL (as column) | observed_at ✗ | lowercase name; no `chain_id` | INTERNAL |
| Venue | markets / trading | Binance/Bybit/MEXC REST, ccxt, DexScreener | NORMALIZED | `backend/api/internal/accounts/exchange` (validity only) | static | mutable | CANONICAL (`venues` table, **no writer**) | recorded_at ✗ | text slug, not a provider id | PUBLIC |
| Instrument | markets | ccxt market maps (10 venues) | CANONICAL (identity) / NORMALIZED (values) | `backend/api/internal/markets/instruments` | per request; 24 h market-map cache | mutable | NONE (no table) | observed_at = venue stamp; expiry is a domain fact | **minted `instrument_id` `exchange:marketType:BASE/QUOTE`** — no producer outside tests | PUBLIC |
| Quote (= Ticker) | markets | 10 ccxt venues | NORMALIZED | `backend/api/internal/markets/overview` | REALTIME | append-only (per sweep) | EPHEMERAL (`TICKER_TTL_MS = 60_000`) | observed_at = `VenueQuote.at` / `Ticker.Ts` | `(venue, symbol)` | PUBLIC |
| TickerRow (cross-venue aggregate) | markets | same | DERIVED / PRODUCT_VIEW | `frontend/web/src/features/ticker` | REALTIME | overwrite-per-run | EPHEMERAL | observed_at = per-venue `at` | symbol+type | PUBLIC |
| Price series (`price_history`) | markets | intended "price sampler" | CANONICAL-shaped storage, **no producer** | **unowned — no in-repo writer** | intended PERIODIC | append-only | HISTORICAL (90-day DELETE) | observed_at = `ts`; `source` = provenance | **symbol-as-identity** unique `(symbol, ts, source)` — named as the schema-level identity violation | PUBLIC |
| MarkPrice / IndexPrice / FundingRate / OpenInterest | markets | ccxt + venue endpoints | NORMALIZED (types only) | `backend/api/internal/markets/overview` | REALTIME | append-only | EPHEMERAL | observed_at = `Ts` / `NextFundingAt` | `(venue, symbol, kind)` | PUBLIC |
| Candle | markets | ccxt `fetchOHLCV` | NORMALIZED (type only) | `backend/api/internal/markets/overview` | REALTIME on request | append-only | NONE (**no table**) | occurred_at ≈ `OpenTime` | `(Exchange, Symbol, Interval, OpenTime)` | PUBLIC |
| Order book | markets | ccxt `fetchOrderBook` | NORMALIZED | `backend/api/internal/markets/overview` | REALTIME | overwrite-per-run | EPHEMERAL | observed_at = `Ts` | `(venue, symbol)` | PUBLIC |
| CoinGecko markets pool | markets | CoinGecko | PRODUCT_VIEW | `frontend/web` route (acquisition debt) | FREQUENT | overwrite-per-run | NONE (TTL cache) | received_at ✗ | CoinGecko `id`, unmapped | PUBLIC |
| DexScreener pairs / profiles / boosts | defi / markets | DexScreener | PARSED | **unowned** — `features/dex` read-only | FREQUENT | append-only | NONE | `pairCreatedAt` only | `pairAddress`; **no Pool identity** | PUBLIC |
| Signals feed rows | signals | `data-public.vercel.app` | PRODUCT_VIEW | **unowned** — web proxy only | NEAR_REALTIME | append-only | NONE | `ts` = **seconds treated as ms** (T4) | provider `(id, mint)` composite | PUBLIC |

### 2.2 Research / news

| dataset | domain | source | layer | ownership | frequency | mutability | durability | time semantics | identity | sensitivity |
|---|---|---|---|---|---|---|---|---|---|---|
| CryptoRank coin rows (`CrCoin`…) | research / markets | CryptoRank HTML SSR | NORMALIZED | `backend/data/internal/research/cryptorank` | FREQUENT (L1 60 s) | overwrite-per-run (cache) | NONE (disk cache) | received_at = `CrEnvelope.FetchedAt`, reused on L2 HIT (T5) | slug/name/symbol strings; provider `ID *float64` where present, unmapped | PUBLIC |
| CryptoRank envelopes | research | same | PRODUCT_VIEW | same | FREQUENT | overwrite-per-run | NONE | received_at = `fetchedAt`; `cache` HIT/MISS | mode+key | PUBLIC |
| CryptoRank fixtures + expected envelopes | research / system | recorded 2026-09-27 | RAW (frozen) | `tests/fixtures` | STATIC | append-only | HISTORICAL | `recordedAt` (epoch s) + per-mode `fetchedAt` | mode name | PUBLIC |
| DefiLlama chains / protocols / historical | defi | DefiLlama | NORMALIZED (raw rows + projection) | `backend/data/internal/research/llama` | PERIODIC (15 s TTL) | overwrite-per-run | NONE | received_at only | provider **slug**; no canonical Protocol id | PUBLIC |
| Khala reports | news / research | khala.io | PARSED | `backend/data/internal/research/khala` | PERIODIC | overwrite-per-run | NONE | `reports` has **no dates**; `latest` resolves per-report dates | slug only | PUBLIC |
| Cointelegraph RSS items | news | cointelegraph.com | PARSED (= wire) | `backend/data/internal/research/news` | FREQUENT | overwrite-per-run | NONE | `occurred_at` = `pubDate` (RSS string, not normalized) | `link` / `title` | PUBLIC |
| ChainRank stats / listings | research (site metrics) | chainrank.fyi | RAW passthrough | `backend/data/internal/research/chainrank` | NEAR_REALTIME / FREQUENT | overwrite-per-run | NONE | received_at ✗ (only `upstream` names the URL) | none | PUBLIC |
| CMS post (editorial) | news (editorial) | editor UI / seed | CANONICAL | Payload CMS (Neon) | MANUAL | mutable + versioned | CANONICAL | `published_at` = occurred_at analogue; created/updated | serial PK + unique `slug` | PUBLIC (published) / INTERNAL (draft) |
| CMS categories / tags / media | news (editorial) | editor UI | CANONICAL | Payload CMS | MANUAL | mutable | CANONICAL | created/updated | slug / filename | PUBLIC |
| CMS users / sessions | access (CMS-only) | admin UI | CANONICAL | Payload CMS | MANUAL | mutable / append | CANONICAL | created/updated; `expires_at` | serial PK + unique email | **SECRET** |

### 2.3 On-chain, portfolio and treasury

| dataset | domain | source | layer | ownership | frequency | mutability | durability | time semantics | identity | sensitivity |
|---|---|---|---|---|---|---|---|---|---|---|
| Wallet registry | accounts / onchain | UI + Rust constants | CANONICAL | `accounts/wallets` (validate); writer = Next route + out-of-band | MANUAL | mutable | CANONICAL | recorded_at `created_at`; updated_at ✗ | **address as PK**; no `wallet_id` | **USER_PRIVATE** |
| Synced balances (`assets`) | portfolio / onchain | Alchemy ×6, Solana RPC, Hyperliquid | NORMALIZED → SQL (no canonical step) | `backend/sync` Rust (+ legacy `sync-live.py`) | PERIODIC (5 min) | **overwrite-per-run** (`DELETE FROM assets` + inserts) | SNAPSHOT | observed_at = run time; recorded_at = `updated_at` | `(wallet, chain, asset)` undeclared; `MATIC`/POL relabel breaks it | INTERNAL |
| Hyperliquid positions / spot | trading / onchain | Hyperliquid `info` | NORMALIZED → SQL | `backend/sync` | PERIODIC | overwrite-per-run | SNAPSHOT | observed_at only | coin symbol + wallet | INTERNAL |
| Hyperliquid fills | trading | Hyperliquid `info` | NORMALIZED | `backend/sync` | PERIODIC | append-only | NONE (not stored) | venue fill time in payload | — | INTERNAL |
| Solana token accounts | accounts / onchain | Solana RPC | PARSED | `backend/sync` | PERIODIC | overwrite-per-run | SNAPSHOT | observed_at only | mint **truncated to 6 chars** in the label | INTERNAL |
| Oracle replay capture | system (test) | recorded responses | RAW (frozen) | `tests/oracle/fixtures` | STATIC | append-only | HISTORICAL | recorded once | request key | INTERNAL |
| Transaction (history row) | portfolio / ledger | manual UI entry | CANONICAL | `backend/api/internal/finance/transactions` | MANUAL | mutable (edit/delete via API) | CANONICAL | `date` TEXT (T3); `created_at` = recorded_at | SQL surrogate `id`; **no canonical id** | INTERNAL |
| LedgerEntry | ledger | treasury movements, executions, fees, adjustments | CANONICAL type, **storage mismatch** | `backend/api/internal/finance/ledger` | EVENT | **append-only by contract** | CANONICAL | `OccurredAtMs` = occurred_at; `CreatedAt` = recorded_at | `ID` + natural dedup key | INTERNAL |
| Treasury account / movement | treasury | internal transfers | NORMALIZED (value model, no store) | `backend/api/internal/finance/treasury` | MANUAL | append-only (movements) | NONE | `Movement.OccurredAt` = occurred_at | `Account.ID`; `accounts.code` | INTERNAL |
| Journal entry / ledger balance / chart of accounts / trade log | ledger, trading (legacy) | manual (out of band) | CANONICAL (table shape only) | **unowned — no in-repo writer** | MANUAL | mutable | CANONICAL | `date` TEXT (T3); `ledger` has **no time column at all** | surrogate `id`; `code`/`(venue,symbol)` strings | INTERNAL |
| Asset history | portfolio | projection of `assets` | SNAPSHOT history | `platform/db/mirror.ts` | every projection (60 s) | append-only + upsert | HISTORICAL (90-day) | observed_at = `ts` | coalesced `(ts, chain, asset, wallet)`; **symbol-as-identity** | INTERNAL |
| Net worth / valuation | portfolio | own computation | DERIVED | `platform/db/client.ts` `getAll` + `finance/portfolio` | per request | overwrite-per-run (computed) | NONE | `AsOf = time.Now().UnixMilli()` inside the derivation (T6) | asset symbols; `InstrumentID` | INTERNAL |
| Reconcile report | portfolio / ledger | three Turso SELECTs | DERIVED | `backend/sync` `reconciliation/reconcile.rs` | on request | overwrite-per-run | NONE | expected vs current are **two different as-of stamps** | `(wallet, asset)`; `"Unknown"` fallback | INTERNAL |

### 2.4 Executor (trading)

| dataset | domain | source | layer | ownership | frequency | mutability | durability | time semantics | identity | sensitivity |
|---|---|---|---|---|---|---|---|---|---|---|
| ExchangeAccount + sealed credential | accounts / access | user input | CANONICAL | Next `platform/executor/store.ts` (writes) + `accounts/exchange` (validate) | MANUAL | mutable (health/rotate/revoke) | CANONICAL | recorded/updated/last_used/revoked (bigint ms); occurred_at ✗ | account uuid; venue fingerprint never used as identity | **SECRET** (sealed columns + `iv`/`auth_tag`) |
| Execution (+ plan snapshot) | trading | own engine | CANONICAL | `backend/workers/executor/internal/executor` | REALTIME | mutable (upsert by `id`) | CANONICAL | created/started/completed/cancelled (ms) | **minted uuid** + `evt_<id>_<seq>` | USER_PRIVATE |
| Order (child order) | trading | Binance/Bybit/MEXC order APIs | CANONICAL | `backend/workers/executor/internal/orders` (+`idempotency`) | REALTIME | mutable per transition | EVENT | `submitted_at`/`updated_at`/`filled_at` (ms) | **`fud_<executionId>_<seq>`**; venue id kept beside it | USER_PRIVATE |
| Fill | trading | venue trade endpoints | CANONICAL | `backend/workers/executor/internal/exchange` (ingest) | REALTIME | append-only (dedup) | EVENT | `timestamp` = **venue occurred_at** | `(account_id, exchange_trade_id)` UNIQUE is the guarantee | USER_PRIVATE |
| Execution events | trading / system | own engine | CANONICAL (append-only) | `backend/workers/executor` | REALTIME | **append-only (enforced)** | EVENT (D1 system of record) | `created_at` ms; subject time in payload | `evt_<executionId>_<seq>` | USER_PRIVATE (prices → S3, never S0) |
| Balance / position snapshots | accounts / trading | venue `GetBalance`/`GetPosition` | NORMALIZED → jsonb | executor repository | PERIODIC | append-only | HISTORICAL | `AccountEquity.Timestamp` = observed_at; `created_at` = recorded_at | `(account_id, created_at)` | USER_PRIVATE |
| Risk profile | trading (config) | user input | CANONICAL | Next `store.ts` | MANUAL | mutable (upsert) | CANONICAL | `updated_at` ms | `user_id` | USER_PRIVATE |
| Audit log | system | own engine | CANONICAL (append) | executor repository | REALTIME | append-only | EVENT | `audit.Record.OccurredAtMs` = occurred_at | bigserial | USER_PRIVATE |
| Preview / derived P&L & sizing | trading (derived) | own engine + quotes | DERIVED | `internal/{risk,sizing,planner}` | REALTIME | overwrite-per-run | NONE | computed per request | `req_<…>` idempotency keys | USER_PRIVATE |
| Identity / Session | access | Discord OAuth2 | CANONICAL | `backend/api/internal/access/identity` | MANUAL (per login) | mutable | SESSION | `Exp` in **seconds** vs `ExpiresAtMs` in ms (T1); `IssuedAtMs` never assigned (T7) | Discord snowflake | **SECRET** (token) / S2 |
| Credential (platform-shaped) | access | user-entered keys | CANONICAL | `backend/api/internal/access/credentials` | MANUAL | mutable | CANONICAL | `Credential.Updated` | account uuid | **SECRET** |
| Entitlement / authorization decision | access | session + roles | CANONICAL (in-memory) | `access/{entitlements,authorization}` | MANUAL | mutable | NONE | ✗ | role tier | INTERNAL |

## 3. What the matrix says at a glance

- **Ownership:** of the **49 rows** in §2, **6** carry `unowned`/`owner absent` in the ownership
  column (`Asset`, `Token`, `price_history`, `DexScreener pairs / profiles / boosts`, `Signals feed
  rows`, and the combined `Journal entry / ledger balance / chart of accounts / trade log` row).
  The other writer-less tables/CDDL the rest of this document records — `accounts`, `journal`,
  `ledger`, `trades`, `venues` (`database-classification.md` §6 finding 1), treasury
  account/movement storage, the `asset_history` consumers and the DexScreener *pool* identity — are
  either grouped into one of those rows or named in a later column, not separate rows of this
  matrix. Every remaining row has exactly one owner.
- **Durability:** only **6** datasets are true `CANONICAL` system-of-record (`transactions`,
  `executor.executions`, `exchange_accounts`, `risk_profiles`, wallet registry, CMS content).
  The treasury plane's canonical facts live in a table that is **overwrite-per-run** (`assets`).
- **Time semantics:** four of the five names have real carriers; **`received_at` has none** —
  `fetchedAt` is reused verbatim by an L2 cache HIT (T5), so a cached body reports the original
  read as if it were this read.
- **Identity:** only the executor's id spaces and `instrument_id` satisfy D-CANON. `Asset`,
  `Token`, `Chain`, `Venue`, `Price`, `Balance`, `Signal` and `NewsArticle` key on provider
  strings; two SQL tables bake that into a UNIQUE constraint.
- **Sensitivity:** SECRET material exists in exactly three places, all sealed or digested —
  `executor.exchange_accounts` ciphertext columns, the platform credential envelope, and the
  CMS `users.hash`/`salt`. No plaintext key material is stored anywhere.

## 4. Rows requiring reconciliation with `docs/architecture/canonical-model.md`

`docs/architecture/canonical-model.md` exists and its vocabulary was used. Assumptions this
matrix had to make (identical set to `data-catalog.md` §11, kept here so the two files cannot
drift):

| row | assumption | why it needs reconciliation |
|---|---|---|
| Asset (as a column) | owner = "unowned — nearest `finance/*` consumers" | canonical-model.md agrees; the eventual owner is its open question O3 |
| Balance / Position snapshots | durability = HISTORICAL (append) | canonical-model.md calls them snapshots but does not fix the durability class |
| LedgerEntry storage | "no table matches `Entry`" | canonical-model.md says the same (D-US5) without naming a replacement |
| `journal` / `ledger` / `trades` / `accounts` | owner = "unowned — no in-repo writer" | canonical-model.md open question O2 |
| CMS datasets | entity = editorial content adjacent to `NewsArticle` | canonical-model.md defines `NewsArticle` for feed articles only |
| Executor audit log | assumed the same shape as `backend/api/internal/audit` | not stated in canonical-model.md |
| Hyperliquid spot labels | `[INFERENCE]` from the capture fixture | undocumented |
| Signals | owner = "unowned — web proxy only" | upstream owner is outside the repo |
| References to `database/schema/analytics.sql`, `backend/api/bin/fudcourt-api`, the `backend/workers/executor/internal/repository` package, and `tests/fixtures/*` | used as *names/globs*, not literal paths | the first does not exist (stale doc reference in `docs/architecture/domain-map.md:53`), the second is a build artifact, the third is written as a package name, the fourth as a glob |

---

# Part A — Provider DTO leak audit

Every provider-specific parsed struct/type in the tree, and whether it stays inside its adapter.
"Canonical table column" means the provider's own field names/shape reach a durable column;
"envelope" means it reaches a wire response; "component" means a React component imports it.

| file + symbol | provider | stays in adapter package? | reaches contracts / envelope / canonical column / component? | verdict |
|---|---|---|---|---|
| `backend/data/internal/research/cryptorank/types.go` — 43 `Cr*` types (`CrCoin:21`, `CrChainRow:132`, `CrNewsRow:157`, `CrAiOverview:403`, `CrEnvelope:438`, …) | CryptoRank | **No** — `types.go` is provider-local but exported and its JSON tags *are* the wire contract (`types.go:2-5`) | **Envelope: yes** — every `Cr*` field ships to the client via `envelope.go` and the `api/cryptorank` route. **Component: yes** — `features/cryptorank/ui.tsx:9,10,125,549,767,886` imports `CrCoin`/`CrCoinDetail`/`CrTrendingRow`. **Table column: no** | **leaks** (envelope + component). The prompt's rule "raw provider structures must NOT propagate into frontend" is violated by design today; canonical-model.md §1.3 already records the TS mirror as non-runtime |
| `backend/data/internal/research/cryptorank/shapers.go` — `ShapeCoin:17`, `ShapeListing:131`, … | CryptoRank | yes (package-local) | no | contained |
| `backend/data/internal/research/cryptorank/value.go` — `asNum:17`, `asNumLoose:27`, `jsNumber:150` | CryptoRank (JS semantics) | yes | no | contained |
| `backend/data/internal/research/khala/parse.go` — `khCard:54`, `KhBlock:175`, `KhSection:182`, `KhAuthor:189`, `ParsedReport:195` | khala.io | yes | `KhReport` reaches the envelope (`features/khala/client.ts:70`); `ParsedReport` itself does not | contained (envelope is a re-shape, not the parse type) |
| `backend/data/internal/research/news/parse.go` — `Item:23` | Cointelegraph RSS | yes | **Envelope: yes, by construction** — the parse output *is* the wire shape (`itemRe:33`) | **leaks** (documented as PARSED = wire) |
| `backend/data/internal/research/llama/shape.go` — `Rows []json.RawMessage:87`, `LlamaChain:32`, `LlamaProtocol:55`, `LlamaHistoricalPoint:73` | DefiLlama | yes | rows ship as raw JSON through `projectProtocols:210` / `projectHistorical:242`; the UI imports `LlamaProtocol` (`features/llama/ui.tsx:5`) | **leaks** (envelope + component); the Go types are documentation only |
| `backend/data/internal/research/chainrank/shape.go` — `map[string]json.RawMessage:36`, `CheckShape:64` | ChainRank | yes | **Envelope: yes** — verbatim upstream body with provenance | **leaks by design** (explicit passthrough) |
| `backend/workers/executor/internal/exchange/binance/parse.go` — `orderWire:20`, `tradeWire:41`, `positionRiskRow:55` | Binance | **yes** (unexported) | no — converted to `executor.NormalizedOrder`/`Fill`/`Position` inside the adapter | **contained** |
| `backend/workers/executor/internal/exchange/bybit/parse.go` — `envelope:15`, `keyInfo:71`, `walletCoin:111`, `walletAccount:119`, `positionRow:141`, `tickerRow:165`, `orderRow:190`, `flexBool:207`, `executionRow:247` | Bybit | **yes** (unexported) | no | **contained** |
| `backend/workers/executor/internal/exchange/mexc/parse.go` + `mexc.go` — `rawJSON = map[string]json.RawMessage:23`, `orderFallback:239`, key probes `obj["success"|"data"|"code"]` (`mexc.go:599-610`) | MEXC | **yes** (unexported) | no | **contained** |
| `backend/workers/executor/internal/exchange/paper/*` — `PaperConfig` (marks injected as data) | FUDCourt (self) | yes | no | contained (not a provider) |
| `backend/sync/src/streams/sync.rs` — `serde_json::Value` decoding in `sync_solana`, `sync_evm`, `sync_hyperliquid`, plus `json_f64`, `sol_lamports:133`, `ui_amount`, `scale_dec:275`, `hl_usd:292` | Solana / Alchemy / Hyperliquid | **yes** (in-process decode) | **Canonical column: partly** — `SOLAMA`-style and `SPL:<mint6>` labels are written straight into `assets.asset` (`sync.rs:186-192`), and the Polygon native is written as `MATIC` for a `POL` node (`chains.rs:112-115`) | **leaks** into a durable column (lossy/relabelled asset labels) |
| `frontend/web/src/features/dex/client.ts` — `DexPair:75`, `DexToken:73`, `DexProfile:105`, `addressKind:65` | DexScreener | **No** — it lives in a shared feature module | **Component: yes** — `features/dex/ui.tsx:5,69,70,204` imports `DexPair`/`DexProfile` directly. **Envelope: yes** | **leaks** (component + envelope) |
| `frontend/web/src/features/ticker/client.ts` — `VenueQuote:185`, `TickerRow:254`, `TickerInstrument:220` | ccxt (10 venues) | **No** | **Component: yes** (`features/ticker/ui.tsx`, `detail.tsx`); route envelope too | **leaks** (component + envelope) |
| `frontend/web/src/features/markets/client.ts` — `MarketsCoin:54` | CoinGecko | **No** | route-local `CgRow` (`frontend/web/src/app/(frontend)/api/markets/route.ts:30`) re-shapes it before the envelope; the client type is imported by the route only | **partly contained** (envelope is a re-shape; the type name still carries the provider) |
| `frontend/web/src/features/news/client.ts` — `NewsItem:28`, `NewsEnvelope:41` | Cointelegraph (via `backend/data`) | **No** | envelope + component | **leaks** (provider-shaped item name/fields reach the UI) |
| `frontend/web/src/features/khala/client.ts` — `KhRow:60`, `KhReport:70`, `KhEnvelope:86` | khala.io | **No** | envelope + component | **leaks** |
| `frontend/web/src/features/llama/client.ts` — `LlamaChain:32`, `LlamaProtocol:41`, `LlamaHistoricalPoint:54`, `LlamaEnvelope:64` | DefiLlama | **No** | envelope + component | **leaks** |
| `frontend/web/src/features/chainrank/client.ts` — `ChainrankRow:37`, `ChainrankPage:56`, `ChainrankStats:64`, `…Envelope:98,114` | ChainRank | **No** | envelope + component | **leaks** |
| `frontend/web/src/features/cryptorank/client.ts` + `shapers.ts` — 25 `Cr*` interfaces (`CrCoin:233`, `CrGlobal:219`), `shapeCoin:93`, `envelope:276` | CryptoRank | **No** | `shapers.ts` is imported only by `frontend/web/tests/shaper-tests.ts:22` and `tests/oracle/dump-envelopes.ts:54` — the **runtime path is Go**; `client.ts` types do reach `features/cryptorank/ui.tsx` | **leaks at the type level** (UI); the shaper module itself is test-only |
| `frontend/web/src/features/executor/client.ts` + `shapers.ts` | none (own API) | n/a | imports `@/platform/executor/types` — the executor's **own** frozen contract, not a provider's | contained |
| `shared/contracts/schemas/**` — `assets/asset.json:59-82` (`provider_ids`), `markets/instrument.json:22,36`, `markets/venue.json:22,30`, `common/identifier.json:5`, `defi/protocol.json:15,99` | — | — | provider names appear **as enumerated mapping values and descriptive text**, never as field names: `provider_ids` is an object keyed by provider, and `identifier.json` states the rule that a provider id is never identity | **contained (correct pattern)** |
| `shared/contracts/openapi/fudcourt.yaml` | contains provider names | — | path/operation names, not payload shapes `[INFERENCE]` (file not read line-by-line in this pass) | contained `[INFERENCE]` |

**Summary.** All four Go venue adapters (Binance/Bybit/MEXC/paper) are **properly contained**:
their wire structs are unexported, converted inside the package, and never appear in a contract,
envelope or column. The **acquisition side leaks almost everywhere**: CryptoRank, DefiLlama,
khala, ChainRank, DexScreener, CoinGecko and ccxt shapes all cross into the frontend, either as
route envelopes (by design, with provenance) or as TypeScript types imported directly by
components (`features/{dex,ticker,llama,news,khala,chainrank,cryptorank}`). One Rust path leaks
provider-derived *values* into a durable column (`assets.asset` labels `MATIC`, `SPL:<mint6>`).
The new `shared/contracts/schemas/**` tree is the only place that models providers correctly —
as an enumerated mapping key, never as a field name.

---

# Part B — Duplicate-concept audit

Requested pairs, each with evidence and a decision. Where a decision already exists in
`docs/architecture/canonical-model.md` §7, this table restates it and cites it rather than
re-deciding.

| # | concepts | distinct or duplicate? | evidence paths | decision + required change |
|---|---|---|---|---|
| **B1** | **Coin** vs **Token** vs **Asset** | **Partially duplicate; three words, one string today** | `CrCoin` (`…/research/cryptorank/types.go:21`), `MarketsCoin` (`features/markets/client.ts:54`), `DexToken` (`features/dex/client.ts:73`) are three provider words for "a thing with a symbol"; the domain side has **no type at all**, only `string` in `finance/{ledger,transactions,portfolio,treasury}` and SQL `assets.asset`. Rust adds a fourth label (`SPL:<mint6>` `streams/sync.rs:186-192`) | **D1 in canonical-model.md — distinct: Asset (economic thing, needs `asset_id` + provider mapping), Token (contract instance `chain:address`), Coin (provider vocabulary, NOT an entity).** Required change: mint `asset_id`/`token_id`, add the missing mapping table, keep `Asset string` as the symbol alongside — additive only |
| **B2** | **Ticker** vs **Price** vs **Quote** | **Two distinct concepts, three names** | `markets.Ticker` (`markets/overview/market.go:38`) = `VenueQuote` (`features/ticker/client.ts:185`) = one venue's observation; `TickerRow` (`:254`) = an aggregate (median + `failed[]`); `price_history.price` (`pg-schema.sql:137`) = a stored observation keyed by symbol; `MarkPrice`/`IndexPrice` (`market.go:84,93`) = named reference series | **D2 — Quote (= Ticker = VenueQuote) and Price (a point on a persisted series) are the entities; `Ticker` is a legacy synonym to rename later; `TickerRow` is a PRODUCT VIEW.** Required change: when Price is built, `price_history`'s unique key must become `(instrument_id, source, observed_at)`; the `Ticker→Quote` rename is a separate phase (36 OpenAPI paths reference it) |
| **B3** | **ExchangeAccount** vs **Account** | **Genuinely distinct, same noun (three things share it)** | `treasury.Account` (`finance/treasury/treasury.go:35`) = internal capital, one asset; `exchangeaccounts`→`accounts/exchange.ExchangeAccount` (`accounts/exchange/account.go:102`) = venue link with credentials/health; SQL `accounts(code,name,type,statement)` (`schema.sql:3-8`) = chart of accounts, **no writer**; plus `executor.exchange_accounts` (`executor-schema.sql:32`) = the merged credential row | **D3 — distinct; document-only + disambiguate names in contracts** (`TreasuryAccount`, `ExchangeAccount`, `LedgerAccount`). No code rename bundled with a behavior change |
| **B4** | **Transaction** vs **Transfer** vs **LedgerEntry** | **LedgerEntry and Transaction are distinct; Transfer is not an entity** | `ledger.Entry` (`finance/ledger/ledger.go:71`, signed, closed `Kind` set, natural dedup key `:127-141`); `transactions.Transaction` (`finance/transactions/transactions.go:51`, user-facing row with `Date/Chain/Event/Hash/URL/Source`); `treasury.Movement` (`finance/treasury/treasury.go:60`, positive magnitude + mandatory `Reason`); SQL `journal`/`ledger` carry a *third* shape (`schema.sql:21-31,33-40`) that matches neither | **D4 — distinct.** Transfer = `Kind` + `Movement` (two LedgerEntries). Required change: **document only**; the SQL `ledger`/`journal` tables are a fourth, unowned shape and must be reconciled when a store is chosen (see matrix §2.3) |
| **B5** | **Market** vs **Pair** vs **Symbol** vs **Instrument** | **Three of four are the same concept under different names** | `instruments.Instrument` (`markets/instruments/instrument.go:52-53`) = venue-scoped tradable market with a grid; `markets.Ticker.Symbol` is canonical `BASE/QUOTE` **without** a venue (`market.go:41`); `VenueSymbol` (`symbol.go:81`) = venue spelling; `DexPair` (`features/dex/client.ts:75`) = a DEX **pool** (genuinely different); ccxt says "market"; executor says `symbol` + `VenueKey` (`platform/executor/types.ts:54,1366`) | **D5 — Instrument is the entity; Market/Pair/Symbol are not.** Required change: record that `Ticker.Symbol` must become `instrument_id`; today the executor's `VenueKey` (`exchange:marketType:BASE/QUOTE`) and markets' `Symbol` (`BASE/QUOTE`) **cannot be joined** — the sharpest interoperability gap in the repo |
| **B6** | **Execution** vs **Order** | **Distinct (one-to-many), already modelled correctly** | `ExecutionRecord` (`executor/records.go:13`) owns plan (`executor-schema.sql:100`), N `child_orders` (`:106`, FK), events (`:147`); `ChildOrderRecord` (`records.go:76`) has its own 10-state lifecycle keyed by `client_order_id`; fills reference the child order | **D6 — distinct, no change.** The schema tree must not invent a merged status enum |
| **B7** | **categories** (market/CryptoRank) vs **categories** (CMS) | **Duplicate *name*, unrelated concepts** | Market side: `CrCategoryInfo` (`…/research/cryptorank/types.go:411`), the UI's category panels, `features/cryptorank/ui.tsx`. CMS side: `categories(title,slug,description)` (`frontend/web/src/cms/migrations/20260917_194354.ts:111-119`) + `posts_rels.categories_id` (`:51-58`), seeded by `src/cms/seed.ts` | **Not on canonical-model.md's list — decision here: distinct concepts that must never share a word in contracts.** Required change: name the market one `AssetCategory` (or a `CryptoRank taxonomy` product view) and the editorial one `ContentCategory`; today both are spelled `categories`, and `database/README.md:150-152` already excludes the CMS tables from the trading surface |
| **B8** | *(extra)* decimal-arithmetic helpers duplicated 5× | **Decided-intentional** | `finance/{ledger,portfolio,transactions,treasury}/decimal.go` + `instruments/rounding.go:17` + `markets/overview/decimal.go:14` + `executor/internal/decimal` | **D-US3 — keep**, documented as intentional decoupling |
| **B9** | *(extra)* supported-exchange set hard-coded 3× | **Duplicate** | `accounts/exchange/account.go:122-125`, `markets/instruments/symbol.go:50-51,88-91`, `accounts/wallets/wallets.go:57-61` | **D-US1 — collapse to one registry** (`markets/venue.json` is the contract); a code change touching 3 packages must be its own step |
| **B10** | *(extra)* wire types re-declared in the UI | **Duplicate** | `features/ticker/ui.tsx:11-45` re-declares `VenueQuote`/`TickerRow`; `features/signals/ui.tsx:6-48` re-declares the route payload | **D-US4 — fix in Phase 5** by consuming generated SDK types; no behavior change |

**Net decisions for this turn (no code changed):** B1/B2/B5 require new persistence (id space +
mapping table) before they can be closed; B3/B4/B6/B7 are document-only or contract-naming;
B8/B9/B10 are recorded with their required change and their blocking phase.
