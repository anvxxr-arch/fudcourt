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
