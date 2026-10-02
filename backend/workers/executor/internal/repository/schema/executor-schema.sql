-- Executor domain schema (PRD §59–§63, §110) — the tracked DDL for the
-- executor.* Postgres schema.
--
-- WHY A SEPARATE SCHEMA: the treasury read model (database/schema/pg-schema.sql, `public`) is
-- pruned and overwritten wholesale by the Turso->Postgres mirror; the executor
-- writes live data and must never share that blast radius. Everything here lives
-- in `executor` and nothing in `platform/db/mirror.ts` touches it.
--
-- Applied at STARTUP by two runtimes, both idempotent and both one statement at
-- a time (the extended query protocol refuses multi-statement strings):
--   * TypeScript — `ensureExecutorSchema()` in src/platform/executor/store.ts,
--     from its embedded `EXECUTOR_DDL` copy.
--   * Go — `repository.EnsureSchema()` at `cmd/executor` startup
--     (backend/workers/executor/internal/repository/schema.go, commit
--     `8d87df1`), run BEFORE the worker loop and either HTTP surface can serve;
--     a failure is fatal (objective §34).
-- There is still no separate migration runner. This tracked file is the SOLE
-- OWNER of the DDL; each runtime keeps a copy and each copy has its own drift
-- guard against this file:
--   * TS copy — executor-store-tests.ts compares after normalizing away blank
--     lines and `--` comment lines (so pure reformatting cannot mask a change,
--     and a real statement change cannot hide behind it).
--   * Go copy (backend/workers/executor/internal/repository/schema/executor-schema.sql)
--     — TestEmbeddedSchemaMatchesTracked requires BYTE IDENTITY, strictly
--     stronger (it also guards a comment-only edit; recopy after editing this
--     file).
-- Every statement is idempotent.
--
-- Conventions:
--   * timestamps are bigint unix MILLISECOND values (the domain types carry
--     number ms) — never timestamptz, so a JS number round-trips exactly
--   * money/quantity columns are double precision (wire values are numbers;
--     calculation happens in decimal.js upstream, never in SQL)
--   * status/name/enum columns are text — the type unions live in types.ts
--
-- Runs on Postgres >= 13 (gen_random_uuid() is built-in from 13).
CREATE SCHEMA IF NOT EXISTS executor;

-- PRD §59's exchange_accounts MERGED with §45's exchange_credentials: in the MVP
-- one connected account is exactly one credential set, so two tables would be a
-- join with no independent lifecycle. The credential columns are §45's shape.
-- `iv`/`auth_tag` carry the AES-256-GCM nonce/tag of each secret CONCATENATED in
-- column order (api_key, api_secret, [passphrase]) — 12-byte IV + 16-byte tag per
-- secret, because a GCM nonce must never repeat under one key.
CREATE TABLE IF NOT EXISTS executor.exchange_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               text NOT NULL,
  exchange              text NOT NULL,
  label                 text NOT NULL,
  api_key_masked        text NOT NULL,
  api_key_encrypted     bytea NOT NULL,
  api_secret_encrypted  bytea NOT NULL,
  passphrase_encrypted  bytea,
  iv                    bytea NOT NULL,
  auth_tag              bytea NOT NULL,
  permissions           jsonb NOT NULL DEFAULT '{}'::jsonb,
  health                text NOT NULL DEFAULT 'UNKNOWN',
  created_at            bigint NOT NULL,
  updated_at            bigint NOT NULL,
  last_used_at          bigint,
  revoked_at            bigint
);
CREATE INDEX IF NOT EXISTS exchange_accounts_user_idx ON executor.exchange_accounts (user_id);

-- PRD §60 (snake_case). `account_id` is NOT NULL even for PAPER/preview modes
-- (§99/§127 decision): a paper execution reuses the account's market/fee/balance
-- context but NEVER sends an order — the paper adapter only reads the injected
-- market-data surface. mode/risk_policy/strategy_state are the extra runtime
-- columns (PRD §118, §37, §130); the plan itself snapshots into
-- execution_plans.
CREATE TABLE IF NOT EXISTS executor.executions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               text NOT NULL,
  account_id            uuid NOT NULL REFERENCES executor.exchange_accounts (id),
  exchange              text NOT NULL,
  symbol                text NOT NULL,
  market_type           text NOT NULL,
  side                  text NOT NULL,
  intent                text NOT NULL,
  status                text NOT NULL,
  mode                  text NOT NULL,
  sizing_mode           text NOT NULL,
  sizing_value          double precision NOT NULL,
  risk_budget           double precision,
  risk_basis            text,
  entry_definition      jsonb NOT NULL,
  stop_definition       jsonb,
  take_profit_definition jsonb NOT NULL DEFAULT '[]'::jsonb,
  execution_strategy    text NOT NULL,
  execution_config      jsonb NOT NULL,
  constraints           jsonb NOT NULL DEFAULT '{}'::jsonb,
  planned_quantity      double precision NOT NULL,
  planned_notional      double precision NOT NULL,
  actual_quantity       double precision NOT NULL,
  actual_notional       double precision NOT NULL,
  average_fill_price    double precision,
  estimated_fees        double precision,
  actual_fees           double precision NOT NULL,
  planned_risk          double precision,
  current_risk          double precision,
  risk_policy           text,
  strategy_state        jsonb,
  created_at            bigint NOT NULL,
  started_at            bigint,
  completed_at          bigint,
  cancelled_at          bigint
);
CREATE INDEX IF NOT EXISTS executions_user_created_idx ON executor.executions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executions_status_idx ON executor.executions (status);

-- Immutable creation-time plan snapshot (PRD §56, §99): the worker's risk math
-- reads THIS, never a re-derived plan.
CREATE TABLE IF NOT EXISTS executor.execution_plans (
  execution_id uuid PRIMARY KEY REFERENCES executor.executions (id),
  plan         jsonb NOT NULL,
  created_at   bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS executor.child_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id      uuid NOT NULL REFERENCES executor.executions (id),
  exchange_order_id text,
  client_order_id   text NOT NULL,
  symbol            text NOT NULL,
  side              text NOT NULL,
  type              text NOT NULL,
  price             double precision,
  quantity          double precision NOT NULL,
  filled_quantity   double precision NOT NULL DEFAULT 0,
  status            text NOT NULL,
  is_exit           boolean NOT NULL DEFAULT false,
  submitted_at      bigint,
  updated_at        bigint NOT NULL,
  filled_at         bigint,
  UNIQUE (execution_id, client_order_id)
);
CREATE INDEX IF NOT EXISTS child_orders_execution_idx ON executor.child_orders (execution_id);

-- Dedup on (account_id, exchange_trade_id) IS the idempotent-fill guarantee
-- (PRD §62): insertFill returns null on conflict and the worker treats that as
-- "already ingested".
CREATE TABLE IF NOT EXISTS executor.fills (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id      uuid NOT NULL REFERENCES executor.executions (id),
  child_order_id    uuid REFERENCES executor.child_orders (id),
  account_id        uuid NOT NULL REFERENCES executor.exchange_accounts (id),
  exchange_trade_id text NOT NULL,
  price             double precision NOT NULL,
  quantity          double precision NOT NULL,
  quote_quantity    double precision NOT NULL,
  fee               double precision NOT NULL,
  fee_asset         text NOT NULL,
  timestamp         bigint NOT NULL,
  UNIQUE (account_id, exchange_trade_id)
);
CREATE INDEX IF NOT EXISTS fills_execution_idx ON executor.fills (execution_id);

-- Append-only event log (PRD §63): no UPDATE/DELETE path exists in the store and
-- none may be added — history is the product here.
CREATE TABLE IF NOT EXISTS executor.execution_events (
  id           bigserial PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES executor.executions (id),
  name         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS execution_events_execution_idx ON executor.execution_events (execution_id, id);

-- Reconciliation history (PRD §41, §59): periodic balance/position snapshots.
CREATE TABLE IF NOT EXISTS executor.balance_snapshots (
  id         bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES executor.exchange_accounts (id),
  payload    jsonb NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS balance_snapshots_account_idx ON executor.balance_snapshots (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS executor.positions_snapshots (
  id         bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES executor.exchange_accounts (id),
  payload    jsonb NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS positions_snapshots_account_idx ON executor.positions_snapshots (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS executor.risk_profiles (
  user_id    text PRIMARY KEY,
  profile    jsonb NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS executor.audit_logs (
  id         bigserial PRIMARY KEY,
  user_id    text,
  action     text NOT NULL,
  target     text,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON executor.audit_logs (user_id, id);
