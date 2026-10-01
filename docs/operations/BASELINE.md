# Baseline Validation — measured before any migration move

> Phase 0 of the domain restructure (2026-10-01). Every command below was run on
> the pre-move tree at `apps/{web,apicalls,sync}` on a clean working tree
> (`git status`: clean). This file is the regression reference: a phase may not
> make any of these results worse. Pre-existing failures (none here) would be
> listed explicitly and would not count as migration regressions.

## Toolchain

| Tool | Version | Notes |
|---|---|---|
| Go | go1.23.3 local (module floor go 1.25.0 / deps floor 1.24.1) | `GOTOOLCHAIN=auto` resolves the cached newer toolchain (DR-005) |
| Rust | cargo 1.98.1 | single crate `fudcourt-sync` |
| Bun | 1.4.2 | installer + task runner + server runtime (DR-008) |
| Node | v22.22.3 | runtime for `next` scripts |
| Next.js | 16.3.6 (Turbopack) | one app, `apps/web`, + Payload CMS 3.89 |

## Results (2026-10-01, pre-move)

| # | Command | Working dir | Result |
|---|---|---|---|
| 1 | `go build ./... && go vet ./... && go test ./...` | `services/data` | **PASS** — 8 packages, all green (cmd + 7 internal), 0 failures |
| 2 | `cargo build --release --bins && cargo test --release` | `services/sync` | **PASS** — 2 binaries, **17 tests, 5 suites, 0 fail** |
| 3 | `python3 scripts/checks/check-contract.py` | `apps/web` | **PASS** — `CONTRACT_OK` (28 CR modes TS↔Go parity, khala/llama/news/chainrank parity, proxy-shape + mutation guards) |
| 4 | `python3 scripts/checks/check-deploy.py` | `apps/web` | **PASS** — `check-deploy: OK (10 unit files)` |
| 5 | `python3 scripts/checks/check-structure.py` | `apps/web` | **PASS** — `STRUCTURE_OK (139 files)` |
| 6 | `bunx tsc --noEmit` | `apps/web` | **PASS** — 0 errors |
| 7 | `bun run test:shapers` | `apps/web` | **PASS** — **240 tests / 0 fail** (shapers + auth + rate-limit + db + executor risk/engine/exchange/store/plan/worker/ui/runtime) |
| 8 | `bun run build` | `apps/web` | **PASS** — Next 16.3.6 Turbopack build, compiled in 59 s, 9 static pages, proxy (middleware) wired |

Live harnesses (`scripts/verify/verify-*.py`, `monitor.py`, `verify:executor`
paper E2E) need the homeserver services, upstream access, or a Postgres+Valkey
cluster and are **not** part of the offline baseline; their last recorded green
runs are cited in `docs/records/DECISIONS.md` (DR-005/006/009/014/019/020/021).

## What the baseline covers structurally (pre-move tree)

```text
apps/web        Next.js 16 + Payload CMS + TS CEX executor runtime + executor worker
services/data   Go acquisition sidecar (cryptorank, chainrank, llama, news, khala) :3101
services/sync       Rust crate: fudcourt-sync (balance sync) + fudcourt-reconciled :3102
```

Deploy units versioned in-repo: 10 unit files under `apps/*/deploy/`
(`fudcourt-web`, `fudcourt-executor-worker`, `fudcourt-pgload`, `fudcourt-sync`
(Python oracle variant + Rust variant), `fudcourt-sync.timer`, `fudcourt-apicalls`,
`fudcourt-reconciled`).

## Regression rule for the migration

Per phase, the acceptance bar is: **no row above gets worse**. A phase lands only
with its own re-run of the affected rows (and the full offline set for moves).
Known/remaining failures at any checkpoint must be classified as
`pre-existing` / `introduced` / `remaining` in the phase report.
