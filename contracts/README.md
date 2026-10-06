# @fudcourt/contracts

The **canonical contracts** of FUDCourt: the executor HTTP surface (OpenAPI),
the cross-service event contract (catalog + JSON Schemas), and the shared error
model. Everything here is documentation of REAL current behavior — fields and
endpoints are never invented; when the wire types in
`apps/web/src/lib/executor.ts` say a value may be unknown, the
schemas say `nullable`, not `0`.

## What this package is

* **The API contract source of truth for the Go services.** `apps/api` and
  `apps/executor` MUST preserve the methods, paths, and response
  envelopes in [`openapi/fudcourt.yaml`](openapi/fudcourt.yaml); additions are
  allowed but these must not change or drop.
* **The event contract** for anything that emits domain events (Go services,
  workers, projections).

The OpenAPI document covers the **Go-owned** executor HTTP surface: the endpoint
list mirrors the header of `apps/web/src/features/executor/client.ts`, the
schemas mirror the wire types in `apps/web/src/lib/executor.ts`
exactly, and the response envelopes are the contract the Go runtime
(`apps/executor`) serves. The executor runtime is the Go service and the
Next.js route handlers under
`apps/web/src/app/(frontend)/api/executor/**/route.ts` are thin `_proxy.ts`
shells that forward to it; this document describes the Go surface, not a TS
implementation.

## File map

| Path | What it is |
| --- | --- |
| `openapi/fudcourt.yaml` | OpenAPI 3.0.3 of the executor HTTP surface (15 paths / 19 operations): preview, executions + lifecycle + child orders/fills/events, BYOK accounts (masked-only), settings, emergency stop. Component schemas mirror `apps/web/src/lib/executor.ts` 1:1, including the enums (`ExecutionStatus` 15 values, `ExecutionEventName` 19 values, the 9 sizing modes, …). |
| `events/events.json` | **Single source of truth** for stable `event_type` ids and their aliases (legacy TS `ExecutionEventName` names ↔ canonical PascalCase names). |
| `events/README.md` | Envelope field table, naming/alias rules, no-secrets rule, evolution rules. |
| `schemas/event-envelope.json` | The shared event envelope (`event_id`, `event_type`, `event_version`, `occurred_at`, `request_id`, `actor_id`, `resource_id`, `payload`). |
| `schemas/error-envelope.json` | The normalized error model (`code`, `message`, `request_id`) with the 12 error codes (`validation`, `authorization`, `credential`, `exchange`, `insufficient_balance`, `risk_limit`, `rate_limit`, `timeout`, `network`, `conflict`, `not_found`, `internal`). |
| `scripts/check-contract.mjs` | Offline drift gate (see below; run it as `node contracts/scripts/check-contract.mjs`). |

## Versioning and evolution

* **`event_version`** is a semver-ish **integer** per `event_type`, starting at
  `1`. Additive evolution (new event types, new optional payload keys) keeps
  the version; a breaking change to an existing shape bumps it. **Consumers
  must tolerate additive evolution**: unknown payload keys MUST be ignored,
  unknown event types MUST not crash a consumer.
* **Stable ids never change meaning and are never reused.** PascalCase names
  (`ExecutionCreated`) are canonical; the legacy TS names
  (`EXECUTION_CREATED`) are accepted aliases of the same id, listed per entry
  in `events/events.json`.
* **HTTP surface**: consumers MUST NOT add unknown fields to request bodies —
  the request schemas are closed (`additionalProperties: false`). New fields go
  into this document first. Response objects may gain fields additively;
  consumers must ignore what they do not know.
* **Events never carry credentials or secrets** — not in payloads, not ever.
  Credential material is write-only through `POST /api/executor/accounts` and
  is only ever echoed back as a masked key (`abc...xyz`).


## Drift gate

```sh
node contracts/scripts/check-contract.mjs
```

Prints `CONTRACTS_OK` with counts on success; lists every `CONTRACT_FAIL` line
and exits `1` otherwise. No network, no dependencies.
