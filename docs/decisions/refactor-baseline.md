# Refactor Baseline (Phase 0)

Structural migration baseline captured before any restructuring.

- **Branch:** `main`
- **Commit:** `ddcc571a58029fcbe2dbe85a01f1aa02a00ac293`
- **Captured:** 2026-10-06
- **Working tree at capture:** dirty (48 modified, 5 untracked) — see
  *Pre-existing work* below. Resolved first as six atomic commits
  (`ae75218` … `ca97a81`) so the Phase 1 artifact-removal commit could not
  sweep in unrelated edits.

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
| Go modules | 4 (`backend/api`, `backend/bot`, `backend/data`, `backend/workers/executor`) |
| `go.work` | 1 (+ `go.work.sum`) |
| Go packages | 48 (8 + 4 + 13 + 23) |
| Frontend route handlers | 56 under `frontend/web/src/app/(frontend)/api/**` |
| Contract JSON files | 59 under `shared/contracts/` |
| Docs files | 43 under `docs/` |
| Rust tracked files | 15 under `backend/sync/` |
| Verify/tool scripts | 21 under `scripts/verify/` (+ 3 testdata) |
| Fixtures | 63 under `tests/fixtures/` (26 `.gz` bodies + `expected/` golden set) |

## Generated artifacts found in Git

One match for the artifact pattern, and it is a **false positive**:

```
backend/sync/src/bin/fudcourt-reconciled.rs
```

The `bin/` segment is a Rust source directory (`src/bin/`), not a build
output directory. No `target/`, `.next/`, `dist/`, `coverage/`,
`.shaper-tests/` or `backend/*/bin/` content is tracked. `.gitignore`
already covers all of them; Phase 1 therefore only widens coverage to the
final paths rather than deleting tracked artifacts.

Two tracked files relate to the shaper-test harness and are **source, not
output** — they are reviewed in Phase 6E:

```
frontend/web/tests/shaper-tests.ts
frontend/web/tsconfig.shaper-tests.json
```

## Test / build results at baseline

| Suite | Command | Result |
|---|---|---|
| Go — api | `cd backend/api && go test ./...` | **PASS** (7 packages) |
| Go — bot | `cd backend/bot && go test ./...` | **PASS** (3 packages) |
| Go — data | `cd backend/data && go test ./...` | **PASS** (11 packages) |
| Go — executor | `cd backend/workers/executor && go test ./...` | **PASS** (23 packages) |
| Go — build | `go build ./...` per module | **PASS** (4/4 modules) |
| Rust | `cd backend/sync && cargo test --release` | **PASS** (17 tests: 5 + 12) |
| Web typecheck | `cd frontend/web && bunx tsc --noEmit` | **PASS** |
| Contracts | `node shared/contracts/scripts/check-contract.mjs` | **PASS** — `CONTRACTS_OK enums=3 openapi_paths=37 route_handlers=56 events=28 client_endpoints=17` |
| Deploy guard | `python3 scripts/verify/check-deploy.py` | **PASS** — 10 unit files, paths exist, ExecStart absolute, timer pairs present |
| Full verify | `bash scripts/verify/verify-all.sh` | **PASS** — `VERIFY_ALL_OK` (35s) |

### Known baseline failures

None. Every suite is green at the baseline commit.

`npm run test:web` (`cd frontend/web && bun run test:shapers`) fails with
`Script not found "test:shapers"` — the root `package.json` script is stale
relative to `frontend/web/package.json`. This is a pre-existing packaging
defect, not a code failure; the same coverage runs green inside
`verify-all.sh`. Recorded here rather than fixed, per Phase 0 rules.

## Binaries that build

| Binary | Source | Status |
|---|---|---|
| `fudcourt-api` | `backend/api/cmd/api` | builds |
| `fudcourt-bot` | `backend/bot/cmd/bot` | builds |
| `fudcourt-data` | `backend/data/cmd/data` | builds |
| `fudcourt-executor` | `backend/workers/executor/cmd/executor` | builds |
| `fudcourt-reconciled` | `backend/sync/src/main.rs` + `src/bin/fudcourt-reconciled.rs` | builds |
| `notifycheck` | `backend/workers/executor/cmd/notifycheck` (untracked at capture) | builds |

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
