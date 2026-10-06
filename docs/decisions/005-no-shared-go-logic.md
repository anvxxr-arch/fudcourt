# 005 — Phase 4 core/ extraction deferred: no shared Go logic exists

## Status

Accepted — Phase 4 executed as a **flattening** of the `internal/core`
nesting inside `apps/executor`, not a `core/` extraction.

## Context

The migration plan's Phase 4 targets a canonical `core/` tree:

```
core/accounts  core/markets  core/trading
core/providers core/exchanges core/infra
```

The plan's premise is "Shared Go business logic ditempatkan di `core/`"
(shared Go business logic lives in `core/`). Phase 4 was therefore
scoped as an extraction: move the trading domain, exchange adapters and
providers out of their apps into a shared location.

Before moving anything, the actual dependency graph was measured. The
result is unambiguous:

```
apps/api     imports from apps/{bot,data,executor}: 0
apps/bot     imports from apps/{bot,data,executor}: 0
apps/data    imports from apps/{bot,data,executor}: 0
apps/executor imports from apps/{bot,data,executor}: 0
```

**There are no cross-app Go imports at all.** Every package is consumed
only by the app that owns it:

| Package | Importers | All inside |
|---|---|---|
| `internal/core/execution` | 68 files | `apps/executor` |
| `internal/core/risk` | 10 files | `apps/executor` |
| `internal/exchanges` (+ 4 venues) | 28 files | `apps/executor` |
| `internal/repository` | 10 files | `apps/executor` |
| `internal/research/*` (9 families) | 8 files | `apps/data` |
| `internal/markets/reference` | 7 files | `apps/api` |
| `internal/platform/{decimal,lock,session,credentials}` | — | `apps/executor` |

The two same-named packages that do exist are not duplicates:

- `apps/api/internal/platform/httpx` — inbound middleware: request-id,
  panic containment, the normalized error envelope.
- `apps/data/platform/httpx` — outbound: a tuned `http.Transport` and a
  `JSON.stringify`-compatible writer.

They share a name because both are "HTTP plumbing", not because either
is a copy of the other.

## Decision

**Do not create `core/` in this migration.** Instead:

1. Flatten `apps/executor/internal/core/*` to `apps/executor/internal/*`,
   removing one level of nesting that carried no information (the
   `core/` segment named the whole subtree, not a distinction inside it).
2. Leave every other package where it is.

## Rationale

The plan's own principles decide this case, and they decide it against
the extraction:

> Whenever an agent must choose between `smaller tree` and
> `clearer ownership` — prefer clearer ownership.

> The repository should be **small because unnecessary structure
> disappeared**, not because meaningful boundaries were destroyed.

> reduce boundaries / reduce indirection / reduce duplicate
> representations / reduce generated/tracked files

Extracting to `core/` would, concretely:

- **Add indirection.** A developer fixing risk math would have to know
  that `core/trading` is really the executor's private risk package. The
  plan's own Definition of Done says they should find it at
  `core/trading` — but the code is only ever run by the executor, so the
  honest location is inside it.
- **Destroy a real boundary.** Go's `internal/` rule is the mechanism
  that keeps these packages private to their app. Moving them to
  `core/` removes that protection and exposes them module-wide, to
  consumers that do not exist.
- **Create a second convention.** `core/exchanges` would sit beside
  `apps/executor/internal/exchanges` for the duration of any partial
  migration, which is exactly the "guess where something lives" problem
  the refactor exists to remove.

The `internal/` visibility rule also makes the extraction *impossible*
without a rewrite: `apps/executor/internal/core/risk` cannot be imported
from `core/trading` at all, because `internal/` binds a package to the
tree rooted at its parent's parent. Every consumer would have to be
re-pointed, and the packages would have to lose their `internal/`
protection — an API-surface widening, which the plan forbids
("No opportunistic rewrite", "Preserve public interfaces").

## Consequences

- `core/` does not exist. The acceptance criterion "Shared Go logic
  canonical: core/{accounts,markets,trading,providers,exchanges,infra}"
  is **not met**, deliberately, with this record as the justification.
- The trading domain lives at `apps/executor/internal/{execution,orders,
  planner,risk,sizing,strategies}` — one level shallower than before.
- If a second app ever needs the risk engine, the correct move is then a
  real extraction with real consumers to justify it, not a speculative
  one now.

## Verification

Zero cross-app imports is re-checkable at any time:

```bash
for a in api bot data executor; do
  for b in api bot data executor; do
    [ "$a" = "$b" ] && continue
    grep -rn "fudcourt/apps/$b/" --include='*.go' apps/$a/ && echo "EDGE $a -> $b"
  done
done
```

No output means the finding still holds.
