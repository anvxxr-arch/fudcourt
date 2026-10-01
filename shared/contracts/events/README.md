# FUDCourt event contracts

Canonical, transport-agnostic contract for every domain event FUDCourt emits.
The executor's own event log (`ExecutionEventRecord`, names from the frozen
`frontend/web/src/platform/executor/types.ts`) is the legacy producer whose names are
mapped into this catalog — see [catalog.json](catalog.json).

## Files

| File | What it is |
| --- | --- |
| `catalog.json` | **Single source of truth** for stable `event_type` ids and their aliases. |
| `event.schema.json` | JSON Schema (draft 2020-12) for one event: shared envelope + `event_type` pinned to the catalog ids. |
| `../schemas/event-envelope.json` | The shared envelope schema (also used by services). |

## Envelope

Every event is the envelope defined in
[`../schemas/event-envelope.json`](../schemas/event-envelope.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `event_id` | uuid | Unique id of this event instance. |
| `event_type` | string | Stable **PascalCase** id from `catalog.json`, e.g. `ExecutionCreated`. |
| `event_version` | integer ≥ 1 | Semver-ish shape version of the event type. |
| `occurred_at` | integer | Unix **milliseconds**. |
| `request_id` | string \| null | Correlation id of the originating request, when known. |
| `actor_id` | string \| null | Acting user or service, when known. |
| `resource_id` | string \| null | Primary resource (execution id, account id, ...). |
| `payload` | object | Event-specific data; free-form, see below. |

```json
{
  "event_id": "6f1c4c2e-2f0a-4f2f-9a4a-3c6a2c1f0001",
  "event_type": "ExecutionCreated",
  "event_version": 1,
  "occurred_at": 1727000000000,
  "request_id": "req_01HQ…",
  "actor_id": "user_42",
  "resource_id": "exec_01HQ…",
  "payload": { "mode": "paper", "sizingMode": "risk_usd", "quantity": 0.01, "riskBudget": 50 }
}
```

## Naming and aliases

- **Canonical ids are PascalCase** (`ExecutionCreated`, `OrderFilled`, …).
- The legacy TS names (`EXECUTION_CREATED`, `ORDER_FILLED`, …) are **aliases of
  the same stable id** — they are listed per entry in `catalog.json`
  (`aliases`), alongside the objective names used in design docs
  (`objective_names`). Emitters SHOULD emit the canonical id; consumers MUST
  accept either spelling when reading legacy producers (the executor event log
  stores the legacy name in `ExecutionEventRecord.name`).
- `catalog.json` also records `observed` payload keys where the current TS
  implementation is known — evidence, not a closed schema.

## Rules

1. **Events never carry credentials or secrets.** No API keys, secrets,
   passphrases, or decrypted material in `payload` — ever. Credential events
   reference records by id and masked key only.
2. **Consumers must tolerate additive evolution.** Unknown payload keys MUST be
   ignored. Additive changes (new event types, new optional payload keys) keep
   `event_version`; a breaking change to an existing shape bumps `event_version`
   and the old version must keep being understandable.
3. `event_type` values are **stable ids**: once published in `catalog.json` an
   id never changes meaning and is never reused.

## Code generation

`shared/sdk/typescript` derives its event types and runtime catalog from
`catalog.json` (`bun run generate`); `shared/contracts/scripts/check-contract.mjs`
fails if the catalog stops covering every TS `ExecutionEventName` value or if
`event.schema.json`'s `event_type` enum drifts from the catalog ids.
