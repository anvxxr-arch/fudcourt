# Migration Plan — FUDCourt domain restructure

> Phase 0 deliverable (2026-10-01). Ordered, smallest-coherent-change phases.
> Hard rules (objective §11): no big-bang rewrite, no behavior redesign, no
> deletion of working TS executor code before Go parity is proven, no new
> infrastructure without demonstrated need, no destructive DB migration, `git mv`
> to preserve history, never overwrite uncommitted user work.

## Per-phase protocol (§48)

inspect → identify dependencies → document intent → smallest coherent change →
format → run affected tests → run affected builds → fix phase regressions →
update docs → **stop until the phase is stable**. No phase may leave a known
regression for a later phase. Every phase reports
Completed/Changed/Moved/Created/Deleted/Tests/Builds/Known failures/Risks/Next.

## Phases

| # | Phase | Scope | Acceptance |
|---|---|---|---|
| 0 | Audit + baseline | repo-wide inspection, `current.md`/`target.md`/`domain-map.md`/`migration-plan.md`, `docs/operations/BASELINE.md` | no production refactor |
| 1 | Top-level service restructure | `apps/apicalls → services/data`, `apps/sync → services/sync`; update module paths, CI, hook, scripts, units, docs | web/Go/Rust build+test ≥ baseline |
| 2 | Database ownership | `apps/web/db → database/schema`; table-ownership doc; update drift gates | schema drift gate + store tests green |
| 3 | Contracts | `packages/contracts` (openapi/events/schemas), `packages/config`, `packages/sdk-ts` generated types | contract docs cover real current routes; sdk types generated from the OpenAPI |
| 4 | Go API | `services/api` (cmd + internal), health/readiness, structured logs, request-id correlation, error envelope | `go build/test` green; serves `/healthz`+`/readyz` |
| 5 | Core domains | boundaries for identity/authorization/entitlements/credentials/exchangeaccounts/instruments/ledger/notifications/audit/jobs (real code where cheap, boundaries everywhere) | compiles; each domain has one owner package; no fake logic |
| 6 | Go executor structure | `services/executor` skeleton per §8.9 | builds; packages named |
| 7 | Risk + sizing port | deterministic math ported TS→Go with parity tests vs TS vectors | parity matrix rows green |
| 8 | Exchange abstraction | `internal/exchange` interface + registry + paper exchange | paper exchange runs full order lifecycle offline |
| 9 | Adapters | binance/bybit/mexc adapters behind the interface (ccxt-parity where measurable) | adapter contract tests (paper + mocked HTTP) |
| 10 | Lifecycle + strategies | explicit state machine, commands, strategy scheduling | invalid transitions rejected; tests green |
| 11 | Idempotency + recovery | request/client-order ids, restart recovery, duplicate protection | restart/duplicate tests green |
| 12 | Reconciliation integration | `sync` (Rust) reports facts → executor consumes | mismatch detection test green |
| 13 | Frontend cleanup | remove only what has Go parity; keep TS executor until parity matrix says otherwise | parity matrix honest; web still green |
| 14 | Cross-service tests | `tests/{integration,e2e,fixtures,oracle}` real content + mapping of host-integrated harnesses | tests run in CI |
| 15 | CI | path-filtered workflows `web/go/rust/contracts/integration` | each subsystem builds from its own workflow |
| 16 | Deployment | `deploy/systemd` single home for units; keep unit names; document host re-install | `check-deploy` covers new layout |
| 17 | Final audit + report | §74 search list; fix safe violations; final report | report evidence-backed |

## Parity gate (executor, §22)

The TS executor in `apps/web/src/platform/executor` stays **the production
implementation** until the Go port proves parity row by row (parity matrix lives
in `docs/architecture/executor.md`). Rows: risk modes (9 sizing modes), long/short,
spot/futures, leverage auto/manual, ladder sizing, strategies
(market/limit/twap/adaptive_twap/iceberg/chase_limit/scale_in/scale_out),
lifecycle (create/validate/start/pause/resume/cancel/complete/fail), partial
fills, worker restart recovery, over-order clamp, credential sealing.
Deletion of a TS path happens only when its Go row is `yes/yes/pass`.

## Domain extraction criteria (§53)

A domain becomes its own process only with: independent scaling, independent
availability, strong security boundary, high throughput, independent deploy
cadence, heavy resource use, or a clear owning team. Absent those, it stays a
module. "Microservices are scalable" is not a criterion.

## Compatibility windows

- Next.js API routes may proxy to `services/api` during migration (BFF kept
  where SSR/auth justify it; DR-003 session tiers are the auth seam).
- Host systemd units are re-pointed in the same change-set as any path move
  (repo units are the versioned source; the deployed copies must be re-installed
  by the operator runbook — `docs/operations/`).
- `fudcourt-sync` keeps its Python oracle (`sync-live.py`) until the Rust
  service has years-equivalent evidence per DR-005's oracle rule; the oracle
  lives under `tests/oracle/` conceptually but stays at its deployed path until
  the host unit is swapped (a path move must land together with the unit).
