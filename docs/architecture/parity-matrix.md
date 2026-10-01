# TS → Go parity matrix (Phase 5 cutover gate)

> Canonical cutover gate for the executor port. **Rule (migration-plan Phase 5): no TS
> module is deleted until its row is `DONE` here and `verify:executor`
> (`executor-paper-e2e.ts`) passes against the Go worker.** Backend is authoritative;
> the TS executor remains the production executor until every row is `DONE` and the
> final cutover row is proven.

Status values: `DONE` (parity vectors ported + green), `IN FLIGHT` (slice running),
`OPEN` (not started), `N/A` (stays TS by design).

| # | TS module (`apps/web/src/platform/executor/`) | Go owner package | TS oracle suite | Go parity suite | Status |
|---|---|---|---|---|---|
| 1 | `types.ts`, `plan.ts`, `risk.ts` (pure sizing/risk/solve) | `internal/{risk,sizing,planner}` | `executor-plan-tests.ts`, `executor-risk-tests.ts` | `risk_test.go`, `sizing_test.go`, `plan_test.go` (69 funcs) | DONE |
| 2 | `engine.ts` strategy FSM (`transitionChildOrder`, `strategyStep/OnFill/Progress`, `defaultSlices`) | `internal/{execution,strategy,orders}` | `executor-engine-tests.ts` | `execution_test.go`, `strategy_test.go`, `orders_test.go` | DONE |
| 3 | `store.ts` persistence (`executor.*` writes) | `internal/repository` | `executor-store-tests.ts` | `store.go` + `credentials.go` (sealed envelope read/touch) | DONE (SQL mirrors DDL; DB-integration gated on `FUDCOURT_PG_DSN`) |
| 4 | `lock.ts` | `internal/lock` (Memory + Valkey, lock.ts Lua) | `executor-worker-tests.ts` (lock paths) | `lock_test.go`, `memory_test.go`, `valkey_test.go` | DONE |
| 5 | `exchange.ts` + binance/bybit/mexc + `CcxtLike` | `internal/exchange` + adapters + `paper` | `executor-exchange-tests.ts` | `exchange/*_test.go` (85 funcs) | DONE |
| 6 | worker loop (recovery pass, MaxInFlight, lease fail-closed, risk-stop) | `internal/worker` | `executor-worker-tests.ts` | `worker_test.go` | DONE |
| 7 | `idempotency` / engine-state resume | `internal/idempotency` | `executor-runtime-tests.ts` | `idempotency_test.go` | DONE |
| 8 | key custody (`masterKeyFromEnv`, seal/unseal interop) | `internal/credentials` | crypto golden vectors (`apps/web/src/platform/crypto`) | `credentials_test.go` (TS-generated vector cited in test header) | DONE |
| 9 | runtime/service wiring (`cmd` entrypoint, env config, shutdown) | `cmd/executor` + `lease.go` bridge | `executor-runtime-tests.ts` | config/lease-adapter tests; fail-closed startup proven | DONE |
| 10 | executor UI (`executor-ui-tests.ts`) | — (stays in `apps/web`) | `executor-ui-tests.ts` | — | N/A |

## Cutover row (Phase 5/7, migration-plan)

| Gate | Proof required | Status |
|---|---|---|
| All rows 1–9 `DONE` | this matrix | **DONE 2026-10-01** (19 packages green, 266+ test funcs) |
| Composed Go paper E2E harness (`internal/e2e/paper_e2e_test.go`) drives worker + paper venue + lease + store together through the §127 scenario | `go test ./services/executor/internal/e2e/` | **DONE 2026-10-01** — 12 tests, hermetic (no PG/Valkey/creds/network), covers create→place→fill→complete, TWAP multi-child schedule (§107), lease contention, restart-no-duplicate-order, cancel-resting, duplicate-start-noop, disconnect-degrade-then-recover, rejected-order-then-replaces, partial-fill-then-complete, pause/resume, reconciliation-mismatch (§94), plan/risk sizing; stable under `-race -count=3` |
| `verify:executor` (`executor-paper-e2e.ts`) green against the **Go** worker | `ALL PAPER-MODE CHECKS PASSED (§127)` (2026-10-01, Bun.sql + real `executor` schema on :5433 + real Valkey lock + real worker) | **DONE for the TS runtime** — the harness exercises the TS runtime against live Postgres/Valkey. The Go-worker cutover itself stays OPEN: `cmd/executor` still exposes only `/healthz` + `/readyz`, so the 13 `/api/executor/*` routes have no Go counterpart yet |
| EXECUTOR DDL lifted to `database/schema/executor-schema.sql` as the sole owner (store DDL byte-identity stays PASS) | `database/schema/executor-schema.sql` + store tests | OPEN |
| TS modules deleted + `test:shapers` still green on what remains | `bun run test:shapers` | OPEN |

*Last updated 2026-10-01 (rows 1–9 verified green by Main; 3/8/9 delegated and running; composed Go paper E2E added 2026-10-01).*
