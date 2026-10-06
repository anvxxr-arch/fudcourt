# Refactor Baseline (Phase 0)

Structural migration baseline captured before any restructuring.

- **Branch:** `main`
- **Commit:** `ddcc571a58029fcbe2dbe85a01f1aa02a00ac293`
- **Captured:** 2026-10-06
- **Working tree at capture:** dirty (48 modified, 5 untracked) — see
  *Pre-existing work* below. Resolved first as six atomic commits
  (`ae75218` … `ca97a81`) so the Phase 1 artifact-removal commit could not
  sweep in unrelated edits.

## Re-audit 2026-10-06 (this session)
The migration described above has since been **executed and accepted**
(ADR 007, `007-architecture-acceptance.md`). This session re-measured the
tree at `HEAD` (`633ffeb`) to confirm the acceptance still holds and to
separate real regressions from unrelated in-flight work.

**At `HEAD` (`git stash --include-untracked`, tree clean):**

| Gate | Result |
|---|---|
| Go — `go build ./...`, `go vet ./...` | **PASS** (clean) |
| Go — `go test ./...` | **PASS** (43 packages, 0 fail) |
| Rust — `cargo test` | **PASS** (12 tests) |
| Web — `bun run test:shapers` | **PASS** (323 pass, 0 fail) |
| Structure gate | **PASS** — `STRUCTURE_OK` |
| Design-token gate | **PASS** — `DESIGN_TOKENS_OK` |
| Contracts / schemas / docs / tables / reference | **PASS** |
| Deploy guard | **PASS** — 10 units |

**Working tree at re-audit:** 14 modified + 31 untracked files of
**in-flight design-system work** (the `ui/atoms`, `ui/foundations`,
`styles/*.css` and `design-system` test/doc set). That work is what makes
three gates red *in the worktree*, and it is **out of scope** for this
refactor:

| Gate | At `HEAD` | In worktree |
|---|---|---|
| `structure` | PASS | FAIL — `ui/` imports `lib/executor-lifecycle` |
| `design-tokens` | PASS | FAIL |
| `web` tests | 323/323 | 316 pass / 7 fail |

The baseline's stale-script note is also resolved: `npm run test:web`
now works (it dispatches `fud.ts test web` → `bun run test:shapers`).
The 7 failures it surfaces are the design-system WIP's, not packaging.

**Conclusion:** no migration regression exists at `HEAD`. The worktree
failures belong to a separate, uncommitted design-system workstream and
are recorded here rather than "fixed", per Phase 0 rules.

## Toolchain

| Tool | Version |
|---|---|
| Go | go1.25.0 linux/amd64 |
| rustc | 1.98.1 (48a229cea 2026-09-01) |
| cargo | 1.98.1 (797e8a9bc 2026-09-01) |
| bun | 1.4.2 |
| node | v22.22.3 |
| npm | 10.9.8 |

## File counts

| Metric | Count |
|---|---|
| Tracked files (total) | 881 |
| Go files | 220 |
| TypeScript (`.ts`) | 216 |
| TSX (`.tsx`) | 142 |
| JSON | 105 |
| Markdown | 60 |
| Python | 26 |
| Rust | 15 |
| SQL | 3 |
| systemd units | 8 |
| CI workflows | 5 |

Top-level distribution: `frontend/` 384 · `backend/` 269 · `shared/` 68 ·
`tests/` 63 · `docs/` 43 · `scripts/` 22 · `infrastructure/` 10 · `.ai/` 9 ·
`.github/` 5 · `database/` 3.

## Structure inventory

| Item | Count / state |
|---|---|
| Go modules | 4 (`apps/api`, `apps/bot`, `apps/data`, `apps/executor`) |
| `go.work` | 1 (+ `go.work.sum`) |
| Go packages | 48 (8 + 4 + 13 + 23) |
| Frontend route handlers | 56 under `apps/web/src/app/(frontend)/api/**` |
| Contract JSON files | 59 under `contracts/` |
| Docs files | 43 under `docs/` |
| Rust tracked files | 15 under `apps/reconciler/` |
| Verify/tool scripts | 21 under `scripts/verify/` (+ 3 testdata) |
| Fixtures | 63 under `tests/fixtures/` (26 `.gz` bodies + `expected/` golden set) |

## Generated artifacts found in Git

One match for the artifact pattern, and it is a **false positive**:

```
apps/reconciler/src/bin/fudcourt-reconciled.rs
```

The `bin/` segment is a Rust source directory (`src/bin/`), not a build
output directory. No `target/`, `.next/`, `dist/`, `coverage/`,
`.shaper-tests/` or `backend/*/bin/` content is tracked. `.gitignore`
already covers all of them; Phase 1 therefore only widens coverage to the
final paths rather than deleting tracked artifacts.

Two tracked files relate to the shaper-test harness and are **source, not
output** — they are reviewed in Phase 6E:

```
apps/web/tests/shaper-tests.ts
apps/web/tsconfig.shaper-tests.json
```

## Test / build results at baseline

| Suite | Command | Result |
|---|---|---|
| Go — api | `cd apps/api && go test ./...` | **PASS** (7 packages) |
| Go — bot | `cd apps/bot && go test ./...` | **PASS** (3 packages) |
| Go — data | `cd apps/data && go test ./...` | **PASS** (11 packages) |
| Go — executor | `cd apps/executor && go test ./...` | **PASS** (23 packages) |
| Go — build | `go build ./...` per module | **PASS** (4/4 modules) |
| Rust | `cd apps/reconciler && cargo test --release` | **PASS** (17 tests: 5 + 12) |
| Web typecheck | `cd apps/web && bunx tsc --noEmit` | **PASS** |
| Contracts | `node contracts/scripts/check-contract.mjs` | **PASS** — `CONTRACTS_OK enums=3 openapi_paths=37 route_handlers=56 events=28 client_endpoints=17` |
| Deploy guard | `python3 scripts/verify/check-deploy.py` | **PASS** — 10 unit files, paths exist, ExecStart absolute, timer pairs present |
| Full verify | `bash scripts/verify/verify-all.sh` | **PASS** — `VERIFY_ALL_OK` (35s) |

### Known baseline failures

None at the baseline commit. Every suite is green.

The `npm run test:web` packaging defect recorded at first capture
(`Script not found "test:shapers"`) is **resolved**: the root script now
dispatches through `tools/fud.ts test web`, which runs
`bun run test:shapers` in `apps/web`. See the re-audit above for the
current worktree state.

## Binaries that build

| Binary | Source | Status |
|---|---|---|
| `fudcourt-api` | `apps/api/cmd/api` | builds |
| `fudcourt-bot` | `apps/bot/cmd/bot` | builds |
| `fudcourt-data` | `apps/data/cmd/data` | builds |
| `fudcourt-executor` | `apps/executor/cmd/executor` | builds |
| `fudcourt-reconciled` | `apps/reconciler/src/main.rs` + `src/bin/fudcourt-reconciled.rs` | builds |
| `notifycheck` | `apps/executor/cmd/notifycheck` (untracked at capture) | builds |

## Pre-existing work (resolved before Phase 1)

The tree was dirty at capture. The changes were reviewed, verified green
(Go 44 packages, Rust 17 tests, tsc, `verify-all.sh` all pass), and
committed as six atomic commits so no later phase could absorb them:

| Commit | Concept |
|---|---|
| `ae75218` | feat(executor): notify on execution events via a Telegram channel (+ 2 executor bug fixes) |
| `d71ba3d` | harden(api): fail-closed origin, next-path and role parsing |
| `7c31c9d` | fix(data): rune-safe truncation, memoised llama projections, 5s L2 write |
| `20c5e58` | fix(sync): survive a Postgres restart, idempotent asset board writes |
| `f8a576c` | harden(web): server-only guards, generic 500s, allowlisted public origin |
| `ca97a81` | docs: re-derive architecture counts and record the retired provider mirrors |

## Exit gate

Satisfied: which tests pass (all), which tests already fail (none), which
binaries build (all six). Proceed to Phase 1.
