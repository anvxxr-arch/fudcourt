# 010 — Task 6C proxy collapse executed: one gateway, contract preserved

## Status

Accepted — 2026-10-07. Supersedes
[006](006-proxy-collapse-deferred.md).

## Context

Task 6C asks to collapse the pure-passthrough routes into one gateway, with
the acceptance criterion "jumlah route handler harus turun secara material".
ADR-006 deferred this: the 22 passthrough handlers (6 `:3101` data families,
the `:3102` reconcile proxy, 15 `:3105` executor shells) are the
machine-checked contract surface, and the three blockers it named were real.

## Decision

The collapse is executed, on the design that answers all three blockers.

**One catch-all at `apps/web/src/app/(frontend)/api/[...path]/route.ts`, not a
rewrite.** Next resolves a concrete route ahead of a catch-all, so every real
application route keeps its own handler and this file only ever sees a path no
specific handler claimed. Two consequences follow, and they are the whole
point:

- **The 502 envelope survives.** The gateway re-implements each family's
  forwarding verbatim (timeout, relayed headers, `{error, upstream, kind}`
  body, 502 on an unreachable sidecar), so blocker 2 is answered by
  construction. A `rewrites()` entry to an external destination would not
  have — Next answers its own 500/504, with a different body.
- **The auth boundary survives.** `middleware.ts` gates on the ORIGINAL
  pathname (`/api/reconcile` and `/api/executor/*` are team-tier, per
  `@/server/auth`). Because the URL is unchanged, the gate still sees it. A
  rewrite to `/api/backend/*` would have left the gateway reachable at a path
  the tier table does not gate — an auth hole, and a worse defect than the one
  6C was fixing.

**The executor's 15 shells collapse into the same gateway**, dispatched to
`forwardExecutor()` (now `src/server/executor-proxy.ts`, moved out of the
deleted route tree). Blocker 3's 404 change is accepted and bounded: a path no
executor route matches now reaches the Go mux, which answers a plain-text 404
instead of Next's own 404 page. It is the one behavior change in this work,
and it is recorded here rather than discovered.

## Gate changes (the coordinated contract change ADR-006 required)

- `scripts/verify/check-contract.py`: `check_route_is_proxy()` and the
  reconcile block now assert the invariant against the gateway source when a
  family's own `route.ts` is absent — "the gateway forwards this family
  verbatim and owns no validation" replaces "this family's file exists".
- `contracts/scripts/check-contract.mjs`: a documented OpenAPI path with no
  specific handler is valid iff the gateway serves its first segment and
  exports the documented method. The gateway's routing table
  (`DATA_FAMILY_NAMES` + `reconcile` + `executor`) is read from source.

## Consequences

- Route handlers under `(frontend)/api`: 53 → 32 (56 → 35 counting the
  Payload CMS tree). 22 files deleted, 1 added, 1 moved.
- The 404 body for an unknown path changes, in two places, with the status
  unchanged. `/api/<unknown>` answers the gateway's JSON 404 rather than
  Next's HTML 404 page (measured live: 404, `application/json`). An
  *authenticated* request to an unknown executor subpath reaches the Go mux
  and gets its plain-text 404 rather than Next's page — unauthenticated
  callers never get that far, the tier gate answers 401 first, so the live
  unauthenticated surface is unchanged.
- The Go sidecars still own all validation; the web tier re-implements none
  of it. `check_route_is_proxy` continues to fail if a needle (python spawn,
  shaper import, mode table) appears in the gateway.
