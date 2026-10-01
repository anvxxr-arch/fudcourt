# @fudcourt/contracts

The **canonical contracts** of FUDCourt: the executor HTTP surface (OpenAPI),
the cross-service event contract (catalog + JSON Schemas), and the shared error
model. Everything here is documentation of REAL current behavior — fields and
endpoints are never invented; when the frozen TS contract in
`apps/web/src/platform/executor/types.ts` says a value may be unknown, the
schemas say `nullable`, not `0`.

## What this package is

* **The API contract source of truth for the Go services being built.**
  `services/api` and `services/executor` MUST preserve the methods, paths, and
  response envelopes in [`openapi/fudcourt.yaml`](openapi/fudcourt.yaml); the
  migration may add endpoints but must not change or drop these.
* **The compatibility contract** consumed by `packages/sdk-ts`, whose types are
  generated from this package.
* **The event contract** for anything that emits domain events (Go services,
  workers, projections).

The OpenAPI document covers the CURRENT TS-owned surface during the Go
migration: the endpoint list mirrors the header of
`apps/web/src/features/executor/client.ts`, the schemas mirror the frozen types
in `apps/web/src/platform/executor/types.ts` exactly, and the response
envelopes mirror the route handlers under the Next.js app api tree
(`apps/web/src/app/(frontend)/api/executor/**/route.ts`).

## File map

| Path | What it is |
| --- | --- |
| `openapi/fudcourt.yaml` | OpenAPI 3.0.3 of the executor HTTP surface (15 paths / 19 operations): preview, executions + lifecycle + child orders/fills/events, BYOK accounts (masked-only), settings, emergency stop. Component schemas mirror `types.ts` 1:1, including the enums (`ExecutionStatus` 15 values, `ExecutionEventName` 19 values, the 9 sizing modes, …). |
| `events/catalog.json` | **Single source of truth** for stable `event_type` ids and their aliases (legacy TS `ExecutionEventName` names ↔ canonical PascalCase names). |
| `events/event.schema.json` | JSON Schema (draft 2020-12) for one canonical event. |
| `events/README.md` | Envelope field table, naming/alias rules, no-secrets rule, evolution rules. |
| `schemas/event-envelope.json` | The shared event envelope (`event_id`, `event_type`, `event_version`, `occurred_at`, `request_id`, `actor_id`, `resource_id`, `payload`). |
| `schemas/error-envelope.json` | The normalized error model (`code`, `message`, `request_id`) with the 12 error codes (`validation`, `authorization`, `credential`, `exchange`, `insufficient_balance`, `risk_limit`, `rate_limit`, `timeout`, `network`, `conflict`, `not_found`, `internal`). |
| `scripts/check-contract.mjs` | Offline drift gate (see below). |

## Versioning and evolution

* **`event_version`** is a semver-ish **integer** per `event_type`, starting at
  `1`. Additive evolution (new event types, new optional payload keys) keeps
  the version; a breaking change to an existing shape bumps it. **Consumers
  must tolerate additive evolution**: unknown payload keys MUST be ignored,
  unknown event types MUST not crash a consumer.
* **Stable ids never change meaning and are never reused.** PascalCase names
  (`ExecutionCreated`) are canonical; the legacy TS names
  (`EXECUTION_CREATED`) are accepted aliases of the same id, listed per entry
  in `events/catalog.json`.
* **HTTP surface**: consumers MUST NOT add unknown fields to request bodies —
  the request schemas are closed (`additionalProperties: false`). New fields go
  into this document first, then the SDK is regenerated. Response objects may
  gain fields additively; consumers must ignore what they do not know.
* **Events never carry credentials or secrets** — not in payloads, not ever.
  Credential material is write-only through `POST /api/executor/accounts` and
  is only ever echoed back as a masked key (`abc...xyz`).

## How `packages/sdk-ts` is generated

`packages/sdk-ts` is a thin typed fetch client over this contract:

1. `bun run generate` runs `openapi-typescript` over
   [`openapi/fudcourt.yaml`](openapi/fudcourt.yaml), emitting
   `packages/sdk-ts/src/generated/schema.d.ts`.
2. The same generate step renders `packages/sdk-ts/src/generated/events.ts`
   from `events/catalog.json` (single source — no hand-synced copies).
3. `packages/sdk-ts/src/client.ts` types every endpoint against the generated
   schema (no duplicated field definitions), and `src/events.ts` re-exports the
   generated catalog types.
4. `bun run check:contracts` runs `scripts/check-contract.mjs`, which fails the
   build if the OpenAPI enums drift from `types.ts`, if a documented path loses
   its route handler (or an executor handler is undocumented), or if the event
   catalog stops covering the TS `ExecutionEventName` values.

## Drift gate

```sh
node packages/contracts/scripts/check-contract.mjs   # or: bun run check:contracts (in packages/sdk-ts)
```

Prints `CONTRACTS_OK` with counts on success; lists every `CONTRACT_FAIL` line
and exits `1` otherwise. No network, no dependencies.
