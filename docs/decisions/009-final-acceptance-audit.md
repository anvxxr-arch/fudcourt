# 009 — Final acceptance audit (2026-10-06): every criterion re-measured
## Status
Accepted — the ultra-lean refactor is **complete**, with three deliberate,
measured deviations (005, 006, 008). This document is the independent
re-measurement; it does not replace ADR 007, which recorded the acceptance
when the migration landed.

## Method
Every claim below was re-run against the tree at `HEAD`, not read from an
earlier document. Where a criterion is unmet, the reason is a prior ADR and
the measurement that supports it is restated.

## Repository
| Criterion | Measurement | Verdict |
|---|---|---|
| one Go module | `find . -name go.mod` → 1 (`./go.mod`, `github.com/anvxxr-arch/fudcourt`) | **met** |
| no `go.work` | absent | **met** |
| no tracked build artifacts | one pattern match — `apps/reconciler/src/bin/fudcourt-reconciled.rs` — which is a **Rust source** dir (`src/bin/`), not output. `.gitignore` covers `**/target/`, `**/.next/`, `**/dist/`, `**/coverage/`, `**/bin/`, `**/.shaper-tests/` and un-ignores `!**/src/bin/` | **met** |
| no historical duplicate app trees | `backend/`, `frontend/`, `shared/`, `infrastructure/`, `database/` all absent | **met** |

## Apps
`apps/{api,bot,data,executor,reconciler,web}` all present. All four Go
binaries build (`go build ./apps/{api,bot,data,executor}`); both Rust
binaries build (`cargo build --release --bins`); `apps/web` builds and
typechecks clean.

`apps/data` is retained and is a real runtime service — `deploy/systemd/
fudcourt-data.service` runs it on `:3101` as the external-data sidecar, so
the plan's "optional, only if a runtime service" condition is satisfied.

## Core
`core/` does not exist — **ADR 005**, re-verified this session:

```bash
for a in api bot data executor; do
  for b in api bot data executor; do
    [ "$a" = "$b" ] && continue
    grep -rn "fudcourt/apps/$b/" --include='*.go' apps/$a/
  done
done
```

No output. Zero cross-app imports still holds, so Go's `internal/` rule is
what keeps each app's packages private. Extracting to `core/` would widen
the API surface to consumers that do not exist.

## Frontend
`apps/web/src/` = `app/`, `cms/`, `features/`, `lib/`, `server/`, `styles/`,
`ui/`. Feature slices are domain-oriented (`auth`, `economy`, `executor`,
`market`, `news`, `portfolio`-adjacent, `signals`, `trade`, `admin`,
`home`, `overview`, `scoreboard`). One provider-named directory remains,
`features/cryptorank`, and it has **zero UI consumers** — only
`apps/web/tests/shaper-tests.ts` reads it, as the TS↔Go parity mirror the contract
gate parses. That is a verification asset, which the plan's own rule allows.

56 route handlers are **not** collapsed — **ADR 006**: the contract gates
`check_route_is_proxy()` per family and `check-contract.mjs` maps all 37
documented OpenAPI paths to per-family `route.ts` files, so deleting a
handler deletes the thing the gate guards, and a rewrite would change the
502 failure envelope.

## Contracts
Single canonical `contracts/` (67 tracked files). No `shared/contracts`.
The event catalog + event schema are one file (`events/events.json`). The
56 schema files were not merged into one `schemas.json` — the fragmentation
was 9 files under 20 lines, and merging would have rewritten 314 `$ref`
sites to remove 4% of the tree.

## Database
`db/schema/`, not `db/migrations/` — **ADR 008** (new this session). There
is no migration runner and no production migration history; both files are
already idempotent single-file sources.

## Tooling
One entrypoint: `tools/fud.ts` (`verify`, `contracts`, `deploy`,
`structure`, `test [go|web|sync]`, `live [family]`). Root `package.json`
scripts all dispatch to it. 19 live/offline verifier scripts remain under
`scripts/verify/`, reached through `fud.ts` rather than reimplemented —
the plan's target was "one discoverable entrypoint", not "rewrite
everything to TypeScript".

## Docs
`docs/architecture.md` is the canonical entry point (77 lines, six
sections, including a "where do I change what" table and an
"I want to change X" short-answer list). Every Definition-of-Done
navigation target resolves:

| Want to change | Location |
|---|---|
| risk calculation | `apps/executor/internal/risk` |
| Binance adapter | `apps/executor/internal/exchanges/binance` |
| CryptoRank ingestion | `apps/data/internal/research/cryptorank` |
| executor runtime | `apps/executor` |
| market UI | `apps/web/src/features/market` |
| API/event contract | `contracts/` |
| database | `db/` |

## Verification (this session, at HEAD)
| Surface | Command | Result |
|---|---|---|
| Go | `go build ./...` | **PASS** |
| Go | `go vet ./...` | **PASS** |
| Go | `go test ./...` | **PASS** — 43 packages, 0 fail |
| Go binaries | `go build ./apps/{api,bot,data,executor}` | **PASS** — 4/4 |
| Rust | `cargo test --release` | **PASS** — 17 tests (5 + 12) |
| Rust | `cargo build --release --bins` | **PASS** |
| Rust | `cargo fmt --check` | **PASS** |
| Rust | `cargo clippy --all-targets --all-features` | 4 style warnings, **0 errors** (pre-existing, in moved-not-rewritten source) |
| Web | `bunx tsc --noEmit` | **PASS** |
| Web | `bun run build` | **PASS** |
| Contracts | `fud.ts contracts` | **PASS** — CONTRACTS_OK / SCHEMAS_OK / DOCS_OK / MDTABLES_OK |
| Deploy | `fud.ts deploy` | **PASS** — 10 units |
| Stale paths | grep for 10 legacy path prefixes across runtime code | **0 matches** |

## The one red gate, and why it is not this refactor's
`fud.ts structure` failed with two violations, both in
`apps/web/src/ui/atoms/system/index.tsx` importing `lib/executor-lifecycle`
and `lib/executor-request-defs` across the DR-018 `ui/`-must-be-dependency-free
boundary.

`git log -1` on that file and on `apps/web/src/styles/tokens.ts` both name
**`9cd063a` — "feat(web): FUDCourt design system — foundations, atoms,
guardrail gate"**. That commit is not part of this refactor; it landed while
this audit was running. Confirmed by stashing the tree clean and re-running:
at the pre-design-system commit the structure gate is `STRUCTURE_OK`.

Recorded, not fixed: repairing the `ui/`→`lib/` boundary means either moving
the canonical lifecycle vocabulary out of `lib/` or accepting a type-only
re-export, and both are decisions for the design-system workstream that owns
those files.

**Resolved since this audit** by `1d6960e` — "refactor(web): declare the
execution lifecycle vocabulary in the atom layer, proven by test". The atom no
longer imports `@/lib`; it imports the two unions from a new sibling,
`apps/web/src/ui/atoms/system/lifecycle.ts`, and `fud.ts structure` returns
`STRUCTURE_OK`. The design-system workstream chose neither — it declared a
**type-only mirror inside the `ui/` layer** rather than re-exporting or
relocating anything: the new module
declares its own copy of `ExecutionStatus` and `ChildOrderStatus` and adds two
`readonly` arrays (`EXECUTION_STATUSES`, `CHILD_ORDER_STATUSES`) that exist only
in the `ui/` layer. It does **not** copy `EXECUTION_TRANSITIONS`, `canTransition`
or `isTerminalExecution`, so `lib/executor-lifecycle.ts` remains canonical for
every runtime behaviour.

**This is a deliberate duplicate source of truth, not an accident.** The
duplication is pinned in `apps/web/tests/design-system-atom-tests.ts` by a
compile-time mutual-assignability assertion over the engine and mirror unions,
plus runtime cross-checks of the atom's label maps against the engine's
`EXECUTION_TRANSITIONS` table and the frozen contract schema's
`execution_status` / `child_order_status` enums. A state added to either side
without the other fails those checks. A future reader should not "fix" the
duplication by reintroducing the import — that is the violation the gate exists
to catch.

## Size targets (metrics, not gates)
| Metric | Baseline | Now |
|---|---|---|
| tracked generated artifacts | 1 false positive | 1 false positive |
| Go modules | 4 | 1 |
| `go.work` | 1 | 0 |
| contract/schema files | ~68 | 67 |
| verify/tool scripts | ~39 | 19 (+ `tools/fud.ts`) |
| top-level dirs | 10 (pre-move: 8) | 10 |

## Conclusion
The repository is small because unnecessary structure disappeared —
`backend/`, `frontend/`, `shared/`, `infrastructure/`, `database/`, four Go
modules and `go.work` are gone, and every remaining boundary is one that
code actually enforces. The three unmet criteria (`core/`, proxy collapse,
`db/migrations`) are each recorded with the measurement that justifies them,
per the plan's own instruction to prefer clearer ownership over a smaller
tree.
