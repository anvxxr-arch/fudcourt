# Agent Prompt Pack

This directory contains an executable prompt pack for restructuring the FUDCourt monorepo into a domain-oriented architecture.

The master prompt is `restructure-fudcourt.md`. It defines the full target architecture, migration constraints, and all phases. The prompts under `prompts/` are scoped, per-phase (or per-agent) prompt bodies meant to be executed one at a time.

## Recommended workflow

- Work on the branch `refactor/domain-architecture`.
- Run one phase at a time, from the repository root.
- Full run (all phases in one agent session):

```sh
codex exec --full-auto "$(cat .ai/restructure-fudcourt.md)"
```

- Per-phase runs use the individual prompt files below, e.g.:

```sh
codex exec --full-auto "$(cat .ai/prompts/phase-00-audit.md)"
```

## Prompt files

| File | Scope |
| --- | --- |
| `phase-00-audit.md` | Phase 0 only: audit + baseline + `docs/architecture/*.md`, no code moves |
| `phase-01-structure.md` | Phase 1: `git mv apps/apicalls -> services/data`, `apps/sync -> services/sync`, update CI/systemd/scripts/imports/docs |
| `phase-02-database.md` | Phase 2: extract DB ownership to `database/` |
| `phase-03-04-contracts-api.md` | Phase 3+4: `packages/contracts` + `services/api` Go backend |
| `executor-migration.md` | Dedicated executor TS->Go migration agent (most critical domain) |
| `rust-sync.md` | Rust sync specialization agent |
| `web-cleanup.md` | Frontend boundary cleanup agent (run only after Go parity) |
| `qa-review.md` | Independent architecture/regression reviewer |

## Ordering note

Do not run multiple agents editing the same folders in parallel. Sequential order is recommended: Arch/Audit -> Structure -> Contracts/API -> Executor -> Rust -> Web -> QA.
