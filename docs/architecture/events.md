# Events — canonical contracts
> Reality-first: everything here is read off `shared/contracts/` (landed),
> `frontend/web/src/platform/executor/types.ts` and
> `apps/executor/internal/execution/enums.go`. Written 2026-10-01.
> Sources: `shared/contracts/events/catalog.json`,
> `shared/contracts/events/event.schema.json`,
> `shared/contracts/schemas/event-envelope.json`,
> `shared/contracts/events/README.md`, PRD §63.

## 1. Canonical envelope
Every domain event is the envelope of
`shared/contracts/schemas/event-envelope.json`:

| Field | Type | Meaning |
|---|---|---|
| `event_id` | uuid | Unique id of this event instance. |
| `event_type` | string | Stable **PascalCase** id from `events/catalog.json` (e.g. `ExecutionCreated`); legacy SCREAMING_SNAKE names are accepted aliases (§3). |
| `event_version` | integer ≥ 1 | Shape version; starts at 1. |
| `occurred_at` | integer | Unix **milliseconds**. |
| `request_id` | string \| null | Correlation id of the originating request, when known. |
| `actor_id` | string \| null | Acting user or service, when known. |
| `resource_id` | string \| null | Primary resource (execution id, account id, …). |
| `payload` | object | Event-specific data; free-form, additive keys allowed. |

Required: `event_id`, `event_type`, `event_version`, `occurred_at`, `payload`
(`event-envelope.json`); the envelope is `additionalProperties: false` — fields
are never invented outside the schema.

**event_version evolution rule:** consumers MUST tolerate additive changes
within the same version — unknown payload keys are allowed and MUST be ignored.
A **breaking** change (renaming/removing a key, changing a type or meaning)
bumps `event_version`. (Verbatim rule in `event-envelope.json` description and
`catalog.json` `payload_policy`; `shared/contracts/README.md` compatibility
rule: additive changes only per release, breaking changes require a versioned
path.)

## 2. The 23 ExecutionEventName values
The immutable append-only event vocabulary of the execution log. Rows 1–19
are the exact legacy list shared 1:1 by `frontend/web/src/platform/executor/types.ts`
(`ExecutionEventName`) and `apps/executor/internal/execution/enums.go`;
rows 20–23 are the 2026-10-01 catalog additions, carried by `enums.go` and
`catalog.json` but not yet by `types.ts` (no producer emits them yet):

| # | `ExecutionEventName` (TS/Go) | Meaning | Typical payload keys (emitter evidence) |
|---|---|---|---|
| 1 | `EXECUTION_CREATED` | execution record created from a validated plan | `mode`, `sizingMode`, `quantity`, `riskBudget` (`runtime.ts`) |
| 2 | `RISK_CALCULATED` | risk engine sized the position against the budget | `estimatedTotalRisk`, `estimatedFees`, `slippageBudget` (`runtime.ts`) |
| 3 | `PLAN_CREATED` | immutable creation-time plan snapshot persisted with the execution | `venueKey`, `strategy`, `estimatedSlices` (`runtime.ts`) |
| 4 | `EXECUTION_STARTED` | READY → RUNNING | `from`, `to` (`runtime.ts`) |
| 5 | `ORDER_SUBMITTED` | child order submitted to the venue (also used, `deferred: true`, when the venue may have taken an in-flight order before a retryable error) | `clientOrderId`, `orderId`, `quantity`, `price`, `stopPrice`; retry form: `clientOrderId`, `deferred`, `category` (`worker.ts`) |
| 6 | `ORDER_PARTIALLY_FILLED` | child order received a partial fill | `tradeId`, `clientOrderId`, `price`, `quantity` (`worker.ts`) |
| 7 | `ORDER_FILLED` | child order fully filled | `tradeId`, `clientOrderId`, `price`, `quantity` (`worker.ts`) |
| 8 | `ORDER_CANCELLED` | child order cancelled | `clientOrderId` (`worker.ts`) |
| 9 | `ORDER_REJECTED` | venue rejected a child order | `clientOrderId`, `category`, `message` (`worker.ts`) |
| 10 | `RISK_RECALCULATED` | risk recomputed after fills/market movement (PRD §36) | `filledQuantity`, `averageEntry`, `projectedRisk`, `remainingRiskBudget` (`worker.ts`) |
| 11 | `PLAN_RESIZED` | remaining plan resized to fit remaining budget (resize-then-stop) | `clientOrderId`, `requested`, `clamped` (`worker.ts`) |
| 12 | `EXECUTION_PAUSED` | RUNNING → PAUSED (user intent or safety pause: kill switch, insufficient balance, permission error) | `from`, `to` (API intent) or `reason` (worker safety) (`runtime.ts`/`worker.ts`) |
| 13 | `EXECUTION_RESUMED` | PAUSED → RUNNING | `from`, `to` (`runtime.ts`) |
| 14 | `EXECUTION_COMPLETED` | execution finished normally (plan consumed) | `status`, `reason` (`worker.ts`) |
| 15 | `EXECUTION_FAILED` | terminal adapter/engine error | `message` or `reason` (`worker.ts`) |
| 16 | `EXECUTION_RISK_STOPPED` | risk policy stopped the execution (PRD §37) | `status`, `reason` (`worker.ts`) |
| 17 | `EXECUTION_CANCELLED` | cancelled (orders cancelled; positions are NEVER closed by cancel) | `status`, `reason` (`worker.ts`) |
| 18 | `RECONCILIATION_MISMATCH` | local state disagreed with the venue during reconciliation | no payload keys observed in the TS producer yet (name is contract-only today — `types.ts`, `enums.go`) |
| 19 | `EXTERNAL_STATE_CHANGE` | venue state changed outside FUDCourt (manual order/cancel; vanished child; failed cancel) | `clientOrderId`, `detail` (`worker.ts`) |
| 20 | `ORDER_PLANNED` | child order planned for submission to the venue | no payload keys observed yet (contract-only so far — `catalog.json`, `enums.go`) |
| 21 | `ORDER_ACCEPTED` | venue accepted a child order | no payload keys observed yet (contract-only so far — `catalog.json`, `enums.go`) |
| 22 | `POSITION_UPDATED` | local position updated from a fill or external state change | no payload keys observed yet (contract-only so far — `catalog.json`, `enums.go`) |
| 23 | `BALANCE_UPDATED` | account balance updated from a fill or external state change | no payload keys observed yet (contract-only so far — `catalog.json`, `enums.go`) |

Payload keys above are the **observed** sets from the current producers —
evidence, not a closed contract (`catalog.json` `payload_policy`); additive
keys may appear and consumers must ignore unknown ones.

Storage: the executor event log is `executor.execution_events`
(`database/schema/executor-schema.sql`: "Append-only event log (PRD §63): no
UPDATE/DELETE path exists in the store and none may be added — history is the
product here"); the row shape is `ExecutionEventRecord` (`types.ts`:
`id`, `executionId`, `name`, `payload`, `createdAt`).

## 3. Alias map ↔ objective catalog names
`shared/contracts/events/catalog.json` is the single source of truth for
stable `event_type` ids. Canonical ids are **PascalCase** (the objective
catalog names); the legacy TS SCREAMING_SNAKE names are accepted aliases of the
same stable id at `event_version` 1 (emitters SHOULD emit the canonical id;
consumers MUST accept both spellings — `catalog.json` `alias_policy`).
Generated copies (`shared/sdk/typescript/src/generated/events.ts`) come from
`bun run generate` — never hand-edited.

| Canonical id (`event_type`) | Legacy alias (`ExecutionEventName`) |
|---|---|
| ExecutionCreated | EXECUTION_CREATED |
| RiskCalculated | RISK_CALCULATED |
| PlanCreated | PLAN_CREATED |
| ExecutionStarted | EXECUTION_STARTED |
| OrderPlanned | ORDER_PLANNED |
| OrderSubmitted | ORDER_SUBMITTED |
| OrderAccepted | ORDER_ACCEPTED |
| OrderPartiallyFilled | ORDER_PARTIALLY_FILLED |
| OrderFilled | ORDER_FILLED |
| OrderCancelled | ORDER_CANCELLED |
| OrderRejected | ORDER_REJECTED |
| PositionUpdated | POSITION_UPDATED |
| BalanceUpdated | BALANCE_UPDATED |
| RiskRecalculated | RISK_RECALCULATED |
| PlanResized | PLAN_RESIZED |
| ExecutionPaused | EXECUTION_PAUSED |
| ExecutionResumed | EXECUTION_RESUMED |
| ExecutionCompleted | EXECUTION_COMPLETED |
| ExecutionFailed | EXECUTION_FAILED |
| ExecutionRiskStopped | EXECUTION_RISK_STOPPED |
| ExecutionCancelled | EXECUTION_CANCELLED |
| ReconciliationMismatch | RECONCILIATION_MISMATCH |
| ExternalStateChange | EXTERNAL_STATE_CHANGE |

Five further canonical ids exist with **no** legacy alias (they are new to the
catalog, payloads must not contain key material):
`CredentialCreated`, `CredentialRevoked`, `ExchangeAccountConnected`,
`ReconciliationStarted`, `ReconciliationCompleted` — 28 catalog entries total
(`shared/contracts/events/catalog.json`; 24 as recorded in the
`docs/architecture/migration-plan.md` Phase 3 amendment, before the four
2026-10-01 additions).

## 4. Secrets rule
**Events never carry credentials or secrets of any kind** — keys, secrets,
passphrases, signed payloads, auth headers. This is stated in three places and
enforced by redaction on the audit side:

- `shared/contracts/schemas/event-envelope.json`: payload "Never contains
  credentials or secrets."
- `shared/contracts/events/catalog.json` `payload_policy`: "Events MUST NOT
  carry credentials or secrets of any kind." (and `CredentialCreated`: "Payload
  MUST NOT contain key material.")
- Audit-side enforcement: the `Redact` rule in
  `apps/api/internal/audit/audit.go` — any metadata value under a key whose
  name case-insensitively contains `secret`, `token`, `password`, `passphrase`,
  `api_key`, `api_secret`, `private_key`, `authorization` or `cookie` becomes
  `[REDACTED]`; redaction recurses through maps AND slices, never mutates its
  input. The same rule applies to anything event/audit-bound.

Producers back this up: `frontend/web/src/platform/executor/exchange.ts`
sanitizes adapter errors (`SECRET_PATTERNS`) so no key/secret/passphrase or
signed payload can appear in an `ExecutorError` (PRD §109); the event payloads
emitted from `runtime.ts`/`worker.ts` carry ids, quantities, prices, statuses
and reasons only (see §2). If an event ever needs to reference a credential, it
carries the **credential id**, never the secret (see
`docs/architecture/security.md` §2).
