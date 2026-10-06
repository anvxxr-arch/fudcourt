# db/ — schema ownership and consumers

> **Audited 2026-10-01** against the tree as it exists. Everything below is a
> statement about code that is in the repo today, with the line it was read from.
> Anything not built yet is in [Roadmap / INTENT](#roadmap--intent--not-done) and
> is marked **NOT DONE**. There are no aspirational claims presented as fact.
>
> **Updated 2026-10-03 (DR-040):** Postgres+TimescaleDB is now the SINGLE system
> of record and Turso/libSQL is dropped. The generated SQLite dump
> `schema/schema.sql`, its generator `scripts/database/dump-schema.mjs` and the
> whole `scripts/database/` directory are deleted; `schema/pg-schema.sql` is the
> only treasury schema. The Turso→Postgres projection
> (`frontend/web/scripts/tools/pg-load.ts`) and its `fudcourt-pgload.{service,timer}`
> are removed (retirement note:
> `deploy/systemd/RETIRED-fudcourt-pgload.service.txt`), and the web data
> module moved from `platform/db/mirror.ts` to `platform/db/pg.ts`.
>
> Moved here from `apps/web/db/` (Phase 2 of the domain restructure); DDL semantics
> were not changed by the move. Column-level documentation stays in
> `docs/architecture/SCHEMA.md`.
>
> **Note on the restructure:** the tree was renamed underneath this document in
> two commits (`8c902dc`: `apps/`→`frontend/`, `services/`→`backend/`,
> `packages/`→`shared/`, `deploy/`→`infrastructure/`; `44604ce`: `backend/data`
> providers grouped under `internal/research`, `internal/platform`). Every
> `path:line` below was re-read after `44604ce`; the `.sql` files themselves
> did not change. Where a doc reference in this file still names the pre-move
> path, it is listed under "Known stale references".

## Files

| File | Dialect / role | Objects | Shape owner |
|---|---|---|---|
| `schema/pg-schema.sql` | Postgres 17 + TimescaleDB — the treasury **system of record** (`public` schema) | the 8 treasury tables + `asset_history`, `price_history` (2 hypertables, 3 indexes) + the `assets_snapshot` trigger that appends every `assets` insert to `asset_history` | hand-written; applied to the `fudcourt` database in the `postgres-hardened` container on `127.0.0.1:5432` |
| `schema/executor-schema.sql` | Postgres `executor` schema (live execution ledger) | 20 statements: `CREATE SCHEMA`, 10 tables, 9 indexes | the executor runtime (`EXECUTOR_DDL` in `apps/web/src/features/executor/store.ts` READS this file; the Go worker applies a byte-pinned `embed` copy) |

Object lines: `pg-schema.sql` tables `:20,:27,:38,:50,:59,:71,:89,:95,:112,:132`,
hypertables `:122,:139`, indexes `:123,:127,:140`; `executor-schema.sql` `:24`
(schema), tables `:32,:58,:100,:106,:129,:147,:157,:165,:173,:179`, indexes
`:50,:95,:96,:124,:143,:154,:163,:171,:187`.

## Consumer map

`file -> consumers (path:line) -> verdict`

### `db/schema/pg-schema.sql` — the treasury schema (sole owner)

| Consumer | Kind |
|---|---|
| `apps/web/src/server/db.ts` (`pg()` client, `toPostgres()`, `DASHBOARD_READS`) | the app's Postgres client and dashboard read set; `apps/web/src/server/db.ts` (`query`/`execute`/`getAll`) is built on it |
| `tests/oracle/sync-live.py` (psycopg2) | the deployed balance sync — writes `assets` directly and runs the 90-day retention `DELETE` on `asset_history`/`price_history` |
| `apps/reconciler` (Rust, `tokio-postgres`) | the undeployed Rust sync writes the same tables; `fudcourt-reconciled` reads them for `/api/reconcile` |
| `db/schema/pg-schema.sql` (`assets_snapshot` trigger) | appends each `assets` INSERT to `asset_history`; snapshots are taken by the database, not by application code |
| `contracts/openapi/fudcourt.yaml:4322,:4399` → SDK `schema.d.ts:2227` | contract comment |
| docs: `docs/architecture/current.md`, `docs/architecture/final-review.md`, `docs/architecture/domain-map.md`, `docs/records/DECISIONS.md` | docs (line numbers move; deliberately not quoted here) |

**Verdict:** the authoritative DDL for the treasury tables and the **only**
treasury schema — the app, the sync and the reconcile service all read and write
these tables directly. The DDL is applied out-of-band to the `fudcourt` cluster
(there is no `psql` invocation in this repo), and the CI `reconcile-live` job
applies this same file to its own throwaway TimescaleDB container.

### `db/schema/executor-schema.sql` — the executor DDL (sole owner)

| Consumer | Kind |
|---|---|
| `tests/integration/executor/executor-store-tests.ts` (§59, "the DDL is the tracked file verbatim") | **verbatim pin** — reads this file and asserts `EXECUTOR_DDL` equals it with comment lines dropped; the structural assertions (tables, idempotency, no `timestamptz`) read this file directly |
| `apps/web/src/features/executor/store.ts` (`EXECUTOR_DDL`, `ensureExecutorSchema`) | **the app READS this file** at module load (`readFileSync`, repo root = cwd/../..); there is no embedded copy on the TS side since 2026-10-02 |
| `apps/web/src/features/executor/runtime.ts` (`bootstrapExecutor` → `ensureExecutorSchema`) | executes it at boot; entry points `apps/web/scripts/executor/worker.ts` and `runtime.ts` |
| `tests/e2e/executor/executor-paper-e2e.ts` | live gate that calls `ensureExecutorSchema()` against the real cluster |
| `apps/executor/internal/repository/schema/executor-schema.sql` + `schema.go` | the Go `embed` copy (`EnsureSchema` applies it at startup), BYTE-pinned to this file by `TestEmbeddedSchemaMatchesTracked`; the comment references in `internal/{execution/records.go, execution/types.go, platform/credentials/credentials.go}` are prose only |
| docs: `docs/architecture/executor.md`, `docs/architecture/security.md`, `docs/architecture/events.md`, `docs/architecture/ARCHITECTURE.md`, `docs/architecture/current.md`, `docs/records/DECISIONS.md` | docs (line numbers deliberately not quoted here — they move) |

**Verdict:** the authoritative tracked DDL for the `executor` schema, and since the
2026-10-02 lift the only TS-side copy — `store.ts` reads it instead of embedding it,
and the §59 test pins the constant to the file verbatim. The one remaining duplicate
is the Go `embed`, which cannot be removed (`go:embed` refuses parent-directory
patterns) and is guarded byte-for-byte.

## Authority and segmentation verdict

**One treasury schema, one execution-ledger schema; nothing here is redundant.**

1. **Treasury / `public` segment** — `schema/pg-schema.sql`. Postgres+TimescaleDB
   is the system of record (DR-040, superseding the DR-019 two-store split). The
   hand-written DDL declares the 8 treasury tables plus the two Timescale
   hypertables (`asset_history`, `price_history`) that give the time-series
   capability the retired Turso store never had (`pg-schema.sql:107-110`), and the
   `assets_snapshot` trigger that fills `asset_history` on every `assets` insert.
2. **Execution-ledger segment** — `executor-schema.sql`. **Disjoint** from the
   treasury segment, by both table names and Postgres schema (`executor` vs
   `public`). The separation is deliberate (`executor-schema.sql:4-6`): the
   executor writes live data and must not share a namespace with the treasury
   tables.

Nothing is defined twice inside a segment. The only duplication anywhere is the Go
`embed` copy of `executor-schema.sql`
(`apps/executor/internal/repository/schema/`), which cannot be avoided
(`go:embed` refuses parent-directory patterns) and is pinned byte-exactly by
`TestEmbeddedSchemaMatchesTracked` rather than left to drift. The TS side had the
same duplication until 2026-10-02, when `store.ts` was changed to read the tracked
file.

## How each file is consumed in a deployment (today)

- **Treasury (`public`)** is written directly by `tests/oracle/sync-live.py` (the
  deployed sync, via psycopg2) and, in the undeployed Rust replacement, by
  `apps/reconciler` (`tokio-postgres`); the web writes `transactions`/`wallets` and
  reads everything through `apps/web/src/server/db.ts`. `pg-schema.sql` is applied
  out-of-band to the `fudcourt` database; there is no projection timer.
- **`executor.*`** is created in-process at startup by `ensureExecutorSchema()`
  (no external migration step).
- **No systemd unit executes any `.sql` file.** The only automated application of
  a `.sql` file is the CI `reconcile-live` job, which applies `db/schema/pg-schema.sql` to
  its own throwaway TimescaleDB container. Otherwise CI runs Go/Rust/TS builds,
  the offline gates and the contracts drift check
  (`.github/workflows/{web,go,rust,contracts,integration}.yml`).

## Table ownership

One owner domain per table. "Owner" = the domain whose code writes it; readers
may exist elsewhere per the dependency rules.

### Postgres `public` — treasury system of record (`schema/pg-schema.sql`)

| Table | Owner domain | Notes |
|---|---|---|
| `transactions` | transactions | canonical ledger of money movements (`docs/architecture/SCHEMA.md` §1.1) |
| `wallets` | wallets | blockchain wallet metadata (addresses, labels) |
| `assets` | portfolio | live balances written by the 5-minute sync (fail-loud: never writes `0`) |
| `accounts` | ledger | chart of accounts |
| `journal` | ledger | double-entry journal |
| `ledger` | ledger | postings |
| `trades` | ledger | trade records |
| `venues` | exchangeaccounts | venue registry |
| `asset_history` | portfolio | history (appended by the `assets_snapshot` trigger on every `assets` insert) |
| `price_history` | markets | price history hypertable (no producer — DR-036) |

### Postgres `executor` schema (`schema/executor-schema.sql`)

| Table | Owner domain | Notes |
|---|---|---|
| `executor.exchange_accounts` | credentials + exchangeaccounts (merged, PRD §59+§45) | one connected account = one credential set; secrets AES-256-GCM per field (`api_key_encrypted`, `api_secret_encrypted`, `passphrase_encrypted`, `iv`, `auth_tag`); plaintext never stored |
| `executor.executions` | executor | execution entity + runtime state |
| `executor.execution_plans` | planner | immutable creation-time plan snapshot (grid, fee, slippage) |
| `executor.child_orders` | orders | one row per child order; `UNIQUE (execution_id, client_order_id)` = idempotency key |
| `executor.fills` | orders | `UNIQUE (account_id, exchange_trade_id)` = fill dedup key |
| `executor.execution_events` | events (executor) | append-oriented execution event log |
| `executor.balance_snapshots` | executor | venue balance snapshots |
| `executor.positions_snapshots` | executor | venue position snapshots |
| `executor.risk_profiles` | risk | user risk profile (caps, ceilings) |
| `executor.audit_logs` | audit | append-oriented actor/action/resource records |

### Neon (Payload CMS, `apps/web/src/cms/migrations/`)

Owned by the CMS (content: posts, media, users for the blog). Not part of this
map's trading/financial surface.

## Migration policy (evidence-based, per store)

There is deliberately **no cross-store migration runner** (objective §57 "do not
introduce a new migration framework unnecessarily"; DR-020):

- `executor.*`: idempotent `CREATE … IF NOT EXISTS` DDL, one tracked copy +
  one embedded copy, drift-pinned by test. Forward-only; a column removal is a
  manual operation.
- Treasury `public`: schema is `db/schema/pg-schema.sql`, applied out-of-band to the
  `fudcourt` database. There is no dump and no drift gate — the SQLite dump and
  its `dump-schema.mjs --check` alarm were retired together with Turso (DR-040).
- Neon (Payload CMS): Payload's own migration folder
  (`apps/web/src/cms/migrations/`) stays with the CMS by Payload convention.

## Invariants enforced at the DB level (not just app code)

- unique execution id (PK), unique `event_id`, unique
  `(execution_id, client_order_id)`, unique `(account_id, exchange_trade_id)`
- `user_id` scoping on every executor query (wrong user ⇒ `null`/`[]`, API 404)
- executor objects live **only** in the `executor` schema, never in `public`
  (DR-020), so the live execution ledger is isolated from the treasury tables
- timestamps are `bigint` unix **milliseconds** (exact JS round-trip);
  money/quantity are `double precision` with `decimal.js` upstream in risk/sizing

## Roadmap / INTENT — NOT DONE

The restructure brief (`.ai/restructure-fudcourt.md`, PHASE 2) targets a
`db/` that contains `migrations/`, `schema/`, `seeds/` and `fixtures/`.
**None of the following exists today** — they are stated here only so nobody
mistakes the plan for the tree:

- `db/migrations/NNNNNN_*.sql` as the **authoritative history**, with
  `db/schema/snapshot.sql` as the **current representation** — **NOT DONE.**
  There is no `db/migrations/` directory and no `snapshot.sql`; today's "current
  representation" is the hand-written `schema/pg-schema.sql`.
- `db/seeds/` — **NOT DONE, and no content exists to put in it.** (Not
  created: an empty directory would be a claim, not a fact.)
- `db/fixtures/` — **NOT DONE.** No DB fixtures live here. (The brief's
  `tests/fixtures` target relates to the moved recorded payloads under
  `tests/fixtures/`; the only DB-shaped fixture set in the repo is
  the sync replay oracle at `tests/oracle/fixtures/`, which belongs to the tests
  tree.)
- A single ordered migration runner — **NOT DONE and deliberately not attempted**
  (see the migration policy above).

## Known stale references (recorded, not yet fixed)
The SQL files carry a few in-file path references written before the tree moved
to `apps/` + `contracts/` + `db/`. Verified, left alone on purpose (they are
prose inside comments, not runtime paths):
- `db/schema/pg-schema.sql:3,:5,:144` name `scripts/tools/…` without the
  `apps/web/` prefix, and `db/schema/executor-schema.sql:11` names
  `src/features/executor/store.ts` the same way.
- `db/schema/executor-schema.sql:20` names the drift test without its
  directory; its real path is `apps/executor/internal/repository/schema_test.go`.
- Go fixture discovery: **fixed 2026-10-01 in `44604bc`**.
  `apps/data/internal/research/cryptorank/parity_test.go:53-70` and
  `apps/data/internal/research/paritytest/parity_test.go:47-65` now try
  `tests/fixtures` → `apps/web/scripts/fixtures` at each ancestor (env
  `FUDCOURT_DATA_FIXTURES_DIR` still wins), and the parity tests execute
  instead of skipping. Recorded here because the fix post-dates this file's
  original path references.
- The root `README.md` "Verify" snippet was written against an older layout; the
  `cd` chain and every `scripts/…` path it carries now resolve against
  `apps/web` and `scripts/verify/`. Its `node scripts/database/dump-schema.mjs
  --check` line is **dead**: `scripts/database/` was deleted with Turso by
  DR-040.
**Verified not stale** (checked because the tree is mid-rename):
`apps/executor/internal/repository/schema_test.go` reaches
`db/schema/executor-schema.sql` by a relative join that survives the move, and
`scripts/verify/verify-sync.py` resolves both the fixtures
(`tests/oracle/fixtures`) and the oracle (`tests/oracle/sync-live.py`)
correctly.