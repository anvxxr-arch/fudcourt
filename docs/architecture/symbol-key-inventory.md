# Symbol-key inventory — every place a provider/symbol string acts as identity or join key

The migration touch-list for the canonical-id workstream. Companion to — and deliberately **not** a
duplicate of — `data-catalog.md` (per-dataset identity strategy), `database-classification.md`
(per-table columns/readers) and `data-classification.md` **Part B** (duplicate-concept decisions).
Those documents answer "what is this dataset/table/column"; this one answers "which concrete
string, at which line, is load-bearing as an identity, and what would replace it".

Canonical minting and the mapping artifact: `backend/api/internal/markets/reference/**`,
`backend/api/internal/markets/instruments/canonical.go`, `shared/contracts/data/reference.json`
(9 chains, 8 assets, 11 tokens, 12 venues, 49 mappings, 3 misses — re-read this turn), DR-034 and
DR-036 in `docs/records/DECISIONS.md`.

**Reading the tables.** *role* is one of `identity` (the string IS the key), `join key` (matched
against another table's key), `unique-index key` (inside a declared index), `display-only` (rendered
but never matched). *canonical replacement* names the id kind; the availability note says whether a
resolver exists **today**. Anything not directly read from a file this session is marked
`[INFERENCE]`.

Availability legend, verified this turn:
- **AVAILABLE** — `reference.json` `mappings` resolves it by `(provider, provider_id)`, or
  `reference.Build()` + `Reference.Resolve`/`ChainByName`/`TokenByAddress`
  (`backend/api/internal/markets/reference/registry.go:486,554,582`) does in-process.
- **AVAILABLE (instrument)** — `instruments.ResolveInstrument` (`canonical.go:351`) over a built
  registry; **not** emitted to `reference.json` by design (`canonical.go:40-45`).
- **BLOCKED** — no resolver exists for this string at all (no mapping row, lossy value, or the
  key is a loose text link with no registry behind it). Each says which.
- **SCHEMA-ONLY** — a SQL table now exists to hold resolutions (`canonical_reference`, DR-036) but
  is **unwired**: nothing reads it, and no money-bearing row carries an `*_id` column yet.

---

## A. SQL — Postgres system of record (`database/schema/pg-schema.sql`, 8 tables)

| # | where | what string | role | consumer(s) that would break | canonical replacement | availability |
|---|---|---|---|---|---|---|
| A1 | `database/schema/pg-schema.sql:20-29` (`assets.chain`, `assets.asset`) | `assets.asset`, `assets.chain` | **identity** — the de-facto PK of a balance row; `(wallet, chain, asset)` is undeclared but used as one | `api/coins/route.ts:11,17` (`GROUP BY asset`); `api/all/route.ts`→`db/client.ts:61-67`; `platform/db/pg.ts:52`; `sync/reconciliation/reconcile.rs:123,208`; `dashboard/ui.tsx:14-15,41,64`; `portfolio/ui.tsx:12-13` | `asset_id`, `chain_id` | **BLOCKED as stored**: the value is a *label* (`MATIC` for a POL node, `SPL:<mint6>`), not a resolvable `(provider, provider_id)`. `MATIC`→`asset:315d864f27` does exist in `mappings` (provider `internal`), so `assets.asset` is resolvable **only for that one relabel**; `SPL:<mint6>` is truncation-lossy (A: `unmapped[0]`, `misses[2]` `known_absence:true`) |
| A2 | `database/schema/pg-schema.sql:20-29` (`assets.wallet`) | owner **label** (`Main`, `Hanif`, `Akang`), not an address | **identity** in practice | `reconcile.rs:123`; `dashboard/ui.tsx:14`; `pg.ts:52` | none — Wallet is not a canonical id kind; the real key is `wallets.address` (A14) | **BLOCKED**: the label is a code constant (`chains.rs` `WALLETS`), and no Wallet id kind is minted (canonical-model §2.1) |
| A3 | `database/schema/pg-schema.sql:64-80` (`transactions.chain/asset/hash/source/venue_id`) | free-form chain, asset symbol, tx hash, `source`, loose venue link | **identity** (hash), **join key** (`venue_id`→`venues.id`), display (`source`) | `api/transactions/route.ts:28,29,179,180,186` (filter and PUT by `chain`/`venue_id`/`asset`); `transactions/ui.tsx:11,12,21`; `reconcile.rs:214` | `chain_id`, `asset_id`, `venue_id` | **AVAILABLE** for symbols present in `mappings` (8 assets); `hash` has no canonical id kind. The Go mirror carries `chain_id`/`asset_id` as **optional** schema fields already (`finance/transaction.json`) |
| A4 | `database/schema/pg-schema.sql:52-62` (`trades.venue`, `trades.symbol`) | venue string + `BASE/QUOTE` | **identity** — the row's only market key | `pg.ts:55,81` (`DASHBOARD_READS.trades`); `db/client.ts:64` | `venue_id` + `instrument_id` | **AVAILABLE (instrument)** for the venue slug; the *symbol* is a spelling, so only `ResolveInstrument` over a venue-complete registry resolves it |
| A5 | `database/schema/pg-schema.sql:43-50` (`ledger.account_code`, `ledger.currency`) | account code + `'USD'` default | **join key** into `accounts.code` (no FK declared); `currency` is a currency code | `pg.ts:54,78`; `finance/ledger` `Entry.AccountID` (D3) | none (account codes are chart-of-accounts, not canonical entities) | **BLOCKED** — no Account id kind; `db/README`/classification record `accounts` as dead (DR-036) |
| A6 | `database/schema/pg-schema.sql:31-41` (`journal.entry_code/debit_account/credit_account`) | entry code + two account codes | **join key** into `accounts.code` | `pg.ts:53,77` | none | **BLOCKED** — same as A5; `journal` is dead (DR-036) |
| A7 | `database/schema/pg-schema.sql:64-80` (`transactions.source`) | provenance string (`manual`, provider name) | display-only + provenance | `transactions/ui.tsx:12` (`source` rendered); `finance/transactions` `DefaultSource:37` | none (Source is not an entity — canonical-model §10 INFERENCE 5) | **BLOCKED** (by design: it is provenance, not identity) |
| A8 | `database/schema/pg-schema.sql:82-86` (`venues.id`) | text slug PK | **identity** of the venue registry row | `transactions.venue_id` implies an FK that is **not declared**; `pg.ts:57` mirrors it | `venue_id` | **AVAILABLE** — the slug is the natural key (`venue/<venue-id>`); `mappings` has 23 venue rows |
| A9 | `database/schema/pg-schema.sql:88-98` (`wallets.address` PK) | exact on-chain address | **identity** (true key) | `api/wallets/route.ts:33,34` (`WHERE address = ?`); `pg-schema.sql:68` `memo/wallet_to` text link; `pg.ts:58`; `reconcile.rs:123` | none — Wallet has no id kind; **the address is the correct identity and needs no replacement** | **N/A** (already canonical-shaped) — listed because it is the join target the *label* A2 must eventually use |
| A10 | `database/schema/pg-schema.sql:88-98` (`wallets.chain`) | free-form chain name | join key to `assets.chain` | `pg.ts:58`; `reconcile.rs:214` joins by `wallet`+`asset`, `chain` only selected | `chain_id` | **AVAILABLE** — `reference.json` `chains` carries `name` (`ethereum`, `bsc`, …); `ChainByName:554` maps it |

## B. SQL — Postgres `public` read model (`database/schema/pg-schema.sql`)

The whole of §A is mirrored here (`pg-schema.sql:20-105`), so every A-row has a `public` twin at the
mirror's line; the rows below are the ones that are **not** pure copies.

| # | where | what string | role | consumer(s) that would break | canonical replacement | availability |
|---|---|---|---|---|---|---|
| B1 | `pg-schema.sql:120-121` `asset_history_snapshot` | unique index over `(ts, chain, asset, coalesce(wallet,''))` | **unique-index key** — the upsert target | `frontend/web/src/platform/db/pg.ts` (`asset_history_snapshot` upsert target) | `(ts, asset_id, wallet_address)` [INFERENCE — address is not in the current tuple; today the tuple carries the *label*] | **BLOCKED**: index columns must change, and the wallet half is a label (A2). `asset_id` is resolvable for mapped symbols only |
| B2 | `pg-schema.sql:140-141` `price_history_symbol_ts_source` | unique index over `(symbol, ts, source)` | **unique-index key** | the 90-day retention DELETE in `tests/oracle/sync-live.py` (only reference); **no writer and no reader exist** (DR-036: 0 rows) | `(instrument_id, source, observed_at)` — the canonical-model D5 note recorded exactly this target | **BLOCKED on a writer**: no producer exists, so there is nothing to migrate; the index is the schema-level symbol-as-identity violation (`canonical-model.md:605` records it) |
| B3 | `pg-schema.sql:134-135` (`price_history.symbol/source`) | market symbol + source id | column pair of B2 | none (dead table) | `instrument_id` + `source_id` | **BLOCKED** (same as B2) |
| B4 | `pg-schema.sql:168-175` (`canonical_reference`) | `(provider, provider_id)` PK → `canonical_id` | **the resolver table itself** | none — **unwired** (DR-036: "nothing calls the loader") | — (this IS the replacement) | **SCHEMA-ONLY**: `reader.go` loads it from the artifact; no money row joins to it yet |
| B5 | `pg-schema.sql:190-198` (`canonical_reference_miss`) | `(provider, provider_id)` of known-unresolved keys | the honest negative half of B4 | none — unwired | — | **SCHEMA-ONLY** |

## C. SQL — Postgres `executor` schema (`database/schema/executor-schema.sql`)

| # | where | what string | role | consumer(s) that would break | canonical replacement | availability |
|---|---|---|---|---|---|---|
| C1 | `executor-schema.sql:48` (`exchange_accounts.exchange`) | venue slug | **identity** of the account's venue; scopes credentials | `repository/credentials.go:51`; `store.ts:554-561`; `executor/types.ts:894,1069` | `venue_id` | **AVAILABLE** — 23 venue mapping rows; `known` flag marks the three tradable ones |
| C2 | `executor-schema.sql:75-77` (`executions.exchange`, `executions.symbol`, `market_type`) | venue slug + `BASE/QUOTE` + market type | **identity** of the execution's market | `repository/store.go:197,487,518`; `store.ts:316,332-334,636-638`; `executor/types.ts:1092-1093`; `canonical-placement.md:113` (15-route surface) | `venue_id` + `instrument_id` | **AVAILABLE (instrument)** via `ResolveInstrument`; **no consumer re-pointed** |
| C3 | `executor-schema.sql:124` (`child_orders.symbol`) | `BASE/QUOTE` | **identity** — mirrored to the venue as `exchange_order_id`; symbol is the human key | `repository/store.go:302,328,615`; `store.ts:729`; `wire.go:144` | `instrument_id` (or keep `VenueKey` spelling) | **AVAILABLE (instrument)** |
| C4 | `executor-schema.sql:122` (`child_orders.exchange_order_id`) | venue-assigned order id | **identity** (provider id) — correctly isolated as provider | `store.go:302,328`; `wire.go:142` | none — this is the *correct* provider-id separation the model demands | **N/A** |
| C5 | `executor-schema.sql:135` `UNIQUE (execution_id, client_order_id)` | client order id (`fud_<execution>_<seq>`) | **unique-index key** | `records.go:76-91`; `store.ts:461` | none — already canonical (not a symbol) | **N/A** |
| C6 | `executor-schema.sql:147,154` `UNIQUE (account_id, exchange_trade_id)` | venue trade id | **unique-index key** — the idempotent-fill guarantee (DR-021 §62) | `store.ts:290,468-471`; `records.go:96-108`; `executor/types.ts:1299-1300`; `wire.go:162` | none — provider id under an account-scoped key | **N/A** |
| C7 | `executor-schema.sql:152` (`fills.fee_asset`) | fee asset symbol | **identity** of what the fee was charged in | `records.go:105,244`; `wire.go:167`; `executor/types.ts:1157` region | `asset_id` | **AVAILABLE** for the 8 seeded assets; a venue fee in an unseeded coin is **BLOCKED** (no mapping row; `misses` has the HYPE/zero-address cases) |

## D. Go — `backend/api/internal/**`

| # | where | what string | role | consumer(s) that would break | canonical replacement | availability |
|---|---|---|---|---|---|---|
| D1 | `finance/ledger/ledger.go:74` `Entry.Asset` | bare asset symbol; `NewEntry:97-99` refuses an empty one | **identity** of the movement's asset | `finance/portfolio` valuations keyed by `Asset`; ledger-entry schema `asset`+`asset_id` | `asset_id` | **AVAILABLE** (8 seeded assets) |
| D2 | `finance/transactions/transactions.go:54-55` `Chain`,`Asset`; defaults `:35-36` (`Offchain`/`USDT`) | free chain + symbol | **identity** of a history row | `transactions` route/tests; `transaction.json` requires `chain` and allows `asset_id` | `chain_id` (9 chains incl. `offchain`), `asset_id` | **AVAILABLE** — `offchain` is seeded (`chain:1f6d776400`) |
| D3 | `finance/transactions/transactions.go:60-63` `WalletTo`,`VenueID`,`TradeID`,`Hash` | loose text links | **join key** (`venue_id`), identity (`hash`) | `transactions` route `:28,29`; no FK in SQL (A-row) | `venue_id`; none for hash/trade | **AVAILABLE** for venue; Trade has no id kind |
| D4 | `finance/portfolio/portfolio.go:27` `Holding.Asset`, `:97,113` `prices map[string]string` keyed by asset | symbol as the price-table key | **join key** — prices must be keyed by the same spelling as holdings | `Derive:113` `prices[h.Asset]`; `MissingPrices:81`; valuation schema `holding.asset`/`asset_id` | `asset_id` | **AVAILABLE** (mapped symbols); the map is internal, so this is a **fixable-without-consumer** case |
| D5 | `finance/portfolio/portfolio.go:50` `Position.InstrumentID` | already named `InstrumentID` but is a plain string | **identity** | `portfolio.go:162-190` groups by it | the minted `instrument_id` | **AVAILABLE (instrument)** — the field name already carries the intent; only the value's provenance must be pinned |
| D6 | `finance/portfolio/portfolio.go:62` `Exposure.Asset` | symbol | **identity** of the exposure's asset | derived view consumers | `asset_id` | **AVAILABLE** |
| D7 | `finance/treasury/treasury.go:39` `Account.Asset`, `:64` `Movement.Asset` | symbol; "one account holds ONE asset" invariant (`:32-33`) | **identity** — the account's asset | `treasury-account.json` (`asset` required, `asset_id` optional) | `asset_id` | **AVAILABLE** |
| D8 | `markets/instruments/instrument.go:53-60` `InstrumentID`,`BaseAsset`,`QuoteAsset`,`Exchange`,`ExchangeSymbol` | mixed: minted id **and** three spellings in one type | **identity** (InstrumentID) vs spellings | `canonical.go` resolver; `instrument.json` (exchange + base/quote + venue_id) | `venue_id`, `base_asset_id`, `quote_asset_id`, `settlement_asset_id` | **AVAILABLE (instrument)** — this type is the bridge `ResolveInstrument:351` consumes |
| D9 | `markets/instruments/symbol.go:35,81` `CanonicalSymbol`,`VenueSymbol` | spellings, explicitly "never identity" | display/normalization | executor `symbols.go`, `exchange.ts` | none — by design these produce spellings | **N/A** |
| D10 | `markets/instruments/canonical.go:310-321` `MintLegacyInstrumentID`,`SpellingFor` | `exchange:marketType:BASE/QUOTE` legacy spelling | retained legacy identity | `executor/types.ts:1366` `venueKey`; `plan_json.go:181` | `instrument_id` (minted at `:264`) | **AVAILABLE (instrument)** |
| D11 | `markets/instruments/canonical.go:445,478` `assetIDForSymbol`,`venueIDForSlug` | the symbol→id lookup itself | the resolver's internals | `ResolveInstrument` | — | **AVAILABLE** — but note `canonical-model.md:930` (INFERENCE 14): the registry reads the *entity list*, and only one asset (`MATIC`) is seeded as an `internal` provider id |
| D12 | `markets/overview/market.go:38-115` | `Exchange`+`Symbol` on **eight** structs: `Ticker:39,41`, `Candle:51,52`, `Book:74,75`, `MarkPrice:85,86`, `IndexPrice:94,95`, `FundingRate:104,105`, `OpenInterest:114,115` | **identity** of each market-data row (`Ticker.Symbol` is canonical `BASE/QUOTE`) | `validate.go` (every `Validate` refuses an empty exchange/symbol); `markets/ticker.json` wants `instrument_id`+`venue_id` | `instrument_id` + `venue_id` | **AVAILABLE (instrument)**; **no producer serves these types yet** (`canonical-model.md:347-361` records "schema only — no runtime consumer") |

## E. Go — `backend/workers/executor/internal/**`

| # | where | what string | role | consumer(s) that would break | canonical replacement | availability |
|---|---|---|---|---|---|---|
| E1 | `core/execution/records.go:17-18` `ExecutionRecord.Exchange`,`Symbol`; `:154` `AccountMetadata.Exchange`; `:164` `Balance.Asset`; `:183` `Position.Symbol`; `:197` `Ticker.Symbol`; `:209` `NormalizedOrder.Symbol`; `:225` `OrderRequest.Symbol`; `:81` `ChildOrderRecord.Symbol`; `:105,244` `FeeAsset` | venue slug + `BASE/QUOTE` + asset symbol | **identity** — persisted as columns C2/C3/C7 | `repository/store.go:197,302,487,518`; `api/wire.go:105-106,144,162,167`; `api/plan_json.go:19-24,104`; `strategies/strategies.go:40,75,355`; TS `platform/executor/types.ts` (all mirrored fields) | `venue_id`, `instrument_id`, `asset_id` | **AVAILABLE (instrument)**; the store's `ensureExecutorSchema`/`EnsureSchema` path is the writer the migration must touch |
| E2 | `core/execution/types.go:39-44` `ExchangeID` + three constants | closed venue set, hard-coded a **third** time | **identity** of a supported venue | `Valid():48-51`; `symbols.go` switch; duplicates D-US1 (`accounts/exchange/account.go`, `wallet.go`) | `venue_id` (one registry: `markets/venue.json`) | **AVAILABLE** — 3 tradable venues all mapped, plus 9 data-only ccxt venues flagged `known:false` |
| E3 | `exchanges/symbols.go:22` `knownQuotes`, `:28` `ToVenueSymbol`, `:51` `FromVenueSymbol` | quote-asset suffix list | **identity-adjacent**: a wrong split silently names the wrong market | every adapter `place/fetch` call; TS twin `exchange.ts:94,101` | none — normalization stays; the *result* should carry `instrument_id` | **N/A** (spelling layer) |
| E4 | `exchanges/market.go:32-37` `Instrument.Symbol/Exchange/BaseAsset/QuoteAsset/SettlementAsset`; `:55` `Market.Symbol` | canonical spelling + venue | **identity** of the tradable instrument | planner/risk (`core/risk/types.go:57-62`), sizing (`sizing/types.go:26`), `api/plan_json.go` | `instrument_id` (5 components) | **AVAILABLE (instrument)** — `canonical.go`'s preimage is exactly these five |
| E5 | `repository/store.go:197,302,487,518` | column lists and scan order carrying `exchange`/`symbol` | **identity** at the persistence boundary | fills/orders/executions reads and writes | the `*_id` columns that do not exist yet | **BLOCKED on DDL**: no `*_id` column exists on any executor table (DR-036: "no columns were added to any existing table") |
| E6 | `repository/credentials.go:34,51` `CredentialRow.Exchange` | venue slug read back from `exchange_accounts.exchange` | **identity** | `LoadCredential` callers; key-restriction endpoints | `venue_id` | **AVAILABLE**, but the credential row must keep the slug for the venue call — a mapping, not a rename [INFERENCE] |
| E7 | `api/wire.go:105-106,144,162,167`; `api/plan_json.go:19-24,103-104,181` | wire echoes of the same fields; `venueKey(...)` recomputed at `plan_json.go:181` | **identity** on the HTTP surface (15 routes) | `frontend/web/src/platform/executor/types.ts`; the 15 `/api/executor/*` handlers | `instrument_id`/`venue_id` | **AVAILABLE (instrument)**, gated by the freeze list (`canonical-placement.md:113`) |

## F. Rust — `backend/sync/src/**`

| # | where | what string | role | consumer(s) that would break | canonical replacement | availability |
|---|---|---|---|---|---|---|
| F1 | `chains.rs:5-10` `EvmChain.name/native/tokens` (`:17,26,35,44,53,62` natives; `:19-20` etc. token symbols+contracts) | chain display name + native symbol + `(symbol, contract, decimals)` | **identity** of the chain/token registry | `streams/sync.rs:231-233,255-257` write them into `assets.chain/asset`; `chains.rs:107-115` tail comment | `chain_id`, `asset_id`, `token_id` | **AVAILABLE** — all six EVM chains + Solana mapped by `cryptorank-chain`/`internal`; tokens by full address (`TokenByAddress:582`). **The contract address is in the table but is discarded** — only the symbol reaches SQL |
| F2 | `streams/sync.rs:191-196` | `format!("SPL:{short}")` where `short = mint.chars().take(6)` | **identity** — lossy truncation written into `assets.asset` | `assets` consumers (A1); `reference.json` `misses[2]` records it as `known_absence:true` | `token_id` (natural key = **full** address, `token/<chain>/<address>`) | **BLOCKED**: the full mint is discarded at `:192`, so the id cannot be recovered from stored data. `canonical-model.md:280` notes the minted id is lossless but the *label* is not |
| F3 | `streams/sync.rs:106-109` | `out.push(("MATIC", pol))` — POL price relabelled `MATIC` | **identity** — a provider-derived *value* baked into a durable label | `assets` consumers; `chains.rs:112-115` documents it; `registry_test.go:309-332` pins `MATIC`→POL as one asset | `asset_id` = `asset:315d864f27` (POL), resolvable via mapping `internal=MATIC` | **AVAILABLE** — the one relabel with a mapping row; migration should stop *writing* `MATIC` and write the id |
| F4 | `streams/sync.rs:344-350` | `coin.to_string()` from the Hyperliquid balance payload | **identity** of an unpriced provider coin | `assets` consumers | `asset_id` | **BLOCKED** for coins beyond the seeded 8: `unmapped[1]` (HYPE) and `misses[0]` record that HYPE is never priced and has no provider id |
| F5 | `streams/sync.rs:21-27` `Position.chain/asset/owner`; `db.rs:123-133` `insert_asset`; `:116-117` `delete_assets` | the write path itself; arguments sent as `{"type":"text"}` | **identity** at the DB boundary | the whole `assets` table (A1) | `chain_id`/`asset_id`/wallet address | **AVAILABLE** for chains/assets; **BLOCKED** for `owner` (label, A2) and SPL rows (F2) |
| F6 | `reconciliation/reconcile.rs:38-39,123,126,208,214,220` | `ReconRow.{wallet,asset}`; three SELECTs; keys on `wallet`+`asset` | **identity** of a reconciliation row — the `/api/reconcile` body | the 3102 `/api/reconcile` envelope (`canonical-placement.md:93`); `treasury/reconciliation.tsx:8-9` | `asset_id` + wallet address | **BLOCKED as-is**: the join is `wallet`+`asset` where wallet is a label; `chain` is selected but not keyed |
| F7 | `pyfmt.rs:1-11` (+ `round4:20`, `round_n:34`, `round10:46`, `round2:52`, `repr:59`, `json_str:120`) | **numeric rendering**, not identity | formatting contract | `sync.rs:11` imports `fixed2/fixed4/fixed8/json_str/repr/round*`; `print_projection:37-60`; the live read-back at `:470-490` | none — it is the byte-parity contract with the Python twin | **N/A** — listed because `data-catalog.md`/`canonical-acceptance.md` cite it as the treasury plane's numeric normalization; it carries **no symbol keys** |
| F8 | `chains.rs:98-105` `LLAMA_IDS` `(sym, coingecko:id)` | symbol → provider id, the oracle's own mapping | **join key** — `price(p, chain.native)` (`sync.rs:64`) | valuation of every `assets` row | `asset_id` (the mapping is exactly what `reference.json` already holds: `("POL","coingecko:polygon-ecosystem-token")` → `asset:315d864f27`) | **AVAILABLE** — this is the one place the code *already* carries the `(provider, provider_id)` pair the artifact needs |

## G. TypeScript — `frontend/web/src/**`

| # | where | what string | role | consumer(s) that would break | canonical replacement | availability |
|---|---|---|---|---|---|---|
| G1 | `styles/shared.ts:12-14` `Asset{chain,asset,value_usd,...}`, `:18-19` `Wallet{address,chain,label,...}` | the DB row shape both dashboards read | **identity** (type-level) | `dashboard/ui.tsx:14-15,41,64`; `portfolio/ui.tsx:12-13`; `wallets/ui.tsx:21` (`key={w.address}`) | `asset_id`/`chain_id`; Wallet keyed by address (already correct) | **SCHEMA-ONLY** — the type gains `*_id` when the row does |
| G2 | `platform/db/pg.ts:51-58` `TABLES` | column lists + declared `pk` (`accounts` `code`, `wallets` `address`, `venues` `id`, else `id`) | **identity** of the mirror's upsert/prune | `loadFromMirror()` (`:155`), `parity-pg.ts` | `asset_id` on `assets`/`transactions`/`asset_history` | **SCHEMA-ONLY** |
| G3 | `platform/db/pg.ts:75-81` `DASHBOARD_READS` | `ORDER BY code`, `account_code`, `label,address` | **join key** in ordering/identity | `db/client.ts:61-67` `getAll()`; `api/all/route.ts` | none (account codes are not canonical entities) | **BLOCKED** (A5/A6 analogue) |
| G4 | `platform/db/pg.ts:200-205` | `ON CONFLICT (ts, chain, asset, (coalesce(wallet,'')))` | **unique-index key** — the B1 tuple, in code | PostgreSQL `asset_history` | `asset_id` + wallet address | **BLOCKED** (B1) |
| G5 | `platform/executor/types.ts:51,54,1366-1367` `ExchangeId`,`VenueKey`,`venueKey()` | `exchange:marketType:symbol` | **identity** of a venue market — the whole executor keys off it | `exchange.ts:204` `metaKey`; `store.ts` mappings; `plan_json.go:181`; every executor route | `instrument_id` | **AVAILABLE (instrument)** but **BLOCKED on consumer**: `canonical-acceptance.md:106` records the `VenueKey`→minted-id bridge as the remaining item |
| G6 | `platform/executor/types.ts:219-224,436,685,921,937,954,978,988,999,1093,1136` | `symbol` (+`exchange`,`baseAsset`,`quoteAsset`,`settlementAsset`) on `InstrumentMetadata`, `NormalizedOrder`, `Order`, `Position`, `FundingRate`, `ExecutionRecord`, `ChildOrderRecord` | **identity** (in-memory/HTTP) | the adapter layer, the executor UI, `/api/executor/*` | `instrument_id` | **AVAILABLE (instrument)** |
| G7 | `platform/executor/types.ts:893-894,1068-1069,1091-1092`; `features/executor/ui.tsx:335-336,379,633` | `exchange` on `AccountMetadata`/credentials; the UI composes a `symbol` and sends it (`:633` `.trim().toUpperCase()`) | **identity** — user-typed symbol becomes the execution key | `exchange.ts` `toVenueSymbol`; C2 | `venue_id` + `instrument_id` | **AVAILABLE (instrument)**; the UI's free-text symbol is itself the risk (no `ResolveInstrument` check) |
| G8 | `platform/executor/exchange.ts:94,101,204` `toVenueSymbol`,`fromVenueSymbol`,`metaKey` | spellings + cache key | identity-adjacent | all ccxt calls; `instruments.ts:43,95-97` | none (spelling layer) | **N/A** |
| G9 | `platform/executor/store.ts:316,332-333,371,636-638,729` | row mappings and INSERTs writing `exchange`/`symbol` | **identity** at the TS persistence boundary | C2/C3; the Go worker reads the same columns | `venue_id`/`instrument_id` columns that do not exist | **BLOCKED on DDL** (E5/DR-036) |
| G10 | `features/ticker/client.ts:62-65,133,139,186,238,255-257` | `TICKER_EXCHANGES`/`TICKER_SYMBOLS` allowlists, `VenueQuote.exchange`, `TickerInstrument.symbol`, `TickerRow.{symbol,base,quote}` | **identity** — the allowlist *is* the ticker's key space; `TICKER_COIN:154` gates 404s | `ticker/ui.tsx:11,20,30-32,162,250,253,255,257,276`; `ticker/detail.tsx:29,36,46-47,69`; `ticker/instruments.ts:43,95-97` | `venue_id` + `instrument_id` | **AVAILABLE (instrument)** for the three tradable venues; the other 7 `TICKER_VENUES` are data-only (`reference.json` `unmapped[4]`) |
| G11 | `features/markets/client.ts:55-57` `MarketsCoin.{symbol,baseAsset,quoteAsset}` | CoinGecko symbol | **identity** | the tracker renders `baseAsset` (`tracker/ui.tsx:11,76,78`) | `asset_id` | **BLOCKED** for the full top-250 pool: only 8 assets are seeded (`unmapped[6]` — "CryptoRank coin keys beyond the eight seeded assets") |
| G12 | `features/dex/client.ts:73,75-82,104-105`; `dex/trench.tsx:8` | `DexToken.{address,symbol}`, `DexPair.{chainId,pairAddress,baseToken,quoteToken}`, `DexProfile.{address,chain,symbol}` | **identity** — the on-chain pair address **is** the true key; `chain`/`symbol` are display | `data-classification.md` Part A leak rows; the dex UI | `token_id` (full address), `chain_id` | **AVAILABLE** for the 11 seeded tokens by full address; `chainId` is a *numeric* EVM id and `reference.json` `unmapped[2]` says no numeric chain id exists anywhere in the tree — **BLOCKED** for that field |
| G13 | `features/signals/ui.tsx:12-15` (`kind,chain,mint,symbol`) | Solana mint + symbol; `CHAINS` allowlist `:50-55` | **identity** — `mint` is the true key | scoreboard `:8-9` (`mint`), signals UI itself | `token_id` / `asset_id` | **BLOCKED**: signals rows are a research surface with no canonical mapping; `mint` is a full address (resolvable in principle) but no rows exist in `reference.json` |
| G14 | `features/scoreboard/ui.tsx:8,9,14,40,59-61` | `chains: Record<string,ChainBoard>` keyed by `solana`/`robinhood` | **join key** — the object key is the chain id in use | scoreboard UI navigation | `chain_id` | **BLOCKED**: `robinhood` is not in `reference.json` `chains` (9 chains; no robinhood row) |
| G15 | `features/transactions/ui.tsx:11-12,21`; `api/transactions/route.ts:28,29,78,82-83,116,120-121,179,180,186` | `chain`,`asset`,`venue_id` in the row type, the SQL filters and the INSERT/PUT | **identity** + **join key** | the transactions UI; A3 | `chain_id`,`asset_id`,`venue_id` | **AVAILABLE** for mapped values; the route writes the raw strings today |
| G16 | `features/treasury/reconciliation.tsx:8-9`; `api/coins/route.ts:11,17` | `ReconRow.{wallet,asset}`; `GROUP BY asset` | **identity** | F6; dashboard coin totals | `asset_id` | **BLOCKED as-is** (F6/B1 label join) |
| G17 | `features/portfolio/ui.tsx:12-13`; `features/dashboard/ui.tsx:14-15,41,64` | `a.chain`, `a.asset` as group-by keys and `CHAIN_COLOR[a.chain]` | **join key** + display | both dashboards | `chain_id`,`asset_id` | **SCHEMA-ONLY** (needs row change, G1) |
| G18 | `features/wallets/ui.tsx:21` (`key={w.address}`), `api/wallets/route.ts:33-34` (`WHERE address = ?`) | wallet address | **identity** | wallet UI | none needed | **N/A** (already correct) |
| G19 | `features/llama/client.ts:37,49` (`chainId?:number`, `chains:string[]`) | provider chain id + names | **identity** of a DefiLlama chain row | `llama/ui.tsx:37,68,73` | `chain_id` | **BLOCKED**: `chainId` numeric (G12); the name list is provider-shaped |
| G20 | `features/cryptorank/client.ts:237,255,278,311,382,400,437,452,473,485,572,647`; `shapers.ts:101,193,206,253,736,917,933,986,1012,1037,1049,1150` | `Cr*` `symbol`/`ticker`/`currency`/`exchange`/`chain` provider DTO fields | **identity** (provider vocabulary) | `cryptorank/ui.tsx`; the leak rows in `data-classification.md` Part A | `asset_id`/`token_id`/`chain_id`/`venue_id` | **AVAILABLE** for the 8 seeded coins + 7 chain mappings; **BLOCKED** for the rest of the pool (`unmapped[6]`). This is criterion 14 work (`canonical-acceptance.md:41`) |
| G21 | `features/executor/ui.tsx:335-336,379,633` | UI state `symbol` default `'BTC/USDT'` | **identity** sent to the API | G7 | `instrument_id` (resolve the typed symbol) | **AVAILABLE (instrument)** |

## H. Python — legacy oracle twin (`tests/oracle/sync-live.py`)

`git status` shows it tracked; `canonical-model.md` §9.1 lists it as a Phase-6 deletion candidate, so
these are **twin rows**, not independent surface.

| # | where | what string | role | consumer(s) | canonical replacement | availability |
|---|---|---|---|---|---|---|
| H1 | `sync-live.py:230` `out['MATIC'] = out['POL']` | the POL→MATIC relabel (F3 twin) | **identity** | the byte-parity gate against Rust | `asset_id` | **AVAILABLE** (same mapping) |
| H2 | `sync-live.py:285,344-345` | `f"SPL:{mint[:6]}"` + `INSERT INTO assets(chain,asset,...)` | **identity** (lossy, F2 twin) | the `assets` table | `token_id` | **BLOCKED** (F2) |

## I. Contracts — the canonical side already declared

Not occurrences to migrate, but the target shape each row above must satisfy (one row per schema
file; the fields are the replacement columns the migration will write):

| # | where | what it declares |
|---|---|---|
| I1 | `shared/contracts/schemas/assets/asset.json` | `asset_id` **required**, `symbol` required, `chain_id` optional, `provider_ids[]` |
| I2 | `shared/contracts/schemas/finance/transaction.json` | `chain` required + `chain_id` optional, `asset` + `asset_id` optional, `venue_id` |
| I3 | `shared/contracts/schemas/markets/instrument.json` | `instrument_id`, `venue_id`, `exchange` required; `base_asset`/`quote_asset` as **asset refs** |
| I4 | `shared/contracts/schemas/trading/execution.json` | `execution_id`+`account_id` required; `exchange` required, `venue_id`/`instrument_id` optional, `symbol` required |
| I5 | `shared/contracts/schemas/finance/{valuation,ledger-entry,treasury-account}.json` | `asset` required, `asset_id` optional on all three |

---

## Closing — what is fixable without touching a consumer, and what is blocked on one

**Fixable without touching a consumer** (the string is internal to one package or is a cache/lookup
key, so changing it does not change any wire body or stored row): **7 rows** —
D4 (`prices map` key in `portfolio.Derive`), D5 (the `Position.InstrumentID` field already named for
the minted id), D11 (the resolver's own internals), E3 (the symbol-normalization layer, which should
keep producing spellings), E4 (the executor's in-process `Instrument` — the resolver consumes exactly
its five components), F7 (`pyfmt` renders numbers, not identities), and G8 (`exchange.ts` spelling
helpers). `[INFERENCE]` D5/E4 are "fixable" only in the sense that the change is package-local; their
values still come from producers, so the *value* migration shares the blocked set below.

**Blocked on a consumer migration** (a stored column, a wire field, a route filter or a component
type is keyed on the string): **65 rows** of the 72 non-contract rows — all of §A (10), all of §B
(5), all of §C (7), §D1–D3/D6–D8/D10/D12 (9 of §D's 12), §E1/E2/E5/E6/E7 (5 of §E's 7),
§F1–F6/F8 (7 of §F's 8), §G all but G8 (20 of §G's 21), and §H (2). §I (5 rows) is the target shape
those rows must satisfy, not a site: 72 = 7 fixable + 65 blocked (the §I rows are excluded from both
counts). Of the 65, every row whose replacement is a *stored* `*_id` column — §A, §B, §C, §E, §H and
the Go/TS persistence rows §D1–D3, §D6, §D8, §D12, §G1–G2, §G5–G7, §G9, §G11, §G15, §G17, §G21 — is
**additionally blocked on DDL that does not exist**: no `*_id` column exists on any money-bearing
table, and the one resolver table (`canonical_reference`, DR-036) is **unwired** — nothing reads it
and no runtime calls its loader. §I's schemas already declare the optional `*_id` fields, so contracts
are not the constraint; the writers and the readers are.

**The ordering constraint — quoted, not re-decided.** `canonical-model.md` **§9.2 O3** (as updated
by DR-036) says the mapping table question is answered: the artifact is the single source and
`canonical_reference` is a derived cache. `canonical-model.md` **§9.1 Phase 9** states the remaining
condition verbatim: *"Phase 9 is blocked only on (b) the fact that no artifact or route yet serves
instrument ids to a consumer (no consumer is re-pointed)"* — i.e. **the migration must first make the
id resolvable at the point of resolution** (serve/publish the artifact so a non-Go consumer can
resolve, and have a runtime call the loader) **before** any consumer is re-pointed; re-pointing a
consumer first would key it to an id nothing in its process can obtain. `canonical-placement.md`
**§6.1** carries the same table in resolver form: for "a SQL/Postgres-side join" the resolver that
exists is *nothing* (until the loader is wired), and for "a venue + market type + resolved
components" the resolver that is missing is *an emitted instrument artifact or HTTP route*. Note:
`canonical-placement.md` has **no §9** — the brief names one; its nearest content is §6.1/§6
("What a consumer must do"). That is reported here rather than edited.

---

## Verification record

Commands run from the repo root this session (outputs summarized; counts are exact).

```sh
# 1. The SQL identity surface, all three schemas
grep -n "UNIQUE\|REFERENCES\|PRIMARY KEY" database/schema/*.sql
grep -n "asset_history_snapshot\|price_history_symbol_ts_source\|canonical_reference" database/schema/pg-schema.sql

# 2. Every reader/writer of the string keys
grep -rn "symbol\|exchange\|chain" frontend/web/src/features --include=*.ts --include=*.tsx
grep -rn "Asset\s*string\|Chain\s*string\|Symbol\s*string\|Exchange\s*string" --include=*.go backend/api/internal
grep -rn "Symbol\s*string\|Exchange\s*string" --include=*.go backend/workers/executor/internal
grep -rn "SPL\|MATIC\|native\|symbol" backend/sync/src --include=*.rs
grep -rniI "provider_id\|canonical_id" database/           # → canonical_reference/miss rows only (DR-036)

# 3. Path existence: every concrete path cited here was `test -f`-checked
#    79 distinct paths, 0 miss (§"path sweep" below).

# 4. The mapping artifact and both resolvers
python3 -c "import json;d=json.load(open('shared/contracts/data/reference.json'));print(list(d.keys()))"
grep -n "func ResolveInstrument\|func MintInstrumentID\|func SpineFor" backend/api/internal/markets/instruments/canonical.go
```

**Path sweep.** 79 distinct concrete paths cited in this document were checked with `os.path.isfile`
(the `test -f` equivalent); **79 OK, 0 miss**.

**`[INFERENCE]` items** (not directly observed): B1's target tuple `(ts, asset_id, wallet_address)`
(the address column does not exist there); E6's claim that the credential row must keep the venue
slug for the venue call; D5/E4 being package-local but value-blocked; the "20 additionally blocked on
DDL" count is derived by intersecting the row sets, not from a stored declaration.

**Contradictions and stale claims observed but not fixed** (as instructed — reported, not edited):
1. `canonical-model.md` **§9.2 O4** still lists `instrument_id` "is not [minted] — it stays at 'API
   exists, no minter'" while `canonical-acceptance.md:106` and `canonical.go:264` show it **is**
   minted. (The same file's §7 D-CANON and §9.1 Phase 9 *were* since updated to "now minted", so the
   document contradicts itself in two places.)
2. `canonical-model.md` §7 D-CANON claims *"grep `(?i)(external_id|provider_id|canonical_id|…)` over
   the whole repo → no SQL/DDL hits"* and *"no mapping/taxonomy table"* in `database/`; both are
   falsified by `database/schema/pg-schema.sql:168-198` (`canonical_reference`, added by DR-036).
3. `canonical-model.md:605` still says `price_history`'s key "is **the** one schema-level violation
   of the identity rule" while `asset_history_snapshot` (B1) is a second, live one.
4. `canonical-acceptance.md:44` (row 16b) and its P0 rows still say `database/` "has no mapping
   table", stale since DR-036.
5. The concurrent DR-036 workstream's §9.1 edit left the §9.2 O4 text untouched, which is how
   contradiction 1 survives in one file.
6. The brief refers to `canonical-placement.md` **§9**; that file has no §9 (its resolver table is
   §6.1). Reported, not edited.

**Note on a concurrent actor.** While this inventory was being written, `database/schema/pg-schema.sql`
(+54 lines) and `database/schema/executor-schema.sql` (+18/-5), `backend/api/internal/markets/reference/loader.go`,
`docs/architecture/canonical-model.md`, `docs/architecture/database-classification.md`,
`docs/records/DECISIONS.md` and others changed underfoot (DR-036). Every line number above was
re-read **after** those changes; the SQL rows quoted here are from the current working tree
(`pg-schema.sql` blob `6f533cd701b7`, `executor-schema.sql` blob `971435d722c8`), and the new
`canonical_reference` tables are reported as SCHEMA-ONLY rather than as unwired-so-absent.
