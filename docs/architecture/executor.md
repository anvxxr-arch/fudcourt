# CEX Executor — architecture
> Reality-first (house rule): every row below names a file that exists in the tree
> or is labelled **in flight**. Written 2026-10-01; the Go port is landing
> concurrently, so the §3 port table carries its check time. When this file and
> the code disagree, the code wins.
> Sources: `docs/prd/cex-executor.md` (PRD §NN), the executor module map
> (objective §8.9–§8.16, §22, §23), `docs/records/archive/target.md` §2,
> `docs/records/archive/migration-plan.md` Phase 5, `docs/architecture/domain-map.md`.

## 1. Domain map — what the executor is made of
The execution lifecycle (PRD §57) is one table, owned today by
`apps/web/src/platform/executor/types.ts` (`EXECUTION_TRANSITIONS` — the wire contract moved, DR-043)
and ported 1:1 by `apps/executor/internal/execution/lifecycle.go` (`ExecutionTransitions`,
"the ONE lifecycle truth for API intents and worker transitions alike").
Terminal states accept nothing:

| From | May go to |
|---|---|
| DRAFT | CALCULATED, CANCELLED, FAILED |
| CALCULATED | VALIDATED, FAILED, CANCELLED |
| VALIDATED | READY, FAILED, CANCELLED |
| READY | RUNNING, CANCELLED, FAILED |
| RUNNING | PARTIALLY_FILLED, FILLED, PAUSED, CANCEL_REQUESTED, CANCELLED, FAILED, RISK_STOPPED, EXPIRED, RECONCILING, STOPPED |
| PARTIALLY_FILLED | RUNNING, FILLED, PAUSED, CANCEL_REQUESTED, CANCELLED, FAILED, RISK_STOPPED, EXPIRED, RECONCILING, STOPPED |
| PAUSED | RUNNING, CANCEL_REQUESTED, CANCELLED, FAILED, RISK_STOPPED, STOPPED |
| CANCEL_REQUESTED | CANCELLED, FAILED, PARTIALLY_FILLED |
| RECONCILING | RUNNING, PARTIALLY_FILLED, PAUSED, CANCELLED, FAILED, RISK_STOPPED, STOPPED |
| FILLED / CANCELLED / FAILED / RISK_STOPPED / EXPIRED / STOPPED | — (terminal) |

Child orders have their own lifecycle (PRD §58):
`PLANNED → SUBMITTING → OPEN → PARTIAL → FILLED`, plus
`CANCELLING / CANCELLED / REJECTED / EXPIRED / UNKNOWN`
(`types.ts` `ChildOrderStatus`; Go `executor.ChildOrderStatus`).

Module map (objective §8.9–§8.16; TS owner today → Go target package):

| Slice | What it owns | Today (TS) | Go package | State |
|---|---|---|---|---|
| §8.9 domain types | wire + domain contract: statuses, sizing/leverage/margin modes, records; money/quantity as decimal strings | `apps/web/src/platform/executor/types.ts` (frozen contract) | `internal/core/execution` (`types.go`, `enums.go`, `lifecycle.go`, `records.go`) | landed |
| §8.10 execution aggregate | lifecycle commands (`start/pause/resume/cancel/complete/fail`), status mutation, timestamp stamping | `runtime.ts` lifecycle intents + `worker.ts` `transitionExecution` | `internal/core/execution` (`Command`, `Execution.Apply`) | landed |
| §8.11 planner | request → immutable `ExecutionPlan` + `PreviewResult`: entry reference, strict validation (field-named refusals, never clamped), leverage/margin/liquidation policy, conflicts | `apps/web/src/platform/executor/plan.ts` (PRD §24, §56, §79–80, §98) | `internal/core/planner` | **in flight** |
| §8.12 risk | the position-risk formulas — the ONE cost model (PRD §22–23: `totalRisk = Q·unitRisk`, fees, slippage-once, safety reserve), liquidation approximation (PRD §21), the §15 constraint solver | `apps/web/src/platform/executor/risk.ts` (pure: no HTTP/DB/exchange, PRD §102) | `internal/core/risk` (`types.go`, `risk.go`, `leverage.go`, `solve.go`, `errors.go`) | landed |
| §8.13 sizing | sizing-mode resolution (the nine `SizingMode`s), budget→quantity solving incl. the §33 scale-in ladder, grid rounding (quantity floor DOWN), tick rounding, minimum-notional refusals | `plan.ts` `sizePosition` + `risk.ts` `calculateRiskPosition` | `internal/core/sizing` | landed |
| §8.14 orders | **Execution ≠ Order**: one execution produces many child orders; the over-order clamp (PRD §107/§128.15) and child accounting | `worker.ts` `clampChild` + `store.ts` child rows | `internal/core/orders` (`Ledger`, `ClampChild`) | landed |
| §8.15 strategy | deterministic strategies (TWAP, adaptive TWAP, iceberg, chase limit, scale in/out): tick context → submit/cancel/complete actions; seeded PRNG in state; zero submits on reconcile-only passes | `apps/web/src/platform/executor/engine.ts` (PRD §25–§35) | `internal/strategies` | landed |
| §8.16 exchange adapters | canonical `Exchange` interface + normalized models/capabilities/errors/symbol mapping; per-venue adapters absorb every venue difference | `apps/web/src/platform/executor/exchange.ts` (`CcxtLike`, `mapError`, `SECRET_PATTERNS`) | `internal/exchanges` (+ `binance/`, `mexc/`, `paper/`; `bybit/` in flight) | landed |
| idempotency (objective §23) | `fud_<executionID>_<sequence>` client order ids, fill dedup keys; pure, parse-strict | `types.ts` `clientOrderId` (PRD §66), `store.ts` `fillDedupKey` | `internal/runtime/idempotency` | landed |
| worker/runtime | scheduler, locks, reconciliation, recovery, placement clamps | `apps/web/src/platform/executor/worker.ts` + `apps/web/scripts/executor/worker.ts` (unit `deploy/systemd/fudcourt-executor-worker.service`) | `internal/runtime/worker` | **in flight** |
| lock | one worker owns one execution (PRD §65) | `apps/web/src/platform/executor/lock.ts` | `internal/platform/lock` (`lock.go`, `memory.go`, `valkey.go`) | landed |
| persistence | `executor.*` schema writes, credential envelope | `apps/web/src/platform/executor/store.ts` (`EXECUTOR_DDL`) | repository layer | **in flight** (DDL tracked at `db/schema/executor-schema.sql`) |

Why risk (§8.12) and sizing (§8.13) stay separate packages:
1. **Direction.** §8.12 is forward evaluation (given Q → totalRisk, projection,
   liquidation); §8.13 is the inverse solve (given budget → safe Q). The solver
   *depends on* the model's exact linearity (`totalRisk = Q·unitRisk`,
   `risk.ts` header); the same package owning both would let a solver tweak
   silently redefine the enforced cost model.
2. **Invariants.** Sizing's rounding direction is a safety property (quantity
   floor DOWN so `rounded ≤ unrounded safe quantity`, PRD §71/§106);
   risk's property is exact-parity decimal arithmetic against `risk.ts`
   (PRD §102). Separate packages make each parity-testable on its own
   (`executor-risk-tests.ts` 39 tests, `executor-plan-tests.ts` 25 tests).
3. **Cadence.** Sizing runs at plan/creation time (`plan.ts`); the risk model
   re-evaluates continuously at runtime (worker `RISK_RECALCULATED` PRD §36,
   `RISK_STOPPED` PRD §37, portfolio ceilings PRD §72–§74). Merging couples
   creation-time changes to live enforcement.

Execution ≠ Order (§8.14): an **execution** is the user's intent + plan +
lifecycle (PRD §57); **child orders** are the venue-facing artifacts with their
own lifecycle (PRD §58) and their own rows (`executor.child_orders`,
`db/schema/executor-schema.sql`; `UNIQUE (execution_id, client_order_id)`).
Cancel cancels orders and NEVER closes a position (PRD §75;
`contracts/openapi/fudcourt.yaml` lifecycle notes).

No-venue-conditionals rule (§8.16): core executor code MUST NOT branch on the
venue. `apps/executor/internal/exchanges/interface.go` states it verbatim —
"No `if exchange == "binance"` outside this package (objective §8.16)" —
symbols, precision, statuses, order types and API errors are normalized by the
adapters (`binance/`, `mexc/`, `paper/`; `mexc/mexc.go`: "venue conditionals
never leave this package").

## 2. Go port state — `apps/executor/internal/*`
Checked 2026-10-01 (tree is moving as sibling slices land). Package layout is
grouped by role: `core/` (business logic), `strategies/`, `exchanges/` (venue
boundary), `runtime/` (worker + idempotency), `platform/` (decimal, credentials,
lock — no business rules), plus `repository/` (executor-schema persistence) and
`tests/e2e/`.
| Package | Contents on disk | State |
|---|---|---|
| `core/execution` (`package execution`) | `types.go`, `enums.go`, `lifecycle.go`, `records.go` (canonical domain vocabulary) + `execution.go` (command→status aggregate, idempotent `Apply`) | landed |
| `core/orders` | `orders.go` (`Ledger`, `ClampChild`) | landed |
| `core/planner` | `plan.go`, `types.go`, `validate.go` | landed |
| `core/risk` | `types.go`, `risk.go`, `leverage.go`, `solve.go`, `errors.go` | landed |
| `core/sizing` | `sizing.go`, `types.go`, `errors.go` (mode resolution, ladder math, grid rounding) | landed |
| `strategies` | `strategy.go` (action vocabulary, determinism/recovery contract), `strategies.go` (market/limit/TWAP/iceberg/scale implementations) | landed |
| `exchanges` | `interface.go`, `registry.go`, `types.go`, `symbols.go`, `classify.go`, `credentials.go`, `http.go` + tests | landed |
| `exchanges/binance` | `binance.go`, `sign.go`, `parse.go`, `binance_test.go` (stdlib REST adapter, injectable `HTTPClient`) | landed |
| `exchanges/mexc` | `mexc.go`, `sign.go`, `parse.go` | landed |
| `exchanges/paper` | `paper.go`, `match.go`, `config.go` (deterministic in-memory venue) | landed |
| `exchanges/bybit` | `bybit.go`, `sign.go`, `parse.go` | landed |
| `runtime/idempotency` | `idempotency.go` (`ClientOrderID`, `ParseClientOrderID`, `FillDedupKey`) | landed |
| `runtime/worker` | `worker.go`, `tick.go`, `helpers.go` (runtime loop, recovery pass, over-order clamp) | landed |
| `platform/decimal` | `decimal.go`, `decimal_test.go` (exact `big.Rat` decimal strings; objective §36: never float64 in financial paths) | landed |
| `platform/credentials` | `credentials.go` (AES-GCM envelope custody; objective §8.4) | landed |
| `platform/lock` | `lock.go`, `memory.go`, `valkey.go`, `lock_test.go` (execution lease, PRD §65) | landed |
| `repository` | `store.go`, `credentials.go` (executor.* schema persistence) | landed |
| `api` | `server.go`, `accounts.go`, `executions.go`, `execution_create.go`, `settings.go`, `emergency.go`, `wire.go`, `decode.go`, `convert.go`, `plan_json.go`, `decimal.go` + `routes_test.go`, `harness_test.go` — the **15 `/api/executor/*` contract routes** (accounts GET/POST, `accounts/{id}` GET/DELETE, `accounts/{id}/test` POST, settings GET/PUT, executions GET/POST, `executions/{id}` GET + `/orders` + `/fills` + `/events` + `{start,pause,resume,cancel}`, preview POST, emergency POST); TS-handler envelope fidelity, 29 hermetic tests | landed (`7b8dc2d`) |
| `tests/e2e` | `paper_e2e_test.go` (composed paper harness, `go test`) | landed |
| `cmd/executor` | `main.go`, `health.go`, `lease.go`, `api.go` + tests — mounts the `internal/api` surface on its own loopback listener `FUDCOURT_EXECUTOR_API_ADDR` (default `127.0.0.1:3105`), separate from the `:3104` `/healthz`+`/readyz` surface | landed (`7b8dc2d`) |

## 3. TS parity policy — RESOLVED 2026-10-05 (DR-043)
**The Go runtime is the SOLE executor.** The TS executor (the previous parity oracle and
production executor) was retired in DR-043; the wire contract `src/platform/executor/types.ts`
is the only TS-side survivor (consumer-facing — composer + trade client), and the 15
`/api/executor/*` route handlers are now 4-line forwarders through
`src/app/(frontend)/api/executor/_proxy.ts`. The TS-runtime test suites
(`tests/e2e/executor/*`, `tests/integration/executor/*`, `apps/web/tests/executor-proxy-tests.ts`)
are gone; their assertions are covered by the named Go counterparts in `parity-matrix.md`
rows 1–9 (253+ test funcs across 19 internal packages). `verify:executor` is
`go test -count=1 -race ./backend/workers/executor/internal/tests/e2e/...` (12 hermetic
tests, <1 s, no PG/Valkey/creds/network). The Linux TS worker systemd unit is retired to
`deploy/systemd/RETIRED-fudcourt-executor-worker.service.txt`; the entry script is
preserved as a 5-line tombstone at `apps/web/scripts/executor/worker.ts`.

What that means in practice (history — kept for the audit trail):

- **Sole live path since 2026-10-05 (DR-043).** Production traffic runs on the Go service
  (`backend/workers/executor`, unit `fudcourt-executor.service` on `:3104` + `:3105`); the web tier
  thin-proxies `/api/executor/*` through `src/app/(frontend)/api/executor/_proxy.ts`. Every one of the
  15 routes is a 4-line forwarder (`export async function GET|POST|...(req, { params }) { void (await params); return forwardExecutor(req); }`).
- The TS oracle suites are retired:
  `tests/e2e/executor/executor-{engine,plan,risk,runtime,worker}-tests.ts` (engine 20, plan 25, risk 39,
  runtime 12, worker 9), `tests/integration/executor/executor-{exchange,store}-tests.ts` (exchange 1, store 41),
  `tests/e2e/executor/executor-paper-e2e.ts` (the §127 integration gate), and
  `apps/web/tests/executor-proxy-tests.ts` are gone. The only surviving TS test referencing the contract
  shape is `apps/web/tests/executor-ui-tests.ts` (still in `test:shapers`).
- Go code mirrors the frozen TS contract field-for-field (`apps/executor/internal/execution/records.go`).
  The contract now lives at `apps/web/src/platform/executor/types.ts` (consumer-facing); the Go-side
  counterpart is `internal/core/execution/{types,enums,lifecycle,records}.go` (row 1 of `parity-matrix.md`).
- Cutover is **CLOSED** by DR-043: every row of `parity-matrix.md` is `DONE`, `bun run test:shapers` is
  213/213 across 11 files, `go build/vet/test ./backend/workers/executor/...` is green (21 pkgs),
  `bash scripts/verify/verify-all.sh` is `VERIFY_ALL_OK`, and `find frontend/web/src/platform/executor -type f` → 0.

Feature × TS × Go parity matrix (objective §22 skeleton). **Status vocabulary — read first:**
`DONE` means **a TS oracle test (file + test title, from the §3 suites) is paired with a named Go test
asserting the same behavior** — it does *not* mean "the Go code has a test". **Go-only coverage is not
parity**: a behavior pinned by a Go test with no TS oracle counterpart is `PARTIAL`, gap named in the row.
This table is **feature-granular**; `parity-matrix.md` is the **canonical, module-granular cutover gate**
and stays authoritative.

| Feature | TS (parity oracle) | Go | Status |
|---|---|---|---|
| fixed USD risk | `risk.ts` `calculateRiskPosition`, `executor-risk-tests.ts` | `internal/core/risk` + `internal/core/sizing` | `DONE` — TS `executor-risk-tests.ts` "PRD §8: BTC E=100000 S=98000 risk $20 → 0.01 BTC / $1,000 at zero fees" ↔ Go `core/risk` `TestPRD8RiskSizing`; TS `executor-plan-tests.ts` "§8 risk USD: 20 / 2000 = 0.01 BTC, notional $1,000 (zero fees)" ↔ Go `core/sizing` `TestRiskUSDVector`, `core/planner` `TestPRD8RiskUSD` |
| percentage risk | `risk.ts` + `resolveBalanceBasis` (PRD §9–10), `executor-risk-tests.ts` | `internal/core/risk` + `internal/core/sizing` | `DONE` — TS `executor-risk-tests.ts` "PRD §9: futures equity $5,000 × 1% → $50 budget, sizing identical to fixed USD" ↔ Go `core/risk` `TestPRD9PercentageBudget`; TS "resolveBalanceBasis: every basis maps explicitly; unknown/absent → null, never 0" ↔ Go `TestResolveBalanceBasis`; TS `executor-plan-tests.ts` "§11: risk % and allocation % are distinct concepts with distinct outputs" ↔ Go `core/sizing` `TestRiskPercentVsAllocationPercent`; TS "unresolved percentage basis is an error naming the basis, never a fabricated 0" ↔ Go `TestPercentageBasisRequirements` |
| long sizing | `plan.ts` `sizePosition`, `executor-plan-tests.ts` | `internal/core/sizing` | `DONE` — TS `executor-plan-tests.ts` "§8 risk USD: 20 / 2000 = 0.01 BTC, notional $1,000 (zero fees)" ↔ Go `core/sizing` `TestRiskUSDVector` and `core/planner` `TestPRD8RiskUSD`. The broader Go `core/sizing` `TestAllNineModesProducePositions` covers nine modes of which `allocation_usd`, `fixed_margin` and `target_profit_percent` have **no TS oracle test** (Go-only — not parity) |
| short sizing | `plan.ts` `sizePosition`, `executor-plan-tests.ts` | `internal/core/sizing` | `PARTIAL` (corrected 2026-10-02) — the short *risk* model is paired: TS `executor-risk-tests.ts` "risk sizing works mirrored for shorts" ↔ Go `core/risk` `TestRiskSizingShortMirrored` (short quantity + notional); TS "autoSafeLeverage: short side buffer mirrored" ↔ Go `TestAutoSafeLeverageShortBufferMirrored`; TS "liquidationPriceApprox: preview-grade formulas both sides (PRD §21)" ↔ Go `TestLiquidationPriceApprox`. Gap: the short path through the `sizePosition`/planner stack is unpinned on **both** sides (no `core/sizing`/`core/planner` test drives `SideSell` — planner's only `SideSell` use is `TestResolveEstimatedEntry`, an entry-resolution test) |
| spot | `types.ts` `MarketType: 'spot'`, `exchange.ts` | `executor.MarketSpot`, `internal/exchanges` | `DONE` — TS `executor-plan-tests.ts` "§16 spot flow: $2,500 balance, risk 1% = $25, E=100 SL=95 → 5 units / $500 capital" ↔ Go `core/planner` `TestPRD16SpotFlow`; TS `executor-risk-tests.ts` "PRD §16: spot flow — balance $2,500 risk 1% E=100 SL=95 → 5 units / $500 required capital" ↔ Go `core/risk` `TestPRD16SpotFlow` and `core/sizing` `TestSpotPercentVector`. (`exchanges/mexc` `TestCreateOrderParsing` spot fixtures are Go-only: TS `executor-exchange-tests.ts` is a wiring placeholder) |
| futures | `types.ts` `'linear_perp'`, `exchange.ts` | `executor.MarketLinearPerp`, `internal/exchanges` | `PARTIAL` (corrected 2026-10-02) — `exchanges/paper` `TestLinearSettlement` pins linear settlement (fee-absorbing quote, `FuturesEquity` set / `SpotEquity` nil, no base-wallet row); `exchanges/bybit` `TestGetPositionFixture` (asserts `pos.MarketType == MarketLinearPerp`), `TestCreateOrderFixture`, `TestSignedRequestHeaders`; `exchanges/mexc` `TestNewAppliesDefaults`, `TestGetPosition`, `TestCreateOrderParsing` perp fixtures. **No linear-specific sizing or risk test exists and the TS oracle is no different** (`core/{risk,sizing,planner}`, the e2e harness, `cmd/executor` and the §3 oracle suites all include `MarketLinearPerp` only via their shared default fixtures, never as the assertion's subject — `TestPRD16SpotFlow`, cited here in the first commit, is a *spot* test and was a mis-citation), so no TS↔Go pair exists for a linear-specific behavior. The futures path is therefore pinned only by paper/bybit/mexc fixtures + stub-HTTP adapter tests, never by a linear-specific model test or an end-to-end linear run |
| leverage | `risk.ts` `autoLeverage` (PRD §18–19), `executor-risk-tests.ts` | `internal/core/risk/leverage.go` | `DONE` — TS `executor-risk-tests.ts` "autoSafeLeverage: minimum feasible leverage, margin math exact (N=1000 avail=250 → 4x)" ↔ Go `core/risk` `TestAutoSafeLeverageMinimumFeasible`; TS "autoSafeLeverage: leverage caps enforced (user + exchange) with honest infeasibility" ↔ Go `TestAutoSafeLeverageCaps`; TS "autoSafeLeverage: liquidation safety honest when the minimum feasible leverage is unsafe" ↔ Go `TestAutoSafeLeverageHonestUnsafe`; TS `executor-plan-tests.ts` "§18/§20 auto leverage: selected ≤ caps, liquidation beyond stop + buffer, thin-buffer warning" ↔ Go `core/sizing` `TestResolveLeverageAndMargin`. Go `TestFixedMarginRequiresManualLeverage` is Go-only (`fixed_margin` has no TS oracle test) |
| pause | `engine.ts` pause policy + `runtime.ts` lifecycle, `executor-engine-tests.ts` | `internal/core/execution` (`CommandPause`) | `DONE` — TS `executor-engine-tests.ts` "a user-paused execution places nothing and never self-resumes (§37 pause policy)" ↔ Go e2e `TestPaperPauseResume`; TS `executor-worker-tests.ts` "child-order terminality (§58) and execution lifecycle legality (§57)" asserts the §57 `EXECUTION_TRANSITIONS` table (`canTransition('PAUSED','RUNNING')`) ↔ Go `core/execution` `TestApplyLegalTransitions` (`CommandPause→StatusPaused`) |
| cancel | `runtime.ts` (cancel cancels orders, never closes positions), `executor-worker-tests.ts` | `internal/core/execution` (`CommandCancel`) | `DONE` — TS `executor-worker-tests.ts` "emergency stop (§75): owner-scoped, cancels managed orders, NEVER closes positions" ↔ Go `internal/api` `TestCancelNeverClosesPosition`; TS "child-order terminality (§58) and execution lifecycle legality (§57)" ↔ Go `core/execution` `TestApplyLegalTransitions`. The worker's resting-entry cancel pass (`TestPaperCancelRestingOrder`) pairs to the TS integration gate `executor-paper-e2e.ts` §127.6 "cancel reaches a terminal state" (not an oracle-suite test) |
| resume | `runtime.ts` + `worker.ts`, `executor-worker-tests.ts` | `internal/core/execution` (`CommandResume`) | `DONE` — TS `executor-worker-tests.ts` "child-order terminality (§58) and execution lifecycle legality (§57)" asserts `canTransition('PAUSED','RUNNING')` ↔ Go `core/execution` `TestApplyLegalTransitions` (`CommandResume`); TS `executor-engine-tests.ts` "a user-paused execution places nothing and never self-resumes (§37 pause policy)" ↔ Go e2e `TestPaperPauseResume` |
| TWAP | `engine.ts` (jitter opt-in, DR-021 §2g), `executor-engine-tests.ts` | `internal/strategies` | `DONE` — TS `executor-engine-tests.ts` "§28/§29: no config ⇒ the naive equal schedule — jitter is opt-in, never silent" ↔ Go `strategies` `TestTwapNaiveEqualSlices`; TS "§107: Σ planned entry quantities never exceeds the target, across fills" ↔ Go `TestTwapSlicesSumToPlanned`; TS "§28/§29: quantity jitter randomizes slices, yet the total is still exactly the target" ↔ Go `TestTwapJitterOptInAndDeterministic`; the venue-composed half pairs TS `executor-paper-e2e.ts` §127.3 ("§107 over-order: sum(child qty) <= planned") ↔ Go e2e `TestPaperTwapSlices` (§107 sum bound) |
| market | `plan.ts`/`exchange.ts` market orders (entry at the touch, PRD §26), `executor-plan-tests.ts` | `internal/exchanges`, `internal/core/orders` | `PARTIAL` — the entry-price rule is paired: TS `executor-plan-tests.ts` "market entry prices at the touch (conservative side), limit at its own price" ↔ Go `core/planner` `TestResolveEstimatedEntry`. Gap: `strategies` `TestMarketSingleChild`, `TestMarketPhantomFreesRoomOnLaterTick` and e2e `TestPaperMarketLifecycle` are **Go-only** (no §3 oracle test asserts the market strategy's single-child / phantom-room behavior), and the live-venue (binance/mexc/bybit) market path is pinned only against stubbed HTTP, never end-to-end |
| limit | `plan.ts`/`exchange.ts` limit orders, `executor-engine-tests.ts` | `internal/exchanges`, `internal/core/orders` | `PARTIAL` — the entry-price rule is paired: TS `executor-plan-tests.ts` "market entry prices at the touch (conservative side), limit at its own price" ↔ Go `core/planner` `TestResolveEstimatedEntry`. Gap: `strategies` `TestLimitPeggedSingleChild`/`TestLimitNeedsPrice` are **Go-only** — the TS chase/limit tests (`executor-engine-tests.ts` "§32: maxChaseDistance holds the peg at the limit instead of chasing a runaway market") have **no Go counterpart** (no chase test in `internal/strategies`) — and the live-venue limit path is stub-only (same gap as `market`) |
| partial fill | `worker.ts` ingest + `clampChild` (PRD §107), `executor-worker-tests.ts` | `internal/core/orders` (`ClampChild`) | `DONE` — TS `executor-worker-tests.ts` "over-order clamp: planned − filled − open entry remainder, never negative (§107)" ↔ Go `core/orders` `TestClampChildPartialFillShrinksRoom`; TS `executor-engine-tests.ts` "§36: a fill updates the average entry and the remaining plan shrinks" ↔ Go e2e `TestPaperPartialFillThenComplete` (tracks a half fill, completes on ingestion) |
| worker recovery | `worker.ts` `recover()` (PRD §114), `executor-engine-tests.ts` | `internal/runtime/worker` | `DONE` (was **in flight**, re-derived 2026-10-02) — TS `executor-engine-tests.ts` "§114: a recovery pass (placementEnabled=false) plans NO placements" ↔ Go `strategies` `TestRecoveryPassPlacesNothing` and `runtime/worker` `TestRecoveryPassPlacesNothing`; TS `executor-paper-e2e.ts` §127.5 "recovery created no duplicate child orders" ↔ Go e2e `TestPaperRestartNoDuplicateOrder`, `TestRestartDoesNotDoubleSubmit`. Go `TestLostLeaseStopsPlacement`/`TestPaperDisconnectDegradesThenRecovers` are **Go-only** (no §3 oracle test drives lease fail-closed / disconnect-degrade) |
| reconciliation | `worker.ts` `reconcileOrders` (PRD §41/§95) | `internal/runtime/worker` | `PARTIAL` (corrected 2026-10-02) — only the reconcile-before-place half is paired: TS `executor-engine-tests.ts` "§114: a recovery pass (placementEnabled=false) plans NO placements" ↔ Go `TestRecoveryPassPlacesNothing`. Gap: the extern-mismatch case (vanished entry child → `UNKNOWN` + `EXTERNAL_STATE_CHANGE`, Go e2e `TestPaperReconcileExternalMismatch`) has **no TS oracle test** — no test in the §3 suites drives `reconcileOrders`/`EXTERNAL_STATE_CHANGE` at all — so the row was `DONE` on Go-only evidence and is downgraded |
| idempotent start | `runtime.ts` same-status 409 + `execution.Apply`-equivalent, `executor-store-tests.ts` | `internal/core/execution.Apply` (idempotent at target) | `PARTIAL` (corrected 2026-10-02) — the §57 terminal-refusal half is paired: TS `executor-store-tests.ts` "§57: the lifecycle table accepts nothing out of a terminal status" ↔ Go `core/execution` `TestApplyIllegalTransitions` (terminal states accept nothing) and `TestApplyLegalTransitions`. Gap: no §3 oracle test drives `lifecycle('start')` at the target status, so the same-status 409/no-op (Go `TestApplyIdempotentRepeat`, Go e2e `TestPaperDuplicateStartIsNoOp`) is **Go-only** |

**Footnote — what `DONE` means here (read with the header).** Every row's `DONE` requires a **paired** citation:
a TS oracle test (the §3 oracle suites, resolved to file + test title) *and* the named Go test asserting the
same behavior. **Go-only coverage is not parity.** A row where the Go test has no TS oracle counterpart — or the
TS test has no Go counterpart — is `PARTIAL`, gap named in one clause. The statuses were re-derived 2026-10-02
from **both** sides: the Go test list (`go test -list '.*'` over `core/{risk,sizing,planner,orders,execution}`,
`strategies`, `exchanges(+binance,bybit,mexc,paper)`, `runtime/{worker,idempotency}`, `tests/e2e/` — **209 named
tests across 14 packages**, all green) and the §3 oracle suites (155 tests, 0 fail), cross-checked against
`parity-matrix.md`. `DONE` is not the cutover itself: the cutover is **CLOSED 2026-10-05 by DR-043** (the entire TS runtime was retired); see `parity-matrix.md`, cutover row + `TS modules deleted` row. The 17 rows above map
onto `parity-matrix.md` rows 1–9 (`DONE 2026-10-01`) at feature granularity; `parity-matrix.md` is the canonical
**module**-granular cutover gate and stays authoritative. `market`, `limit` and `futures` stay `PARTIAL` because
the Go tests do not carry them all the way to a live venue (and the market/limit strategy tests are Go-only);
`short sizing` stays `PARTIAL` because neither side drives `SideSell` through the sizing/planner stack;
`reconciliation` and `idempotent start` are now `PARTIAL` because their remaining Go evidence
(`TestPaperReconcileExternalMismatch`; `TestApplyIdempotentRepeat`/`TestPaperDuplicateStartIsNoOp`) has no TS
oracle counterpart. Audit trail: the first commit (`1d31ae5`) cited `TestPRD16SpotFlow` as evidence for the
`futures` row; that test is a *spot* test and the row was downgraded in `1d31ae5`'s follow-up (2026-10-02); the
later Go-only re-derivation (`681ab13`, 2026-10-02) is the drift this pairing rule corrects.

## 4. Idempotency keys
Four identity layers make retries, restarts and replays safe (objective §23;
PRD §62/§66):

| Key | Form | Makes idempotent | Evidence |
|---|---|---|---|
| request id | `request_id` correlation id of the originating request | replays of one API call correlate to one logical request; carried on every event (`contracts/schemas/event-envelope.json`) and error (`contracts/schemas/error-envelope.json`) | event/error envelope schemas |
| execution id | execution uuid | one execution aggregate per user intent; lifecycle intents addressed to it refuse illegal repeats | `executor-schema.sql` `executions`; `internal/core/execution/execution.go` |
| client order id | `fud_<executionID>_<sequence>` | a retried/duplicated/replayed placement maps onto the SAME venue order instead of a second one | PRD §66; `types.ts:747`; `internal/runtime/idempotency/idempotency.go` (parse-strict: foreign/zero-padded ids refused, never mis-parsed); `UNIQUE (execution_id, client_order_id)` in `executor-schema.sql` |
| fill dedup key | `(account_id, exchange_trade_id)` | one venue trade ingested once; `insertFill` resolves null on conflict ("already ingested") | PRD §62; `store.ts` `fillDedupKey` + `UNIQUE (account_id, exchange_trade_id)` in `executor-schema.sql`; Go `FillDedupKey` |

Idempotent start specifically: `internal/core/execution.Apply` treats a repeated
command whose target equals the current status as a no-op
(`transitioned=false, err=nil`) and the caller MUST NOT re-emit lifecycle events
or re-drive work; the TS API layer answers the same repeat with 409
(`runtime.ts`: "`<op>` is not applicable in status …").

## 5. Recovery rules
1. **Reconcile before acting.** Every worker pass reads venue truth first
   (open orders, fills) and reconciles local rows to it before any new placement
   (`worker.ts` "venue truth first (§41/§95)"; PRD §41/§95/§114). A vanished
   child becomes `UNKNOWN` + `EXTERNAL_STATE_CHANGE`; the venue is authoritative
   over `EngineState` (`records.go`: "NOT authoritative across a lost write — the
   exchange is (PRD §95/§114)").
2. **First pass places nothing.** Startup is a recovery pass: `worker.ts`
   `start()` runs `runPass(false)` — "startup == recovery pass (§114):
   reconcile, don't place" — and the placement loop breaks on
   `if (!placementEnabled)` ("recovery reconciles first; resume places next
   tick"). `recover()` is the same code path. Go mirrors it:
   `internal/strategies/strategy.go` — `ctx.PlacementEnabled=false` means the
   strategy MUST emit ZERO submit actions while staying resumable.
3. **Over-order clamp** (PRD §107/§128.15; `worker.ts` `clampChild`, Go
   `orders.ClampChild`). For an entry child, the quantity legal to send now is
   ```
   openRemaining_entry = Σ over non-terminal entry children (quantity − filledQuantity)
   room   = floor_grid(max(0, plannedQuantity − filledQuantity − openRemaining_entry))
   sent   = min(floor_grid(requested), room)     ; null when room ≤ 0
   ```
   Exit children are reduce-only and carry their planned quantity VERBATIM
   (the venue clamps the fill to the open position, PRD §40) but still floor to
   the grid. Every rounding is DOWN (`floor_grid`), because rounding up would
   round into exposure the user never approved (PRD §71). A shrunk order emits
   `PLAN_RESIZED` (`requested` vs `clamped`). Belt and braces: the engine has
   its own clamp (DR-021 §1d) — "a duplicated order is real money".
4. **Worker restart must not produce duplicate exchange orders** (objective
   EXECUTOR SAFETY): the `fud_<executionID>_<sequence>` id + the fill dedup key
   (§4) + the `execution:{id}:lock` lease (PRD §65) hold across restarts; the
   paper E2E asserts "restart recovery with no duplicate children" (DR-020
   verification).
