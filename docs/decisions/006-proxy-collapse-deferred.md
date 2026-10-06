# 006 — Task 6C proxy collapse deferred: the contract gates are the contract

## Status

Accepted — the 56 route handlers are **not** collapsed. The reduction the
plan targets is achieved elsewhere (see *What was done instead*).

## Context

Task 6C asks to "collapse pure proxy routes" into Next rewrites or a
generic gateway, with the acceptance criterion "jumlah route handler harus
turun secara material" (the handler count must fall materially).

The 56 handlers under `apps/web/src/app/(frontend)/api/**` classify as:

| Class | Count | What it is |
|---|---|---|
| A — real behavior | 3 | `auth/{login,logout,callback}` — OAuth round-trip, signed-cookie handling |
| A — real behavior | 31 | local routes: Postgres reads, upstream fetches, shaping, validation |
| B — passthrough | 6 | `coinank`, `coinglass`, `coinmarketcap`, `cryptorank`, `llama`, `news` → `:3101` |
| B — passthrough | 1 | `reconcile` → `:3102` (**team-tier gated**) |
| B — passthrough | 15 | `executor/**` → `:3105`, all calling one shared `forwardExecutor()` |

## Why the collapse was not performed

Three independent blockers, any one of which is sufficient.

**1. The contract gates require the per-family handlers to exist.**

`scripts/verify/check-contract.py` calls `check_route_is_proxy()` seven
times (cryptorank, llama, news, coinglass, coinank, coinmarketcap,
reconcile). Each call asserts, for that family's own `route.ts`:

- the file exists,
- it contains `DATA_URL` (or `RECONCILE`) — "proxy wiring lost" otherwise,
- it contains none of a needle list (`execFile`, `child_process`,
  `cr_fetch`, `CR_PYTHON`, `CR_MODES.includes`, `limitedFetch`),
- for reconcile specifically: it does **not** import the TS shaper, and it
  **does** carry a 502 path.

These are not incidental tests. They are the machine-checked statement of
"the Go sidecar owns validation; the web tier is a thin proxy". Deleting
the handler to satisfy a file-count metric deletes the thing the gate
guards. `shared/contracts/scripts/check-contract.mjs` adds a second
dependency: it maps all 37 documented OpenAPI paths to
`apps/web/src/app/**/api/<key>/route.ts` and fails when a handler is
missing. A gateway at `/api/backend/[...path]` satisfies neither.

**2. The failure contract would change.**

Each sidecar proxy catches its own fetch failure and answers a specific
envelope:

```json
{ "error": "fudcourt-data unreachable: <real reason>", "upstream": "...", "kind": "<mode>" }
```

with status 502. A Next `rewrites()` entry to an external destination
returns Next's own 500/504 on upstream failure, with a different body and
no `upstream`/`kind`. The house rule these routes implement is "fail loud
with the real reason"; a rewrite fails quieter. That is a change to
`API response shapes`, which §1 of the plan forbids.

**3. The executor catch-all would change 404 semantics.**

The 15 executor shells are already collapsed in the way that matters:
they are 5–8 lines each, all delegating to one `forwardExecutor()` in
`_proxy.ts`. Replacing them with `executor/[...path]/route.ts` would
forward *unknown* subpaths to the Go mux, which has no `/` handler and
answers a plain-text 404 — replacing Next's own 404. Method dispatch
would survive (the catch-all can export all five verbs), but the
unknown-path response would not.

## What was done instead

The material reduction is real, and it does not touch the contract
surface:

- **Provider leakage removed from the UI architecture** (Task 6B): the
  `features/llama`, `features/market-data/cryptorank` and
  `features/market-data/markets` trees are typing/display mirrors of
  backend provider detail. They were audited and folded into the domain
  features the frontend actually renders (`features/market`,
  `features/news`), so no UI module names a data vendor as an
  architectural unit.
- **Duplicate shared infrastructure collapsed** (Task 6D): one canonical
  implementation per concern, chosen by measuring which copies existed
  and which had consumers.

## If the collapse is still wanted later

It is achievable, but it is a contract change, not a refactor:

1. Move the per-family assertions in `check-contract.py` from
   "this family's `route.ts` is a thin proxy" to "the gateway forwards
   this family verbatim and owns no validation".
2. Re-express the 37 OpenAPI paths in `check-contract.mjs` against the
   gateway's routing table.
3. Decide, explicitly, what the 502 envelope becomes — and update every
   consumer that reads `error`/`upstream`/`kind`.

Those three are a coordinated change to the contract *and* its two
gates. Doing them silently inside a structural migration is exactly what
§1 forbids.
