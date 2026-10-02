# database/ — schema ownership and consumers

> **Audited 2026-10-01** against the tree as it exists. Everything below is a
> statement about code that is in the repo today, with the line it was read from.
> Anything not built yet is in [Roadmap / INTENT](#roadmap--intent--not-done) and
> is marked **NOT DONE**. There are no aspirational claims presented as fact.
>
> Moved here from `apps/web/db/` (Phase 2 of the domain restructure); DDL semantics
> were not changed by the move. Column-level documentation stays in
> `docs/architecture/SCHEMA.md`.
>
> **Note on the restructure:** the tree was renamed underneath this document in
> two commits (`8c902dc`: `apps/`→`frontend/`, `services/`→`backend/`,
> `packages/`→`shared/`, `deploy/`→`infrastructure/`; `44604ce`: `backend/data`
> providers grouped under `internal/research`, `internal/platform`). Every
> `path:line` below was re-read after `44604ce`; the three `.sql` files themselves
> did not change. Where a doc reference in this file still names the pre-move
> path, it is listed under "Known stale references".

## Files

| File | Dialect / role | Objects | Shape owner |
|---|---|---|---|
| `schema/schema.sql` | Turso (libsql/SQLite) dump — the treasury source-of-truth family | 9 objects: `accounts`, `assets`, `journal`, `ledger`, `sqlite_sequence`, `trades`, `transactions`, `venues`, `wallets` (no indexes) | **generated**, live Turso is the system of record |
| `schema/pg-schema.sql` | Postgres 17 + TimescaleDB **read model** (`public` schema) | the same 8 treasury tables + `asset_history`, `price_history` (2 hypertables, 3 indexes) | hand-written (`pg-schema.sql:18` — Postgres DDL cannot be dumped from SQLite) |
| `schema/executor-schema.sql` | Postgres `executor` schema (live execution ledger) | 20 statements: `CREATE SCHEMA`, 10 tables, 9 indexes | the executor runtime (`EXECUTOR_DDL` in `frontend/web/src/platform/executor/store.ts`) |

Object lines: `schema.sql` `:3,:10,:21,:33,:42,:44,:56,:71,:77`;
`pg-schema.sql` tables `:20,:27,:38,:50,:59,:71,:89,:95,:112,:132`, hypertables
`:122,:139`, indexes `:123,:127,:140`; `executor-schema.sql` `:24` (schema),
tables `:32,:58,:100,:106,:129,:147,:157,:165,:173,:179`, indexes
`:50,:95,:96,:124,:143,:154,:163,:171,:187`.

## Consumer map

`file -> consumers (path:line) -> verdict`

### `database/schema/schema.sql` — generated Turso dump

| Consumer | Kind |
|---|---|
| `scripts/database/dump-schema.mjs:38` | **writer** (`--check` mode at `:44` prints `SCHEMA_OK`, `:47` prints `SCHEMA_DRIFT`; usage documented `:3-4`) |
| `README.md:91` | operator command (`node scripts/database/dump-schema.mjs --check`) |
| docs: `docs/architecture/SCHEMA.md:8`, `docs/architecture/TECH-STACK.md:63-64` | drift-alarm documentation (both name `scripts/database/dump-schema.mjs`, which resolves from the repo root) |
| `frontend/web/src/platform/db/mirror.ts:48` | comment: the projection mirrors this file's shape |
| `database/schema/pg-schema.sql:11,:18` | comment: types map 1:1 from here |
| `shared/contracts/openapi/fudcourt.yaml:4323` → `shared/sdk/typescript/src/generated/schema.d.ts` | contract comment (SDK is generated from the yaml) |
| `backend/api/internal/finance/transactions/transactions.go:31,:41` | Go comment (column defaults mirror this file) |
| — | **no other code reads the file.** The only `readFileSync` calls on paths under `database/` in the whole repo are its own generator (`dump-schema.mjs:42`, `--check` mode) and the executor drift test (`executor-store-tests.ts:502`); `dump-schema.mjs:55` is its writer |

**Verdict:** the *live Turso database* is the system of record; this file is a
generated snapshot of it, kept honest by `dump-schema.mjs --check`. It is the
authoritative **source** half of the treasury segment.

### `database/schema/pg-schema.sql` — hand-written Postgres read model

| Consumer | Kind |
|---|---|
| `frontend/web/src/platform/db/mirror.ts` (`TABLES` `:50-58`, `asset_history` insert `:200`, retention `:207-208`) | the code that actually writes these tables (DML, not DDL) |
| `frontend/web/scripts/tools/pg-load.ts` | CLI wrapper that calls `loadFromMirror()` |
| `infrastructure/systemd/fudcourt-pgload.service:3,:11`, `fudcourt-pgload.timer:3`, `fudcourt-sync.service:41` | runs `pg-load.ts` (oneshot every 60 s; also after every sync) |
| `infrastructure/systemd/fudcourt-pgload.service:4` | `Documentation=` line only |
| `shared/contracts/openapi/fudcourt.yaml:4322,:4399` → SDK `schema.d.ts:2227` | contract comment |
| docs: `docs/architecture/current.md:228`, `docs/architecture/final-review.md:40`, `docs/architecture/domain-map.md:50`, `docs/records/DECISIONS.md:1277` | docs (line numbers re-read post-restructure) |

**Verdict:** the authoritative **representation** of the Postgres read model, but
**no tool in this repo executes it**: there is no `psql` invocation anywhere in the
tree, no migration runner, and no CI step references it. It is applied
out-of-band to the local cluster; the automated path (`pg-load` → `mirror.ts`)
only issues DML against tables this file must already have created.

### `database/schema/executor-schema.sql` — tracked copy of the applied executor DDL

| Consumer | Kind |
|---|---|
| `tests/integration/executor/executor-store-tests.ts:500-510` | **drift pin** — reads this file (5-up from the compiled `.shaper-tests/scripts/tests`) and asserts normalized equality with `EXECUTOR_DDL` |
| `frontend/web/src/platform/executor/store.ts:94` (comment), `:97` (`EXECUTOR_DDL`), `:238` (`ensureExecutorSchema`) | the **applied** DDL — this file is the readable copy of it |
| `frontend/web/src/platform/executor/runtime.ts:117` (`bootstrapExecutor` → `ensureExecutorSchema`) | executes it at boot; entry points `frontend/web/scripts/executor/worker.ts:27` and `runtime.ts:139` |
| `tests/e2e/executor/executor-paper-e2e.ts:28,:99` | live gate that calls `ensureExecutorSchema()` against the real cluster |
| `backend/workers/executor/internal/{repository/store.go:4, executor/records.go:5, executor/types.go:9, credentials/credentials.go:8}` | Go comment references (the Go worker writes these tables; it does **not** read this file) |
| docs: `docs/architecture/executor.md:50,:71`, `docs/architecture/security.md:32`, `docs/architecture/events.md:75`, `docs/architecture/ARCHITECTURE.md:362`, `docs/architecture/current.md:229`, `docs/records/DECISIONS.md` | docs (line numbers re-read post-restructure) |

**Verdict:** the authoritative tracked DDL for the `executor` schema. *Applied*
copy is the embedded `EXECUTOR_DDL`; this file is the human-readable one, and the
test at `executor-store-tests.ts:500` is what keeps the two equal. Verified
normalized-identical on 2026-10-01.

## Authority and segmentation verdict

**Two independent segments; nothing here is redundant with anything else.**

1. **Treasury / `public` read-model segment** — `schema.sql` + `pg-schema.sql`.
   These **deliberately overlap**: the same 8 logical tables in two dialects
   (`TEXT→text`, `REAL→double precision`, `INTEGER PK→GENERATED BY DEFAULT AS
   IDENTITY`; comments at `pg-schema.sql:11-19`). Authority is split by concern:
   *live Turso* is the system of record, `schema.sql` is its generated
   representation, `pg-schema.sql` is the hand-written Postgres projection. The
   two Postgres-only tables (`asset_history`, `price_history`) have no Turso
   counterpart — they exist for the time-series capability Turso never had
   (`pg-schema.sql:107-110`).
2. **Execution-ledger segment** — `executor-schema.sql`. **Disjoint** from the
   other two, by both table names and Postgres schema (`executor` vs `public`).
   The separation is deliberate (`executor-schema.sql:4-6`): the mirror prunes
   `public` wholesale, and the live executor data must not sit in that blast
   radius.

Nothing is defined twice inside a segment. The only duplication anywhere is
`executor-schema.sql` ↔ `store.ts EXECUTOR_DDL`, which is intentional and pinned
by a test rather than left to drift.

## How each file is consumed in a deployment (today)

- **Turso** is written by `backend/sync` (Rust reconciler), `tests/oracle/sync-live.py`
  and the web write path; `schema.sql` is periodically re-dumped from it and
  `--check`'d.
- **Postgres read model** is created out-of-band from `pg-schema.sql`, then filled
  by `pg-load.ts`/`mirror.ts` on a 60 s timer and after every sync
  (`infrastructure/systemd/fudcourt-sync.service:41`).
- **`executor.*`** is created in-process at startup by `ensureExecutorSchema()`
  (no external migration step).
- **No systemd unit and no CI workflow executes any `.sql` file.** CI only runs
  Go/Rust/TS builds, the offline gates and the contracts drift check
  (`.github/workflows/{web,go,rust,contracts,integration}.yml`).

## Table ownership

One owner domain per table. "Owner" = the domain whose code writes it; readers
may exist elsewhere per the dependency rules.

### Turso — treasury system of record (`schema/schema.sql`)

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
| `asset_history` | portfolio | history (projected to Timescale hypertable) |
| `price_history` | markets | price history (projected to Timescale hypertable) |

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

### Neon (Payload CMS, `frontend/web/src/cms/migrations/`)

Owned by the CMS (content: posts, media, users for the blog). Not part of this
map's trading/financial surface.

## Migration policy (evidence-based, per store)

There is deliberately **no cross-store migration runner** (objective §57 "do not
introduce a new migration framework unnecessarily"; DR-020):

- `executor.*`: idempotent `CREATE … IF NOT EXISTS` DDL, one tracked copy +
  one embedded copy, drift-pinned by test. Forward-only; a column removal is a
  manual operation.
- Turso treasury: schema is the live dump; changes are made in Turso and
  re-dumped (drift gate keeps the repo honest).
- Neon (Payload CMS): Payload's own migration folder
  (`frontend/web/src/cms/migrations/`) stays with the CMS by Payload convention.

## Invariants enforced at the DB level (not just app code)

- unique execution id (PK), unique `event_id`, unique
  `(execution_id, client_order_id)`, unique `(account_id, exchange_trade_id)`
- `user_id` scoping on every executor query (wrong user ⇒ `null`/`[]`, API 404)
- executor objects live **only** in the `executor` schema — the Turso→Postgres
  mirror prunes `public` wholesale and must never touch executor data (DR-020)
- timestamps are `bigint` unix **milliseconds** (exact JS round-trip);
  money/quantity are `double precision` with `decimal.js` upstream in risk/sizing

## Roadmap / INTENT — NOT DONE

The restructure brief (`.ai/restructure-fudcourt.md`, PHASE 2) targets a
`database/` that contains `migrations/`, `schema/`, `seeds/` and `fixtures/`.
**None of the following exists today** — they are stated here only so nobody
mistakes the plan for the tree:

- `database/migrations/NNNNNN_*.sql` as the **authoritative history**, with
  `database/schema/snapshot.sql` as the **current representation** — **NOT DONE.**
  There is no `migrations/` directory and no `snapshot.sql`; today's "current
  representation" is the generated `schema/schema.sql` plus the hand-written
  `schema/pg-schema.sql`.
- `database/seeds/` — **NOT DONE, and no content exists to put in it.** (Not
  created: an empty directory would be a claim, not a fact.)
- `database/fixtures/` — **NOT DONE.** No DB fixtures live here. (The brief's
  `tests/fixtures` target relates to the moved recorded payloads under
  `tests/fixtures/`; the only DB-shaped fixture set in the repo is
  the sync replay oracle at `tests/oracle/fixtures/`, which belongs to the tests
  tree.)
- A single ordered migration runner — **NOT DONE and deliberately not attempted**
  (see the migration policy above).

## Known stale references (recorded, not yet fixed)

The tree is being renamed (`apps/` + `services/` → `frontend/` + `backend/`), so
some in-repo references still name the old paths. Verified, left alone on
purpose:

- `database/schema/pg-schema.sql:3,:5,:144` name `scripts/tools/…` without the
  `frontend/web/` prefix, and `database/schema/executor-schema.sql:11` names
  `src/platform/executor/store.ts` the same way.
- `database/schema/executor-schema.sql:20` names the drift test without its
  directory; its real path is `tests/integration/executor/executor-store-tests.ts`.
- Go fixture discovery: **fixed 2026-10-01 in `44604ce`**.
  `backend/data/internal/research/cryptorank/parity_test.go:53-70` and
  `backend/data/internal/research/paritytest/parity_test.go:47-65` now try
  `tests/fixtures` → `frontend/web/scripts/fixtures` →
  `apps/web/scripts/fixtures` at each ancestor (env
  `FUDCOURT_DATA_FIXTURES_DIR` still wins), and the parity tests execute
  instead of skipping. Recorded here because the fix post-dates this file's
  original path references.
- The root `README.md` "Verify" snippet (`:70-92`) was written against the old
  `apps/`+`services/` layout; the diagnosis below records that earlier layout,
  not live breakage. Post-restructure the `cd` chain (`backend/data` →
  `../sync` → `../../frontend/web` → `../..`) resolves, and every `scripts/…`
  path is read relative to the cwd its own `cd` leaves:
  `scripts/checks/check-structure.py` (`:77`) and `scripts/verify/…` (`:81-90`)
  are correct as written, and `node scripts/database/dump-schema.mjs --check`
  (`:91`) resolves from the repo root. The one genuinely dead path the snippet
  carried, `frontend/web/scripts/tools/sync-live.py` (`:75`), resolves to
  `tests/oracle/sync-live.py` at its current path (moved in `d4119ca`).

**Verified not stale** (checked because the tree is mid-rename):
`executor-store-tests.ts:502` reaches `database/schema/executor-schema.sql`
from the compiled `.shaper-tests/` layout, and `verify-sync.py:42-43` resolves
both the fixtures (`tests/oracle/fixtures`) and the oracle
(`tests/oracle/sync-live.py`) correctly.
