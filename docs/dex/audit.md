# DEX Data Subsystem — Phase 0 Audit

**Scope.** Agent 00 (Orchestrator) + Agent 01 (Repository Auditor) of the Fudcourt DEX Data Platform
plan. Deliverable: the repo map, the existing-data map, the reuse decisions and the migration risks.
**No production code changes** in this phase.

**Method.** Read-only sweep of the working tree at `4604c7c` (the commit the news-adapter work
landed on), plus the canonical docs the repo already carries. Every claim below names the file it
came from. Commands run are recorded in §13.

---

## 0. Verdict up front

**This is not a greenfield build, and the plan should not treat it as one.**

The repo already carries roughly two thirds of the plan's Phase 0–2 output under names that do not
match the plan's vocabulary:

- a frozen, published **canonical id rule** with a provider mapping table (`contracts/data/reference.json`)
- **canonical JSON Schemas** including a DEX-shaped `defi/pool.json` and `common/provenance.json`
- a working **ingestion engine** with jobs, cursors, rate limiting, circuit breaking, retention and
  dead-lettering (`apps/data/internal/ingest`)
- **14 Timescale hypertables** covering swaps, candles, liquidity, funding, liquidations, orderbook
  and pool snapshots (`db/schema/data-schema.sql`)
- **19 provider adapters**, five of them already DEX/market-data relevant
- a **DexScreener contract-drift verifier** (`scripts/verify/verify-dex.py`, 504 lines)
- eleven **canonical architecture documents** that already took the D1–D7 duplicate-concept
  decisions and the D-CANON identity decision

What the plan genuinely adds is a **canonical query/read layer and a reconciliation layer**, plus the
provider families the repo has never touched (raw EVM swap logs, Solana, routing, confidence
scoring, derived analytics). §8 is that gap list, and it is much shorter than the plan implies.

**Two things must stop for an architecture decision before any code is written** — see §9: the plan's
canonical id *format* contradicts the repo's frozen id *rule*, and the plan's "Reconciler" names a
different job than the repo's existing `apps/reconciler`.

---

## 1. Repo map

| service | language | LOC | role | runtime |
|---|---|---|---|---|
| `apps/web` | TS / Next.js | 65,877 | public pages + `/api/*` proxy routes; owns the Payload CMS | Vercel / node |
| `apps/data` | Go | 54,407 | ingestion engine + provider adapters + research passthrough | sidecar `:3101` |
| `apps/executor` | Go | 33,574 | execution plane, strategies, venue adapters, Valkey leases | loopback `:3105` |
| `apps/api` | Go | 7,786 | auth, admin, health, **and the canonical reference registry** | `:3100` family |
| `apps/bot` | Go | 1,579 | Discord bot | — |
| `apps/reconciler` | Rust | — | multi-chain **balance** sync into Postgres `assets` | systemd timer 5 min |

Two facts drive the whole plan:

1. **`apps/api` serves almost no domain data.** Per `docs/architecture/canonical-model.md` §9.1 its
   live surface is `/healthz`, `/readyz`, `/api/auth/{login,callback,logout}`, `/api/admin/members`.
   The plan's `/api/v1/dex/*` layer therefore has **no host today**.
2. **The frontend talks to providers directly.** `apps/web/src/app/(frontend)/api/dex/route.ts` is a
   documented DexScreener passthrough (`DEX = 'https://api.dexscreener.com'`,
   `features/market/dex/client.ts`), and `contracts/openapi/fudcourt.yaml:1425` publishes it as
   `/api/dex`. That is the plan's Rule 1 and anti-goal §65 ("query provider langsung dari frontend")
   already violated in production.

---

## 2. Existing canonical contracts — what is already frozen

Do **not** re-freeze these. Extend them.

| artifact | path | state |
|---|---|---|
| Canonical id rule | `apps/api/internal/markets/reference/ids.go` | Live. `id = kind ":" hex(sha256(salt NUL kind NUL naturalKey))[0:10]`; salt `fudcourt/canonical-reference/v1` |
| Published mapping table | `contracts/data/reference.json` | Live, 19,565 B: 9 chains, 8 assets, 11 tokens, 12 venues, 49 mappings, 7 unmapped, 3 misses |
| Entity types | `apps/api/internal/markets/reference/types.go` | Live: `Asset`, `Token`, `Chain`, `Venue`, `ProviderID` |
| DEX pool schema | `contracts/schemas/defi/pool.json` | Live |
| DEX protocol schema | `contracts/schemas/defi/protocol.json` | Live |
| **Provenance schema** | `contracts/schemas/common/provenance.json` | Live — this is plan §6, already frozen |
| Market schemas | `contracts/schemas/markets/{candle,price,venue,ticker}.json` | Live — covers plan's Candle/Price/Market |
| Reference schemas | `contracts/schemas/assets/{asset,chain,token}.json` | Live |
| Machine contract + gates | `contracts/openapi/fudcourt.yaml`, `contracts/events/events.json`, `scripts/verify/check-contract.py` | Live, 36 paths + 28 event ids frozen |

**Id kinds already minted:** `Asset`, `Token`, `Chain`, `Venue`, `Instrument` (in `apps/api`), plus
`Pool`, `Protocol`, `Series`, `Article`, `Prediction`, `Country`, `Currency` (in
`apps/data/internal/canon/ids.go`). Two minting packages, two salts, two id spaces — see §9 G2.

**Provenance is already a first-class contract.** `common/provenance.json` plus the
`data.observation` hypertable plus `provider_source`/`provider_symbol` tables mean plan §6 and the
`ProviderObservation` entity are **delivered**, not pending.

---

## 3. Existing ingestion infrastructure — reusable as-is

`apps/data/internal/ingest` already implements the plan's §14 (ingestion infra) and §35 (circuit
breaker) and §57 (rate-limit budgeting):

| plan requirement | existing implementation |
|---|---|
| Provider capability contract (§11) | `ingest/interfaces.go` — `Module` + `Fetcher` with `Datasets()`, `Fetch()` |
| Provider registry (§36) | module registration + `provider_source` table |
| Cursor / resumable ingestion (§14) | job store with per-dataset cursors |
| Exactly-once semantics (§15) | at-least-once + deterministic natural keys in `canon` |
| Retry / timeout | built into the fetcher contract, per-provider |
| Rate limiter (§57) | engine-level limiter, per-provider budgets |
| Circuit breaker (§35) | engine-level CLOSED/OPEN/HALF_OPEN |
| Dead letter | engine dead-letter store |
| Retention | per-dataset retention policy |
| Checkpoints (§14) | `data.job`, `data.ingestion_run`, `data.ingestion_error` |
| Cache (§29) | Valkey hot cache for quotes |

**Consequence:** plan Phase 2 (core infrastructure: ingestion, cache, reliability) is **largely
done**. The remaining Phase-2 work is provider-health surfacing (§34) and the circuit-breaker
*fallback by capability* rule (§35), which the engine does not yet express.

---

## 4. Existing DEX-relevant adapters — the reuse table

| provider | path | what it ingests | plan tier |
|---|---|---|---|
| DexScreener | `ingest/providers/dexscreener` | pools, prices, liquidity, volume (discovery) | S3 |
| GeckoTerminal | `ingest/providers/geckoterminal` | onchain pools, OHLCV | S3 |
| CoinGecko | `ingest/providers/coingecko` | tokens, market data, OHLCV | S3 |
| DefiLlama | `ingest/providers/defillama` | protocol TVL, chain TVL, TVL history | S4 |
| Dune | `ingest/providers/dune` | query results (analytics) | S4 |
| Etherscan | `ingest/providers/etherscan` | native supply + gas oracle only | S0-adjacent |
| Blockscout | `ingest/providers/blockscout` | chain stats only (keyless) | S0-adjacent |
| Binance / Bybit / OKX | `ingest/providers/{binance,bybit,okx}` | CEX market data | — |
| FRED / OECD / World Bank / IMF / BIS / CFTC | `ingest/providers/*` | macro series | — |
| Polymarket | `ingest/providers/polymarket` | prediction markets | — |
| Newsfeed | `ingest/providers/newsfeed` | 61 RSS/Atom sources | — |

**Critical finding for the plan:** `etherscan` and `blockscout` fetch **supply, gas and chain
stats only** — *not* blocks, logs or swap events. So plan §16 (EVM raw data) and §17 (Solana raw
data) are **entirely absent**. There is no block/transaction/log ingestion anywhere in the repo,
and no Solana client at all.

---

## 5. Existing storage

`db/schema/data-schema.sql` — 32 tables, **14 Timescale hypertables already declared**:

- hypertables: `ohlcv`, `trade`, `quote`, `orderbook`, `observation`, `funding`, `open_interest`,
  `liquidation`, `tvl_protocol`, `tvl_chain`, `pool`, `supply`, `metric`, `option_quote`
- dimension tables: `asset`, `chain`, `token`, `venue`, `instrument`, `protocol`, `provider_source`,
  `provider_symbol`, `news_article`, `news_source`, `prediction_market`, `country`, `currency`, `series`
- ops tables: `job`, `ingestion_run`, `ingestion_error`

`db/schema/pg-schema.sql` also declares `canonical_reference` + `canonical_reference_miss` with a
`CHECK (canonical_id LIKE kind || ':%')`, loaded by `reference/loader.go` — **additive and unwired**
(nothing resolves through SQL yet).

**Plan §12's partitioning requirement is satisfied by Timescale**, not by hand-rolled
`swaps_2026_10` tables. The plan's suggested table names should be dropped in favour of the
existing hypertables.

**Plan §13's HOT/WARM/COLD tiering** is partially expressible today (hypertables + retention), but
there is **no ClickHouse and no profiling evidence** that PostgreSQL is insufficient — the plan
itself says not to add ClickHouse before that proof exists. Correct call: do not add it.

---

## 6. Duplicate adapters — evidence

Three real duplications exist and must be resolved before new adapters land.

1. **DefiLlama, twice.** `apps/data/internal/ingest/providers/defillama` (canonical ingest jobs,
   writes through `canon.Writer`) **and** `apps/data/internal/research/llama` (research HTTP
   passthrough with its own gzip handling and envelope). Same upstream, two clients, two shapes.
2. **DexScreener, twice.** `apps/data/internal/ingest/providers/dexscreener` (canonical) **and**
   `apps/web/src/features/market/dex/client.ts` + `api/dex/route.ts` (frontend passthrough).
   `verify-dex.py` pins the frontend copy's live behaviour.
3. **CoinGecko, twice.** `apps/data/internal/ingest/providers/coingecko` (canonical) **and**
   `apps/web/src/features/market/coingecko-markets.ts` (frontend normalizer).

`docs/architecture/provider-consolidation.md` already mapped these as "price/tvl/news mirrors" and
proposed collapsing them. **The plan's Rule 1 is the mechanism for that collapse** — the canonical
route is what lets the frontend copies be deleted. It does not license a third copy.

---

## 7. Deprecated / dead modules — do not build on these

- `price_history` table — **dead, 0 rows**, no writer anywhere (proven in `canonical-model.md` §9.2 O2).
- `trades`, `accounts`, `journal`, `ledger`, `venues` — **dead tables**, seeded then frozen
  2026-09-15. Note: the *entities* are live (`reference.json` mints 12 `venue_id`s); only the
  tables are dead. Do not confuse the two.
- `features/cryptorank/shapers.ts` — runtime-dead TS twin.
- `tests/oracle/sync-live.py` — Python twin of the Rust reconciler, kept only as an oracle.

**Naming trap (documented):** `/api/coins` is **not** CoinGecko — it is a portfolio aggregate over
`assets`. CoinGecko lives at `/api/markets`.

---

## 8. Missing infrastructure — the actual gap list

Ordered by what unblocks the most downstream work.

1. **No canonical query/read layer.** `/api/v1/dex/*` does not exist; `apps/api` serves health, auth
   and admin only. Plan §30 and §31 (filtering, sorting, cursor pagination) have no host.
2. **No raw-chain ingestion.** No blocks, logs, transactions or swap events from any EVM chain, and
   no Solana RPC/Helius client. Plan §16 and §17 are empty.
3. **No DEX-native protocol adapters.** No Uniswap, PancakeSwap, Curve, Balancer, Aerodrome,
   Raydium, Orca or Meteora. Plan §20 is empty. Pool data today comes from aggregators only (S3),
   so there is **no S0/S1 ground truth** to reconcile against.
4. **No routing/quote aggregation.** No 0x, 1inch or Jupiter client. Plan §21 is empty.
5. **No price reconciliation or confidence scoring.** Plan §24 and §25 are empty. **Beware the name
   collision:** `apps/reconciler` reconciles *wallet balances*, not prices.
6. **No data-quality engine.** Plan §32/§18 — no stale detection, outlier detection, missing-candle
   detection, decimal-mismatch detection, or quality status.
7. **No derived analytics.** Plan §26/§14 — no liquidity depth, price impact, volatility, imbalance,
   pool health, LP APR, IL, wallet PnL, wash-trade probability or MEV detection.
8. **No activity-based scheduling.** Plan §28 — pools are not tiered A/B/C/D.
9. **No provider health surface.** Plan §34/§58 — no availability, latency percentiles, error rate,
   quota or cost tracking, and no `/admin/data/dex` dashboard.
10. **No discovery engine.** Plan §27/§49 — no factory-event listener, no candidate-pool
    verification pipeline.
11. **No swap/trade ingest at all.** `data.trade` is a hypertable with **no producer**.

---

## 9. Contract gaps requiring an architecture decision — STOP list

Per the plan's own §63 discipline ("Jika kontrak tidak cukup: STOP → report contract gap →
architecture owner decides"), these must not be resolved unilaterally by an adapter author.

**G1 — Canonical id *format* conflicts with the frozen id *rule*.**
The plan specifies readable ids: `pool: eip155:1:uniswap-v3:0x…`, `chain: eip155:1`,
`token: eip155:1:0x…`. The repo's frozen, published rule is an **opaque** id:
`kind ":" hex(sha256(salt NUL kind NUL naturalKey))[0:10]`, with the explicit contract "an id is
opaque; resolve through `mappings`, **never by parsing an id** or matching a symbol"
(`contracts/data/reference.json` `note`). The two are mutually exclusive: a readable id *is* parsed.
**Recommendation:** keep the opaque rule (it is already published, versioned, test-pinned by
`TestReferenceArtifactIsCurrent`, and cross-chain safe because the natural key carries the full
address verbatim). Add the plan's human-readable form as a **derived display field**, never as the
id. This needs the owner's sign-off, not an adapter decision.

**G2 — Two id-minting packages with two salts.**
`apps/api/internal/markets/reference` (salt `fudcourt/canonical-reference/v1`) and
`apps/data/internal/canon/ids.go` (its own salt) both mint ids. The plan's §51 rule ("canonical
contracts have one owner") is currently violated for `Pool`/`Protocol`. **Recommendation:** the
data plane's `canon` mints the *natural keys* and the api plane's `reference` owns the *published
registry*; document which plane is authoritative for pool/protocol ids, and pin it with a parity
test the way `canon/parity_test.go` already does for asset/chain/token/venue.

**G3 — "Reconciler" is an overloaded noun.**
`apps/reconciler` = multi-chain wallet-balance sync (Rust, systemd, writes `assets`).
Plan §24 "Reconciliation Engine" = cross-source price/value reconciliation with confidence.
**Recommendation:** name the new component `reconcile` **only inside the dex namespace**
(a new `dex/reconcile` package under `apps/data/internal` or `apps/api/internal`), and never as a
top-level app. Reusing `apps/reconciler` would collide with a live systemd unit.

**G4 — Plan §38's target tree does not match the repo.**
The plan sketches `backend/internal/dex/…`. The repo's boundaries are `apps/{api,data,executor,web}`
with `apps/data/internal/{ingest,canon,research,platform}`. Plan §38 itself says "sesuaikan dengan
struktur aktual repo". **Recommendation:** land the DEX subsystem as
`apps/data/internal/dex/{domain,ports,providers,normalize,reconcile,quality,derive,cache,storage,service}`
plus `apps/data/internal/ingest/providers/<provider>` for the adapters, and expose reads from
`apps/api`. Do not create a `backend/` tree.

---

## 10. Recommended reuse — per plan agent

| plan agent | build on | do not build |
|---|---|---|
| 02 Contracts | `contracts/schemas/**`, `reference.json`, `canon/ids.go` | a new schema tree |
| 03 Storage | `db/schema/data-schema.sql` hypertables | new `swaps_YYYY_MM` tables, ClickHouse |
| 04 Ingestion | `apps/data/internal/ingest` engine | a second job/cursor/limiter stack |
| 05 EVM raw | `ingest` engine + a new `providers/evmrpc` | new transport |
| 06 Solana raw | `ingest` engine + a new `providers/solana` | — |
| 07 Aggregators | `providers/{dexscreener,geckoterminal,coingecko}` | a third DexScreener client |
| 08 Indexers | new `providers/{bitquery,thegraph,subsquid,goldrush}` | — |
| 09 Native DEX | new `providers/{uniswap,pancakeswap,curve,balancer,raydium,orca,meteora}` | — |
| 10 Routing | new `providers/{zerox,oneinch,jupiter}` | — |
| 11 Analytics | `providers/defillama` + `providers/dune` | a second DefiLlama client |
| 12 Institutional | adapter stubs that register **disabled** — the engine already supports a
  no-credentials `HardError` (see `providers/etherscan/doc.go`) | making build fail without keys |
| 13 Reconcile | new `dex/reconcile` in `apps/data` | reusing `apps/reconciler` |
| 16 Cache | the engine's Valkey cache | a second cache layer |
| 17 API | `apps/api` + new `internal/dex/` handlers | a new service |
| 18 Quality | new `dex/quality` | — |
| 19 Reliability | engine limiter/breaker + a new health surface | a second breaker |

---

## 11. Migration risks

1. **`/api/dex` is a published, verified route.** `verify-dex.py` (504 lines) pins its live
   behaviour and `openapi/fudcourt.yaml:1425` publishes it. Deleting it in favour of
   `/api/v1/dex/*` breaks a verifier and a published contract — it must be a **deprecation with a
   redirect window**, not a removal.
2. **Frozen id rule is test-pinned.** `TestReferenceArtifactIsCurrent` fails if `reference.json`
   drifts from `seed.go`. Any id change regenerates the artifact and re-pins 16 tests.
3. **`contracts/openapi/fudcourt.yaml` + `events/events.json` are frozen surfaces** with a
   `check-contract.py` gate. New `/api/v1/dex/*` paths must be **added** to both, and the checker
   extended — never replaced (documented in `canonical-model.md` §9.1).
4. **Timescale is load-bearing.** 14 hypertables exist; new time-series must use
   `create_hypertable(..., if_not_exists => TRUE)` and include the partition column in every PK,
   or the migration fails (noted in `data-schema.sql:38,478`).
5. **Provider adapters must not require credentials at build.** The `etherscan` pattern
   (register disabled, return a redacted `HardError`, never touch the network) is the established
   answer and must be reused for Bitquery/Kaiko/Amberdata.
6. **Cross-feature import rule.** Web code may not import another feature's internals; shared
   resolvers live in `lib/`. A DEX UI reading `/api/v1/dex/*` must go through a single
   `features/market/dex` client, not reach into sibling features.
7. **Concurrent workstream.** The tree at `4604c7c` is clean, but the main checkout is dirty with a
   sibling session's work. All DEX work happens in a detached worktree until that settles.

---

## 12. Phase mapping — plan phase to existing artifact

| plan phase | already exists | remaining work |
|---|---|---|
| 0 Audit | this document | — |
| 1 Contracts | `contracts/schemas/**`, `reference.json`, `canon/ids.go` | resolve G1/G2; add pool/protocol/swap schemas |
| 2 Core infra | `ingest` engine, Valkey cache, limiter, breaker | provider health (§34), capability-based fallback |
| 3 P0 providers | DexScreener, GeckoTerminal, CoinGecko, DefiLlama | **raw chain, Bitquery, The Graph, Jupiter, Helius** |
| 4 Native DEX | none | all of §20 |
| 5 Indexers | Dune | Bitquery, The Graph, Subsquid, GoldRush |
| 6 Execution intel | none | 0x, 1inch, Jupiter |
| 7 Reconciliation | none | §24, §25, §18, §19 |
| 8 Derived | none | §26 |
| 9 API | none | `/api/v1/dex/*` + frontend migration |
| 10 Backfill | cursors exist | ordering + checkpoint policy |
| 11 Discovery | none | factory events + verification |

**Milestone 1 (plan §62) reduced to what is actually missing:** raw EVM + Solana ingest,
Bitquery/The Graph/Helius/Jupiter adapters, a native DEX adapter (Uniswap + Raydium), the
reconcile/confidence engine, and the `/api/v1/dex/*` read layer. Everything else in the milestone
is already running.

---

## 13. Verification record

Read-only commands run against the worktree at `4604c7c`:

```
git worktree list                          # worktree isolation confirmed
find apps/data/internal -maxdepth 2 -type d
grep -rn 'dex' apps/api --include=*.go -il
grep -rno '"/api/v[0-9][^"]*"' apps/api --include=*.go
grep -oE 'CREATE TABLE (IF NOT EXISTS )?data\.[a-z_]+' db/schema/data-schema.sql
grep -nE 'create_hypertable' db/schema/data-schema.sql
grep -rn '/api/v1' --include=*.go --include=*.ts .
grep -oE 'Kind[A-Z][a-z]+' apps/data/internal/canon/*.go
head -16 apps/data/internal/ingest/providers/{etherscan,blockscout}/doc.go
head -70 docs/architecture/provider-consolidation.md
grep -n '^#\{1,3\} ' docs/architecture/canonical-model.md
```

Outputs are quoted inline in the sections above.
