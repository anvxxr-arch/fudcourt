# Refactor Baseline — 2026-10-06 Re-audit

Independent re-measurement of the repository, taken **after** the structural
migration already recorded in `docs/decisions/refactor-baseline.md` and
`docs/decisions/007-architecture-acceptance.md`. This file exists to record
today's numbers, not to replace either document. Nothing was fixed, moved,
formatted or committed to gather it.

- **Branch:** `main`
- **Commit:** `633ffebf52e2aeca21890b62aa82d55012db23c7`
- **Commit subject:** `docs(db,docs): repair db/README.md, docs/README.md and the index prose`
- **Captured:** 2026-10-06
- **Working tree at capture:** dirty — **14 modified, 31 untracked, 0 staged**
  (all in-flight design-system work; see *Working tree* below). The tree was
  changing during the capture window (one new untracked file,
  `apps/web/scripts/checks/check-design-system.py`, appeared mid-run), so the
  file counts below are a point-in-time snapshot, explicitly labelled where the
  shift matters.

> **Snapshot status.** The design-system workstream this snapshot describes
> has since committed itself (`9cd063a`, "feat(web): FUDCourt design system —
> foundations, atoms, guardrail gate"), so "14 modified / 31 untracked" no
> longer describes the tree. Everything below is preserved as the measurement
> it was — a record of what the tree looked like *while that work was
> uncommitted*, which is exactly the state ADR 007's acceptance numbers were
> measured against. Do not read the counts as current.

## Working tree (dirty files)

### Modified (14)
```
apps/web/package.json
apps/web/postcss.config.js
apps/web/scripts/checks/check-design-tokens.py
apps/web/scripts/design/emit-tokens.ts
apps/web/src/app/(frontend)/globals.css
apps/web/src/styles/tokens.ts
apps/web/tailwind.tokens.json
contracts/schemas/defi/pool.json
contracts/schemas/event-envelope.json
contracts/schemas/finance/movement.json
contracts/schemas/research/category.json
contracts/schemas/trading/order-request.json
contracts/scripts/check-doc-citations.mjs
docs/architecture.md
```

### Untracked (31)
```
apps/web/scripts/checks/check-design-system.py
apps/web/src/styles/accessibility.css
apps/web/src/styles/motion.css
apps/web/src/styles/theme.css
apps/web/src/styles/typography.css
apps/web/src/ui/atoms/actions/index.tsx
apps/web/src/ui/atoms/blockchain/index.tsx
apps/web/src/ui/atoms/financial/format.ts
apps/web/src/ui/atoms/financial/index.tsx
apps/web/src/ui/atoms/form/index.tsx
apps/web/src/ui/atoms/layout/index.tsx
apps/web/src/ui/atoms/market/index.tsx
apps/web/src/ui/atoms/status/index.tsx
apps/web/src/ui/atoms/system/index.tsx
apps/web/src/ui/atoms/table/index.tsx
apps/web/src/ui/atoms/typography/index.tsx
apps/web/src/ui/atoms/visual/index.tsx
apps/web/src/ui/atoms/visualization/index.tsx
apps/web/src/ui/atoms/visualization/sparkline.tsx
apps/web/src/ui/foundations/accessibility.ts
apps/web/src/ui/foundations/color.ts
apps/web/src/ui/foundations/index.ts
apps/web/src/ui/foundations/layout.ts
apps/web/src/ui/foundations/motion.ts
apps/web/src/ui/foundations/spacing.ts
apps/web/src/ui/foundations/typography.ts
apps/web/src/ui/index.ts
apps/web/tests/design-system-atom-tests.ts
apps/web/tests/design-system-tests.ts
docs/design-system/current-ui-audit.md
docs/design-system/fudcourt-foundations-atoms-spec.md
```

## File counts

| Metric | Count |
|---|---|
| Tracked files (total) | 881 |
| Go (`.go`) | 220 |
| TypeScript (`.ts`) | 219 |
| TSX (`.tsx`) | 142 |
| JSON (`.json`) | 103 |
| Markdown (`.md`) | 65 |
| Rust (`.rs`) | 15 |
| Python (`.py`) | 26 |
| SQL (`.sql`) | 3 |

### Directory counts (tracked files)

| Directory | Tracked files |
|---|---|
| `deploy/` | 10 |
| `docs/` | 48 |
| `contracts/` | 67 |
| `scripts/` | 22 |
| `tests/` | 63 |

Top-level distribution (tracked files): `apps/` 647 · `contracts/` 67 ·
`tests/` 63 · `docs/` 48 · `scripts/` 22 · `deploy/` 10 · `.ai/` 9 ·
`.github/` 5 · `db/` 3 · `tools/` 1 · plus root files (`package.json`,
`go.sum`, `go.mod`, `README.md`, `.gitignore`, `.env.example`).

### Structure facts

| Item | Value |
|---|---|
| `go.mod` files | **1** — `./go.mod` only (root module) |
| `go.work` / `go.work.sum` | **0** (gone, as ADR-007 §2 claims) |
| Next.js route handlers under `apps/web/src/app` | **56** (`route.ts`; 53 under `(frontend)/api`, 3 CMS under `blog/(payload)/cms/api`) |
| Go packages (`go list ./...`) | 48 total (api 8 · bot 4 · data 13 · executor 23) |
| Go packages with tests (`go test ./...`) | **43 ok**, 0 FAIL |
| Contract schema JSON under `contracts/` | 56 (matches `SCHEMAS_OK files=56`) |
| systemd units in `deploy/systemd/` | 10 (matches `check-deploy: 10 unit files`) |
| CI workflows | 5 |
| `apps/web/tests/*-tests.ts` | 19 files, 323 tests |
| `docs/architecture/` | 29 files |
| `docs/decisions/` | 4 ADRs (005, 006, 007, plus the original `refactor-baseline.md`) |

## Generated artifact scan

Artifact-directory pattern
(`git ls-files | grep -E '(^|/)(target|dist|coverage|bin|\.next|\.shaper-tests)/'`):

```
apps/reconciler/src/bin/fudcourt-reconciled.rs
```

Build-output / cache pattern
(`git ls-files | grep -E 'tsbuildinfo|__pycache__|\.pyc$'`): **(no matches)**

Explicit checks:

| Check | Result |
|---|---|
| `apps/web/tsconfig.tsbuildinfo` tracked | **NO** |
| `apps/web/.shaper-tests` tracked | **NO** (0 files) |

## Toolchain versions

| Tool | Version |
|---|---|
| Go | `go1.25.0 linux/amd64` |
| rustc | `1.98.1 (48a229cea 2026-09-01)` |
| cargo | `1.98.1 (797e8a9bc 2026-08-05)` |
| bun | `1.4.2` |
| node | `v22.22.3` |
| npm | `10.9.8` |
| python3 | `Python 3.12.14` |

## Verification results

| # | Command | Result | Notes |
|---|---|---|---|
| 1 | `npm run verify` | **FAIL** (exit 1) | Runs the whole offline suite. Two gates fail: `structure` and `design-tokens`. Every other gate in the suite is OK. Ends `VERIFY_ALL_FAILED` / `!! FAILED: offline verification suite`. |
| 2 | `npm run contracts` | **PASS** (exit 0) | `DOCS_OK`, `MDTABLES_OK`, contract schema/doc gates clean. |
| 3 | `npm run deploy` | **PASS** (exit 0) | `check-deploy: OK (10 unit files: paths exist, ExecStart absolute, timer pairs present)`. |
| 4 | `npm run structure` | **FAIL** (exit 1) | `STRUCTURE_FAIL`: `src/ui/atoms/system/index.tsx:31 ui/ imports lib/executor-lifecycle`; `src/ui/atoms/system/index.tsx:32 ui/ imports lib/executor-request-defs` — DR-018 boundary (`ui/` must stay dependency-free). |
| 5 | `npm run test:go` | **PASS** (exit 0) | 43 packages `ok`, 0 FAIL (`go test ./...`). |
| 6 | `npm run test:web` | **PASS** (exit 0) | `323 pass / 0 fail`, 19 files, 45.66s. |
| 7 | `npm run test:sync` | **PASS** (exit 0) | Rust reconciler: 5 + 12 tests pass (17 total), 0 fail. |
| 8 | `go build ./...` (root) | **PASS** (exit 0) | Whole module builds clean. |

Command-name mapping (from root `package.json`): `verify` =
`node --experimental-strip-types tools/fud.ts verify`, and `contracts`,
`deploy`, `structure`, `test:go`, `test:web`, `test:sync` are the matching
`tools/fud.ts` subcommands.

## Known pre-existing failures

These fail at `633ffeb` **before** any new refactor work. They are recorded,
not fixed.

1. **`structure` gate — 2 violations.** `ui/` must be presentational and
   dependency-free; `apps/web/src/ui/atoms/system/index.tsx` imports
   `lib/executor-lifecycle` and `lib/executor-request-defs` (lines 31–32).
   Both the file and the atoms tree are **untracked at this commit** — the
   violations come from the in-flight design-system work, not the committed
   tree. `npm run verify` and `npm run structure` both fail on this alone.
2. **`design-tokens` gate.** `DESIGN_FAIL: files=363 colors=2 scales=76
   deadtokens=159` (plus a `DESIGN_SOFT` advisory block). The 2 color literals
   are `src/ui/foundations/color.ts:63,116`; the scale literals and the ~159
   dead tokens are reported against the modified `src/styles/tokens.ts:1` and
   the untracked `src/ui/atoms/*` files. Same root cause: uncommitted
   design-system work. `TOKENS_OK (14 colors, 9 space, 9 font-size, 284 vars
   total)` still passes — only the literal/dead-token gate fails.
3. **Aggregate consequence.** `npm run verify` exits non-zero
   (`VERIFY_ALL_FAILED`) because of the two gates above. No Go, Rust, web-test,
   contract, schema, doc-citation, markdown-table, deploy or reference-artifact
   check fails.

## Generated artifacts tracked in git

Exact paths from the scan (this is the full list):

```
apps/reconciler/src/bin/fudcourt-reconciled.rs
```

Assessment (unchanged from the original baseline): the single match is a
**false positive**. `apps/reconciler/src/bin/` is a Rust source directory
(Cargo binary target), not a build-output `bin/`. **No** `target/`,
`.next/`, `dist/`, `coverage/` or `.shaper-tests/` content is tracked.
`tsbuildinfo`, `__pycache__` and `*.pyc` are untracked. `apps/web/tsconfig.tsbuildinfo`
and `apps/web/.shaper-tests` are **not** tracked.

## Drift vs `docs/decisions/refactor-baseline.md`

The original baseline was captured **before** the restructure (it records
"48 modified, 5 untracked" and pre-move top-level dirs). Differences are
expected; listed explicitly as instructed.

| Claim in original baseline | Today's measurement | Drift? |
|---|---|---|
| Branch `main` | `main` | no |
| Commit `ddcc571…` (+ six follow-up commits `ae75218`…`ca97a81`) | `633ffeb…` | **yes** — HEAD advanced ~8 commits past the original capture |
| Dirty: 48 modified, 5 untracked | 14 modified, 31 untracked | **yes** — different in-flight work |
| Tracked files 881 | 881 | no |
| Go 220 | 220 | no |
| `.ts` 216 | 219 | **yes** (+3) |
| `.tsx` 142 | 142 | no |
| JSON 105 | 103 | **yes** (−2) |
| Markdown 60 | 65 | **yes** (+5) |
| Python 26 / Rust 15 / SQL 3 | 26 / 15 / 3 | no |
| systemd units 8 | 10 | **yes** (+2) |
| CI workflows 5 | 5 | no |
| Go modules 4 + `go.work` | 1 root `go.mod`, no `go.work` | **yes** — the ADR-007 consolidation has landed since |
| Frontend route handlers 56 | 56 | no |
| Contract JSON 59 | 58 | **yes** (−1) |
| Docs files 43 | 48 | **yes** (+5) |
| Rust tracked 15 | 15 | no |
| Generated artifact match `apps/reconciler/src/bin/fudcourt-reconciled.rs` | same single match | no |
| `.gitignore` covers outputs; no `target/.next/dist/coverage/.shaper-tests` tracked | holds | no |
| "Known baseline failures: none" | `structure` + `design-tokens` now FAIL | **yes** (new, from uncommitted design-system work) |
| Go 44 packages green / Rust 17 / verify-all PASS | Go 43 packages green (48 total) / Rust 17 / verify now FAIL | **yes** on package count and aggregate |

Top-level layout also differs by design: the original lists
`frontend/ 384 · backend/ 269 · shared/ 68 · infrastructure/ 10 · database/ 3`,
which is the pre-move tree; today those are `apps/ 647 · … · deploy/ 10 · db/ 3`.

## Drift vs ADR-007 acceptance claims

ADR-007 was measured "against the tree as committed". Today's tree is dirty,
so failures in the *uncommitted* design-system work do not contradict its
committed-tree claims — but the acceptance text also states several numbers
that have drifted on their own. Both are listed.

| ADR-007 claim | Today | Drift? |
|---|---|---|
| §2 One Go module: `find . -name go.mod` = 1, `go.work` gone | 1 (`./go.mod`), 0 `go.work` | **no — holds** |
| §3 One Rust crate `fudcourt-reconciler`, 2 binaries | 1 `Cargo.toml`, `src/bin/fudcourt-reconciled.rs` present | **no — holds** |
| §4 Go `go test ./...` **43 packages ok, 0 fail** | 43 ok, 0 fail | **no — exact** |
| §4 Rust **17 tests** across suites | 17 pass, 0 fail | **no — exact** |
| §4 `bunx tsc --noEmit` clean | `test:web` runs the typecheck + shaper suite | **no — holds** |
| §4 Web **249/249 shaper tests** | **323 pass / 0 fail** | **yes** (+74 since acceptance) |
| §4 Contracts `CONTRACTS_OK` (3 enums, 37 paths, 56 handlers, 28 events, 17 endpoints) | identical string | **no — holds** |
| §4 `SCHEMAS_OK` (56 files, 344 refs, 148 enums) | identical | **no — holds** |
| §4 `DOCS_OK` (**1072 citations**) | 1161 citations | **yes** (+89) |
| §4 `MDTABLES_OK` | passes | **no — holds** |
| §4 `STRUCTURE_OK` | **FAIL** (2 imports) | **yes** (uncommitted design-system work) |
| §4 `DESIGN_TOKENS_OK` | **FAIL** (2 colors, 76 scales, 159 dead tokens) | **yes** (uncommitted design-system work) |
| §4 `TOKENS_OK`, `REFERENCE_OK`, `check-deploy OK (10 units)`, `API_CONTRACT_OK`, oracle byte-identical | all pass | **no — holds** |
| §4 Aggregate `verify-all.sh VERIFY_ALL_OK` | `VERIFY_ALL_FAILED` | **yes** (same two gates) |
| §6 `contracts/` holds **67 files** | 67 tracked | **no — holds** |
| §7 `deploy/systemd/` **10 unit files** | 10 | **no — holds** |
| §12 **8 top-level directories** | 10 (`apps contracts tests docs scripts deploy .ai .github db tools`) | **yes** — `db/` and `tools/` are top-level and counted here (+2; §12's count likely excluded dotdirs) |
| §14 route handlers **56** (`53` frontend API + `3` CMS) | 56 (53 + 3) | **no — holds** |
| §14 `test:shapers` **268** | 323 | **yes** (+55) |
| §14 `apps/data` `func Test` **262** | 262 | **no — holds** |

**Summary of real drift (committed tree):** shaper/web tests 249 → 323,
`DOCS_OK` citations 1072 → 1161, `test:shapers` 268 → 323, and the top-level
directory count 8 → 10. **Drift from the dirty tree only:** `structure` and
`design-tokens` gates fail, cascading into `npm run verify`. Everything else
in ADR-007 that was re-measured still holds with the same numbers.

## Method notes

- Counts via `git ls-files` (tracked only) unless stated otherwise.
- Test counts are `go test ./...` / `bun test` / `cargo test` as reported by
  the tooling at `633ffeb`.
- The working tree changed during capture (one new untracked file); no command
  was re-run to "confirm" earlier results. A failing baseline is data.
- No fixes, no formatting, no `git add`, no commit were performed.
