# CEX Executor — architecture
> Reality-first (house rule): every row below names a file that exists in the tree
> or is labelled **in flight**. Written 2026-10-01; the Go port is landing
> concurrently, so the §3 port table carries its check time. When this file and
> the code disagree, the code wins.
> Sources: `docs/prd/cex-executor.md` (PRD §NN), the executor module map
> (objective §8.9–§8.16, §22, §23), `docs/architecture/target.md` §2,
> `docs/architecture/migration-plan.md` Phase 5, `docs/architecture/domain-map.md`.

## 1. Domain map — what the executor is made of
The execution lifecycle (PRD §57) is one table, owned today by
`frontend/web/src/platform/executor/types.ts` (`EXECUTION_TRANSITIONS`) and ported
1:1 by `backend/workers/executor/internal/core/execution/lifecycle.go` (`ExecutionTransitions`,
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
| §8.9 domain types | wire + domain contract: statuses, sizing/leverage/margin modes, records; money/quantity as decimal strings | `frontend/web/src/platform/executor/types.ts` (frozen contract) | `internal/core/execution` (`types.go`, `enums.go`, `lifecycle.go`, `records.go`) | landed |
| §8.10 execution aggregate | lifecycle commands (`start/pause/resume/cancel/complete/fail`), status mutation, timestamp stamping | `runtime.ts` lifecycle intents + `worker.ts` `transitionExecution` | `internal/core/execution` (`Command`, `Execution.Apply`) | landed |
| §8.11 planner | request → immutable `ExecutionPlan` + `PreviewResult`: entry reference, strict validation (field-named refusals, never clamped), leverage/margin/liquidation policy, conflicts | `frontend/web/src/platform/executor/plan.ts` (PRD §24, §56, §79–80, §98) | `internal/core/planner` | **in flight** |
| §8.12 risk | the position-risk formulas — the ONE cost model (PRD §22–23: `totalRisk = Q·unitRisk`, fees, slippage-once, safety reserve), liquidation approximation (PRD §21), the §15 constraint solver | `frontend/web/src/platform/executor/risk.ts` (pure: no HTTP/DB/exchange, PRD §102) | `internal/core/risk` (`types.go`, `risk.go`, `leverage.go`, `solve.go`, `errors.go`) | landed |
| §8.13 sizing | sizing-mode resolution (the nine `SizingMode`s), budget→quantity solving incl. the §33 scale-in ladder, grid rounding (quantity floor DOWN), tick rounding, minimum-notional refusals | `plan.ts` `sizePosition` + `risk.ts` `calculateRiskPosition` | `internal/core/sizing` | landed |
| §8.14 orders | **Execution ≠ Order**: one execution produces many child orders; the over-order clamp (PRD §107/§128.15) and child accounting | `worker.ts` `clampChild` + `store.ts` child rows | `internal/core/orders` (`Ledger`, `ClampChild`) | landed |
| §8.15 strategy | deterministic strategies (TWAP, adaptive TWAP, iceberg, chase limit, scale in/out): tick context → submit/cancel/complete actions; seeded PRNG in state; zero submits on reconcile-only passes | `frontend/web/src/platform/executor/engine.ts` (PRD §25–§35) | `internal/strategies` | landed |
| §8.16 exchange adapters | canonical `Exchange` interface + normalized models/capabilities/errors/symbol mapping; per-venue adapters absorb every venue difference | `frontend/web/src/platform/executor/exchange.ts` (`CcxtLike`, `mapError`, `SECRET_PATTERNS`) | `internal/exchanges` (+ `binance/`, `mexc/`, `paper/`; `bybit/` in flight) | landed |
| idempotency (objective §23) | `fud_<executionID>_<sequence>` client order ids, fill dedup keys; pure, parse-strict | `types.ts` `clientOrderId` (PRD §66), `store.ts` `fillDedupKey` | `internal/runtime/idempotency` | landed |
| worker/runtime | scheduler, locks, reconciliation, recovery, placement clamps | `frontend/web/src/platform/executor/worker.ts` + `frontend/web/scripts/executor/worker.ts` (unit `infrastructure/systemd/fudcourt-executor-worker.service`) | `internal/runtime/worker` | **in flight** |
| lock | one worker owns one execution (PRD §65) | `frontend/web/src/platform/executor/lock.ts` | `internal/platform/lock` (`lock.go`, `memory.go`, `valkey.go`) | landed |
| persistence | `executor.*` schema writes, credential envelope | `frontend/web/src/platform/executor/store.ts` (`EXECUTOR_DDL`) | repository layer | **in flight** (DDL tracked at `database/schema/executor-schema.sql`) |

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
`database/schema/executor-schema.sql`; `UNIQUE (execution_id, client_order_id)`).
Cancel cancels orders and NEVER closes a position (PRD §75;
`shared/contracts/openapi/fudcourt.yaml` lifecycle notes).

No-venue-conditionals rule (§8.16): core executor code MUST NOT branch on the
venue. `backend/workers/executor/internal/exchanges/interface.go` states it verbatim —
"No `if exchange == "binance"` outside this package (objective §8.16)" —
symbols, precision, statuses, order types and API errors are normalized by the
adapters (`binance/`, `mexc/`, `paper/`; `mexc/mexc.go`: "venue conditionals
never leave this package").

## 2. Go port state — `backend/workers/executor/internal/*`
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

## 3. TS parity policy
**The TypeScript executor is the PARITY ORACLE and the PRODUCTION executor until
parity is proven** (objective §22; `.ai/restructure-fudcourt.md` "Do NOT remove
the existing TypeScript executor until Go parity is demonstrated through tests";
`migration-plan.md` Phase 5: "parity tests MUST pass before each TS module is
deleted"). What that means in practice:

- Production traffic runs on `frontend/web/src/platform/executor/*` +
  `frontend/web/scripts/executor/worker.ts` (unit
  `infrastructure/systemd/fudcourt-executor-worker.service`) — the API routes under
  `frontend/web/src/app/(frontend)/api/executor/**` — **15 `route.ts` files exporting 19
  route-method handlers** (recounted 2026-10-02: `find … -name route.ts | wc -l` → 15;
  `grep -c 'export async function {GET,POST,PUT,DELETE}'` → 19), matching
  `shared/contracts/openapi/fudcourt.yaml` **15 paths / 19 operations** (paths ≠ operations:
  `accounts` and `executions` carry GET+POST, `accounts/{id}` GET+DELETE, `settings`
  GET+PUT) and the Go surface's 15 contract routes (`internal/api`, §2) — and the worker.
- The oracle suites are `tests/e2e/executor/executor-{engine,plan,risk,runtime,worker}-tests.ts`,
  `tests/integration/executor/executor-{exchange,store}-tests.ts` and
  `frontend/web/tests/executor-ui-tests.ts` — **155 tests, 0 fail** as recorded in
  `docs/architecture/current.md` §5a (engine 20, exchange 1, plan 25, risk 39,
  runtime 12, store 41, worker 9, ui 8). The paper E2E
  (`tests/e2e/executor/executor-paper-e2e.ts`, `bun run verify:executor`) is
  the integration gate; it is environment-gated on `FUDCOURT_EXECUTOR_MASTER_KEY`.
- Go code mirrors the TS contract field-for-field and says so
  (`backend/workers/executor/internal/core/execution/records.go`: "mirror
  frontend/web/src/platform/executor/types.ts field-for-field … Where the two
  disagree, the TS contract and its tests are the parity oracle until cutover").
- Cutover (delete TS) requires: every row below green in Go, the paper E2E green
  against the Go worker, and an atomic `fudcourt-executor-worker.service`
  switch (`migration-plan.md` Phase 5 — one worker live at a time).
  **2026-10-01 (`7b8dc2d`):** the Go **code** counterpart is complete — engine/worker/persistence
  plus the 15-route HTTP surface (`internal/api` on `:3105`). Still open before deletion: the web
  tier must thin-proxy `/api/executor/*` to `127.0.0.1:3105`, and `FUDCOURT_SESSION_SECRET` +
  `FUDCOURT_EXECUTOR_PG_URL` (+ `FUDCOURT_EXECUTOR_MASTER_KEY`) must be provisioned so the unit can
  start; then the live `verify:executor` runs against the **Go** worker.

Feature × TS × Go parity matrix (objective §22 skeleton — migration status
column is filled from the §2/§3 evidence only):

| Feature | TS (parity oracle) | Go | Status |
|---|---|---|---|
| fixed USD risk | `risk.ts` `calculateRiskPosition`, `executor-risk-tests.ts` | `internal/core/risk` + `internal/core/sizing` | `DONE` — `core/risk` `TestPRD8RiskSizing`; `core/sizing` `TestRiskUSDVector` |
| percentage risk | `risk.ts` + `resolveBalanceBasis` (PRD §9–10), `executor-risk-tests.ts` | `internal/core/risk` + `internal/core/sizing` | `DONE` — `core/risk` `TestPRD9PercentageBudget`, `TestResolveBalanceBasis`; `core/sizing` `TestRiskPercentVsAllocationPercent`, `TestPercentageBasisRequirements` |
| long sizing | `plan.ts` `sizePosition`, `executor-plan-tests.ts` | `internal/core/sizing` | `DONE` — `core/planner` `TestPRD8RiskUSD`; `core/sizing` `TestAllNineModesProducePositions` |
| short sizing | `plan.ts` `sizePosition`, `executor-plan-tests.ts` | `internal/core/sizing` | `DONE` — `core/risk` `TestRiskSizingShortMirrored`, `TestAutoSafeLeverageShortBufferMirrored` |
| spot | `types.ts` `MarketType: 'spot'`, `exchange.ts` | `executor.MarketSpot`, `internal/exchanges` | `DONE` — `core/sizing` `TestSpotPercentVector`; `core/planner` `TestPRD16SpotFlow`; `exchanges/mexc` spot-market fixtures |
| futures | `types.ts` `'linear_perp'`, `exchange.ts` | `executor.MarketLinearPerp`, `internal/exchanges` | `DONE` — `exchanges/paper` `TestLinearSettlement`; `core/risk`/`core/sizing` `TestPRD16SpotFlow` linear fixtures; `exchanges/bybit` perp fixtures |
| leverage | `risk.ts` `autoLeverage` (PRD §18–19), `executor-risk-tests.ts` | `internal/core/risk/leverage.go` | `DONE` — `core/risk` `TestAutoSafeLeverageMinimumFeasible`, `TestAutoSafeLeverageCaps`, `TestAutoSafeLeverageHonestUnsafe`; `core/sizing` `TestResolveLeverageAndMargin`, `TestFixedMarginRequiresManualLeverage` |
| pause | `runtime.ts` lifecycle + `worker.ts`, `executor-runtime-tests.ts` | `internal/core/execution` (`CommandPause`) | `DONE` — `core/execution` `TestApplyLegalTransitions` (`CommandPause→StatusPaused`); e2e `TestPaperPauseResume` |
| cancel | `runtime.ts` (cancel cancels orders, never closes positions) | `internal/core/execution` (`CommandCancel`) | `DONE` — `core/execution` `TestApplyLegalTransitions`; e2e `TestPaperCancelRestingOrder` |
| resume | `runtime.ts` + `worker.ts` | `internal/core/execution` (`CommandResume`) | `DONE` — `core/execution` `TestApplyLegalTransitions` (`CommandResume`); e2e `TestPaperPauseResume` |
| TWAP | `engine.ts` (jitter opt-in, DR-021 §2g), `executor-engine-tests.ts` | `internal/strategies` | `DONE` — `strategies` `TestTwapNaiveEqualSlices`, `TestTwapSlicesSumToPlanned`, `TestTwapJitterOptInAndDeterministic`; e2e `TestPaperTwapSlices` (§107 sum bound) |
| market | `plan.ts`/`exchange.ts` market orders (entry at the touch, PRD §26) | `internal/exchanges`, `internal/core/orders` | `PARTIAL` — `strategies` `TestMarketSingleChild`, `TestMarketPhantomFreesRoomOnLaterTick` and e2e `TestPaperMarketLifecycle` pin the strategy + paper composition; the live-venue (binance/mexc/bybit) market path is pinned only against stubbed HTTP, never end-to-end |
| limit | `plan.ts`/`exchange.ts` limit orders | `internal/exchanges`, `internal/core/orders` | `PARTIAL` — `strategies` `TestLimitPeggedSingleChild`, `TestLimitNeedsPrice` and e2e `TestPaperCancelRestingOrder`/`TestPaperPauseResume` rest real limit children on the paper venue; live-venue limit path is stub-only (same gap as `market`) |
| partial fill | `worker.ts` ingest + `clampChild` (PRD §107), `executor-worker-tests.ts` | `internal/core/orders` (`ClampChild`) | `DONE` — e2e `TestPaperPartialFillThenComplete` (tracks a half fill, completes on ingestion); `core/orders` `TestClampChildPartialFillShrinksRoom` |
| worker recovery | `worker.ts` `recover()` (PRD §114), `executor-worker-tests.ts` | `internal/runtime/worker` | `DONE` (was **in flight**, re-derived 2026-10-02) — `runtime/worker` `TestRecoveryPassPlacesNothing`, `TestRestartDoesNotDoubleSubmit`, `TestLostLeaseStopsPlacement`; e2e `TestPaperRestartNoDuplicateOrder`, `TestPaperDisconnectDegradesThenRecovers` |
| reconciliation | `worker.ts` `reconcileOrders` (PRD §41/§95) | `internal/runtime/worker` | `DONE` (was **in flight**, re-derived 2026-10-02) — e2e `TestPaperReconcileExternalMismatch` (vanished entry child → `UNKNOWN` + `EXTERNAL_STATE_CHANGE`, no silent re-place); `runtime/worker` `TestRecoveryPassPlacesNothing` (reconcile-before-place). Caveat: the extern-mismatch case is the one pinned; fill-truth reconciliation enters through the ingestion seam the same test composes |
| idempotent start | `runtime.ts` same-status 409 + `execution.Apply`-equivalent | `internal/core/execution.Apply` (idempotent at target) | `DONE` — `core/execution` `TestApplyIdempotentRepeat`; e2e `TestPaperDuplicateStartIsNoOp` |

Re-derived 2026-10-02 from the Go test list (`go test -list '.*'` over `core/{risk,sizing,planner,orders,execution}`,
`strategies`, `exchanges(+binance,bybit,mexc,paper)`, `runtime/{worker,idempotency}`, `tests/e2e/`) plus
`parity-matrix.md`: **209 named tests across 14 packages**, all green. `DONE` here means a named Go test pins the
row's behavior; it is not the cutover itself — the cutover stays OPEN on the web re-point + env provisioning + the
live `verify:executor` against the Go worker (see `parity-matrix.md`, cutover row). The 17 rows above map onto
`parity-matrix.md` rows 1–9 (`DONE 2026-10-01`) at feature granularity; `market` and `limit` are the two rows the
Go tests do not carry all the way to a live venue, so they stay `PARTIAL`.

## 4. Idempotency keys
Four identity layers make retries, restarts and replays safe (objective §23;
PRD §62/§66):

| Key | Form | Makes idempotent | Evidence |
|---|---|---|---|
| request id | `request_id` correlation id of the originating request | replays of one API call correlate to one logical request; carried on every event (`shared/contracts/schemas/event-envelope.json`) and error (`shared/contracts/schemas/error-envelope.json`) | event/error envelope schemas |
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
