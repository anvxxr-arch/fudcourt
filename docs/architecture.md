# Architecture

The canonical entry point. Everything a newcomer needs to orient is one hop
from here; nothing below is a second copy of another document.

**Start with [`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md).**
It is the current-state map: the product statement, the repository map (§1a —
"where do I change what"), the runtime topology, the API boundaries, and the
data families. If this file and the code disagree, the code wins and that file
is wrong; fix it the same day.

## The shape in one paragraph

One Go module at the root. `apps/` holds every deployable — `api`, `bot`,
`data`, `executor` (Go), `reconciler` (Rust), `web` (Next 16). There is no
`core/`: measured zero cross-app imports, so Go's `internal/` rule is what keeps
each app's packages private to it (ADR 005). Contracts, DDL, fixtures, tooling,
deployment and docs each have exactly one home, and `tools/fud.ts` is the one
command surface.

## Where things live

| Concern | Home |
|---|---|
| executables | `apps/{api,bot,data,executor,reconciler,web}` |
| API + event contract | `contracts/` — OpenAPI, schemas, events, and the four drift gates |
| database DDL | `db/schema/` — the treasury schema and the execution ledger |
| shared test fixtures | `tests/fixtures/` (shared) · package-local `testdata/` (private) |
| verification | `scripts/verify/`, reached through `tools/fud.ts` |
| deployment | `deploy/systemd/` |
| environment | `.env.example` (root, Go/Rust/sync) · `apps/web/.env.example` (Next) |

## The one command

```bash
node tools/fud.ts verify      # every offline gate — the canonical green check
node tools/fud.ts contracts   # the four contract drift gates
node tools/fud.ts deploy      # the systemd unit guard
node tools/fud.ts structure   # the frontend structure gate
node tools/fud.ts test        # the three test suites
node tools/fud.ts live [fam]  # the live/network harnesses (list, or run one)
```

## Reading order by intent

| I want to… | Read |
|---|---|
| understand the system | `architecture/ARCHITECTURE.md` |
| understand the data model | `architecture/canonical-model.md`, `architecture/SCHEMA.md` |
| know where a value comes from | `architecture/source-catalog.md`, `architecture/data-catalog.md` |
| change the schema or a contract | `contracts/` + `db/schema/` |
| deploy or operate | `docs/operations/` + `deploy/systemd/` |
| know why something is the way it is | `docs/decisions/` (ADRs) and `docs/records/DECISIONS.md` |

## Decisions that shaped this layout

| ADR | Decision |
|---|---|
| [005](decisions/005-no-shared-go-logic.md) | no `core/` — zero cross-app imports, so `internal/` is the boundary |
| [006](decisions/006-proxy-collapse-deferred.md) | the sidecar proxy routes stay — the contract gates are the contract |
| [007](decisions/007-architecture-acceptance.md) | the acceptance scorecard, measured against the tree as committed |
| [refactor-baseline](decisions/refactor-baseline.md) | the pre-refactor baseline this layout was migrated from |
