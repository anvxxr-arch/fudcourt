# Target Architecture — FUDCourt

> Phase 0 deliverable of the domain restructure (2026-10-01). This is the
> destination; `current.md` is the reality; `migration-plan.md` is the ordered
> path between them. Evidence-first rule from `ARCHITECTURE.md` applies here too:
> when this file and the code disagree, the code wins and this file is wrong.

## North star

```text
Modular monorepo
+ domain-driven boundaries
+ Go-first backend
+ specialized Rust
+ thin Next.js frontend
+ PostgreSQL durable truth
+ Valkey ephemeral coordination
+ contract-first communication
+ independently deployable runtime services
```

One line: **Go decides. Rust observes/reconciles fast. PostgreSQL remembers.
Valkey coordinates. Next.js presents. Contracts connect everything.**

## Target repository tree

```text
fudcourt/
├── apps/
│   └── web/                    # Next.js 16 + Payload CMS: UI, SSR, thin BFF
├── services/
│   ├── api/                    # Go: primary backend API (modular domains)
│   ├── executor/               # Go: execution engine, risk, sizing, strategies, adapters
│   ├── data/                   # Go: external data aggregation (was apps/apicalls)
│   └── sync/                   # Rust: streams, normalization, reconciliation (was apps/sync)
├── packages/
│   ├── contracts/              # openapi/ + events/ + schemas/ — canonical contracts
│   ├── sdk-ts/                 # generated/typed TS client from contracts
│   └── config/                 # shared technical configuration conventions
├── database/
│   └── schema/                 # canonical DDL + table-ownership map
├── tests/
│   ├── integration/            # cross-service behavior
│   ├── e2e/                    # system-level, paper exchange
│   ├── fixtures/               # recorded payloads (tamper-evident)
│   └── oracle/                 # independent-oracle scripts (anti-self-confirmation)
├── deploy/
│   ├── systemd/                # versioned user units (single home, was apps/*/deploy)
│   ├── docker/                 # container definitions if/when needed
│   └── compose/                # local dev stack (Postgres + Valkey)
├── scripts/{dev,verify,database,release}/
├── docs/{architecture,operations,records,prd,product}/
├── .github/workflows/          # path-filtered: web, go, rust, contracts, integration
├── go.work                     # Go workspace: services/* modules
├── Cargo.toml                  # Rust workspace: services/sync
├── package.json / bun.lock     # JS workspace root (task running + tooling)
└── README.md
```

Adaptation notes (repo evidence governs, objective says "adapt where
appropriate"):

- `database/migrations`, `seeds`, `fixtures` appear **only when real content
  exists**. Today's schema has exactly three DDL documents and two documented
  "no migration runner" decisions (DR-020 executor DDL; Payload CMS owns its own
  Neon migrations under `apps/web/src/cms/migrations`). No fake migration
  framework is introduced (objective §57).
- `deploy/docker` and `deploy/compose` are created when there is a real
  container/compose need; the homeserver is systemd (DR-002).
- Unit **names** on the host (`fudcourt-web`, `fudcourt-apicalls`,
  `fudcourt-reconciled`, `fudcourt-sync.timer`, `fudcourt-executor-worker`,
  `fudcourt-pgload`) are an operational identity; directory moves never silently
  rename a running unit.

## Target runtime processes

| Process | Language | Role | Decides? |
|---|---|---|---|
| `web` (Next.js) | TS | UI, SSR, forms, presentation, thin BFF, Payload CMS | no — presents |
| `api` (Go) | Go | identity, authorization, entitlements, credentials, exchange accounts, instruments, ledger, portfolio, treasury, wallets, transactions, notifications, audit, jobs | yes — business rules |
| `executor` (Go) | Go | execution lifecycle, planner, risk, sizing, strategies, orders, exchange adapters, worker, recovery | yes — execution decisions |
| `data` (Go) | Go | external data aggregation & normalization (cryptorank, chainrank, llama, news, khala; later market data) | yes — provider contract rules |
| `sync` (Rust) | Rust | exchange streams, event normalization, reconciliation | no — observes and reports facts |

Exactly these five. Domains are **modules inside processes**, not processes
(§51): `identity-service`, `ledger-service` etc. are explicitly *not* created.
A domain earns its own process only via the extraction criteria in
`migration-plan.md` (independent scaling/availability/security/throughput).

## Dependency rules

Allowed: `web → sdk-ts, api`; `api → contracts, PostgreSQL, Valkey, executor API,
data API`; `executor → contracts, PostgreSQL, Valkey, exchange adapters`;
`data → contracts, external providers`; `sync → contracts, PostgreSQL, Valkey,
exchange streams`.

Forbidden: `web → executor internals / exchange signing / executor workers`;
`executor → Next.js source`; `sync → frontend source`; `data → executor
internals`; **any service → another service's internal packages**. Services
share contracts, generated clients and technical configuration — never business
implementations.

## Data ownership

- **PostgreSQL = durable truth**: financial records, executions, orders, fills,
  events, credentials (sealed), audit, user/account state, durable jobs.
- **Valkey = ephemeral**: cache, distributed locks (execution/account
  sync/reconciliation), rate-limit state, pub/sub. Never the only copy of
  anything that matters (objective §39; DR-021's fail-closed execution lease is
  a lock, and durable execution state is in `executor.*`).
- **Turso (libsql)** is the *current* system of record for the treasury family
  (DR-019) with a local Postgres+TimescaleDB read model. Target direction keeps
  PostgreSQL as canonical for executor/financial records already; the treasury
  store migration is deliberately **not** part of this restructure (no
  destructive DB migration, §11) and is tracked as P1 debt.

## Domain placement (one-line ownership)

| Domain | Home | Answers |
|---|---|---|
| identity | `services/api/internal/identity` | who is this actor? (users, sessions, roles, tokens) |
| authorization | `services/api/internal/authorization` (colocated with identity initially) | may this actor do this? |
| entitlements | `services/api/internal/entitlements` | what does the plan/membership allow? |
| credentials | `services/api/internal/credentials` | sealed exchange secrets, rotation, revocation |
| exchangeaccounts | `services/api/internal/exchangeaccounts` | user's connected venue accounts |
| instruments | `services/api/internal/instruments` | canonical instrument normalization |
| market data | `services/data/internal/marketdata` | tickers/candles/books (future) |
| external data | `services/data/internal/{cryptorank,chainrank,llama,news,khala}` | provider aggregation (exists today) |
| executor | `services/executor` | execution lifecycle + orchestration |
| risk | `services/executor/internal/risk` | how much may this execution risk? |
| sizing | `services/executor/internal/sizing` | what quantity represents that risk? |
| orders | `services/executor/internal/orders` | canonical order/fill lifecycle |
| strategy | `services/executor/internal/strategy` | market/limit/twap/… decisions |
| exchange | `services/executor/internal/exchange` | venue adapters behind one interface |
| ledger | `services/api/internal/ledger` | canonical financial movement record |
| portfolio | `services/api/internal/portfolio` | derived holdings/PnL/exposure view |
| treasury | `services/api/internal/treasury` | internal capital tracking |
| wallets | `services/api/internal/wallets` | blockchain wallet metadata |
| transactions | `services/api/internal/transactions` | user-visible history (derived) |
| notifications | `services/api/internal/notifications` | Discord/Telegram/email/push delivery |
| audit | `services/api/internal/audit` | append-only actor/action/resource record |
| jobs | `services/api/internal/jobs` | scheduled sync/refresh/maintenance |
| observability | `services/*/internal/platform` | logs, health, correlation ids |

Full map with current code anchors: `domain-map.md`.

## Performance posture

Internal APIs (no external provider): p50 < 20 ms, p95 < 100 ms, p99 < 250 ms
aspirational. Executor planning: risk/sizing in very low milliseconds. Design
rules: pooled connections, instrument-metadata cache (never per child order),
bounded worker concurrency, context deadlines, no unbounded goroutines, no
JSON churn in hot paths. Measure before optimizing (DR-019's pattern).

## Security posture

Encrypted exchange credentials (AES-256-GCM per field, master key outside the
DB — DR-021), `credential_id` references everywhere except the single
server-side reveal path, no secrets in logs/events/audit/URLs/frontend state,
fail-closed auth and live-trading kill switch, idempotent execution commands,
DB-enforced uniqueness for execution/order/event ids, append-only audit.
