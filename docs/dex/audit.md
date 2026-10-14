# DEX Data Platform — Repository Audit (Phase 0)

Read-only audit of `/home/dwizzy/fudcourt` ahead of the DEX Data Platform build. No code was
changed. Every claim below carries `file:line` evidence gathered on 2026-10-12.

**Headline finding: the plan's target architecture is ~70% already built, under different names.**
The repo already owns a frozen canonical contract (`internal/canon`), a full ingestion engine with
per-provider rate limiting, circuit breaking, exponential backoff and dead-lettering
(`internal/ingest`), a pgx canon store with per-row validation (`internal/ingest/repo`), a Valkey
L2 cache (`platform/cache`), a derived-metrics engine (`internal/derive`), and **seven
DEX-adjacent provider adapters** (`coingecko`, `dexscreener`, `geckoterminal`, `defillama`,
`etherscan`, `blockscout`, `dune`).

Per plan §38 ("Sesuaikan dengan struktur aktual repo; jangan memaksakan tree ini jika Fudcourt
sudah memiliki boundaries setara"), the DEX subsystem is built **inside** these existing
boundaries. The plan's `backend/internal/dex/...` tree is NOT created.

---

## 1. Existing reusable modules

### 1.1 Canonical contract — `apps/data/internal/canon/` (FROZEN, do not fork)

| File | What it owns |
|---|---|
| `ids.go` | `MintID(kind, naturalKey)` = `kind + ":" + hex(sha256(salt 0x00 kind 0x00 naturalKey))[:10]`, salt `fudcourt/canonical-reference/v1` (`ids.go:55`), 10 hex digits (`ids.go:60`). Pure function — no clock, no randomness, no map order. Natural-key builders: `AssetKey`, `TokenKey`, `ChainKey`, `VenueKey`, `ProtocolKey`, `SeriesKey`, `CountryKey`, `CurrencyKey`, `ArticleKey`, `PoolKey`, `PredictKey`, `InstrumentKey`. |
| `types.go` | Canonical structs: `Asset`, `Token`, `Chain`, `Venue`, `Instrument`, `Protocol`, `Country`, `Currency`, `Article`, `PredictionMarket`, `ProviderSymbol`, `Ohlcv`, `Trade`, `Quote`, `OrderbookSnap`, `Ticker`, `FundingRate`, `OpenInterest`, `Liquidation`, `OptionQuote`, `Observation`, `SeriesMeta`, `ProtocolTVL`, `ChainTVL`, `Pool`, `SupplySnapshot`, `MetricPoint`. |
| `api.go` | `Doer` (`:35-37`), `RunRecord` (`:42-56`), `Writer` (`:63-89`, 24 methods), `Reader` (`:95-136`, 30 methods), `ErrUnknownSymbol` (`:141`). |
| `versions.go` | `SchemaVersion = "1.1.0"`, `NormalizationVersion = "1.0.0"` (`:10`, `:13`). |

**Relevance to the plan.** Plan §5 asks for `eip155:1` / `solana:mainnet` / `eip155:1:0x…` id
spellings. The repo's rule is **opaque hashes**, deliberately: `ids.go:20-22` — "A minted id is
OPAQUE: consumers never parse it and never read a symbol out of it; the natural key that produced
it is the readable part and is carried alongside the id wherever an entity is written."

**Decision: keep the repo's opaque-id rule.** The plan's stated *goal* — "USDC Ethereum / USDC
Base / USDC Solana tidak pernah dianggap asset yang sama secara tidak sengigal" — is already
satisfied and more strongly than the plan's own spelling: `TokenKey(chainName, address)`
(`ids.go:157-159`) and `PoolKey(chainName, address)` (`ids.go:208-210`) put the chain in the
natural key, and `data.token` carries `UNIQUE (chain_id, address)`
(`db/schema/data-schema.sql:79-86`). Cross-chain token collision is structurally impossible.
Switching to readable `eip155:1:0x…` ids would break `contracts/data/reference.json` parity with
`apps/api/internal/markets/reference` (pinned by `canon/parity_test.go` and the
`go run ./apps/api/internal/markets/reference/cmd/emit -check` gate in `verify-all.sh:77`) for
zero consumer benefit. **This is a deliberate, documented deviation from plan §5's spelling, not
an omission.**

### 1.2 Ingestion engine — `apps/data/internal/ingest/`

| Concern | Status | Evidence |
|---|---|---|
| Scheduler | **Built.** DB-driven: `DueJobs` = `SELECT … WHERE enabled AND status <> 'running' AND (last_attempt IS NULL OR last_attempt + make_interval(secs => schedule_seconds) <= $2) ORDER BY priority, last_attempt NULLS FIRST` | `jobstore.go:84-102` |
| Worker pool | **Built.** Bounded, default 4, `FUDCOURT_DATA_INGEST_WORKERS` | `engine.go:323-341`, `main.go:528` |
| Rate limiter | **Built.** Per-provider lazy token bucket, burst default 5, `Config.ProviderBurst` override | `engine.go:504-542` |
| Circuit breaker | **Built.** Per-provider `CLOSED/OPEN/HALF_OPEN`, threshold 5 consecutive failures, 60s half-open cooldown, one probe at a time | `engine.go:550-623` |
| Retry / backoff | **Built.** `2s * 2^attempt`, cap 5m, overflow-safe | `engine.go:482-497` |
| Dead letter | **Built.** `data.ingestion_error` on backoff cap or recovered panic | `engine.go:419-427`, `journal.go:63-81` |
| Panic containment | **Built.** Per-job `recover()` → `panicError` → dead letter | `engine.go:366-375`, `:439-441` |
| Run journal | **Built.** One `data.ingestion_run` row per attempt with rows_in/written/rejected/error/attempt | `journal.go:25-56` |
| Retention sweeps | **Built.** Per-dataset TTL windows, 6h cadence, `FUDCOURT_DATA_RETENTION_JSON` overrides | `retention.go:34-263`, `engine.go:196` |
| Job registry | **Built.** `data.job` with `UNIQUE (provider, dataset, subject, mode)`; `EnsureJobs` upserts schedule/priority/enabled and **preserves runtime state** (cursor, last_success, retry_count) | `data-schema.sql:289-318`, `interfaces.go:102-113` |
| Cursor round-trip | **Built.** `Cursor map[string]any` persisted as jsonb, returned as `FetchResult.Next` | `interfaces.go:34`, `:58-64`, `jobstore.go:137-154` |
| Valkey hot cache | **Built.** L1 (in-process) → L2 (Valkey) → upstream, **fails open at every step** | `platform/cache/cache.go:1-16`, `:107-145` |

**Plan §14 (ingestion infra), §16 (cache), §19 (reliability), §35 (circuit breaker) are already
satisfied.** The plan's `poller/stream/backfill/checkpoint` sub-packages are not needed as
separate packages: polling is `Mode: "poll"`, backfill is `Mode: "backfill"` (cursor-driven, same
dispatch gate), and the checkpoint is `data.job.cursor`.

### 1.3 Canon store — `apps/data/internal/ingest/repo/`

- `Repo` is one struct over one `Executor` interface (`repo.go:21-33`); `New(pool)` (`:36`).
- **Per-row validation is pure functions** returning `(reject, warn)`; rejects are counted and
  dropped, warns are written (`validate.go:11-16`). NaN/Inf rejected everywhere; negative
  volume/price/quantity rejected; broken OHLC ordering rejected; zero timestamps rejected;
  timestamps > now+5m rejected (`validate.go:31`, `:35-73`).
- `clampLimit`: `<=0 → 100`, `>1000 → 1000` (`repo.go:57-65`).
- Windowed reads are `ORDER BY <time> DESC` then reversed to ASC (`reader.go:24-46`) — **a limit
  window keeps the NEWEST N rows**. Backfill must advance an explicit cursor.
- `WriteMetric` is all-or-nothing per call and `validateMetricPoint` rejects non-nil NaN/Inf
  (`validate.go:521-533`, `facts.go:410-442`).

### 1.4 Derived metrics — `apps/data/internal/derive/`

Complete pure engine, **zero production importers before this work**:
`Registry`/`Processor`/`MetricSpec`/`Pipeline` (`pipeline.go:154-260`), `DefaultProcessors()` =
SMA/EMA/RSI/MACD/BollingerBands/ATR/Stochastic/ADX/OBV/VWAP/Supertrend/Ichimoku/log+simple
returns/rolling vol/corr/zscore/percentile/sharpe/sortino/momentum (`processors.go`).
`Pipeline.RunPoints` is the multi-source entry point that accepts points the caller already holds
(`pipeline.go:205-246`) — exactly what a DEX derived metric needs. NaN→nil mapping is already
correct (`pipeline.go:36-59`).

### 1.5 Existing DEX-adjacent providers

| Provider | Datasets | Endpoints | Writes | Key |
|---|---|---|---|---|
| `coingecko` | markets, global, market-chart | `/coins/markets`, `/global`, `/coins/{id}/market_chart` | Assets, ProviderSymbols, Observations | keyless |
| `dexscreener` | pools | `/token-pairs/v1/{chain}/{token}`, `/latest/dex/pairs/{chain}/{pair}`, `/latest/dex/search` | Chains, Venues, **Pools** | keyless |
| `geckoterminal` | pools | `/networks/{network}/pools/{address}` | Chains, Venues, **Pools** | keyless |
| `defillama` | protocols-tvl, chains-tvl, protocol-history | `/protocols`, `/v2/chains`, `/protocol/{slug}` | Protocols, ProtocolTVL, Chains, ChainTVL | keyless |
| `etherscan` | supply, gas | `/v2/api?module=stats&action=ethsupply`, `gastracker/gasoracle` | Supply, Series, Metric | `ETHERSCAN_API_KEY` |
| `blockscout` | stats | `{instance}/api/v2/stats` | Series, Metric | keyless |
| `dune` | query | `/query/{id}/results` | Series, Metric | `DUNE_API_KEY` |

All seven follow one identical shape (`module.go` + `client.go` + `<dataset>.go` + `doc.go` +
`<pkg>_test.go`), all take `canon.Doer` for offline tests, all use inline Go-const fixtures (no
`testdata/` dirs), all emit package-local `HardError{Kind: transport|status|shape|api-error|no-credentials}`,
and all are registered in the single literal `buildDataModules()` (`main.go:340-364`).

**The universal module template is `geckoterminal/module.go`** — smallest complete example.

---

## 2. Deprecated / duplicate adapters

**None deprecated.** No duplicate adapters: each provider package owns exactly one upstream, and
no provider package imports another (`data-platform-guide.md:70-71`).

One **near-duplicate worth noting**: `dexscreener` and `geckoterminal` both write `canon.Pool`
snapshots for overlapping pools (both seed a SOL/USDT pool — `dexscreener/module.go:98`,
`geckoterminal/module.go:95`). This is not a bug: it is exactly the multi-source input the
reconciler needs. They mint the **same** `pool_id` for the same `(chain, address)` because both go
through `canon.PoolKey`, so their rows land in one `data.pool` series distinguished by `source`.

---

## 3. Missing infrastructure (the real work)

| # | Gap | Plan § | Evidence |
|---|---|---|---|
| G1 | **No DEX swap/candle/liquidity/route/wallet/perp/orderbook/risk/MEV tables or canon types.** `data.pool` is snapshot-only (`PK (pool_id, at)`); there is no per-pool OHLCV, no swap event table, no route quote table. | §4, §12 | `data-schema.sql:524-552`; `canon/types.go` has no `Swap`/`Candle`/`RouteQuote`/`LiquidityPosition`/`MEVEvent`/`PerpMarket`/`OrderbookSnapshot`-for-DEX type |
| G2 | **No cross-provider reconciliation.** `data.provider_symbol` maps *identities* only — no value agreement, no consensus, no outlier detection. | §24, §25 | `data-schema.sql:248-269`; `reader.go:735-749` |
| G3 | **No confidence scoring.** The only `confidence` in the tree is a pass-through string in the DeFiLlama coins family. | §25 | `research/llama/fetch.go:676-677` |
| G4 | **No provider health/latency/error-rate recorder.** `data.provider_source` exists but is **write-dead** (never inserted, never read). `/api/data/health` returns only `{ok, db, runs, providers, schema_version, normalization_version}`. | §34, §58 | `data-schema.sql:272-281`; `serve.go:793-819` |
| G5 | **No rate-limit budgeting.** Limiter rate is hardcoded 5 rps; `main.go:529-532` passes only `Workers` and `Once`, so `ProviderBurst`/`BreakerThreshold`/`BreakerCooldown` are never set in production. No quota, no daily cap, no cost model. | §57 | `engine.go:538`, `main.go:529-532` |
| G6 | **No raw-observation retention tier.** `data.observation` is permanent by design; there is no HOT/WARM/COLD tiering and no raw-payload table. | §13 | `retention.go:34-41` |
| G7 | **No streaming/WebSocket.** Zero `websocket` matches in `apps/data/**/*.go`; no WS lib in `go.mod`. `Mode: "stream"` is a faster REST ticker via `NextRunHint`, not a socket. | §14 | `engine.go:86-91`, `:391-395` |
| G8 | **No shared backfill cursor contract.** Each fetcher invents its own cursor keys (`since_ms`, `start`/`end`, `offset`/`year`, `query_id`). No page budget, no window-advance helper, no completion state. | §14, §48 | `binance/module.go:29-83`, `bybit/klines.go:455-460`, `cftc_test.go:307` |
| G9 | **No discovery engine, no activity-based scheduling.** Every pool is polled at a fixed 5m regardless of activity. | §27, §28 | `dexscreener/module.go:94-108` |
| G10 | **No quality engine.** Validators reject bad rows at write time but nothing detects *stale*, *conflicting*, *missing-candle*, *duplicate-swap*, *broken-decimals*, *wrong-token-mapping*, *chain-mismatch*, *impossible-liquidity* conditions across the store. | §32 | `validate.go` is per-row only |
| G11 | **Frontend has a direct provider dependency.** `apps/web/src/app/(frontend)/api/dex/route.ts` is a **live DexScreener proxy** — it builds `api.dexscreener.com` URLs itself, validates mints, and flattens provider envelopes. `apps/web/src/features/market/dex/client.ts:11` hardcodes `DEX = 'https://api.dexscreener.com'`. This is the plan's §65 anti-goal ("query provider langsung dari frontend") and §60's first Definition-of-Done item. | §47, §60, §65 | `(frontend)/api/dex/route.ts:1-314`, `features/market/dex/client.ts:11` |
| G12 | **No `/api/v1/dex/*` surface.** The sidecar serves `/api/data/*`; the web gateway allowlists `dex` as a `data` subpath (`(frontend)/api/[...path]/route.ts:112`) but the sidecar only registers `/dex/pools`. | §30 | `serve.go:230`; `route.ts:97-115` |
| G13 | **No precision policy.** Every money/price/quantity column is `double precision` and every canon field is `float64`/`*float64`. No `big.Rat`, no `numeric`, no `json.Number`/`UseNumber()` anywhere in `apps/data/internal`. | §54 | `data-schema.sql:32-33`; `repo/validate.go` |
| G14 | **No metrics emission.** Zero prometheus/expvar/statsd in `apps/data`. Observability is DB rows only. | §59 | grep across `apps/data/internal/ingest` |

---

## 4. Recommended reuse

| Plan component | Build as | Reuse |
|---|---|---|
| Canonical contracts (§10) | **Extend** `canon/types.go` + `canon/api.go` with DEX types (`Swap`, `Candle`, `LiquiditySnapshot`, `RouteQuote`, `LiquidityPosition`, `WalletActivity`, `MEVEvent`, `PerpMarket`, `FundingSnapshot`, `OrderbookSnapshot`, `RiskMetric`, `ProviderObservation`, `IngestionCheckpoint`) and matching `Writer`/`Reader` methods | `canon.MintID`, `canon.PoolKey`, `canon.TokenKey`, `canon.ChainKey`, `canon.VenueKey`, `canon.ProtocolKey` |
| Provider capability contract (§11) | **New** `internal/dexcap` package: capability interfaces (`TokenProvider`, `PoolProvider`, `PriceProvider`, `SwapProvider`, `CandleProvider`, `LiquidityProvider`, `ProtocolMetricProvider`, `WalletProvider`, `RoutingProvider`, `RiskProvider`, `PerpProvider`, `OrderbookProvider`) + a `Provider` descriptor (name, capabilities, chains, auth, limits, realtime, historical, priority, cost, health) | `ingest.Module` stays the engine-facing contract; `dexcap` is the *capability* view layered on top |
| Storage (§12) | **Extend** `apps/data/internal/ingest/schema.sql` (sole DDL owner) with new numbered sections; bump `canon.SchemaVersion` | existing hypertable + named-constraint + DO-block conventions |
| Ingestion infra (§14) | **Reuse as-is.** Add a shared cursor helper package for G8 | `engine.go`, `jobstore.go`, `interfaces.go` |
| Cache (§16) | **Reuse as-is.** Add `dex:` key helpers over `cache.Get/Set` | `platform/cache` |
| Reliability (§19, §35) | **Reuse as-is.** Add a health recorder for G4 and per-provider config for G5 | `engine.go:504-623` |
| Reconciler (§24) | **New** `internal/dexrecon` | `canon.Reader` for multi-source reads |
| Confidence (§25) | **New** `internal/dexrecon` | — |
| Derived (§26) | **Wire** the existing `internal/derive` engine + new DEX processors | `derive.Pipeline.RunPoints`, `DefaultProcessors()` |
| Discovery (§27) | **New** `internal/ingest/providers/discovery` | `ingest.Module` |
| Quality (§32) | **New** `internal/dexquality` | `canon.Reader` |
| API (§30) | **Extend** `serve/routeMux` with `/dex/*` routes | `serve.go` handler helpers (`handleList`, `limitParam`, `window`, `writeData`, `writeErr`) |
| Frontend migration (§47) | **Rewrite** `(frontend)/api/dex/route.ts` into a thin canonical proxy | existing gateway `forwardDataFamily` already forwards the pathname remainder correctly (`route.ts:149-175`) |

---

## 5. Migration risks

| Risk | Severity | Mitigation |
|---|---|---|
| **R1 — Schema census is pinned by exact counts.** `TestSplitStatementsRealSchema` asserts `CREATE TABLE IF NOT EXISTS data.` == 30, `create_hypertable(` == 14, `CREATE INDEX IF NOT EXISTS` == 11, `CREATE UNIQUE INDEX IF NOT EXISTS` == 1. Adding DEX tables **breaks this test**. | **High** | Update the pinned counts in `schema_test.go:79-90` as part of the schema change. This is a legitimate test update (the census is a drift guard, not a behavior pin) — **never** weaken the assertions to make them pass. |
| **R2 — Embedded schema must stay byte-identical.** `TestEmbeddedSchemaMatchesTracked` compares `apps/data/internal/ingest/schema.sql` to `db/schema/data-schema.sql` byte-for-byte, including comments. | **High** | Edit `apps/data/internal/ingest/schema.sql` (sole owner), then copy to `db/schema/data-schema.sql`. Verify with `go test ./apps/data/internal/ingest/ -run TestEmbeddedSchemaMatchesTracked`. |
| **R3 — Widening `canon.Reader`/`canon.Writer` breaks 4 implementers.** `repo.Repo` (`reader.go`), `main.go unavailableReader` (`main.go:395-495`), `serve.go failingWriter` (`serve.go:840-936`), plus test fakes in `derive/pipeline_test.go` and `ingest/serve/helpers_test.go`. | **High** | Every new `Writer`/`Reader` method must be added to all four. Mechanical but easy to miss one; `go build ./...` catches it. |
| **R4 — `data.pool` PK is `(pool_id, at)` with `UNIQUE (chain_id, address, at)`.** A pool re-keyed between polls can coexist with its old-id row for the same `(chain, address, at)`. | Medium | DEX pool identity must be deterministic from `(chain, protocol, address)` so re-keying cannot happen. New DEX tables use the plan §15 deterministic keys. |
| **R5 — `clampLimit` 0→100 and DESC-then-reverse reads.** A naive backfill with `limit` silently keeps only the newest N rows. | Medium | Backfill must advance an explicit window cursor and assert the row count at the boundary (fail loud on partial history). |
| **R6 — `WriteMetric` all-or-nothing + NaN rejection.** A single non-nil NaN in a derived batch fails the whole call. | Medium | `derive` already maps NaN→nil (`pipeline.go:36-59`). New DEX processors must reuse `floatsToPoints`, never hand-roll. |
| **R7 — Frontend `/api/dex` rewrite is consumer-visible.** `features/market/dex/{ui.tsx,ui-board.tsx,ui-pairs.tsx,trench.tsx}` consume `DexPair`/`DexProfile` shapes directly. | **High** | The rewrite must preserve the UI's rendered fields or update the UI in the same change. `scripts/verify/verify-dex.py` (504 lines, live harness) asserts the **current** proxy contract — it will need a companion canonical harness, and the old one retired deliberately, not silently. |
| **R8 — `check-api-contract.py` only covers `apps/api` routes.** It reads `apps/api/main.go` `HandleFunc` and `contracts/openapi/fudcourt.yaml`. New `/api/data/dex/*` sidecar routes are **not** gated by it. | Low | No action needed, but do not assume the gate covers the sidecar. |
| **R9 — `check-doc-citations.mjs` resolves cited repo paths.** Any new doc under the `DOCS` list must have resolvable citations. | Low | New docs go in `docs/dex/`; cite only real paths. |
| **R10 — `check-schemas.mjs` requires README↔disk parity** for `contracts/schemas/`. Adding a schema file without indexing it fails the gate. | Low | If DEX schemas are added, index them in `contracts/schemas/README.md` §2.2 in the same change. |
| **R11 — No API keys for premium providers.** Bitquery, The Graph, Helius, Jupiter, Birdeye, 0x, 1inch, Subsquid, GoldRush, Kaiko, Amberdata all need credentials. | Medium | Follow the `etherscan`/`dune` pattern exactly: read the key once in `newClient`, `HardError{Kind: "no-credentials"}` before any request, `Jobs()` seeds `Enabled: m.HasCredentials()`. Build and full test suite must stay green with zero credentials. |
| **R12 — `verify-all.sh` step ordering.** `check-deploy.py` MUST run after `cargo build` (the two Rust units carry no `ExecStartPre=go build`). | Low | Always run `bash scripts/verify/verify-all.sh` as one command; never run `check-deploy.py` standalone on a clean checkout. |

---

## 6. Phase 0 deliverables

- [x] Repo map — §1 above
- [x] Existing data map — §1.5 above
- [x] Reuse decisions — §4 above
- [x] Migration risks — §5 above
- [x] No major code changes — confirmed, this audit is read-only

**Barrier 1 (plan §40) is satisfied**: the canonical contract already exists and is frozen
(`canon`), the storage schema exists and is versioned (`canon.SchemaVersion`), and the provider
interface exists and is frozen (`ingest.Module`/`Fetcher`). Provider work may proceed against
these contracts. The DEX-specific *additions* to the contract (new canon types, new tables, new
capability interfaces) are Phase 1 work owned by a single agent, per plan §51.

---

## 7. Phase 1 freeze decisions (made against the plan, deviation noted)

| Decision | Choice | Rationale |
|---|---|---|
| **API path** | Implement plan §2/§30's **`/api/v1/dex/*`** verbatim, as a NEW surface on the sidecar. Keep the existing `/api/data/dex/pools` exactly as-is (a documented legacy alias, not a fork: both read the same `data.pool` through `canon.Reader.ListPools`). | Plan §2 spells `/api/v1/dex/...` explicitly and forbids provider-named routes. `/api/v1/dex/*` is the canonical surface; `/api/data/dex/pools` predates this work and stays for its existing consumer. |
| **Precision** | New DEX canon types carry token amounts as `TokenAmount{Raw *big.Int, Decimals int}` (exact) and prices/liquidity/USD as `Dec` (exact decimal string). **No `float64` in any new DEX type.** | Plan §54 + §65 anti-goal ("use floats untuk token balances"). Existing non-DEX types keep `float64`: retrofitting them is out of scope and would break the frozen parity contract. |
| **Provider JSON decoding** | Every new DEX adapter decodes with `json.Decoder.UseNumber()` so an upstream decimal reaches `Dec` as its literal digits, never through a `float64`. | Without it, `4001.20` is already lossy before `Dec` sees it. |
| **Storage** | Extend the sole DDL owner `apps/data/internal/ingest/schema.sql` **additively** (new numbered sections), copy to `db/schema/data-schema.sql`, bump `canon.SchemaVersion`. | `docs/architecture/data-platform-guide.md:110-114` prescribes exactly this for a new fact table; a second `dex-schema.sql` would mean a second applier and two sources of truth for one Postgres. |
| **ID spelling** | Keep the repo's opaque `MintID` output; do NOT adopt plan §5's readable `eip155:1:…` spelling. | §1.1 above: the chain is already in the natural key, so cross-chain safety holds, and switching would break the parity-pinned reference artifact. |

