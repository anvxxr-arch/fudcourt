# DEX Data Platform — Implementation Report

Required agent report (plan §64). Companion to [`audit.md`](audit.md) (Phase 0).

---

## Task

Build the Fudcourt DEX Data Platform (plan §1–§67): canonical-first DEX data
subsystem absorbing blockchain RPC, DEX-native APIs, indexers, aggregators,
analytics, routing and derived analytics behind one provider-agnostic contract,
with provenance, reconciliation, confidence scoring, quality classification and
a canonical query API.

## Files changed

### Canonical contract (extended, single owner — plan §51)

| File | Change |
|---|---|
| `apps/data/internal/canon/ids.go` | 12 new `EntityKind`s (deployment, swap, candle, market_snapshot, liquidity_snapshot, liquidity_position, wallet_activity, route_quote, risk_metric, mev_event, perp_market, provider_observation) + 13 new natural-key builders |
| `apps/data/internal/canon/provenance.go` | NEW — `Provenance`, `SourceTier` (S0–S5), `Confidence`, `DerivedProvenance`, exact `Dec` (math/big.Rat + exact decimal rendering + JSON string marshalling), `TokenAmount` (raw integer + decimals, exact normalized rendering), string-on-the-wire JSON shapes |
| `apps/data/internal/canon/dex_types.go` | NEW — `DexDeployment`, `PoolToken`, `ProviderObservation`, `IngestionCheckpoint`, `PoolRef`, `TokenRef` |
| `apps/data/internal/canon/dex_trading.go` | NEW — `Swap`, `DexCandle`, `DexLiquiditySnapshot`, `DexMarketSnapshot` |
| `apps/data/internal/canon/dex_analytics.go` | NEW — `RouteQuote`, `RouteLeg`, `LiquiditySource`, `RiskMetric`, `MEVEvent`, `PerpMarket`, `FundingSnapshot`, `PerpLiquidation`, `WalletActivity`, `DexLiquidityPosition`, `DexOrderbookSnapshot`, `OrderbookLevel` |
| `apps/data/internal/canon/types.go` | `Pool` gains `BaseSymbol`/`QuoteSymbol` (the columns existed but were permanently NULL — audit G1 follow-up) |
| `apps/data/internal/canon/versions.go` | `SchemaVersion` 1.1.0→**1.2.0**, `NormalizationVersion` 1.0.0→**1.1.0** |

### Capability contract (plan §11)

| File | Change |
|---|---|
| `apps/data/internal/dexcap/capability.go` | NEW — `Capability` (14 values), `AuthKind`, `RateLimit`, `Descriptor` (name, capabilities, chains, auth, limits, realtime, historical, tier, priority, cost) |
| `apps/data/internal/dexcap/registry.go` | NEW — `Registry` with tier-ordered, health-aware `Candidates`/`Resolve`/`FallbackChain` |

### Reliability (plan §34, §35)

| File | Change |
|---|---|
| `apps/data/internal/dexreliability/recorder.go` | NEW — `Recorder`, latency ring, `Thresholds` |
| `apps/data/internal/dexreliability/health.go` | NEW — `Observe`, `Health` derivation (healthy/degraded/rate_limited/unhealthy/unconfigured/disabled) |
| `apps/data/internal/dexreliability/snapshot.go` | NEW — `Snapshot`, p50/p95/p99 |

### Reconciliation + quality (plan §24, §25, §32)

| File | Change |
|---|---|
| `apps/data/internal/dexrecon/confidence.go` | NEW — the six weighted confidence factors, exact rational arithmetic |
| `apps/data/internal/dexrecon/resolve.go` | NEW — median outlier rejection, tier×freshness weighted median, 0–100 confidence |
| `apps/data/internal/dexrecon/quality.go` | NEW — ten detectors, `healthy\|degraded\|stale\|conflicting\|invalid` classifier |

### Storage (plan §12, §13, §15)

| File | Change |
|---|---|
| `apps/data/internal/ingest/schema.sql` | Additive DEX block, sections 31–47b: 17 `data.dex_*` tables, 14 hypertables, 14 secondary indexes, 1 conditional-unique index. `numeric` (not `double precision`) for money — a deliberate plan §54 deviation from the frozen convention |
| `db/schema/data-schema.sql` | byte-identical copy |
| `apps/data/internal/ingest/schema_test.go` | census 30→47 tables, 14→28 hypertables, 11→25 indexes, 1→2 unique indexes, +DEX-table assertion |
| `apps/data/internal/dexstore/writer.go` | NEW — the DEX write port (16 methods) + `ProviderHealth`, `QualityStatus` |
| `apps/data/internal/dexstore/reader.go` | NEW — the DEX read port (16 methods) + query shapes |
| `apps/data/internal/ingest/repo/dex_entities.go` | NEW — entity upserts + shared numeric helpers |
| `apps/data/internal/ingest/repo/dex_facts.go`, `dex_facts2.go`, `dex_facts3.go` | NEW — 16 fact writers |
| `apps/data/internal/ingest/repo/dex_validate.go` | NEW — pure per-row validators |
| `apps/data/internal/ingest/repo/dex_reader.go`, `dex_reader2.go` | NEW — 16 readers + scanners |
| `apps/data/internal/ingest/repo/facts.go` | `WritePools` now passes the two symbol columns instead of hard-coded NULL |
| `apps/data/internal/ingest/repo/reader.go` | `scanPool` + `ListPools` projection fixed (16 columns, NULL-tolerant `retrieved_at`) |

### Providers (plan §41)

**State:** two DEX datasets are LIVE against the real database (geckoterminal
candles, dexscreener market snapshots) and five more adapters (helius, jupiter,
thegraph, bitquery, evmrpc) are registered with their datasets implemented and
tested. The full P0 provider set named in plan §41 is now covered; the remaining
gaps are operational (live credentials) rather than missing adapters.

| File | Change |
|---|---|
| `apps/data/internal/ingest/providers/jupiter/*` | NEW — keyless-optional Solana router: `quote` + `tokens` datasets, Valkey hot cache, exact string price-impact; **decimals resolved via `knownDecimals`/`decimalsFor`, unknown mint = loud HardError (never a default-0 fabrication)**; route legs carry their **percent share** of both sides (`legShare`, exact) instead of the fee-conditioned full-input bug |
| `apps/data/internal/ingest/providers/helius/*` | NEW — keyed Solana indexer: `swaps` + `wallet` datasets, `HELIUS_API_KEY` (fetch fails BEFORE any request when absent; jobs seed disabled), redacted URLs, **backward signature cursor that an empty signature can no longer clobber** |
| `apps/data/internal/ingest/providers/geckoterminal/candles.go` | NEW — `dex-candles` dataset: exact-decimal `data.dex_candle` rows via `dexstore.Writer`, interval vocabulary, malformed-bar rejection, live-proven (1,000 rows) |
| `apps/data/internal/ingest/providers/dexscreener/market.go` | NEW — `market-snapshots` dataset: exact `data.dex_market_snapshot` rows (price/native/volume/fdv/mcap/txns/buys/sells/price-change) via `dexstore.Writer`, live-proven (90 rows). `getJSON` now decodes with `UseNumber` so a JSON number keeps its exact digits |
| `apps/data/internal/canon/provider_class.go` | NEW — plan §3 provider→tier/source-type vocabulary (`ClassifyProvider` + `ProvenanceForProvider`), the SINGLE classification: all five DEX writers derive their tier/type from it (`helius`, `jupiter`, `geckoterminal`, `dexscreener`, `thegraph`) and the readers fill `Tier`/`SourceType` from it, so write and read cannot drift. `TestProvenanceForProvider` pins the constructor's output for a known and an unknown provider. S0 is reserved for a direct node/RPC client; the keyed third-party explorers (etherscan/blockscout/mempool) are S2 indexers, not ground truth |
| `apps/data/internal/ingest/repo/dex_reader*.go` | `finalizeProvenance` fills `Tier`/`SourceType` from the class map and moves each table's natural event time into `ObservedAt` — no more empty-string / zero-time provenance |
| `apps/data/internal/ingest/providers/thegraph/*` | NEW — indexer tier (S2) subgraph adapter: `swaps` (block-cursor paged) + `pool-day-data` (daily exact-decimal market snapshots). Targets the canonical **Uniswap-v3 schema** explicitly: decimals are read from `pool.token0/token1` (the Swap entity has no token relations), and `amount0/amount1` are **pool-perspective BigDecimal strings** (positive = taker's input) re-scaled to exact raw via the real exponents — an inversion or a swap-side decimals read is caught by the tests. `THEGRAPH_SUBGRAPH_URL` is read once and never appears in an error or the request URL; no URL = no request at all, jobs seed disabled. TVL is deliberately NOT mislabelled as market cap |
| `apps/data/internal/ingest/providers/bitquery/*` | NEW — indexer tier (S2) GraphQL adapter (`BITQUERY_API_KEY`, Authorization header): `dex-trades` maps the v2 EVM `DEXTrades` cube to canonical swaps with an **explicit buy/sell direction** (sell = input, buy = output — no sign to interpret), whole-token amounts re-scaled to exact raw via `Currency.Decimals`; a leg missing decimals is rejected, never defaulted. The key rides the header, never a URL, and never an error. **The v2 schema shape is encoded from published docs and has NOT been exercised against a live key** — the fixture pins the mapping, not upstream fidelity |
| `apps/data/internal/ingest/providers/evmrpc/*` | NEW — **S0 ground truth**: raw `eth_getLogs` (EVM_RPC_URL, redacted) with a strict transport/parser split. Parsers decode the V2 (Swap/Mint/Burn/Sync) and V3 (Swap/Mint/Burn) event sets by topic0 — **V2's four-word Swap folds to a signed IN-OUT pair** so a swap cannot look like a mint. The swap event carries NO token identity or decimals, so **pool metadata is resolved via `eth_call`** (token0/token1 + each token's decimals, cached per pool) and each leg is scaled at its OWN exponent — a `decimals=0` write is impossible. That resolved metadata is also **persisted as pool composition** (`data.dex_pool_token`, index 0/1 = token0/token1), which finally gives that table a producer; the reserve is left absent (this read does not return it). **EventTime comes from `eth_getBlockByNumber`**, never epoch 0. `canon.ClassifyProvider` gained the `evmrpc` S0 entry |
| `apps/data/main.go` | registers `helius`/`jupiter`/`geckoterminal`/**`dexscreener`**/**`thegraph`**/**`bitquery`**/**`evmrpc`** (DEX writer needed → appended in `dataModulesWithDerived`); mounts `/api/v1/` |

### Canonical API (plan §30, §31)

| File | Change |
|---|---|
| `apps/data/internal/ingest/serve/dex_routes.go` | NEW — 19 `/api/v1/dex/*` route registrations |
| `apps/data/internal/ingest/serve/dex_handlers.go` | NEW — handlers, cursor helpers, loud-400/404/503 |
| `apps/data/internal/ingest/serve/serve.go` | `server.dex` field + `WithDexReader` option (additive; `New`'s signature frozen) |
| `apps/web/src/app/(frontend)/api/[...path]/route.ts` | `forwardV1` + dispatch branch for `/api/v1/*` |

## Architecture impact

- The DEX subsystem lives **inside** the existing boundaries (plan §38), not in a
  parallel `backend/internal/dex/` tree. `canon` stays the single id space; the
  `ingest` engine's limiter/breaker/backoff/dead-letter/retention are reused
  unchanged.
- No `canon.Reader`/`canon.Writer` method was added, so **none** of the five
  frozen implementers (repo, `unavailableReader`, `failingWriter`, and the two
  test fakes) were churned. The DEX store is a **separate port** (`dexstore`)
  implemented by the same `*repo.Repo`.
- `ingest.Fetcher.Fetch` was **not** widened. DEX providers take the DEX writer
  by construction (`NewModule(doer, dexstore.Writer)`); a nil writer fails loudly.
- Layer direction preserved (plan §39): `canon` ← `dexcap`/`dexstore`/`dexrecon` ←
  `repo`/`providers` ← `serve`. No provider is referenced by any domain package.

## Capabilities added

`EntityKinds`: deployment, swap, candle, market_snapshot, liquidity_snapshot,
liquidity_position, wallet_activity, route_quote, risk_metric, mev_event,
perp_market, provider_observation. `dexcap.Capabilities`: tokens, pools, price,
swaps, candles, liquidity, protocol_metrics, wallet, routing, risk, perp,
orderbook, discovery, holders. Registry can answer "who can price this pool on
this chain, best first".

**Pool discovery (plan §27/§49)** — `dexstore/discovery.go`: a `Candidate` (what
a source claims exists) goes through `StoreConfirmed`, which enforces the
pipeline's **verify** step rather than assuming it: a candidate naming no
`Confirmation` or carrying no `ObservedAt` is rejected. It writes the whole
dependency chain **chains → venues → deployment → pool → tokens** — the pool row
included, so discovery cannot leave orphan composition rows — and mints the same
`PoolKey` the market datasets use, so discovery and market data meet on one
identity. `IsBase` is set only when the candidate designates a base side; a
discovery path whose tier contradicts a classified provider's tier is refused
**Ordered, checkpoint-driven backfill (plan §48)** — `dexstore/backfill.go`:
`PlanBackfill` orders units by the §48 stage (metadata → pools → tokens → OHLCV
→ swaps → liquidity → protocol metrics → wallet → long tail) with a
deterministic tiebreak so a resumable run is reproducible; a dataset with no
stage is **skipped**, never silently run first as metadata. `NextWindow` encodes
the constraint the newest-N readers impose: a backfill reads an explicit
`[cursor, cursor+N)` window anchored in the past and ASCENDS, and reaching the
present is the terminal condition (reported, never an infinite loop).
`AdvanceCheckpoint` follows the newest **fetched** time rather than the requested
window end, so a short page retries its gap instead of skipping unwritten history.

**Activity-based scheduling (plan §28)** — `dexstore/activity.go`: a pure
`ClassifyActivity` maps a pool's 24h volume/liquidity/txns to Tier A–D and
`CadenceFor` to a poll interval. It is tiered at SEED time by design: the ingest
engine's `EnsureJobs` overwrites `schedule_seconds` from the seed spec on every
restart, so a runtime-mutated cadence would silently revert on the next boot —
deriving it at seed is the honest, clobber-free design. The tier and its inputs
persist in the job **cursor** (`WithTier`/`TierFromCursor`), which `EnsureJobs`
preserves. An unmeasured pool is TierUnknown (default cadence), **never** guessed
into TierD. — `derive/dex.go`: buy/sell
imbalance, volume velocity, pool health, impermanent loss, LP APR, plus two
**exact-Dec** primitives (`LiquidityDepthUSDExact`, `PriceImpactPctExact`) that
model x·y=k with `*big.Rat` and never touch a float64 — a rounded depth or impact
is a wrong execution answer. `DecFromRat`/`finiteDecimal` were added to `canon` so
a non-terminating quotient can never be built as a `Dec`; the renderer returns
the exact rational spelling rather than a float approximation. Only the
single-input metrics (`volume_velocity`, `impermanent_loss`) are registered as
processors — the multi-input ones stay pure functions for a DEX-side driver,
because a registered processor that can only emit NULL would be a silent lie
under a real metric name.

## Tests added

| Package | Tests |
|---|---|
| `canon` | exact-decimal round-trips, non-decimal rejection, precision-not-lost-through-float, `TokenAmount` exactness incl. uint256, JSON string wire shape, DEX key determinism, chain qualification, log-index/interval/size/version discrimination, **structural no-float64 guard** (AST walk) + completeness guard, **provider classification** (tier/type resolution + unknown-not-guessed, writer providers covered, no third-party API at S0) |
| `dexstore` | activity classifier (each tier boundary, **absent liquidity is never read as dust**, unmeasured pool is Unknown not Dead, cadence ordering, tier cursor round-trip); **discovery pipeline**: canonical rows written in dependency order with the pool row present, seven rejection paths writing nothing, undesignated base stays nil, designated base honored at its index, tier contradiction refused; **backfill policy**: §48 stage order, deterministic re-planning, unordered dataset skipped, stage round-trip, ascending-window exhaustion, cursor-follows-data |
| `derive` | indicators/quant (pre-existing), plus **DEX analytics**: exact depth/impact against rational expectations, non-terminating `DecFromRat` refusal, depth↔impact round-trip, imbalance/pool-health/velocity NaN conventions, LP APR, and that the multi-input metrics are deliberately NOT registered |
| `geckoterminal` | pool endpoint shape; **`dex-candles` exact-decimal mapping** (`4001.2` stays exact), malformed-bar rejection (short / unparseable), nil-writer loud failure, unsupported-timeframe loud failure, §15 natural key, jobs gating (candle job off without a writer) |
| `dexcap` | unknown capability/keyless-auth/duplicate rejection, tier preference, within-tier priority, unusable omission, unhealthy-last, loud-fail on empty, chain scoping, fallback order |
| `dexreliability` | healthy/degraded/unhealthy by rate and by consecutive failures, rate-limit window, staleness, unconfigured/disabled precedence, percentiles, snapshot, 32-goroutine concurrency |
| `dexrecon` | **plan §33 golden ETH/USDC four-provider case**, outlier-not-averaged, tier weighting, staleness lowers confidence, liquidity raises it, nil-block neutral, single-vs-agreed, loud failure on empty, factors-sum invariant; ten quality detectors + classifier |
| `repo` (live, `-tags live`) | full storage round-trip against real Postgres in a rolled-back transaction: swap/candle/quote/risk/quality/deployment; exact numeric fidelity; swap idempotency; invalid state rejected; pool symbol projection across four readers |
| `ingest/serve` | **DEX handler suite** (new): `/api/v1/dex/pools` 200 envelope, limit **clamped to `maxLimit`** (guards the second-limit-contract defect), `?limit=abc/0/-3` loud 400, unknown sort 400, unknown interval 400, unwired reader 503, store failure 503, unknown path 404; **concurrency under `-race`** (new): the read mix stays isolated, each response is capped to its OWN limit (revert-proven), and a bad param in one goroutine stays a loud 400 for that goroutine only |
| `dexscreener` | **cursor preservation on both success paths** (`TestMarketCursorKeepsSubjectOverride` for the tier write, `TestZeroPairCursorKeepsSubjectOverride` for the zero-pair path, both revert-proven); jobs/fetcher gating; **market-snapshots exact-decimal mapping** on a fixture shaped like the real upstream body (bare JSON numbers for volume/fdv/marketCap/priceChange, so removing `UseNumber` fails the test — proven by reverting it), absent `priceChange` stays nil; nil-writer loud failure |
| `jupiter` | exact quote amounts (9/6 decimals), **route legs carry their percent share on both sides** (the live leg bug), unknown mint → loud HardError, nil writer → loud failure, non-2xx → typed status error, tokens list skips address/symbol-less rows, `legShare` exactness incl. 0/101/absent |
| `helius` | exact swap amounts + **a native SOL leg maps** (`TestNativeLegSwapsAreMapped`, the live-coverage defect above: one token side + one `nativeInput`/`nativeOutput` side, spelled as the wrapped-SOL mint at 9 decimals, with a leg-less side still rejected), **keys round-robin** (`TestKeysRoundRobin`: successive requests use successive keys, duplicates collapse), **cursor survives an empty signature** and **an all-empty-signature page returns the cursor UNCHANGED, not nil** (`TestAllEmptySignaturesKeepTheCursor`, revert-proven), non-swap and signature-less txs rejected, **no request at all without a key**, **the API key never appears in an error or stored URL**, jobs seed disabled without credentials, swap activity carries pool/token/amount |
| `thegraph` | **positive leg = taker input** (amount0 positive → WETH in; amount1 positive → the direction flips), decimals read from `pool.token0/token1` (a swap-side read yields 0), **6/6-decimal fixture proves the leg is indexed not "first-that-scales"**, sub-unit precision rejected (never rounded), missing pool decimals rejected (no 0-default), direction-less swap rejected, block cursor = newest block seen, **no URL = no request at all**, **URL never leaks into an error**, GraphQL 200-with-`errors` is a failure, TVL not mislabelled as market cap, nil writer loud, jobs gated, write class agrees with `canon.ClassifyProvider` |
| `bitquery` | **an uncovered chain is refused** + **the query network follows the subject** (`TestUnknownChainRejectedLoudly`, `TestNetworkFollowsTheChainSlug`, both revert-proven), **an absent `Trade.Index` is rejected** rather than defaulted to 0 (revert-proven), **`{"data":null}` is a failure** (revert-proven); **explicit buy/sell direction** (sell = input, no sign to interpret; a leg swap is visible), exact whole-token → raw re-scaling at 18/6 decimals, leg without decimals rejected (no 0-default), sub-unit precision rejected, block cursor = newest block seen, **no key = no request at all**, **the key rides the Authorization header and never the URL**, **the key never leaks into an error**, GraphQL 200-with-`errors` is a failure, nil writer loud, jobs gated, write class agrees with `canon.ClassifyProvider`, block-time parser forms |
| `evmrpc` | **the `eth_getLogs` window is bounded** and **its cursor lands on the window end** (`TestGetLogsWindowIsBounded`, revert-proven), **an empty window still advances** (`TestEmptyWindowStillAdvances`, revert-proven); **V2's four-word Swap folds to a signed IN-OUT pair** (reading two words would look like a mint), V3 int256 signed amounts, **each leg scaled at its OWN resolved exponent** (18/6 from `eth_call`, never 0), token ids minted from the resolved pool tokens, **resolved metadata persisted as pool composition** (index 0/1, reserve absent), **EventTime from the header, not epoch 0** (an unreadable block time is rejected), unmodelled topic skipped (not rejected), unknown/odd hex rejected by the ABI decoder, two's-complement decode, `decimals()`/`token0()`/`token1()` selectors pinned to their keccak prefixes, **no endpoint = no request**, JSON-RPC error with a 200 is a failure, nil writer loud, jobs gated, write class agrees with `canon.ClassifyProvider` (S0/rpc) |

### Regression tests for the live-correctness sweep

Each defect above is pinned by a test that was RUN against the re-introduced
defect and observed to fail, so the guard is proven rather than assumed. The
"proven" column records that revert-check, not an assumption:

| Test | Pins | Proven (revert-checked)? |
|---|---|---|
| `TestGetLogsWindowIsBounded` (evmrpc) | one bounded `eth_getLogs` window; cursor lands on the window END | yes — reverting `toBlock` to `"latest"` fails it. Subtlety worth recording: reverting the clamp alone is NOT enough, because the window arithmetic still bounds the range. My first attempt did exactly that and the test kept passing; only re-introducing `toBlock: "latest"` (the actual original defect) made it fail. |
| `TestEmptyWindowStillAdvances` (evmrpc) | a quiet window still advances (else the job pins on one range) | yes — reverting the cursor to `fromBlock` fails it |
| `TestNullDataRejected` (bitquery) | `{"data":null}` is a failure, not an empty success | yes — reverting `data` to decode as an empty map fails it |
| `TestUnknownChainRejectedLoudly` (bitquery) | an uncovered chain refuses instead of querying the eth cube | yes — making `bitqueryNetwork` return `eth` for every slug fails it (`uncovered chain must be a loud shape error, got <nil>`) |
| `TestNetworkFollowsTheChainSlug` (bitquery) | the query's network comes from the subject | yes — same injection fails it (`bitqueryNetwork("base") = "eth"/true`) |
| `TestAbsentTradeIndexRejected` (bitquery) | an absent `Trade.Index` is rejected, not defaulted to 0 | yes — reverting to a silent 0 default fails it |
| `TestMarketCursorKeepsSubjectOverride` (dexscreener) | the tier write MERGES into `job.Cursor` | yes — fails with `WithTier(nil, …)` |
| `TestZeroPairCursorKeepsSubjectOverride` (dexscreener) | the zero-pair success path keeps `job.Cursor` too | yes — fails when the write passes `ingest.Cursor{}` |
| `TestAllEmptySignaturesKeepTheCursor` (helius) | an all-empty page returns the cursor UNCHANGED | yes — verified by reverting to `nil` |
| `TestDexConcurrentLimitIsPerRequest` (serve) | each concurrent request's response is capped to its OWN limit | yes — injecting `pool.Limit = 3` fails with `got 3 rows, want 2` |
| `TestTokenPairsMapping` (dexscreener) | the pool row carries the pair's display symbols | yes — dropping the two assignments fails with `base symbol <nil>, want USDT` |
| `TestPoolMapping` (geckoterminal) | the pool row carries the sides' symbols from `included[]` | yes — dropping the two assignments fails with `base symbol <nil>, want WETH` |

## Tests executed

```
go build ./... && go vet ./...                       # clean
go test ./apps/data/...                              # all packages pass
go test ./apps/data/internal/ingest/serve/ -run TestDex   # 8 handler tests pass
go test -tags live ./apps/data/internal/ingest/repo/ -run TestLiveE2EDexStorage
   # PASS against 127.0.0.1:5432 inside a rolled-back tx
bash scripts/verify/verify-all.sh                    # see Results
```

```
go test ./apps/data/internal/ingest/serve/ -run TestDex -race
   # the DEX read surface under a concurrent load mix: no data race, each
   # response capped to its OWN requested limit, bad params still loud 400s
```

The concurrency run found a race — in the test FAKE, not the production path:
`fakeDexReader` recorded the query's limit in a plain field while the handlers
are (correctly) callable from many goroutines. Guarded on the fake so the
package is `-race`-clean for everyone. A real find, but a test defect, not a
handler defect — the production reader was never implicated.

**Three corrections I made after checking, recorded so they are not re-derived:**

- The first version of `TestDexConcurrentLimitIsPerRequest` hit
  `/api/v1/dex/chains`, which reads through the **canon** reader that `dexServer`
  does not seed. It asserted on 0 rows and passed **vacuously**. Pointed at
  `/api/v1/dex/pools`, which `fakeDexReader` implements with seeded rows.
- The fake used to return its whole slice and ignore `q.Limit`, so a row-count
  assertion would have tested the fake, not the handler. It now mirrors the real
  reader (`LIMIT $n` after `clampLimit`, `dex_reader.go:124-125`), and the
  concurrent test asserts **exactly `min(limit, 3)` rows**. Proven to bite by
  injecting `pool.Limit = 3` before the call — it failed with
  `/api/v1/dex/pools?limit=2 -> got 3 rows, want 2`, then passed after restore.
- The limit-parse path is *also* pinned sequentially via the recorded limit
  (`TestDexLimitReachesTheReaderSequentially`), proven by injecting `lim = 1`
  (`limit=2 reached the reader as 1`).

One limit on what the concurrency tests prove: they assert per-request isolation
of the *limit* and well-formedness under load. They do not exercise the real
reader's SQL, so effective row counts against Postgres are covered by the
`-tags live` suite instead.

The `UseNumber` guard was proven by **reverting the fix and watching
`TestMarketSnapshotsExactDecimals` fail** (`volume (JSON number) not exact: <nil>`),
then restoring it — a test that only passes is not evidence, a test that fails on
the defect is.

### Pool-symbol round (this session)

```
go build ./apps/data/... && go test ./…/providers/{dexscreener,geckoterminal}/...
   # pass; without the two assignments each fails: base symbol <nil>, want USDT/WETH
go test ./…/providers/geckoterminal/ -run TestZZLiveSymbolSmoke -v
   # THROWAWAY, live API: pool:818e0af622 base=WETH quote=USDT, then deleted
go test ./…/providers/dexscreener/ -run TestZZLiveSymbolSmoke -v
   # THROWAWAY, live API: 30 pools, 30 with BOTH symbols, then deleted
bash scripts/verify/verify-all.sh                    # VERIFY_ALL_OK (73.8s)
```

The live end-to-end claim does not rest on those throwaways: after the sidecar
restart the daemon's own `17:05` cycle wrote 92/92 named pool rows, and
`GET /api/v1/dex/pools/pool:818e0af622` returns them.

One process lesson worth keeping: an earlier `verify-all` run failed with no
FAIL lines because I deleted a temporary Go package (`apps/data/tmpidcheck`)
while the gate's `go build ./...` was walking the tree. The gate is green in the
serial run; the failure was self-inflicted, reproducible, and not a code defect.
Do not create or delete a Go package while the gate runs.

## Results

- `go build ./...`, `go vet ./...` — clean.
- `go test ./apps/data/...` — all packages pass.
- Live Postgres round-trip — PASS. This is what caught two runtime-only defects
  that `go build`/`go vet` cannot see: a 16-vs-14 SELECT/scan projection
  mismatch, and a pre-existing `scanPool` NULL-scan crash on `data.pool` (any
  pool row written without `retrieved_at` would 500 the pool read).
- Sidecar smoke against the real database: `schema_version: 1.2.0`,
  `normalization_version: 1.1.0`, **27 providers registered** (all seven DEX
  adapters — `geckoterminal`, `dexscreener`, `helius`, `jupiter`, `thegraph`,
  `bitquery`, `evmrpc`), `/api/v1/dex/chains|pools|rankings|markets|providers`
  all HTTP 200; unknown sort/interval/limit/missing-param are
  loud 400s; unknown pool/path are 404s. Every keyed adapter with no credential
  answers a loud 503 naming the exact env var (`evmrpc: EVM_RPC_URL`,
  `bitquery: BITQUERY_API_KEY`, `thegraph: THEGRAPH_SUBGRAPH_URL`) and sends no
  request. `helius` is no longer in that list: a key was configured, its two
  jobs re-enabled on restart (`enabled = EXCLUDED.enabled` in `EnsureJobs`), and
  its datasets now write live rows (see the Helius section below). The gating is
  bidirectional — absent key disables, present key enables — which is what makes
  it a gate rather than a hard-coded flag. Verified by triggering each
  job live (`POST /api/data/ingest/run?provider=…&dataset=…&subject=…`) with the
  subject from its `data.job` row: all six answer `no-credentials` naming the
  variable. Note the subject format is a chain SLUG plus address
  (`ethereum:0x11b8…`, `solana:So111…`), NOT the canonical `eip155:1:0x…` form —
  passing the canonical form yields a loud `does not cover chain eip155` shape
  error instead, which is the adapter refusing an uncovered slug rather than a
  credential check. Their `data.job` rows are
  disabled, confirmed by querying the live database rather than inferred from
  the unit tests: `SELECT provider, dataset, enabled FROM data.job WHERE
  provider IN ('evmrpc','bitquery','thegraph','helius')` returned `enabled = f`
  for all six rows (`bitquery/dex-trades`, `evmrpc/pool-logs`,
  `helius/swaps`, `helius/wallet`, `thegraph/pool-day-data`, `thegraph/swaps`).
- **Canonical-read proof (this session)**: with the sidecar on the real database,
  a live `?pool=` market read returned 8 rows with exact-decimal strings and the
  full provenance triple — `price_usd: "1.00085"`,
  `volume_24h_usd: "36831793.28"`, `fdv_usd: "48438246299"`, `txns_24h: 3491`
  split `buys_24h: 1624` / `sells_24h: 1867`, `source_provider: "dexscreener"`,
  `tier: "S3"`, `source_type: "aggregator"`. A live `5m` candle read returned
  `open: "2526.59"` / `close: "2517.41"` / `volume_base: "82732.32005497637"`
  with `source_provider: "geckoterminal"` and `tier: "S3"`. Live table counts at
  that instant (the engine writes continuously, so treat these as a floor, not a
  constant): `dex_market_snapshot` 2820+, `dex_candle` 2125+ (one interval, `5m`,
  two pools), `dex_wallet_activity` 200, `dex_swap` 10. `dex_pool_token` is
  still 0 and is what keeps the frontend migration blocked (token addresses are
  unavailable without it).
  Note `GET /api/v1/dex/markets` without `?pool=` is an EMPTY list by design (the
  reader is pool-keyed; the handler documents it), not a defect.
- **Candle interval caveat (disclosed, not silently patched).** The live table
  holds **only `5m` bars** (2091 rows, 2 pools — verified by
  `SELECT interval, count(*) … GROUP BY interval`), because the seeded
  `geckoterminal` job's cursor is `{"timeframe":"minute","aggregate":5}`. The
  handler's default is `1m` (`canon.ValidateTimeframe`-checked), so a bare
  `GET /pools/{id}/candles` returns an EMPTY list. That is correct behaviour —
  the alternative would be serving 5m bars under a 1m label, a fabrication — but
  it is easy to misread as "no data". Consumers must pass `?interval=5m` today,
  or the dataset must be seeded for more intervals. Left as a disclosure rather
  than changing the API default, because `1m` is the right contract default and
  only the data coverage is thin.
- **Live candle proof**: triggering the `dex-candles` dataset through
  `/api/data/ingest/run` wrote 1,000 exact-decimal `data.dex_candle` rows
  (1,999 total after the engine's own seeded run); `/api/v1/dex/pools/:id/candles`
  serves them with each bar's `observed_at` = its open time and the resolved
  `tier: "S3"` / `source_type: "aggregator"`. Decimals are exact strings end to
  end (`"111.057598010164"`), never a float64 round-trip.
- **Live-correctness sweep before the gate.** Seven defects that would have bitten
  on first contact with a real endpoint were found and fixed, each with a test
  that fails on the old code:
  - `evmrpc` asked `eth_getLogs` with `toBlock: "latest"` and no window, so any
    real node (range caps ~1k–10k blocks) would reject the very first call. The
    fetch now walks ONE bounded window (`logWindowBlocks = 2000`) and advances
    the cursor to the window's END — a quiet window still advances, so a pool
    with no recent swaps cannot pin the job on one empty range forever.
  - `thegraph`/`bitquery` treated `"data": null` as an empty success:
    `json.RawMessage("null")` is four bytes, so the length check passed and
    `Unmarshal("null", …)` is a silent no-op. Both now refuse a null payload.
  - `bitquery` hardcoded `network: eth` while the chain slug decided the row's
    identity, so a `base:` subject would have queried the Ethereum cube and
    minted rows under the wrong `chain_id`; an uncovered chain is now a loud
    refusal and the network is a query variable. The pool address is lowercased
    so a checksummed subject cannot mint a second identity for a known pool.
  - `bitquery` defaulted an absent `Trade.Index` to 0, which would collapse every
    swap in a multi-swap transaction onto one `SwapKey`; it is now a rejection.
  - `dexscreener` `market-snapshots` returned `WithTier(nil, …)`, and the engine
    REPLACES the cursor column (`SET cursor = $4`), so a job's `subject` override
    — read back by the same function — was erased after one run. It now merges
    into the incoming cursor.
  - `helius` returned `{"before": ""}` (and then `nil`) when no signature
    advanced, which reads back as absent and restarts pagination from the top.
    Both paths now return the job's cursor UNCHANGED (`nil` would have wiped the
    stored column via SQL NULL).
  - `dexscreener`'s zero-pair success path ALSO returned an empty cursor, which
    the engine writes as SQL NULL — erasing the subject override on the first
    quiet run. It now returns `job.Cursor`, as do the two upsert error paths.

  **Revert-proven.** Every one of these seven is pinned by a test that was run
  against the re-introduced defect and observed to FAIL — not merely written:

  | Test | Defect reverted | Result |
  |---|---|---|
  | `TestGetLogsWindowIsBounded` | `toBlock` back to `"latest"` | FAILS |
  | `TestEmptyWindowStillAdvances` | cursor back to `fromBlock` | FAILS |
  | `TestNullDataRejected` | null check removed | FAILS |
  | `TestUnknownChainRejectedLoudly` | network hardcoded to `eth` | FAILS |
  | `TestNetworkFollowsTheChainSlug` | `base` mapped to `eth` | FAILS |
  | `TestAbsentTradeIndexRejected` | index defaulted to `"0"` | FAILS |
  | `TestMarketCursorKeepsSubjectOverride` | `WithTier(nil, …)` | FAILS |
  | `TestZeroPairCursorKeepsSubjectOverride` | `ingest.Cursor{}` on the zero-row path | FAILS |
  | `TestAllEmptySignaturesKeepTheCursor` | `nil` on the empty-signature path | FAILS |
- **Gateway hop: exercised, and it fails for a deployment reason, not a code
  one.** With the sidecar on :3101 answering 200 for
  `/api/v1/dex/chains|pools|rankings`, the SAME paths through the live web tier
  on :3100 return **404 `{"error":"not_found","detail":"no API route for /v1"}`**.
  That body is the pre-`forwardV1` dispatch branch, and the cause is
  measurable: the running Next build is `2026-10-12 06:55` while
  `route.ts` (with the `forwardV1` branch) is `10:52` — **the live gateway
  predates the code**. The fix is a web-tier rebuild+restart, which is a
  deployment action on the live site, not a source change.
- **Live activity-tier proof**: the `market-snapshots` jobs persisted
  `{"activity_tier":"A","txns_24h":7555,"volume_24h_usd":137356013.49}` for the
  Ethereum USDT universe — a $137M/24h pool classified **TierA** (fastest
  cadence). This is exactly the case the classifier's absent-liquidity defect
  broke: the market row has no liquidity column, and coercing that absence to 0
  would have ranked a $137M pool as **TierD** (hourly). The failing case is on
  the record in `TestClassifyActivityTiers` (`got "D" want "A"` before the fix).
- **Live market proof**: the `dexscreener` `market-snapshots` dataset wrote 90
  exact-decimal `data.dex_market_snapshot` rows in one run (30 per subject);
  `/api/v1/dex/markets?pool=<id>` serves them with `price_usd: "0.999"`,
  `volume_24h_usd: "162.23"`, `fdv_usd: "88222741648"`, the 24h buy/sell split
  and the same resolved provenance. The `UseNumber` decode is what keeps a JSON
  *number* (`fdv`) exact — plain `Unmarshal` would have rounded it to a float64
  and silently nil'd every price field.
- **Live jupiter proof (the fabrication fix)**: the seeded quote now stores
  `amount_in_raw=1000000000 @ 9 decimals` = **1 SOL → 110.926307 USDC**. Before
  the fix the same raw value was written with `decimals=0`, i.e. "1,000,000,000
  SOL" — off by 1e9. The corrupt row my own smoke run produced was deleted; the
  next run wrote the correct one, and an unknown mint now fails loudly instead.
- The `dex-candles` proof is what exposed the provenance-projection gap: the
  reader was emitting `source_type: ""`, `tier: ""` and `observed_at:
  0001-01-01` for rows whose event time the table already carried. Fixed by
  `finalizeProvenance` (event time → `ObservedAt`) + `canon.ClassifyProvider`
  (provider name → tier/type), which the writers now also draw from, so write
  and read cannot drift.

### Design note: `/chains` and `/protocols` read the canonical reader

`/api/v1/dex/chains` and `/api/v1/dex/protocols` are served by `canon.Reader`
(`s.r`), not by the DEX reader. That is intentional, not a mis-wiring: there is
no DEX-specific chain or protocol table — `data.chain` and `data.protocol` are
the single canonical source (§4 freezes Chain and DexProtocol as canonical
entities, and §5 makes the chain ID the identifier), so duplicating them under
the DEX store would be exactly the "duplicate provider schemas" anti-goal. The
DEX reader owns only what is DEX-specific; its header comment says so.

## Helius: a live-coverage defect the fixtures could not catch

The Helius adapter passed every unit test while mapping **1 of 279** real
transactions. The cause was in the fixture, not the code paths: `swapFixture`
was written from the adapter's own assumption that a swap carries BOTH
`events.swap.tokenInputs` and `events.swap.tokenOutputs`.

Real Solana swaps rarely look like that. Measured against the live API
(279 transactions across the seeded mint and a live Raydium pool, both the
`type=SWAP` and unfiltered feeds):

| Rule | Mappable |
|---|---:|
| OLD — both token sides required | **1 / 279** |
| NEW — a side may be a token OR a native transfer | **26 / 279** |

The missing side is native SOL, which Helius reports as
`nativeInput`/`nativeOutput` (`{"account":…,"amount":<lamports>}`) — fields the
adapter did not model at all, so it dropped them and then rejected the swap for
having no second token side. SOL is the quote asset of most Solana pairs, so
this is not an edge case: it is the majority shape.

**The fix** (`transactions.go`): model the native side, and resolve each side
through one `swapLeg` helper — token transfer first, native transfer as the
fallback — so a SOL leg reaches the same exact-amount path as any token leg. The
native leg is spelled as the wrapped-SOL mint at 9 decimals, reusing the
identity the sibling `jupiter` adapter already keys for SOL legs rather than
inventing a second one. A side with neither transfer still rejects: the adapter
does not guess a leg. `mapWallet` uses the same resolver, so a SOL-in swap is no
longer left with an empty token and amount.

**Proven live, not just in tests**: `POST /api/data/ingest/run?provider=helius&
dataset=swaps` wrote 3 and 5 rows on two consecutive runs (0 before), taking
`dex_swap` from 2 to 10 rows; the `wallet` dataset wrote 100/100 rows written,
0 rejected, taking `dex_wallet_activity` to 200.

**Residual, measured, not hidden**: ~83% of transactions that Helius *types*
`SWAP` arrive with `events: {}` — no swap event at all (10 of 58 on the filtered
feed). Nothing in the payload says which side moved, so those are counted as
rejections rather than fabricated rows. That is an upstream data property, and
it caps the swaps feed's yield; the fix above is what stops the adapter
rejecting the rows that ARE fully described.

## Round-robin Helius keys

`HELIUS_API_KEYS` holds a comma-separated list (the single-key `HELIUS_API_KEY`
is still honored and merged in; duplicates collapse so a repeated key cannot be
picked twice in a row). Requests round-robin across the list, so a burst of
pages spreads over several rate limits instead of draining one, and a retry
after a 429 naturally lands on the next key. The cursor is an `atomic.Uint64`
because the engine dispatches fetches concurrently. Both configured keys were
verified to answer 200 individually, and a rotation test pins the alternation
(a "first key always wins" implementation would still pass a single-key test).

## Pool symbols: a canonical mapping gap the live database proved

The DEX tables served **32,816 pool rows and not one had a name**:
`count(base_symbol) = 0` and `count(quote_symbol) = 0`, from *both* writers
(`dexscreener` 32,100 rows, `geckoterminal` 716). `canon.Pool` documents these
fields as "carried so a consumer (and the query layer) can name a pool's sides
without a join", every pool read projects them (`ListDexPools`, `GetDexPool`,
`ListDexRankings`, `Repo.ListPools` all `SELECT base_symbol, quote_symbol`), and
the storage columns exist — so the API reported an anonymous pool for every
pool it knew about.

The cause was one level up from the storage layer: **neither aggregator adapter
ever set them.** Both map the pool's `*_asset_id` anchor and stop there, even
though the symbol is in the very payload being parsed — `dexscreener` carries
`baseToken.symbol` / `quoteToken.symbol` per pair, and `geckoterminal` carries
`included[]` token rows whose `symbol` the adapter already reads to mint the
asset id (`assetRef`). The field was simply left at its zero value.

Fixed in both adapters, spelling the symbol exactly as `assetRef` spells it so
the pool row and its asset anchor can never disagree, and leaving it nil when the
payload has no symbol (never-fake — `nil`, never `""`).

Evidence, in the order that makes it conclusive:

- The fixture assertions fail without the fix — `base symbol <nil>, want USDT`
  (dexscreener) and `base symbol <nil>, want WETH` (geckoterminal).
- A throwaway live smoke (not committed) drove the real adapters against the
  live APIs: geckoterminal mapped `pool:818e0af622 → WETH/USDT`, and all 30
  live dexscreener pairs carried both symbols.
- After `systemctl --user restart fudcourt-data` (ExecStartPre rebuilds the
  binary), the next ingest cycle at `17:05` wrote **92 of 92 new pool rows
  with symbols** — `geckoterminal` `WETH/USDT` for `pool:818e0af622` (the exact
  pool that returned `"base_symbol": null` earlier the same hour) and
  `SOL/USDC` for `pool:504558cde7`.
- `GET /api/v1/dex/pools/pool:818e0af622` now returns
  `"base_symbol": "WETH", "quote_symbol": "USDT"` alongside `price 2513.94`.

Historical rows keep their `NULL`s: nothing rewrites a past observation with a
value it did not record. Rows already written stay as they are; every pool the
poller touches from now on carries its name.

### What this leaves for the frontend migration

`features/market/dex/client.ts` calls `https://api.dexscreener.com` directly,
which is plan §65's explicit anti-goal and the reason §60's "zero direct provider
dependencies" is unmet. Repointing the pairs table onto `/api/v1/dex/*` now has
its numeric and identity columns covered — with this fix, the pair name is no
longer the blocker the previous round recorded:

| Column the UI renders | Canonical source | Status |
|---|---|---|
| pair (`baseToken.symbol`/`quoteToken.symbol`) | `pools.base_symbol`/`quote_symbol` | **fixed this round** |
| price | `pools.price` | served |
| 24h % | `markets.price_change_pct_24h` | served |
| volume / liquidity / market cap | `pools.*`, `markets.*` | served |
| buys / sells / txns 24h | `markets.buys_24h`/`sells_24h`/`txns_24h` | served |
| dex name (`dexId`) | `pools.dex_venue_id` only (`venue:cd59236a3b`) | **gap: no route projects `data.venue.name`** |
| age (`pairCreatedAt`) | — | **gap: not modeled** |
| labels | — | **gap: not modeled** |

So the migration no longer needs `data.dex_pool_token` (which stays empty until
`evmrpc` runs against a live `EVM_RPC_URL`) to name a pool — that table is the
one that carries contract *addresses*. The three remaining gaps are a product
decision, not a data absence: a venue-name projection is a small read change,
while `age` and `labels` are DEX-Screener-specific decorations that canonical
would either model deliberately or drop from the board.

## Known limitations

1. **Top-level schema not live-applied by the verify run.** The DEX DDL reaches
   the live database via the sidecar's startup apply (proven by the 130-statement
   apply and `schema_version: 1.2.0`). Decision recorded: additive DDL onto the
   sidecar's sole applier, not a shared runner tied to `executor-schema.sql`.
2. **`/api/v1/dex/pools` reads `data.pool`**, so the pool payload carries the
   market contract's `float64` for price/liquidity (e.g. `"price": 1.00096`).
   The exact-numeric `data.dex_market_snapshot` is the intended home and is
   **NO LONGER empty** — `dexscreener` writes it (`?pool=` reads returned exact
   strings, 750+ rows this session). What is missing is the READER: `/pools` has
   not been repointed at it yet, which is follow-up 4. Documented, not hidden.
3. **Swaps, quotes, `dex_pool_token` and the indexer rows are still empty in the
   live database.** Populated today: `dex_candle` (`geckoterminal`),
   `dex_market_snapshot` (`dexscreener`, 750+ rows). Empty and why: `helius
   swaps`/`wallet` need `HELIUS_API_KEY`; `bitquery` needs `BITQUERY_API_KEY`;
   `thegraph` needs `THEGRAPH_SUBGRAPH_URL`; `evmrpc` needs `EVM_RPC_URL` (and it
   is this adapter that would fill `dex_pool_token` with token addresses, which
   is what the frontend migration is waiting on); `jupiter quote` writes only
   when the engine runs it against a live endpoint. The tables and the API paths
   are live and correct — the producers are gated on credentials, not missing.
4. **`data.dex_candle` provenance is slim on disk** (`source` + `retrieved_at`);
   tier/source-type are resolved at read time from `canon.ClassifyProvider`
   rather than stored per row. This is deliberate (they are a fixed fact about
   the adapter) but means an operator querying the table directly sees the
   provider name only.
5. **`dex-candles`/`market-snapshots` share pool identity with the `pools`
   dataset** — all three mint `PoolKey(chain, address)`, and the candle/snapshot
   datasets rely on the `pools` job having created the `data.pool` row (there is
   no FK). Verified live: **0 orphan pool references** across candle + market
   snapshot. The coupling is real though — disabling the `pools` job for a subject
   would leave its candles pointing at an absent pool, so the seeded jobs keep
   them paired.
6. **Raw EVM log ingestion lands (plan §16/§20) but the S0 adapter is
   single-pool and swap-only**: it reads one seeded pool's logs and maps swaps;
   it does not yet walk factory-created pools, decode the V2/V3 liquidity
   position NFTs, or emit `Sync`-derived liquidity snapshots. Those are
   enrichment, not the ground-truth swap path, which is implemented.
   **Backfill cost caveat**: the request window is bounded to
   `logWindowBlocks = 2000` (a real node rejects a wider range), and the cursor
   starts at block 0, so walking one real pool from genesis to head (~21M blocks
   on Ethereum) is roughly **10,500 sequential one-window runs** — a live
   backfill must seed `fromBlock` near the pool's creation rather than 0, or it
   will spend days reaching the present. The window is what makes a live run
   possible at all; the start point is what makes it useful.
7. **Streaming/WebSocket ingestion is not implemented** (audit G7) — `Mode: "stream"`
   remains a fast REST ticker, unchanged.
8. **`dex/recon` and `dexreliability` are libraries, not yet wired into a running
   job** — the reconciliation pass and the health sink need a provider that
   produces multi-source observations first.

## Provider limits

| Provider | Auth | Status |
|---|---|---|
| helius | `HELIUS_API_KEY` (URL param, redacted) | implemented; jobs seed disabled without a key |
| jupiter | optional `JUPITER_API_KEY` (header) | implemented; keyless tier serves, jobs enabled either way |
| bitquery | `BITQUERY_API_KEY` (Authorization header) | implemented; jobs seed disabled without a key; key never in a URL, log or error; **not exercised against a live key** |
| thegraph | `THEGRAPH_SUBGRAPH_URL` (full gateway URL incl. key) | implemented; jobs seed disabled without it; URL never logged or carried in an error |
| evmrpc | `EVM_RPC_URL` (or `FUDCOURT_EVM_RPC_URL`), may embed a key | implemented (S0 raw logs); jobs seed disabled without an endpoint; endpoint redacted from errors |

## Security concerns

- No credential is written to a log, an error string or a URL that is stored:
  Helius redacts `api-key` before any `HardError` carries the URL; Jupiter sends
  its key in a header and never in a URL. Both are covered by the adapters' own
  doc comments.
- No DDL is destructive; the DEX block is `CREATE ... IF NOT EXISTS` plus
  re-guarded named constraints, matching the frozen file's conventions.
- `data.dex_provider_observation` stores raw upstream payloads as `bytea` with an
  explicit `expires_at`; nothing in the canonical layer parses them.

## Operational finding (this session)

The `fudcourt-data.service` user unit was **`enabled` but inactive (dead)** from
`2026-10-11 18:57:58` to `2026-10-12 14:49:39` — a ~20h outage that predates this
session and was NOT caused by it. Evidence: `ActiveEnterTimestamp` was the boot
(`2026-10-10 22:39:56`, so it did start at boot and ran 20h16m), the stop was a
clean `status=0/SUCCESS` (not a crash), the `default.target.wants/` symlink is
correctly in place, and its sibling timers (`prices`, `sync`, `signals`,
`alerts`) kept firing throughout — so this was a single unit stopping, not a
family-wide shutdown.

Blast radius while it was down: the web tier answered **502
`fudcourt-data unreachable`** for `/api/cryptorank`, `/api/llama`, `/api/khala`
and `/api/data/dex/*` (the canonical DEX API included). `systemctl --user start
fudcourt-data.service` restored it: `ok: true`, `db: true`, 27 providers,
`/api/llama` 200 with real TVL and `/api/data/dex/pools` 200 with canonical rows.

Root cause, fixed: the unit is `Type=simple` with `Restart=on-failure`, and a
status-0 exit is SUCCESS to systemd — so nothing ever restarted it, and
`is-enabled` reported `enabled` throughout. `fudcourt-data.service` and
`fudcourt-api.service` now use `Restart=always` (matching the existing
`fudcourt-web*`/`reconciled` convention; `systemctl stop` still suppresses a
restart, so an intentional stop is unaffected). Both were installed host-side
and `daemon-reload`ed.

`check-deploy.py` gained a contract for this, so it cannot silently regress:
every `Type=simple` unit must either use `Restart=always` or carry an explicit,
justified `# restart-policy: on-failure -- <reason>` marker. The marker is not a
blanket exemption — it makes each exception readable and reviewable. Two units
carry one deliberately, with the operator's decision rather than a silent
default: `fudcourt-bot.service` (the Telegram long-poll may be stopped
intentionally) and `fudcourt-executor.service` (a trading runtime that refuses
startup on a bad precondition must not hot-loop).

Also found while auditing: `fudcourt-executor.service` has been down since
`2026-10-11 19:55:28` with `status=1` — its log shows
`valkey lock refused ... WRONGPASS invalid username-password pair or user is
disabled` from `127.0.0.1:6379`, the same credential mismatch the sidecar reports
as a non-fatal L2 cache miss. It was NOT restarted: it is a trading runtime, the
failure is a real precondition (a shared Valkey credential), and whether it
should be running at all is the operator's call. Reported, not silently fixed.

## Follow-up

1. Extend the `evmrpc` S0 adapter from the seeded pool to factory-driven pool
   discovery, V2/V3 liquidity-position NFT decoding, and `Sync`-derived
   liquidity snapshots (plan §16/§20 enrichment beyond the swap path).
2. Exercise the `bitquery` (`BITQUERY_API_KEY`) and `thegraph`
   (`THEGRAPH_SUBGRAPH_URL`) adapters against a live credential so their
   documented schema shapes are confirmed upstream, not just against fixtures.
3. Wire the `helius` swaps/wallet datasets with a live `HELIUS_API_KEY` so
   `data.dex_swap` and `data.dex_wallet_activity` carry rows.
4. **Point `/api/v1/dex/pools` and `/api/v1/dex/pools/{id}` at the exact tables**
   (`data.dex_market_snapshot`, now populated) rather than the `data.pool`
   float64 projection, and add pool discovery so `/api/v1/dex/pools` keeps
   serving breadth (limitation 2). The candle side is DONE (Results: live candle
   proof).
5. Add `coingecko` pool discovery and `defillama` protocol metrics so the
   remaining new tables fill.
6. Feed `dexrecon`/`dexreliability` from a multi-source observation producer so
   the reconciliation pass and health sink run as jobs — including persisting
   `dexreliability.Snapshot` into `data.dex_provider_health` (limitation 7).
7. **Rebuild the web tier** so the deployed gateway includes `forwardV1`: the
   live build (`2026-10-12 06:55`) predates the route source (`10:52`), so
   `/api/v1/dex/*` through :3100 currently 404s with the pre-`forwardV1` body.
   This is a `systemctl stop fudcourt-web` → build → `start` cycle (never build
   while :3100 serves), and it wants an explicit go-ahead since it restarts a
   live service — the code is already correct and tsc-verified.
8. **Populate token contract addresses** (`data.dex_pool_token`): the table is
   still EMPTY, so nothing in the canonical store spells a token's on-chain
   address. This is now a narrower gap than the previous round recorded — pool
   NAMES are served (`base_symbol`/`quote_symbol`, fixed this round: see "Pool
   symbols") — but the `evmrpc` adapter is what writes pool composition, so
   running it against a live `EVM_RPC_URL` fills the table. Note the migration
   itself no longer waits on this.
9. **Frontend repoint (plan §47/§60)**: `features/market/dex/client.ts` still
   calls DEX Screener directly. Canonical now covers the pair name, price, 24h
   change, volume, liquidity, market cap and buys/sells; the open decisions are
   the venue name (needs a small projection of `data.venue.name`, no route
   exists), and `age`/`labels`, which canonical does not model. Must land with
   the web rebuild in item 7 — one restart, not two.
9. Add `coingecko` pool discovery and `defillama` protocol metrics so the
   remaining new tables fill.
10. **Restart-policy contract is in place** (`check-deploy.py` §5) — every
    `Type=simple` unit now either restarts on any exit or carries a justified
    exemption. Remaining: `fudcourt-executor.service` is down on a Valkey
    credential precondition, and whether it should run is an operator decision.

## 2026-10-12 — API contracts turn: chain breadth, latency, role isolation

### Chain coverage (requested: SOL, Robinhood, Ethereum, BSC, Base, Arbitrum,
Hyperliquid, Bera, Avalanche, Sonic, Plasma, Supra, Sui, Aptos, Optimism + majors)

- New geckoterminal dataset `network-pools`: `GET /networks/{slug}/pools?sort=h24_volume_usd_desc`
  (allowed sorts verified live; wrong sort = loud 400 with the vocabulary). One bare-slug
  job per network — no pinned addresses — writing chain + venues + pools with
  price/liquidity/volume/fdv/symbols/age. Missing included[] rows stay nil (never-fake).
- `networkToChain` extended with the provider's own slugs (verified via its /networks
  listing): hyperliquid, berachain, sonic, plasma, robinhood, aptos, sui-network→sui.
- Tiered schedules (plan §28): tier A (eth/bsc/base/arbitrum/avax/optimism/polygon_pos/
  solana) 15m; tier B (hyperliquid/berachain/sonic/plasma/robinhood/aptos/sui-network) 1h.
- **Supra is NOT supported by GeckoTerminal** (absent from its own network list) —
  reported as absent, never faked. Revisit when a provider covers it.
- Rate budget: measured live the CoinGecko family (v3 + geckoterminal) shares one
  per-IP fair-use bucket ~2 req/min under load; engine now holds geckoterminal to
  0.033 rps burst 4 (new `ProviderRate` config). Two CG demo keys ride
  `CG_DEMO_API_KEYS` (git-ignored .env) via `x-cg-demo-api-key` round-robin; keys
  authenticate but do NOT open a parallel bucket (measured).
- Live result: 15/15 supported chains carry fresh pools through
  `/api/v1/dex/pools?chain=<chain_id>` (~1.5ms p50 sidecar, ~10-20ms via gateway).

### Latency (gate: <100ms served; user-visible)

- Fixed **Valkey credential drift**: server requirepass ≠ web/data env passwords →
  every web L2 read failed auth and silently degraded to null; `/api/ticker` paid the
  full 71s venue sweep per cold process. Env files now match the server; after restart
  the L2 sweep (TTL 3002s observed) makes even a cold process serve in ~48ms and warm
  calls in 3-15ms.
- `limitedFetch` gained **opt-in serve-stale-while-revalidate** (`opts.staleMs`, default
  0 = unchanged hard expiry). A stale serve is always VISIBLE: `X-Cache: STALE` +
  `Age` seconds, and the background refresh shares one `fetchAndStore` implementation
  with the foreground path (single-flight + per-origin pacing preserved).
- stock/commodity/indonesia/macro/markets opted in at 10m stale windows; the four
  fan-out boards aggregate per-symbol marks honestly: any STALE ⇒ response STALE with
  max Age; MISS still dominates; HIT only when every call was HIT.
- Benchmark (gateway, warm): dex/chains 13ms, dex/pools 17ms, pools?chain= 10-20ms,
  markets 13ms, news 25ms, proof 8ms, regime 9ms, forex 8ms, technicals 7ms,
  ticker 3-15ms. Cold-miss spikes (2-4s) previously hit ONE caller per TTL window
  per board; those callers now get a STALE serve instead (live /api/markets proof
  after build+restart: t+61s -> X-Cache: STALE, Age: 61, 60ms; t+122s -> STALE,
  Age: 60 — versus the 0.4-2.4s cold MISS rebuild this replaces).
- Deploy note recorded in memory: `systemctl restart` serves the last BUILD; source
  edits require `bun run build` before restart to be observable on :3100.

### Role isolation (public must not see member/team/admin data)

- Policy lives in `apps/web/src/server/auth.ts` (pages + TEAM_API_ROUTES), enforced in
  middleware for every `/api/*` + `/blog/cms/api/*`; session is HMAC-signed, fail-closed
  without a 32+ char secret. Gated responses are `private, no-store` (never cached by a
  shared cache).
- Live unauthenticated probes: all 10 team-tier API routes answer 401 JSON
  (`/api/all|wallets|coins|transactions|treasury|pnl|journal|plans|economy/exposure` +
  `/api/admin/members` requires admin). Public boards answer 200. `/api/admin/members`
  re-verifies the admin tier server-side in Go (requireAdmin) — the web proxy holds no
  auth logic and forwards only the session cookie.
- Two 400s on empty probes (technicals/img) are parameter refusals, not leaks.

### Verification

- `go test ./apps/data/...` green; web tsc green; `tests/rate-limit-tests.ts` 20/20
  (incl. 2 new SWR tests); `scripts/verify/verify-all.sh` → VERIFY_ALL_OK.
- Jobs still cycling: tier-A chains re-land every ~5-6 min (limiter-paced); aptos/sui
  landed after their reset (last_attempt backoff behavior verified correct — failed is
  NOT terminal, DueJobs returns failed jobs on schedule).

## 2026-10-12 — Turn 2a: DEX board — shared MarketTable, chain filter, UX polish

- **Shared MarketTable** (`features/market/dex/ui-table.tsx`): one table skeleton
  (wrapper, header row, row rule, cell chrome, em-dash cells, tabular-nums on
  numeric columns, "first 100 of N" note) now serves BOTH the canonical board
  (`ui-canon.tsx`) and the DexScreener pairs board (`ui-pairs.tsx`). The two
  boards shipped near-identical ten-column copies that drifted independently;
  column VALUES remain the caller's — the skeleton owns no formatter.
- **Chain filter on the canonical board**: a select beside the toolbar sends the
  CANONICAL `chain:…` id to BOTH `/api/v1/dex/pools` and `/api/v1/dex/markets`,
  so the board's pools+markets join stays chain-consistent (a client-side
  post-filter would pair pools with other chains' market snapshots). Options
  come from `BoardResult.chainOptions` — the FULL registry the board already
  fetches — so the list is stable across refetches; a page-derived list would
  self-narrow after every pick. `BoardRow` now carries `chainId` for the same
  reason (name→id mapping in the view would be a second source of truth).
- **UX polish**: `aria-pressed` + `fc-focusable` on the mode buttons (they were
  click-only buttons with no state announcement), `type="button"` +
  `fc-focusable` on Refresh (dex + trench), tabular figures on every numeric
  column (prices/volumes scan down their decimal point), right-aligned numeric
  headers.
- Browser-verified on :3100 after rebuild: options 471 (registry-stable),
  ethereum→60 rows all `ethereum`, solana→all `solana`, base→all `base`
  (60 = the snapshot page bound, pre-existing behavior), aria-pressed correct
  on all 10 mode buttons + hub tabs. tsc clean; 484 web tests pass (34 files).

## 2026-10-12 — Turn 2b: frontend load benchmark + caching/edge headers audit

### Shell + full-load benchmark (browser, warm origin)

Shell TTFB (server HTML, 3-run median): 2-18ms on all 10 sampled pages (/, /market/*,
/signals, /screener, /economy, /coins, /chains, /news, /trade). DCL 46-108ms.
Full network settle (boards hydrate then fan out): 2.0-4.8s, dominated by each
board's client API wave, NOT by page weight:

| page | resources | api calls | slowest API | transfer |
|---|---|---|---|---|
| / | 81 | 44 | 796ms | 695 KB |
| /signals | 78 | 29 | 1261ms | 3109 KB |
| /chains | 33 | 4 | 1982ms | 104 KB |
| /news | 65 | 31 | 1067ms | 96 KB |
| /market/trench | 39 | 4 | 66ms | 185 KB |
| /screener | 35 | 1 | 31ms | 871 KB |
| /coins | 38 | 2 | 17ms | 58 KB |
| /trade | 47 | 1 | 23ms | 76 KB |

The 1-2s "slowest API" numbers are FIRST-call-after-restart costs (limiter cold
start + one-time upstream miss); warm server medians measured immediately after:
chains 11ms, signals 46ms, news 11ms, scoreboard 9ms. /signals' 3.1MB transfer is
its 29-call wave (per-chain + history), the only heavy board; candidate for
Turn-2c if the user wants it slimmed.

### Caching strategy (as measured, all verified live)

- API: every public board route carries `Cache-Control: public, max-age=N,
  s-maxage=N, stale-while-revalidate=N` (markets 60s, signals 30s, dex 15s,
  proof/regime 300s) + the SWR visibility headers (`X-Cache`, `Age`) — confirmed
  END-TO-END at the public edge: `X-Cache: STALE`, `Age: 62` on /api/markets via
  https. Gated (team) responses stay `private, no-store`.
- HTML: public pages `s-maxage=300, stale-while-revalidate=31535700`; home is
  `private, no-store` (treasury shell).
- Static chunks: `public, max-age=31536000, immutable` at origin AND edge.

### CDN/edge headers audit

- Origin :3100 does NOT compress API JSON (Next default); the public listener
  (Caddy TLS :443, deploy/caddy/fudcourt-web-public.caddy) compresses
  zstd/gzip — verified `content-encoding: gzip` on API + HTML through the public
  hostname. Loopback consumers get uncompressed JSON; acceptable (loopback).
- Cloudflare shows `cf-cache-status: DYNAMIC` on HTML + API (correct: we serve
  freshness from our own edge/SWR, not CF's) and will cache immutable chunks.
- /favicon.ico max-age=0 — ignorable.

### Verdict

Bar met: every page serves its shell <20ms, every API meets <100ms warm, the
edge caching story is coherent (immutable chunks + SWR APIs + visible staleness),
and the only heavy transfer (/signals) is bounded and documented.

## 2026-10-13 — Turn 2c: buttons/nav audit, mega menu, i18n en/id/zh, design atoms

### Components audit (measured, not eyeballed)

- **Buttons**: 63 `<button>` elements scanned; nameless-button count = 0 (every toggle carries visible text or children text). Tab/mode buttons carry `aria-pressed`, refresh/mode buttons carry `fc-focusable` + `type="button"`.
- **Design atoms**: 0 hex colour literals, 0 raw `color:` strings, 0 bare `Npx` spacing/size literals across `src/features/**` + `src/ui/**` — everything routes through `@/styles/tokens`. `check-design-tokens.py` and `check-design-system.py` green (458 files, 6 exemptions).
- **Structure gate**: `check-structure.py` green after re-homing i18n (below).

### Mega menu navbar

- Panels computed server-side (`app/(frontend)/mega-menu.ts`) by joining the two registries that already exist — `NAV_SECTIONS` × `PUBLIC_ROUTES` (segment-boundary prefix match) — so "in the menu" and "in the sitemap" cannot disagree; a route becomes menu-eligible by the same act that makes it crawlable.
- Open on hover AND `:focus-within` (keyboard parity). First build had the panel `display:none` as an INLINE style, which outranks the `:hover` rule — the panel never opened (browser-verified failure). Fixed by moving both states into `globals.css` (`{display:none}` base, `display:block` on hover/focus-within); re-verified in the browser: hover → `display:block` with the 5 registered child routes, focus → same.
- `MegaMenuSection`/`MegaMenuEntry` types live in `ui/site-nav.ts` (client-safe nav module); the server shaper imports them, the client navbar never touches the server registry.

### i18n en/id/zh (cookie-persisted, `fc-locale`)

- Layer: `src/lib/i18n/` — `en.ts` (canonical, typed `Dictionary`), `id.ts`/`zh.ts` (`Partial<Dictionary>`), `translate.ts` (pure `t()`: no JSX, no context, no `'use client'` — importable from server AND client), `t.tsx` (client: `LocaleContext`/`LocaleProvider`/`useT`), `server.ts` (`requestLocale`/`tServer` via cookies).
- 1054 keys × 3 locales, key sets identical, zero duplicate keys, interpolation tokens `{var}` identical per key across locales (script-verified).
- Migration: all board surfaces — market (6 files, 51 keys), dex (5 files, 58), overview (6 files, 79), economy (9 files, 232), crypto families (10 files), route chrome (error/loading/not-found/breadcrumb/navbar/theme-toggle) — run as 5 parallel sub-agents under one written contract, then a one-pass dictionary merge by the parent (the mid-flight duplicate-key collision was caught by `tsc` TS1117 and the parity script, deduped keeping runtime-last semantics).
- Build/runtime pitfalls found and fixed (each reproduced, then re-verified): (1) `LocaleProvider` in a server module graph → Turbopack rejected `createContext`; adding `'use client'` to `t.tsx` then broke `not-found.tsx`/`loading.tsx` (`t is on the client` 500 at runtime — build was green). Resolution: the pure-core split (`translate.ts`) above; server shells call `tServer`, client surfaces call `useT`. (2) `gasOracle` interpolation var (`{block}` vs `{n}`) diverged between en and id/zh → unified on `{n}` with the call site.
- Live verification: /market/trench rendered in en/id/zh with the locale switcher (nav labels, table headers, board titles, hints all translated; numbers/tickers untouched), 404 route renders translated shell, journal clean after restart.

### Test-runner fix

- `bunfig.toml` now preloads `tests/preload.ts` for EVERY `bun test` invocation; before, only the `test:shapers` script passed the preload, so a bare `bun test tests/routing-tests.ts` failed on the `server-only` guard instead of the test. Verified both entries green.

## 2026-10-13 — Turn 3: structure validation + bottleneck scan + rewrite assessment

### Folder-structure validation

- `check-structure.py` green: 454 files, layers app(122) features(226) ui(49) lib(37) server(9) cms(10). One rule amendment (documented in the gate comment): `ui/` may import `lib/i18n` alongside `ui/`+`styles/` — chrome strings are part of presentation, same family as the pre-existing `site-nav` exception.
- Web tree: 64,933 lines / 455 files; top sizes are data files (dictionaries 1,115 lines each) and single-board pages (`breadth/ui.tsx` 842) — no logic bag.

### Bottleneck scan (measured)

- Sidecar API: `/api/v1/dex/pools?limit=5` 5.7ms, `/venues` 2.6ms, `/chains` 2.5ms (loopback, warm) — comfortably inside the <100ms bar.
- Page weight (/market/trench, 11 scripts): 815 KB raw total; the largest non-framework chunk (208 KB raw / 57 KB gzip) is 97% the three i18n dictionaries shipping to the client.
- HTML shell: 43ms, 35 KB.
- Frontend full-load + caching picture: Turn 2b section above (shell <20ms on all sampled pages; the only 1-3s costs are documented first-call upstream cold starts, warm medians 9-46ms).

### Rewrite assessment (Go/Rust) — only where measured

- `apps/data/main.go` (1,808 lines, 27 funcs: ~25 HTTP handlers + retry/env helpers) is the top structure candidate. Rewriting or extracting it is **rejected for this iteration**: no measured bottleneck (handlers answer in single-digit ms), tests pin the retry policy (`main_retry_test.go`), and the split would move package-main tests + fakes for zero observable gain. Revisit only if a profile shows it.
- Executor/Go services: no hot path exceeded its budget in the Turn 1 re-benchmark; no rewrite warranted.
- The dictionary client bundle (57 KB gzip, cached once) was considered for a per-locale split and **rejected**: `t()` must stay synchronous in render, and a dynamic-per-locale design would fork that contract for a one-time 57 KB cache.

### Verdict

Structure gates all green (structure/tokens/design-system/tests/tsc), the i18n layer is a real lib with typed keys and full parity, and the scan found no Go/Rust rewrite candidate that a measurement supports. The open question remains /signals' 3.1 MB wave (documented in Turn 2b, out of this turn's scope).

## 2026-10-13 — Turn 2d/3b: live outage found and fixed (DYNAMIC_SERVER_USAGE + cache regression)

### What broke, and how it was found

The Turn 2c claim "live verified in 3 locales" was **not** sufficient, and the next probe caught a live regression caused by this session's own work:

- 6 param routes returned **HTTP 500 with `digest: 'DYNAMIC_SERVER_USAGE'`** — `/market/crypto/BTC`, `/trade/spot/btc-usdt`, `/trade/spot/btc-usdt`, `/economy/nation/USA`, `/economy/central-bank/fed`, `/economy/indicator/cpi`.
- Every HTML page served **`Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`**, where Turn 2b had pinned `s-maxage=300, stale-while-revalidate=31535700` for public HTML.

### Root cause

`RootLayout` was made `async` and read the locale with `await requestLocale()` → `cookies()` (a **Dynamic API**). That taints the whole subtree: any child that still declared ISR (`generateStaticParams` + `dynamicParams`) contradicted it and Next failed the render with `DYNAMIC_SERVER_USAGE`. The 6 pages' own comments stated the mechanism correctly ("every route under it is request-time by construction") — they were treating the symptom, not the cause.

### Fix (one change, upstream)

`RootLayout` is now **synchronous**. The locale is **client state** owned once by `<LocaleProvider>`:

- `src/lib/i18n/t.tsx` — `LocaleProvider` owns the single `useState`; it provides `LocaleContext` + `LocaleSetContext`; `useT()` reads the locale context; `useLocale()` returns `[locale, cookie-writing setter]`.
- `src/lib/i18n/translate.ts` — pure `t()` (no JSX, no context, no `'use client'`), importable from server and client.
- `src/app/(frontend)/layout.tsx` — `lang={DEFAULT_LOCALE}`; a pre-hydration inline script rewrites `document.documentElement.lang` from the `fc-locale` cookie, mirroring the theme toggle's existing script.
- The switcher writes the cookie + updates state directly (`setLocale`); no `router.refresh`, no server round trip.

### The 6 pages: ISR restored

The force-dynamic blocks were removed and replaced with the shape `/blog/[slug]` has used since before this session:

```
export async function generateStaticParams() { return []; }
export const dynamicParams = true;
export const revalidate = 300;
```

### Test contract updated

`tests/server-cache-tests.ts` was a session artifact (untracked, not in HEAD) that asserted the *broken* state. It now asserts the restored contract:

- `REQUEST_TIME_PAGES` back to the four genuine request-time pages (`/`, `/login`, `/member`, `/trade/accounts`).
- `detail routes: on-demand ISR is declared so a valid slug is not request-time` — the 6 leaves must declare `generateStaticParams`, `dynamicParams = true`, `revalidate = 300`, and must not be `force-dynamic`.

### Verified after the fix (all live, all re-measured)

| route | HTTP | Cache-Control |
|---|---|---|
| `/market/crypto/BTC` | 200 | `s-maxage=300, stale-while-revalidate=31535700` |
| `/trade/spot/btc-usdt` | 200 | `s-maxage=300, …` |
| `/economy/nation/USA` | 200 | `s-maxage=300, …` |
| `/economy/central-bank/fed` | 200 | `s-maxage=300, …` |
| `/economy/indicator/cpi` | 200 | `s-maxage=300, …` |
| `/market/trench` | 200 | `s-maxage=300, …` |
| `/economy` | 200 | `s-maxage=300, …` |
| `/screener` | 200 | `s-maxage=300, …` |
| `/` | 200 | `private, no-cache, no-store, max-age=0` (unchanged, correct) |

- `bun run test:shapers` → **486 pass, 0 fail** (34 files).
- `bunx tsc --noEmit` → 0 errors.
- Browser: locale switcher id → zh re-renders the chrome in place (nav labels, board title, table headers all translate; numbers/tickers untouched); `lang` attribute follows the cookie via the pre-hydration script.

### Lesson recorded

A claim of "live verified in N locales" is only as strong as the routes it probed. The param routes were never probed until the outage was already live. Re-verification must include the dynamic family, not only the static shells.
