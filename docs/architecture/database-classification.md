# Database Classification (Phase 8)

Classification of **every table/object** in the schemas actually present in the
repository, plus what does **not** exist. Walked from the DDL and the writers on
2026-10-01. This is an *identification* pass — no schema was changed.

Scope: task brief supplied to this audit; not stored in-repo. The originating session
transcript is `history://source-inventory`.

## Schemas in scope, and where their DDL lives

| Storage | DDL file | Generator / provenance | Extra DBs |
|---|---|---|---|
| Postgres 17 + TimescaleDB 2.30.1, `public` (database `fudcourt`) | `database/schema/pg-schema.sql` | hand-written, `IF NOT EXISTS` throughout; **the single system of record since DR-040** (the generated SQLite dump and its `dump-schema.mjs` generator are deleted) | system of record |
| Postgres, `executor` schema | `database/schema/executor-schema.sql` | tracked copy; executed from an **embedded duplicate** `EXECUTOR_DDL` in `backend/workers/executor/internal/repository/store.go` via `ensureExecutorSchema()`; pinned by `backend/workers/executor/internal/repository/schema_test.go` | execution system of record |
| Neon Postgres | `frontend/web/src/cms/migrations/20260917_194354.ts` (+ `.json` snapshot, `index.ts` manifest) | Payload PostgreSQL adapter migration, generated | CMS content store |

Connection facts (names only, no values):
`backend/sync/src/persistence/db.rs` reads the DSN from `FUDCOURT_PG_URL` (`tokio-postgres`);
`frontend/web/src/server/db.ts` Postgres client from `FUDCOURT_PG_URL` (`platform/db/pg.ts`);
`tests/oracle/sync-live.py` (psycopg2) reads `FUDCOURT_PG_URL` from the repo-root `.env`;
executor Go worker from `FUDCOURT_EXECUTOR_PG_URL` (`backend/workers/executor/cmd/executor/main.go:95`);
Payload from `DATABASE_URL` (`frontend/web/src/cms/payload.config.ts:44-46`).

## Column meanings

- **classification**: `canonical` (domain truth, one owner) · `event` (append-only
  history) · `snapshot` (point-in-time state, overwritten) · `cache` (rebuildable) ·
  `provider-specific` (shaped by a provider) · `legacy` (superseded but still read) ·
  `unknown` (no writer and no clear owner found).
- **sensitivity**: `PUBLIC` · `INTERNAL` · `USER_PRIVATE` · `SECRET` (SECRET columns are
  named but their *values* are never reproduced anywhere in this repo's docs).

---

## 1. Postgres `public` — treasury system of record (`database/schema/pg-schema.sql`) — 8 tables

Writers: the Python oracle `tests/oracle/sync-live.py` (psycopg2, the deployed sync)
and `backend/sync` (Rust `tokio-postgres`, built but **not deployed** —
`fudcourt-sync-rust.service` is the uninstalled replacement) for `assets`; the Next
`(frontend)` API routes for `transactions`/`wallets`. Readers:
`frontend/web/src/server/db.ts`, `platform/db/client.ts` `getAll()`, and the
routes below. Every writer writes Postgres directly (DR-040).

### `assets` — synced balances (latest state)

| Field | Value |
|---|---|
| table | `assets` (`database/schema/pg-schema.sql:20-29`) |
| storage | Postgres `public.assets` (system of record, DR-040) |
| classification | **snapshot** (rewritten wholesale each sync: `DELETE FROM assets` then INSERTs — `db.rs:117,133`) |
| owning service | `backend/sync` Rust `fudcourt-sync` (`streams/sync.rs`), legacy `sync-live.py` |
| readers | `frontend/web/src/server/db.ts,79,82`; `api/coins/route.ts` (`SELECT asset, SUM(value_usd) … FROM assets GROUP BY asset`); `api/all/route.ts` via `getAll()`; `backend/sync/src/reconciliation/reconcile.rs:207` |
| canonical entity | **Balance** (account ≈ wallet address × chain, asset by symbol) + derived valuation |
| durability | SNAPSHOT (live table keeps only the newest run; history lands in Postgres `asset_history`) |
| sensitivity | INTERNAL (wallet-level holdings; no secrets) |
| columns carrying secrets | none |
| notes/violations | provider-shaped values are absent, but identity is **symbol-string based** (`asset TEXT`) with one subjective relabel already baked in: Polygon native is stored as `MATIC` while the chain registry says `POL` (`chains.rs` trailing comment). `quantity/value_usd/share_pct` are `REAL`/`double precision` — binary floating point for money/quantity (scope prompt §NUMERIC TYPES violation). `share_pct` is derived, stored beside canonical facts. |

### `transactions`

| Field | Value |
|---|---|
| table | `transactions` (`database/schema/pg-schema.sql:64-80`) |
| storage | Postgres `public.transactions` (system of record, DR-040) |
| classification | **canonical** (user-entered ledger of movements; append + edit + delete) |
| owning service | Next `(frontend)` API: `api/transactions/route.ts` (POST, DELETE, bulk PUT), `api/transactions/[id]/route.ts` (PUT/DELETE) |
| readers | same routes; `pg.ts:56,76`; `api/all/route.ts`; `backend/sync/src/reconciliation/reconcile.rs:213` |
| canonical entity | **Transaction** (and its money movement; the scope's LedgerEntry is separate — see `ledger`) |
| durability | CANONICAL |
| sensitivity | INTERNAL (memo/wallet addresses are not secrets) |
| columns carrying secrets | none |
| notes/violations | `date` is TEXT with no timezone semantics; `chain` is `NOT NULL` even for non-chain rows (a cash/BANK transaction could not be stored honestly today). `direction` is a free-text `IN`/else convention (`reconcile.rs` hard-codes the split). `venue_id`/`trade_id` are loose text links into `venues`/`trades` with no FK. |

### `wallets`

| Field | Value |
|---|---|
| table | `wallets` (`database/schema/pg-schema.sql:88-102`) |
| storage | Postgres `public.wallets` (system of record, DR-040) |
| classification | **canonical** (wallet registry; UI-editable metadata) |
| owning service | Next API `api/wallets/route.ts` (**UPDATE only** — no INSERT exists anywhere in the tree; rows are created out-of-band); the addresses the sync *reads* are code constants `backend/sync/src/chains.rs` `WALLETS` (Main, Hanif, Akang) |
| readers | `api/wallets/route.ts` (`SELECT * FROM wallets ORDER BY rowid` → `ORDER BY id` via `toPostgres`); `pg.ts:58,80`; `reconcile.rs:219` |
| canonical entity | **Wallet** (an account of type WALLET) |
| durability | CANONICAL |
| sensitivity | **USER_PRIVATE** (exact on-chain addresses + owner labels; addresses are pseudonymous but linked to named people) |
| columns carrying secrets | none |
| notes/violations | `chain` is free text and never constrained to the `EVM`/`SOL` kinds the sync actually supports; `alias/emoji/color/notes` are product-view decoration living in the canonical table. Only EVM (`0x…`) and Solana addresses appear; `monitored` is an integer flag with a text default `1`. |

### `accounts`

| Field | Value |
|---|---|
| table | `accounts` (`database/schema/pg-schema.sql:13-18`) |
| storage | Postgres `public.accounts` (system of record, DR-040) |
| classification | **canonical** (chart of accounts) |
| owning service | **none found in-repo** — no INSERT/UPDATE against `accounts` anywhere (only reads). **DEAD (DR-036):** 6 rows, frozen at the 2026-09-15 import; no out-of-band writer in cron, any timer, or `~/.hermes/**` |
| readers | `pg.ts:51,75`; `api/all/route.ts` `getAll()` |
| canonical entity | **Account** metadata (code/name/type/statement) |
| durability | CANONICAL |
| sensitivity | INTERNAL |
| columns carrying secrets | none |
| notes/violations | `[INFERENCE]` write path is manual/out-of-band (probably a spreadsheet import by the operator). `type`/`statement` are unconstrained text. |

### `journal`

| Field | Value |
|---|---|
| table | `journal` (`database/schema/pg-schema.sql:31-41`) |
| storage | Postgres `public.journal` (system of record, DR-040) |
| classification | **event** (dated accounting entries with a `status`) |
| owning service | **none found in-repo** (read-only usage) `[INFERENCE]` manual entry. **DEAD (DR-036):** 8 rows, max `created_at` `2026-09-15 23:48:35` — frozen at the import, never advanced |
| readers | `pg.ts:53,77`; `getAll()` |
| canonical entity | **LedgerEntry** (journal ↔ ledger are the two halves of double entry) |
| durability | CANONICAL |
| sensitivity | INTERNAL |
| notes/violations | `debit_account`/`credit_account` reference `accounts.code` with no FK; `amount REAL` (binary float for money). |

### `ledger`

| Field | Value |
|---|---|
| table | `ledger` (`database/schema/pg-schema.sql:43-50`) |
| storage | Postgres `public.ledger` (system of record, DR-040) |
| classification | **snapshot** (a `balance` per `(account, side, currency)`) |
| owning service | **none found in-repo**. **DEAD (DR-036):** 3 rows, frozen at the 2026-09-15 import |
| readers | `pg.ts:54,78`; `getAll()` |
| canonical entity | **LedgerEntry**/balance roll-up (scope's LedgerEntry fields are account/amount/entry_type — this table stores only a running balance, not movements) |
| durability | CANONICAL |
| sensitivity | INTERNAL |
| notes/violations | `balance REAL NOT NULL DEFAULT 0` is the only money column and it is a float. Duplicated concept with `public.asset_history`-style snapshotting; no append-only guarantee, so "ledger" is a misnomer versus the scope's append-oriented model. |

### `trades`

| Field | Value |
|---|---|
| table | `trades` (`database/schema/pg-schema.sql:52-62`) |
| storage | Postgres `public.trades` (system of record, DR-040) |
| classification | **event** (executed trade log) |
| owning service | **none found in-repo** `[INFERENCE]` manual entry. **DEAD (DR-036):** 0 rows, never written |
| readers | `pg.ts:55,81` (LIMIT 20 in the dashboard read); `getAll()` |
| canonical entity | **Fill**/**Order** (symbol-string based, venue as free text) |
| durability | CANONICAL |
| sensitivity | INTERNAL |
| notes/violations | **Provider-shaped duplication of the executor's own domain**: `symbol`, `venue`, `side`, `quantity`, `price`, `pnl`, `status` duplicate `executor.fills`/`child_orders` with no link. `pnl REAL` is a derived value stored as fact. |

### `venues`

| Field | Value |
|---|---|
| table | `venues` (`database/schema/pg-schema.sql:82-86`) |
| storage | Postgres `public.venues` (system of record, DR-040) |
| classification | **canonical** (venue registry; `id` is a text slug, not a provider id) |
| owning service | **none found in-repo**. **DEAD — the TABLE only (DR-036):** 12 rows, seeded once at the 2026-09-15 import. The venue *entity* is alive despite the unwritten table: `shared/contracts/data/reference.json` mints 12 `venue_id`s, `backend/api/internal/accounts/exchange/account.go:122` `KnownExchange` validates the slug, and the executor's venue boundary (`backend/workers/executor/internal/exchanges/`) resolves it in code — so a cleanup retires the TABLE, never the identity |
| readers | `pg.ts:57` (read, but **not** in `DASHBOARD_READS`); `transactions.venue_id` implies a foreign key that does not exist |
| canonical entity | **Venue** |
| durability | CANONICAL |
| sensitivity | PUBLIC |
| notes/violations | Text PK; no sequence to advance (`pg_get_serial_sequence` returns NULL). No FK from `transactions.venue_id` or `trades.venue`. |

### `sqlite_sequence` — retired (DR-040)

The SQLite internal AUTOINCREMENT table existed only in the deleted SQLite dump. Postgres uses `GENERATED BY DEFAULT AS IDENTITY`, so there is no counterpart and nothing to classify.

---

## 2. Postgres `public` — the same schema's Timescale hypertables and read surface

All ten `public` objects live in ONE Postgres database (`fudcourt`, the single system
of record since DR-040) — there is no second store and no projection. The eight tables
above are the treasury tables; the two rows here are the Timescale hypertables, whose
history `asset_history` is appended by the `assets_snapshot` trigger, not by a loader.

| table | storage | classification | owning service | readers | canonical entity | durability | sensitivity | notes/violations |
|---|---|---|---|---|---|---|---|---|
| `public.accounts` (`pg-schema.sql:13-18`) | Postgres | canonical | API routes (`getAll()`) | `getAll()`, `api/all/route.ts` | Account | CANONICAL | INTERNAL | Read-only in-app; dead table (DR-036). |
| `public.assets` (`:20-29`) | Postgres | snapshot | the sync (`tests/oracle/sync-live.py` / `backend/sync`) | `pg.ts:52,79,82`, `api/coins`, `api/all` | Balance | SNAPSHOT | INTERNAL | Rewritten wholesale each sync; **latest state only** — history lives in `asset_history`. |
| `public.journal` (`:31-41`) | Postgres | event | (none in-repo) | `getAll()` | LedgerEntry | CANONICAL | INTERNAL | Dead table (DR-036). `to_char(now() AT TIME ZONE 'UTC', …)` default must never fire: a writer always supplies the date. |
| `public.ledger` (`:43-50`) | Postgres | snapshot | (none in-repo) | `getAll()` | LedgerEntry balance | CANONICAL | INTERNAL | Dead table (DR-036). |
| `public.trades` (`:52-62`) | Postgres | event | (none in-repo) | `pg.ts:55,81` | Fill/Order | CANONICAL | INTERNAL | Same duplication note as §1 `trades`. |
| `public.transactions` (`:64-80`) | Postgres | canonical | Next API routes | API routes + `getAll()` | Transaction | CANONICAL | INTERNAL | The **write target for the app's `query()` calls** — every route write lands here directly. |
| `public.venues` (`:82-86`) | Postgres | canonical | (none in-repo) | (none in-app) | Venue | CANONICAL | PUBLIC | Text PK; not in `DASHBOARD_READS`; dead table (DR-036). |
| `public.wallets` (`:88-102`) | Postgres | canonical | Next API `api/wallets/route.ts` (UPDATE only) | `api/wallets`, `getAll()` | Wallet | CANONICAL | USER_PRIVATE | — |
| `public.asset_history` (`:105-128`) + hypertable (`:115`) + trigger `assets_snapshot_trg` (`:145-148`) | Postgres/Timescale | **snapshot history** (append per `assets` INSERT) | the DB **trigger** `assets_snapshot` (DR-040 — not application code) | none in-app yet (boards "chart history") | Balance snapshot (time series) | HISTORICAL (90-day retention via plain DELETE in `tests/oracle/sync-live.py`) | INTERNAL | **The one place history exists.** Retention is a hand-rolled DELETE because `add_retention_policy()` is Timescale-License. The trigger means every writer — sync, route, operator — lands in the series identically. |
| `public.price_history` (`:150-160`) | Postgres/Timescale | **cache/price series** | **no writer found** — only the retention DELETE in `tests/oracle/sync-live.py` | none in-app | Price (time series) | HISTORICAL (90-day DELETE) | PUBLIC | **Writer gap, now confirmed dead (DR-036):** the schema comment says "Written by the price sampler", but no `price sampler` exists anywhere in the tree — `grep -rniI "INSERT INTO price_history"` → **0 hits**, the table is **empty in Postgres** and has no writer. The DDL comment describes a producer that was never written. |

---

## 3. Postgres `executor` (`database/schema/executor-schema.sql`) — schema + 10 tables

Writer split (both found in-repo):

- **Next app** (`backend/workers/executor/internal/repository/store.go`, `EXECUTOR_DDL` +
  `STATEMENTS`) — owns `exchange_accounts` writes (sealing via
  `sealCredentials`, `aes-256-gcm`), execution/plan creation, lifecycle transitions,
  settings, audit.
- **Go worker** (`backend/workers/executor/internal/repository/{store,credentials}.go`) —
  owns order/fill/event ingestion and `last_used_at` touches.
- Go also reads credentials (`credentials.go:51`) but never writes them; TS never
  writes fills (`[INFERENCE]` from statement inventory in both files).

| table | classification | owning service (writer) | readers (exact) | canonical entity | durability | sensitivity (secret columns) | notes/violations |
|---|---|---|---|---|---|---|---|
| `executor.exchange_accounts` (`executor-schema.sql:32-49`) | **canonical** (account + credential set merged, PRD §59+§45) | Next `store.ts:559` (INSERT), `:417-419` (health/touch/revoke); Go `credentials.go:83` (`UPDATE last_used_at` only) | Next `store.ts:414-416,484` (`rotateAccounts` — the only reader of ciphertext); Go `credentials.go:51` | **Account** (CEX) + SECRET credential envelope | CANONICAL | **SECRET**: `api_key_encrypted`, `api_secret_encrypted`, `passphrase_encrypted` (bytea, AES-256-GCM), `iv`, `auth_tag` (bytea). Display-only: `api_key_masked`. | **Confirmed: no column stores plaintext key material.** `Envelope`/`CredentialRow` types explicitly carry `[]byte` sealed values only (`Go credentials.go`: "Plaintext is NEVER a field of this type"). `iv`/`auth_tag` concatenate per-secret 12-byte nonce + 16-byte tag in column order. `permissions jsonb`, `health text` are provider-shaped but provider-agnostic. One merged table for two PRD entities is called out in the DDL comment as deliberate. |
| `executor.executions` (`:58-94`) | **canonical** (execution aggregate) | Next `store.ts:636` (INSERT), lifecycle transitions; Go `store.go:196` (upsert of runtime state) | Next `store.ts:420-428`; Go `store.go:239` | **Execution** | CANONICAL | USER_PRIVATE (user_id, sizing, risk) | `symbol`/`exchange` are stored as provider wire strings (`BTC/USDT` canonical form is upstream discipline only); `*_definition jsonb` embed provider-shaped stop/take-profit structures in the canonical row. `double precision` for money/quantity per the DDL's stated convention (calculation in decimal.js upstream). |
| `executor.execution_plans` (`:96-100`) | **snapshot** (immutable creation-time plan) | Next `store.ts:654` | Next `store.ts:424`; Go `store.go` plan fetch | Execution plan (derived) | CANONICAL | USER_PRIVATE | Whole plan as one `jsonb` — provider-independent by construction but opaque to SQL. |
| `executor.child_orders` (`:101-120`) | **event** (one row per venue order) | Next `store.ts:461`; Go `store.go:309` | Next `store.ts:463`; Go `store.go:328` | **Order** | EVENT | USER_PRIVATE | `exchange_order_id` (nullable provider id) beside canonical `client_order_id` — correct provider-id separation. `status text` normalizes venue statuses (union in TS types). |
| `executor.fills` (`:121-137`) | **event** | Next `store.ts:468`; Go `store.go` fills insert | Next `store.ts:471`; Go | **Fill** | EVENT | USER_PRIVATE | `UNIQUE (account_id, exchange_trade_id)` is the idempotency guarantee (DDL comment). `provider_fill_id` = `exchange_trade_id`. |
| `executor.execution_events` (`:139-147`) | **event** (append-only; "no UPDATE/DELETE path exists in the store and none may be added") | Next `store.ts:473`; Go `store.go:376` | Next `store.ts:475`; Go `store.go:154,328` | Execution event log | EVENT | USER_PRIVATE | The only genuinely append-only table in the tree. |
| `executor.balance_snapshots` (`:149-155`) | **snapshot** | Next `store.ts:481`; Go repository | Next `store.ts` (list) | **Balance** snapshot | HISTORICAL | USER_PRIVATE | `payload jsonb` — the balance rows are not columns, so the canonical Balance shape is not enforced anywhere at rest. |
| `executor.positions_snapshots` (`:156-162`) | **snapshot** | Next `store.ts:482`; Go repository | Next `store.ts` (list) | **Position** snapshot | HISTORICAL | USER_PRIVATE | Same jsonb-payload issue as balances. |
| `executor.risk_profiles` (`:163-167`) | **canonical** (one per user) | Next `store.ts:478` (UPSERT) | Next `store.ts:476` | RiskProfile (executor config) | CANONICAL | USER_PRIVATE | `profile jsonb`; not a scope-prompt entity — executor-domain configuration. |
| `executor.audit_logs` (`:168-175`) | **event** | Next `store.ts:483`; Go repository | Next `store.ts` | AuditRecord (system domain) | EVENT | USER_PRIVATE | `payload jsonb`; no retention/rotation policy stated. |

**Embedded-DDL duplication (violation to record, not fix here):** the same 10
`CREATE TABLE` statements exist twice — `database/schema/executor-schema.sql` and the
`EXECUTOR_DDL` template literal (retired with the TS store module 2026-10-05, DR-043) lived at the TS platform store path; the canonical embeddable is now `backend/workers/executor/internal/repository/schema.go`.
The tracked file is *not* what runs; `ensureExecutorSchema()` executes the embedded copy.
`backend/workers/executor/internal/repository/schema_test.go` compares them after normalizing
blank/comment lines, so drift is caught only by that test.

The Go worker does **not** create the schema; it assumes it exists
(`cmd/executor/main.go` pings `FUDCOURT_EXECUTOR_PG_URL`).

---

## 4. Neon Postgres — Payload CMS (`frontend/web/src/cms/migrations/20260917_194354.ts`) — 16 tables + 2 enums

Storage: Neon serverless Postgres (`DATABASE_URL`, `…neon.tech/neondb`, pooled).
Classification: **CMS content store** — user/editor managed, not market data, but it is
*stored content* and therefore in scope.

| table | classification | owning service (writer) | readers | canonical entity | durability | sensitivity | notes/violations |
|---|---|---|---|---|---|---|---|
| `users` (`migration:15-27`) | canonical (CMS identity) | Payload (`/blog/cms/api/*`, admin UI) | Payload admin/auth; `posts.author_id` | CMS author | CANONICAL | **SECRET** columns: `hash`, `salt` (password digest), `reset_password_token` | `email` unique. These are CMS-editor accounts, **not** FUDCourt platform identities (Discord OAuth is the platform identity source) — a second, unrelated user table. |
| `users_sessions` (`:7-14`) | event/session | Payload | Payload admin | CMS session | EPHEMERAL-ish | SECRET (opaque `id` cookie value) | Cascades on user delete. |
| `posts` (`:35-50`) | canonical (content) | Payload (`Posts` collection) / `src/cms/seed.ts` | `src/app/blog/[slug]/page.tsx`, `/blog` index, Payload REST/GraphQL | **NewsArticle/CMS post** | CANONICAL | PUBLIC (when `_status='published'`); drafts are INTERNAL | `content jsonb` holds a Lexical tree (provider/editor-shaped blob in the canonical row). |
| `posts_tags` (`:28-34`) | canonical (child array) | Payload | post renderer | post tag | CANONICAL | PUBLIC | Child-array table pattern (order + parent). |
| `posts_rels` (`:51-58`) | canonical (join) | Payload | post renderer | post↔category link | CANONICAL | PUBLIC | Payload's polymorphic rels pattern; only `categories_id` populated. |
| `_posts_v` (`:67-86`) | **legacy/version** (draft-version history) | Payload drafts | Payload admin | post version | HISTORICAL | INTERNAL | `latest boolean` marks the newest version. |
| `_posts_v_version_tags` (`:59-66`) | version child | Payload | admin | tag version | HISTORICAL | INTERNAL | — |
| `_posts_v_rels` (`:87-94`) | version join | Payload | admin | category version link | HISTORICAL | INTERNAL | — |
| `media` (`:95-110`) | canonical (asset metadata) | Payload `Media` collection (`staticDir: 'media'`) | blog renderer | MediaAsset | CANONICAL | PUBLIC | File **bytes** live on disk (`frontend/web/media`), only metadata here. |
| `categories` (`:111-119`) | canonical | Payload `Categories` / seed | blog index | Content category (editorial, **not** an Asset category) | CANONICAL | PUBLIC | Name collision risk with market "categories" — different concept entirely. |
| `payload_kv` (`:120-125`) | internal (framework key-value) | Payload | Payload internals | — | CANONICAL | INTERNAL | Framework table. |
| `payload_locked_documents` + `_rels` (`:126-142`) | internal | Payload | admin | — | EPHEMERAL | INTERNAL | — |
| `payload_preferences` + `_rels` (`:144-159`) | internal | Payload | admin | per-user UI prefs | CANONICAL | INTERNAL | — |
| `payload_migrations` (`:160-166`) | internal | Payload runner | operator | — | CANONICAL | INTERNAL | The CMS migration ledger. |
| enums `enum_posts_status`, `enum__posts_v_version_status` | internal | — | — | `draft`/`published` | — | — | — |

---

## 5. What does NOT exist (explicit)

Enumerated, not implied:

| Expected thing | Status | Evidence |
|---|---|---|
| `database/migrations/` | **Does not exist** | `ls database/` → `README.md`, `schema/` only. The only migration runners are Payload's (`src/cms/migrations/index.ts`) and the executor's two idempotent startup appliers of `database/schema/executor-schema.sql`: the TS `ensureExecutorSchema()` and — added `8d87df1` — the Go `repository.EnsureSchema` at `cmd/executor` startup. |
| A Postgres migration framework for the treasury tables | **Does not exist** | `database/schema/pg-schema.sql` is hand-written and applied by hand; there is no migration runner (DR-020). |
| Seed scripts for the treasury tables | **Does not exist** | No `INSERT INTO accounts/journal/ledger/venues/trades` in any **source** file (the phrase occurs in the prose recording it, so a bare whole-tree grep is non-zero); `wallets` is seeded only as Rust constants (`chains.rs` `WALLETS`) which are *read* as the sync's watch list, not inserted by the app. |
| SQL fixture files for the treasury schema | **Does not exist** | Only `tests/oracle/fixtures/capture.json` (HTTP bodies) and `tests/fixtures/**` (provider payloads). |
| `database/schema/analytics.sql` | **Does not exist** (referenced by an older doc) | `docs/architecture/domain-map.md:53` names it; the file is not in the tree. The analytics tables actually live in `pg-schema.sql`. `[INFERENCE]` stale doc reference, out of my write scope. |
| Tables for: bank accounts, macro series/observations, DEX pools/LP positions, signals, wallets-indexer data, Candles/OHLCV, news from any provider other than the CMS | **Do not exist** | No DDL matches; no writer exists. `price_history` is the only price-series table and has no writer — DR-036 confirms it dead (empty in Postgres, no producer). |
| Any table holding plaintext API keys/secrets | **Does not exist** | `executor.exchange_accounts` stores only `bytea` ciphertext + `iv`/`auth_tag` + `api_key_masked`; `users.hash`/`salt` are digests. |
| A `raw_*` provider table namespace | **Does not exist** | The scope's suggested `raw_cryptorank_*`/`raw_exchange_*` naming has no implementation; raw payloads live in the disk cache (`~/.cache/crfetch`) and gzipped fixtures only. |
| Tables for CoinGlass / CoinAnk derivatives metrics (funding, open interest, liquidations, long/short, ETF flows) | **Do not exist** | Neither family persists: `backend/data/internal/research/{coinglass,coinank}` serve the upstream body through the disk cache only (no DDL, no writer). CoinAnk is additionally `dark` — every mode returns HTTP 502 `403`. |
| Tables for CoinMarketCap market surfaces (listing, global metrics, market pairs, exchanges) | **Do not exist** | `backend/data/internal/research/coinmarketcap` serves the upstream body through the disk cache only (no DDL, no writer); like its CoinGlass/CoinAnk siblings it is a pass-through acquisition family, not a persisted dataset. |

---

## 6. Cross-cutting findings (Phase 8 output, no changes made)

1. **Writer ownership is mostly clean but not fully.** `assets` is owned by Rust sync
   (and the legacy Python oracle) only; `transactions`/`wallets` by the Next API only;
   `executor.*` by the Next store + Go worker only. The exception: `accounts`, `journal`,
   `ledger`, `trades`, `venues` have **no in-repo writer at all** — they are read by the
   dashboard, which means their canonical owner is unidentified. **O2 answered
   2026-10-02 (DR-036): they are DEAD, not merely unowned.** Queried read-only in both
   stores, the four non-empty ones are frozen at the 2026-09-15 import (`journal` max
   `created_at` `2026-09-15 23:48:35`; `accounts` 6 rows, `ledger` 3, `venues` 12, none with
   a later write) and `trades` is empty; the live controls (`assets`, advancing on each
   `fudcourt-sync` tick; `transactions`, reaching `2026-09-28`) confirm the probe. No writer
   exists in source, in `git log -S` history, in cron, in any system/user timer, or in the
   operator tree `~/.hermes/**`. So the owner is not "unidentified" — there is none, and the
   tables are dead; retirement is Phase 6 (no schema change this round). **"Dead" is a verdict on
   each TABLE, never on the noun:** `venues`'s table is unwritten while the venue *entity* is live
   (12 `venue_id`s in `reference.json`; slug validated at `accounts/exchange/account.go:122`;
   resolved by the executor's venue boundary), and `Account`/`LedgerEntry`/`Fill` are live entities
   in `backend/api/internal/accounts/**`, `[removed: finance/ledger]` and `executor.fills`; only `journal` is
   table-only (no code-side entity beyond the dashboard read).
2. **`price_history` has a schema, an index, a retention DELETE, and no writer.** **Dead by
   the same evidence (DR-036): the table is empty and has never been written, and `grep -rniI "INSERT INTO price_history"` over the **source** tree → 0 hits** (run it with source globs; a bare whole-tree grep is non-zero by construction, because the phrase occurs in the prose that records it, e.g. `canonical-model.md:856`) —
   the DDL comment ("Written by the price sampler") describes a producer that was never
   written, and the 90-day retention DELETE runs against a table nothing ever fills.
3. **`trades` duplicates the executor domain** (`executor.fills`/`child_orders`) in a
   parallel, unlinked, provider-shaped table.
4. **Numeric type policy is inconsistent:** `double precision`
   for money/quantity in the treasury tables, while the executor's *stated* convention is
   decimal.js upstream (and the Go `markets`/`ledger` value models use decimal strings).
5. **Snapshot vs canonical is unstated for `assets`:** it is a mutable latest-state table
   in the system of record, with history only in the `asset_history` hypertable.
6. **Embedded DDL duplication** (`executor-schema.sql` vs `EXECUTOR_DDL`) means the
   tracked schema file is documentation, not the artifact that runs.
7. **Two unrelated identity/user stores** exist (`users` in Neon for CMS editors,
   Discord OAuth sessions in Go for platform users); neither references the other.
8. **No foreign keys anywhere** in `public` (the executor schema *does* use FKs);
   relationships (`transactions.venue_id`→`venues.id`, `journal.*_account`→`accounts.code`,
   `trades.venue`→`venues.id`) are unenforced conventions.
