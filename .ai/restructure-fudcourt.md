You are the lead architecture and refactoring agent for the FUDCourt monorepo.

Your task is to restructure the repository into a clean, scalable, high-performance domain architecture while preserving existing behavior.

You are authorized to inspect, move, create, modify, and delete project files when required, but you MUST follow the migration constraints below.

# PRIMARY OBJECTIVE

Transform FUDCourt from a Next.js-centric repository containing mixed frontend/backend/runtime responsibilities into a domain-oriented monorepo with:

- Next.js + Bun for frontend
- Go for primary backend services and executor
- Rust for streaming/reconciliation/high-throughput workloads
- PostgreSQL for durable state
- Valkey for cache, locks, queues, and ephemeral coordination
- OpenAPI/event schemas for contracts

Target repository structure:

fudcourt/
├── apps/
│   └── web/
├── services/
│   ├── api/
│   ├── executor/
│   ├── data/
│   └── sync/
├── packages/
│   ├── contracts/
│   ├── sdk-ts/
│   └── config/
├── database/
├── tests/
├── deploy/
├── scripts/
├── docs/
└── .github/

# ARCHITECTURAL RULES

apps/web:
- Next.js frontend
- UI and presentation
- SSR
- forms
- client/server data fetching
- optional thin BFF/proxy
- Payload CMS may remain here when tightly coupled to Next.js

apps/web MUST NOT permanently own:
- executor runtime
- risk engine
- order sizing engine
- exchange API adapters
- exchange signing
- execution workers
- distributed locks
- reconciliation
- core backend persistence

services/api:
- Go
- primary application API
- authentication
- authorization
- accounts
- members
- portfolio
- wallets
- transactions
- treasury
- markets API
- executor-facing API/orchestration

services/executor:
- Go
- execution planner
- risk engine
- position/order sizing
- execution strategies
- TWAP
- VWAP
- iceberg
- smart limit
- exchange adapters
- worker runtime
- execution state machine
- idempotency
- retries
- locking
- execution persistence

services/data:
- Go
- external data providers
- DefiLlama
- CryptoRank
- Khala
- ChainRank
- news
- third-party API aggregation
- caching

services/sync:
- Rust
- exchange websocket streams
- order/fill streams
- reconciliation
- event normalization
- high-throughput streaming workloads

packages/contracts:
- OpenAPI definitions
- event definitions
- shared schemas
- canonical service boundaries

database:
- schemas
- migrations
- seeds
- fixtures

PostgreSQL:
- durable source of truth

Valkey:
- cache
- locks
- transient queues
- ephemeral coordination
- pub/sub where appropriate

# CRITICAL CONSTRAINTS

Do NOT perform a big-bang rewrite.

Do NOT rewrite working code merely for style.

Do NOT introduce Kubernetes, Kafka, NATS, service mesh, or additional infrastructure unless existing code already requires it.

PostgreSQL and Valkey are sufficient for the current architecture.

Do NOT change public API behavior unnecessarily.

Do NOT change frontend URLs unnecessarily.

Do NOT perform destructive database migrations.

Do NOT remove the existing TypeScript executor until Go parity is demonstrated through tests.

Do NOT duplicate business logic permanently across TypeScript and Go.

Do NOT move executor core business logic into Rust.

Do NOT create unnecessary microservices.

Prefer a small number of strongly bounded services.

Use git mv whenever practical when relocating existing files.

Preserve Git history.

Do not discard unrelated local changes.

Inspect git status before making changes.

# DOMAIN DEPENDENCY RULES

Allowed:

web -> contracts/sdk
web -> API

api -> contracts
api -> PostgreSQL
api -> Valkey
api -> executor
api -> data

executor -> contracts
executor -> PostgreSQL
executor -> Valkey
executor -> exchange adapters

data -> contracts
data -> PostgreSQL/Valkey when required

sync -> contracts
sync -> PostgreSQL
sync -> Valkey
sync -> exchange streams

Forbidden:

web -> executor implementation
web -> sync implementation
executor -> Next.js implementation
sync -> frontend code
data -> executor internals

Services may share contracts.

Services must not share domain implementations through cross-service imports.

# PHASE 0 — AUDIT

Before changing architecture:

1. Inspect repository structure.
2. Inspect git status.
3. Discover build commands.
4. Discover test commands.
5. Discover all Next.js API routes.
6. Discover PostgreSQL schemas.
7. Discover executor modules.
8. Discover Go packages.
9. Discover Rust crates.
10. Discover systemd services.
11. Discover CI workflows.
12. Find imports crossing architectural boundaries.

Create:

docs/architecture/current.md
docs/architecture/target.md
docs/architecture/domain-map.md
docs/architecture/migration-plan.md

Document existing failures before changing anything.

Run all reasonable baseline tests/builds.

Do not treat pre-existing failures as regressions.

# PHASE 1 — TOP LEVEL STRUCTURE

Move:

apps/apicalls -> services/data
apps/sync -> services/sync

Update all affected:

- imports
- working directories
- deployment files
- systemd units
- CI
- scripts
- documentation

Do not refactor service logic during this phase.

Verify builds.

# PHASE 2 — DATABASE

Move database ownership out of apps/web.

Create:

database/
├── migrations/
├── schema/
├── seeds/
└── fixtures/

Move existing executor-schema.sql and pg-schema.sql appropriately.

Preserve compatibility.

Document table ownership.

Do not execute destructive schema changes.

# PHASE 3 — CONTRACTS

Create:

packages/contracts/
├── openapi/
├── events/
└── schemas/

Document existing APIs before redesigning them.

Start with executor APIs.

Define canonical execution/order/fill/event schemas.

Do not break existing frontend clients.

# PHASE 4 — GO API

Create services/api.

Use idiomatic Go structure:

services/api/
├── cmd/api/
│   └── main.go
│
└── internal/
    ├── auth/
    ├── accounts/
    ├── members/
    ├── portfolio/
    ├── wallets/
    ├── transactions/
    ├── treasury/
    ├── markets/
    ├── executor/
    └── admin/

Migrate endpoints incrementally.

Existing Next.js endpoints may temporarily proxy requests to the Go API.

Preserve existing external routes where practical.

# PHASE 5 — EXECUTOR

Create services/executor in Go.

Port executor modules incrementally from:

apps/web/src/platform/executor

Expected structure:

services/executor/
├── cmd/executor/
│   └── main.go
│
└── internal/
    ├── engine/
    ├── planner/
    ├── risk/
    ├── sizing/
    ├── execution/
    ├── strategy/
    ├── exchange/
    ├── worker/
    ├── events/
    ├── lock/
    └── repository/

Port in this approximate order:

1. canonical domain types
2. sizing logic
3. risk calculation
4. planner
5. exchange abstraction
6. exchange adapters
7. execution state machine
8. workers
9. pause/resume/cancel
10. persistence
11. recovery
12. reconciliation integration

Every migrated module must have tests demonstrating parity where practical.

Do not delete the TypeScript implementation until Go parity is verified.

# EXCHANGE ARCHITECTURE

Create a common exchange abstraction.

Core execution logic must not contain exchange-specific conditional branches for ordinary operations.

Adapters should exist under:

internal/exchange/binance
internal/exchange/bybit
internal/exchange/mexc

Normalize exchange-specific:

- symbols
- quantity precision
- price precision
- order status
- order types
- API errors
- balances
- positions
- fills

Core executor works with canonical domain types.

# EXECUTOR SAFETY

Execution operations must be idempotent.

Implement or preserve identifiers such as:

execution_id
request_id
event_id
client_order_id

Worker restart must not produce duplicate exchange orders.

Execution state must be recoverable from durable storage and exchange reconciliation.

Expected state model should support at minimum:

CREATED
VALIDATING
READY
RUNNING
PAUSED
CANCELLING
CANCELLED
COMPLETED
FAILED

Do not use in-memory state as the only source of truth for active executions.

# PHASE 6 — RUST SYNC

Keep business decisions in Go.

Use Rust for workloads where Rust provides clear value:

- websocket streams
- order/fill streams
- reconciliation
- event normalization
- high-rate ingestion
- CPU-sensitive processing

Do not migrate ordinary CRUD or orchestration into Rust without a demonstrated reason.

# PHASE 7 — FRONTEND CLEANUP

After backend parity exists, remove backend executor responsibilities from apps/web.

Final frontend domains should contain:

api clients
components
hooks
schemas
stores
UI utilities

Frontend must not contain:

exchange clients
executor workers
risk engine
core execution engine
distributed lock implementation

# PHASE 8 — TESTS

Keep unit tests close to implementation.

Move cross-service verification into:

tests/integration
tests/e2e
tests/fixtures
tests/oracle

Create or preserve a paper/mock exchange.

Test executor scenarios including:

fixed USD risk
percentage-based risk
profit-target sizing
spot
futures
long
short
leverage

TWAP
pause
resume
cancel

partial fill
rejected order
timeout
network failure
exchange disconnect
worker restart
duplicate requests
reconciliation mismatch

# PHASE 9 — CI

Split CI by responsibility.

Prefer:

.github/workflows/web.yml
.github/workflows/go.yml
.github/workflows/rust.yml
.github/workflows/contracts.yml
.github/workflows/integration.yml

Use path filters when practical.

Do not rebuild unrelated services for trivial changes.

# PHASE 10 — DEPLOYMENT

Normalize deployment definitions under:

deploy/systemd
deploy/docker
deploy/compose

Expected deployables:

fudcourt-web
fudcourt-api
fudcourt-data
fudcourt-executor
fudcourt-sync

Each service should be independently buildable and restartable.

# PERFORMANCE PRINCIPLES

Do not optimize blindly.

Preserve or establish benchmarks where practical.

Optimize:

- allocations in hot paths
- unnecessary serialization
- unnecessary network hops
- repeated database queries
- repeated exchange metadata fetching
- unnecessary frontend/backend transformations

Cache exchange metadata where safe.

Use connection pooling.

Avoid blocking executor workers on unrelated operations.

Do not sacrifice correctness for microbenchmarks.

# DEVELOPMENT SPEED PRINCIPLES

A developer should be able to identify ownership immediately.

Examples:

risk calculation:
services/executor/internal/risk

TWAP:
services/executor/internal/strategy/twap

Binance:
services/executor/internal/exchange/binance

portfolio API:
services/api/internal/portfolio

DefiLlama:
services/data/internal/llama

executor frontend:
apps/web/src/features/executor

If ownership remains ambiguous, improve the boundary.

# WORKFLOW

For every phase:

1. inspect
2. write/update plan
3. make smallest coherent change
4. format
5. run relevant unit tests
6. run relevant integration tests
7. run relevant build
8. fix regressions
9. update architecture documentation
10. continue to next safe change

Do not continue stacking known regressions.

If a pre-existing failure exists, document it and distinguish it from new failures.

Do not ask for clarification for issues that can be resolved safely by inspecting the repository.

Prefer evidence from the repository over assumptions.

# DEFINITION OF DONE

The restructure is complete when:

- apps/web no longer owns executor runtime
- apps/web no longer owns database schema
- apps/apicalls has become services/data
- Rust sync lives under services/sync
- services/api exists as the primary Go backend API
- services/executor owns executor business logic
- exchange adapters use a common abstraction
- PostgreSQL is the durable execution source of truth
- Valkey is used only for appropriate ephemeral coordination/cache/locking
- API contracts are centralized
- cross-service tests are outside apps/web
- each deployable has clear ownership
- CI is domain-aware
- services do not import implementation code from each other
- existing product behavior remains compatible
- migrated executor behavior has parity tests
- build/test status is documented

At the end, provide:

1. final repository tree
2. files moved
3. files created
4. files removed
5. architecture decisions
6. remaining technical debt
7. test/build results
8. known regressions, if any
9. recommended next optimization steps

Execute the work. Do not stop after only generating a plan unless continuing would risk data loss or require credentials unavailable in the repository.
