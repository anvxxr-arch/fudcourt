Read:
- .ai/restructure-fudcourt.md
- docs/prd/cex-executor.md
- docs/architecture/*
- existing apps/web/src/platform/executor implementation
- existing executor tests

Act as the FUDCourt Executor Migration Agent.

Your only responsibility is migrating the executor domain from TypeScript backend runtime into services/executor written in Go.

Do not change frontend UX.
Do not redesign unrelated domains.
Do not remove the existing TypeScript implementation prematurely.

First derive current behavior and tests.

Then migrate incrementally:

1. domain types
2. sizing
3. risk
4. planning
5. exchange abstraction
6. Binance adapter
7. Bybit adapter
8. MEXC adapter
9. execution state machine
10. worker runtime
11. persistence
12. idempotency
13. recovery
14. reconciliation integration

For every migrated unit:
- create Go tests
- compare behavior with existing TypeScript implementation
- preserve precision and rounding behavior
- preserve exchange-specific constraints through adapters

Never allow retries or worker restarts to create duplicate exchange orders.

Do not delete TypeScript runtime until equivalent Go tests and integration tests demonstrate parity.

Run relevant tests after every coherent migration step.

Finish with a parity matrix showing: TypeScript feature | Go feature | test coverage | migration status.

## Parity gates (added 2026-10-01 after interim architecture review)

These gates are MUST-level preconditions derived from an independent review of the in-flight Go port. Do not evaluate the "delete TypeScript" gate until every item is satisfied with test evidence:

1. **Sizing + planner parity tests green.** `services/executor/internal/sizing` and `internal/planner` must have parity tests against the TS oracles (`scripts/tests/executor-plan-tests.ts`, `executor-risk-tests.ts` vectors). Seed files `plan_test.go` / `sizing_test.go` landed in-flight on 2026-10-01 — confirm them green and extend until every TS vector class is covered.
2. **Durable Store before any deployment claim.** The only `worker.Store` implementation was `MemoryStore` (test-only). `internal/repository` (Postgres) MUST exist and be exercised by tests before any worker deployment or persistence claim. In-memory state is never the source of truth for active executions.
3. **Restart-safe event ids before event-sink/audit work.** `event_id` MUST be deterministic per execution from the durable store (e.g. per-execution sequence persisted with the event). A per-process counter (`evt_<exec>_<seq>`) silently drops events after restart because duplicate-id appends are ignored — fix before anyone builds audit/compliance on the event log.
4. **Complete the canonical event catalog before event work.** `packages/contracts/events` MUST define all 17 canonical events. As of 2026-10-01 missing: `OrderPlanned`, `OrderAccepted`, `PositionUpdated`, `BalanceUpdated`.
RESOLVED 2026-10-01: catalog.json holds 28 canonical event ids incl. the four named above; the TS side keeps 22 legacy SCREAMING_SNAKE aliases by design until the TS executor is deleted. Do NOT re-add these events.
5. **request_id idempotency before live-mode cutover.** Implement `request_id` (plan EXECUTOR SAFETY). Duplicate-order protection currently rests on venue-side clientOrderId dedup, verified only by fixture replay — prove it against a real venue (paper/low-size) before enabling live mode.
6. **Honest status claims.** Never mark a module "landed" in docs or headers before its tests exist. Historical example (since resolved same-day): `docs/architecture/executor.md` marked sizing "landed" while `internal/sizing` still had zero tests; the parity tests landed later the same day. Unresolved as of 2026-10-01: `services/api/cmd/api/main.go` lists "admin" as hosted while `internal/admin` does not exist — fix the comment or create the package; such claims misdirect migration gates.

Acceptance for this section: none — it is instructions for the executing agent.
