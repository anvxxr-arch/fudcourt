# Domain Map — today's owner → target owner

> Phase 0 audit. "Today" = working tree 2026-10-01 (Phase 1/2 moves committed as `4e8ba91`;
> Go scaffolds `services/{api,executor}` — since renamed `backend/api` + `backend/workers/executor`
> — started in the uncommitted wave). Paths are repo-relative.
>
> **Amended 2026-10-01 (api bounded-context regroup):** `apps/api/internal/` was regrouped
> from a flat package set into explicit bounded contexts (`access/`, `accounts/`, `finance/`,
> `markets/`) — the as-built layout is §4 below, the ownership mapping stays §1. No behavior,
> route, response shape, error code or exported symbol changed; the module path is unchanged.
>
> Sources cross-checked read-only: `ARCHITECTURE.md` §2 (System picture) + §4 (Data families)
> define the domains, §8b (CEX Executor runtime) the execution-plane boundary;
> `TECH-STACK.md` §2/§4/§5/§6 the acquisition stack and infra; `SCHEMA.md` §1–§3 the table and
> envelope reality this map's Table/contract rows are drawn from.

## 1. Domain → owning module (today) → target location

| Domain | Today (module) | Today (path) | Target |
|---|---|---|---|
| auth / sessions | web platform | `apps/web/src/platform/auth/*` (session, guard, discord, mutation) | `backend/api` (auth), web keeps UI login |
| accounts / members | web | `apps/web/src/app/(frontend)/api/admin/members`, `src/features/*` | `backend/api` |
| portfolio | web | `apps/web/src/features/{portfolio,treasury,wallets,transactions}/*.tsx` | `backend/api` (portfolio) |
| wallets | web | `api/wallets/route.ts` + `features/wallets/ui.tsx` | `backend/api` (wallets) |
| transactions / ledger | web | `api/transactions{,/[id]}` + `features/transactions/ui.tsx` | `backend/api` (transactions, treasury) |
| treasury reconciliation (query side) | web | `api/reconcile/route.ts` (proxies Rust) | `backend/api` reads via `backend/sync` |
| markets / venues / prices (read) | web | `api/{markets,ticker,ticker/instrument(s)}`, `features/{markets,ticker}/*` | `backend/api` (markets) |
| data acquisition | Go sidecar | `apps/data/internal/research/{llama,cryptorank,khala,chainrank,news,coinglass,coinank,coinmarketcap}` (ex-`apps/apicalls`) | `backend/data` (already moved) |
| data caching | Go + TS | `apps/data/platform/cache`, `apps/web/src/platform/cache` | `backend/data` |
| stream sync / balances | Rust | `apps/reconciler/src/streams/sync.rs` + `{chains,jsonrpc,pyfmt}.rs` + `persistence/db.rs` + Python twin `tests/oracle/sync-live.py` | `backend/sync` (already moved; Phase 6 specializes) |
| reconciliation maths | Rust + TS twin | `apps/reconciler/src/reconciliation/reconcile.rs` vs `apps/web/src/app/(frontend)/api/reconcile/route.ts` | `backend/sync` |
| event normalization | Rust (partial) | `apps/reconciler/src/jsonrpc.rs`, `streams/sync.rs` | `backend/sync` |
| executor orchestration (command/API) | web | `apps/web/src/app/(frontend)/api/executor/**` (16 routes) | `backend/api` (executor orchestration) |
| executor planning | web | `apps/web/src/platform/executor/plan.ts` | `backend/workers/executor` (planner) |
| risk & sizing | web | `apps/web/src/platform/executor/risk.ts` | `backend/workers/executor` (risk, sizing) |
| strategies (market/limit/TWAP/adaptive-TWAP/iceberg/chase-limit/scale — **not** VWAP or smart-limit) | web | `apps/web/src/platform/executor/engine.ts` (`defaultSlices`, `createStrategy`, `strategyStep/OnFill/Progress`) | `backend/workers/executor` (strategies) |
| exchange adapters (binance/bybit/mexc) | web | `apps/web/src/platform/executor/exchange.ts` (`CcxtLike`, symbol mapping) | `backend/workers/executor` (exchange adapters) |
| exchange signing / keys | web | `apps/web/src/platform/executor/store.ts` (`masterKeyFromEnv`) + `exchange.ts` | `backend/workers/executor` (signing) |
| execution worker | web (Bun) | `apps/web/scripts/executor/worker.ts` + `src/platform/executor/worker.ts` | `backend/workers/executor` (worker) |
| execution state machine | web | `src/platform/executor/{engine,worker}.ts` (`transitionChildOrder`, `clampChild`) | `backend/workers/executor` (state machine) |
| execution locks | web | `src/platform/executor/lock.ts` | `backend/workers/executor` |
| execution persistence | web | `src/platform/executor/store.ts` (`EXECUTOR_DDL`, `executor.*`) | `backend/workers/executor` (persistence) |
| executor UI | web | `apps/web/src/features/executor/{ui.tsx,client.ts,shapers.ts}` + `app/(frontend)/(dashboard)/executor/**` pages | `frontend/web` (stays, via `shared/sdk/typescript`) |
| CMS / blog | web | `apps/web/src/app/blog/**`, `src/cms/**` (Payload) | `frontend/web` (frontend-only exception: content, no domain logic) |

## 2. Table ownership mapping

| Table(s) | Today (schema + writer) | Target owner | Target location |
|---|---|---|---|
| `users`, `members` (admin) | web `platform/auth`, admin UI; no dedicated table yet (Payload `users` in `src/cms`) | api | `db/schema/accounts.sql` |
| `wallets` | `db/schema/pg-schema.sql`; web treasury | api | `db/schema/portfolio.sql` |
| `accounts`, `trades`, `journal`, `ledger`, `transactions` | same; web treasury + `backend/sync` writes `assets`-adjacent rows | api | `db/schema/portfolio.sql` |
| portfolio (derived from `ledger`/`positions`) | web treasury UI | api | `db/schema/portfolio.sql` |
| `execution` (`executor.executions`, `executor.execution_plans`) | `apps/web/src/platform/executor/store.ts` | executor | `db/schema/execution.sql` |
| `execution_orders` (`executor.child_orders`) | same | executor | `db/schema/execution.sql` |
| `execution_fills` (`executor.fills`) | same | executor | `db/schema/execution.sql` |
| `execution_events` (`executor.execution_events`) | same | executor | `db/schema/execution.sql` |
| `executor.{balance_snapshots,positions_snapshots,risk_profiles,audit_logs,exchange_accounts}` | same | executor | `db/schema/execution.sql` |
| `analytics` (`assets`, `asset_history`, `price_history`) | `backend/sync` + `tests/oracle/sync-live.py` (Postgres `assets`) + `backend/data` (upstream values) | data + sync | `db/schema/analytics.sql` |
| `venues` | web markets + sync chains registry | api (read) / sync (write) | `db/schema/markets.sql` |

Naming note: today's physical names (`executor.*` schema, `child_orders`, `fills`) map to the
target's logical names (`execution_orders`, `execution_fills`); renaming happens in Phase 2/5.
**Re-read 2026-10-01 (docs-reality pass):** the `db/schema/*.sql` filenames in the "target
location" column are the **Phase-2 proposal** and were never created — the tree holds exactly
three schema files, `db/schema/{pg-schema.sql,executor-schema.sql}`, and
`database/migrations/` is deliberately absent (DR-020). Read that column as "which schema file
would own this table if the split were made".

## 3. Cross-boundary import violations (file paths)

### 3.1 Web frontend imports executor runtime internals (target: MUST NOT — backend/workers/executor owns these)

All 20 production files below import `@/platform/executor/…`; those marked **[sensitive]** also
import the risk/exchange/lock/store/plan/engine modules directly (signing, keys, persistence,
state machine — the exact concerns `target.md` §3.2 forbids in web):

**API routes (16) — all [sensitive]:**
- `apps/web/src/app/(frontend)/api/executor/accounts/route.ts`
- `apps/web/src/app/(frontend)/api/executor/accounts/[id]/route.ts`
- `apps/web/src/app/(frontend)/api/executor/accounts/[id]/test/route.ts`
- `apps/web/src/app/(frontend)/api/executor/executions/route.ts`
- `apps/web/src/app/(frontend)/api/executor/executions/[id]/route.ts`
- `apps/web/src/app/(frontend)/api/executor/executions/[id]/start/route.ts`
- `apps/web/src/app/(frontend)/api/executor/executions/[id]/pause/route.ts`
- `apps/web/src/app/(frontend)/api/executor/executions/[id]/resume/route.ts`
- `apps/web/src/app/(frontend)/api/executor/executions/[id]/cancel/route.ts`
- `apps/web/src/app/(frontend)/api/executor/executions/[id]/orders/route.ts`
- `apps/web/src/app/(frontend)/api/executor/executions/[id]/fills/route.ts`
- `apps/web/src/app/(frontend)/api/executor/executions/[id]/events/route.ts`
- `apps/web/src/app/(frontend)/api/executor/preview/route.ts`
- `apps/web/src/app/(frontend)/api/executor/settings/route.ts`
- `apps/web/src/app/(frontend)/api/executor/emergency/route.ts`
- `apps/web/src/app/(frontend)/api/executor/accounts/route.ts` (list/create shares imports with `[id]`)

**Workers/tools — [sensitive]:**
- `apps/web/scripts/executor/worker.ts`
- `tests/e2e/executor/executor-paper-e2e.ts`

**Feature UI (executor UI may keep calling the API, but imports runtime types/logic today):**
- `apps/web/src/features/executor/client.ts`
- `apps/web/src/features/executor/ui.tsx`

**Test-only (moves with Phase 5/8, listed for completeness):**
- `tests/e2e/executor/executor-{engine,plan,risk,runtime,worker}-tests.ts` +
  `tests/integration/executor/executor-{exchange,store}-tests.ts`
- `apps/web/tests/executor-ui-tests.ts`

### 3.2 Shell layer imports feature pages (layering inversion inside frontend/web)

- `apps/web/src/components/layout/store-shell.tsx` imports `@/features/{dashboard/ui,
  portfolio/ui, wallets/ui, transactions/ui, treasury/reconciliation, dex/trench, dex/ui,
  signals/ui, scoreboard/ui, …}` (feature modules; the former `chainrank/ui` import left with
  the board, DR-041).
  Acceptable while `frontend/web` is UI-only; MUST NOT migrate into `shared/*` or services.

### 3.3 Platform-internal coupling (fine today, becomes backend/workers/executor internals)

- `apps/web/src/platform/executor/{engine,worker,runtime}.ts` import
  `platform/executor/{plan,risk,exchange,store,lock,types}` — single-module-family coupling;
  not a violation per se, but every one of these files is in the Phase-5 move set.

### 3.4 Cross-app source imports (Go/Rust ↔ TS)
- **None found.** `backend/data` (Go) and `backend/sync` (Rust) contain no references to
  `frontend/web` source; coupling is HTTP (`/api/reconcile` proxy), the shared Postgres
  `public` tables, and shared `.sql` files only. (Docs/comments in Rust reference `tests/oracle/sync-live.py` as the oracle —
  documentation references, not imports.)

### 3.5 Dual-implementation debt (same domain in two languages, both live)

- Balance sync: `apps/reconciler/src/main.rs` + `apps/reconciler/src/streams/sync.rs` **and** `tests/oracle/sync-live.py`,
  each with its own systemd unit (`deploy/systemd/fudcourt-sync-rust.service` vs
  `deploy/systemd/fudcourt-sync.service`). Phase 6 collapses to Rust after oracle parity.
- Reconcile: `apps/reconciler/src/reconciliation/reconcile.rs` **and** `apps/web/…/api/reconcile/route.ts`
  (route proxies the Rust service, verified byte-parity in CI `verify/verify-reconcile.py`).

### 3.6 Scaffolds started after this audit snapshot (historical — the scaffolds are now built)
> **Superseded 2026-10-01:** the paragraph below records the uncommitted state this audit saw.
> Those scaffolds were committed and then completed; `apps/api/internal/` has since been
> regrouped into bounded contexts (see §4, "backend/api package layout (as-built)"), and
> `backend/data` + `backend/sync` were regrouped by their own lanes.
- Uncommitted as of this writing (post-`4e8ba91`): `backend/api/` (Go: `cmd/api`,
  `internal/{identity,credentials,authorization,platform/{errs,health,httpx}}`),
  `backend/workers/executor/` (Go: `internal/{decimal,exchange,executor}` — `records.go`/`types.go`
  already pin `db/schema/executor-schema.sql` as their reference), `packages/`, `go.work`,
  and the `deploy/systemd/` consolidation (units moved from per-app `infrastructure/` folders into one
  repo-level folder; the Python-vs-Rust `fudcourt-sync` name collision resolved as
  `fudcourt-sync.service` (Python) vs `fudcourt-sync-rust.service` (Rust)). Those paths are now
  `shared/` (not `packages/`) and `backend/workers/executor` is committed.
- The TS execution plane (§3.1) remains the live implementation until Phase 5's parity gate
  allows deletion.
> **Re-read 2026-10-01 (docs-reality pass):** nothing in this section is current — the
> "uncommitted" scaffolds it lists were committed, and there is no `packages/` or `services/`
> directory in the tree. The as-built homes are `shared/contracts` + `shared/sdk/typescript`
> (not `packages/*`), `backend/api` (not `services/api`) and `backend/workers/executor` (not
> `services/executor`).
## 4. `backend/api` package layout (as-built, 2026-10-01)
The module `github.com/anvxxr-arch/fudcourt/backend/api` hosts ONE process (`cmd/api`) whose
`internal/` is grouped by bounded context. A directory exists only where real code lives —
there is deliberately no `bank/`, `cash/`, `sources/`, `finance/assets`, `finance/valuation`,
`executor/` or `admin/` package.
```
internal/
├── access/          identity/ authorization/ entitlements/ credentials/
├── accounts/        exchange/ (was exchangeaccounts/)  wallets/
├── finance/         ledger/ portfolio/ treasury/ transactions/
├── markets/         instruments/ overview/ (was markets/)
├── notifications/   audit/   jobs/
├── platform/        errs/ health/ httpx/          cmd/api/ = main.go, routes.go, errors.go,
└── (18 packages)                                  cookies.go, discord.go (+ tests)
```
Judgment calls, with their evidence:
- **`wallets` → `accounts/wallets`.** `wallets.go` is the metadata of a `wallets` table row
  (`db/schema/pg-schema.sql:77`, `pg-schema.sql:95`; written by `backend/sync`), not a derived
  holding — it is the durable source record, so it belongs to the account side. Its defining rule
  is chain-address-only and refuses CEX names (`WALLET_CHAIN_IS_EXCHANGE`), and it is exactly the
  pairing the browser talks to as `/api/wallets` beside the CEX accounts.
- **`exchangeaccounts` → `accounts/exchange`.** The package name stays `exchangeaccounts` (no
  exported-symbol or package-name churn); only the directory is named `exchange`, so the accounts
  context reads `exchange/` + `wallets/` exactly as the spec's `accounts/ exchange/ wallets/`
  sketch. No `bank/`, `cash/` or `sources/` module is justified by existing functionality.
- **`instruments` and `markets` are NOT merged.** They are two halves of the read side, not two
  spellings of one: `markets` is the *market-data value model* (Ticker/Candle/Book/MarkPrice/
  FundingRate/OpenInterest + their validators and the touch-pair snapshot) while `instruments` is
  the *tradable-instrument identity + grid* model and the only real computation (venue-symbol
  normalization, `RoundQuantityDown`, `RoundPrice`). Merging would put the whole execution-sizing
  grid into the market-data package, and `markets` already refers to `instruments.CanonicalSymbol`
  in prose (`market.go:40`) without importing it — the boundary is a real seam with zero code
  coupling between them today. The spec's own sketch names them separately
  (`markets/ instruments/`), so the split is honored, not inflated.
- **The six self-contained decimal helpers are kept** (five `decimal.go` copies under
  `finance/{ledger,portfolio,treasury,transactions}` + `markets/overview`, plus
  `markets/instruments/rounding.go` which carries its own `parseDecimal`): each is a deliberately
  self-contained helper for its own domain (the accepted grammar differs per caller — see each
  file's header), and the spec forbids cross-domain implementation sharing. Consolidating them
  into one shared package would create exactly the cross-domain coupling the restructure exists to
  remove, and none of them imports another domain.
- **`executor/` is NOT created.** It is a facade name (commands/queries over the real engine in
  `backend/workers/executor`) and no api-side executor code exists today; per the spec's own rule,
  no empty placeholder package is created. The route plane lives in `cmd/api/{routes,errors}.go`
  and the admin plane is likewise a route plane, not an `internal/admin` package.
