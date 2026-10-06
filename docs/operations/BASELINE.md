# Baseline Validation — measured before any migration move

> Phase 0 of the domain restructure (2026-10-01). Every command below was run on
> the pre-move tree at `apps/{web,apicalls,sync}` on a clean working tree
> (`git status`: clean). **HISTORICAL SNAPSHOT** — those directories no longer exist
> (current homes: `apps/web`, `apps/data`, `apps/reconciler`); the `Working dir`
> column in the results table names the **post-move** directory the same commands run from
> today. This file is the regression reference: a phase may not
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
| 1 | `go build ./... && go vet ./... && go test ./...` | `apps/data` | **PASS** — 8 packages, all green (cmd + 7 internal), 0 failures |
| 2 | `cargo build --release --bins && cargo test --release` | `apps/reconciler` | **PASS** — 2 binaries, **17 tests, 5 suites, 0 fail** |
| 3 | `python3 scripts/checks/check-contract.py` | `apps/web` | **PASS** — `CONTRACT_OK` (28 CR modes TS↔Go parity, khala/llama/news/chainrank parity, proxy-shape + mutation guards) — at the time of this snapshot; the khala and chainrank web-parity blocks were later replaced by "web surface removed (sidecar-only)" rows (DR-041) |
| 4 | `python3 scripts/checks/check-deploy.py` | `apps/web` | **PASS** — `check-deploy: OK (10 unit files)` |
| 5 | `python3 scripts/checks/check-structure.py` | `apps/web` | **PASS** — `STRUCTURE_OK (139 files)` |
| 6 | `bunx tsc --noEmit` | `apps/web` | **PASS** — 0 errors |
| 7 | `bun run test:shapers` | `apps/web` | **PASS** — **240 tests / 0 fail** (shapers + auth + rate-limit + db + executor risk/engine/exchange/store/plan/worker/ui/runtime) |
| 8 | `bun run build` | `apps/web` | **PASS** — Next 16.3.6 Turbopack build, compiled in 59 s, 9 static pages, proxy (middleware) wired |
Counts in rows 1, 4 and 5 are as-of-2026-10-01 measurements: `deploy/systemd/` held 10
units then and holds **10 live units + 3 tombstones** now (DR-040 retired
`fudcourt-pgload` + `fudcourt-pgload.timer`), and `go test ./...` in `apps/data`
is 179 `func Test` today (was 111 when `ARCHITECTURE.md` was written). The command paths in the
table are the paths the gates lived at then; the contract/deploy gates have since moved out of
the app to `scripts/verify/check-{contract,deploy}.py` (`check-structure.py` remains at
`apps/web/scripts/checks/`). Re-derive rather than quoting these numbers forward.

Live harnesses (`scripts/verify/verify-*.py`, `monitor.py`, `verify:executor`
paper E2E) need the homeserver services, upstream access, or a Postgres+Valkey
cluster and are **not** part of the offline baseline; their last recorded green
runs are cited in `docs/records/DECISIONS.md` (DR-005/006/009/014/019/020/021).

## What the baseline covers structurally (pre-move tree)

```text
apps/web        Next.js 16 + Payload CMS + TS CEX executor runtime + executor worker
apps/api        Go primary backend (identity, admin, portfolio, treasury, ...) :3103
apps/data   Go acquisition sidecar (cryptorank, chainrank, llama, news, khala) :3101
apps/reconciler       Rust crate: fudcourt-sync (balance sync) + fudcourt-reconciled :3102
apps/executor   Go execution worker; loopback health only (/healthz + /readyz) :3104
```

Deploy units versioned in-repo: 10 unit files under `deploy/systemd/`
(`fudcourt-web`, `fudcourt-api`, `fudcourt-executor`, `fudcourt-executor-worker`,
`fudcourt-data`, `fudcourt-reconciled`, `fudcourt-sync` + `fudcourt-sync.timer`
(the Python oracle), `fudcourt-sync-rust` + `fudcourt-sync-rust.timer` — the
uninstalled Rust replacement). `fudcourt-pgload` and `fudcourt-pgload.timer`
were retired by DR-040 (the Turso→Postgres projection is gone); their tombstone
is `RETIRED-fudcourt-pgload.service.txt`.

## Regression rule for the migration

Per phase, the acceptance bar is: **no row above gets worse**. A phase lands only
with its own re-run of the affected rows (and the full offline set for moves).
Known/remaining failures at any checkpoint must be classified as
`pre-existing` / `introduced` / `remaining` in the phase report.
