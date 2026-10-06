# 007 — Architecture acceptance: the restructure's end state

## Status

Accepted — Phase 17. Every criterion below was measured against the tree
as committed, not against the plan's intent.

## The criteria, and the evidence

### 1. No legacy path remains

Seven legacy top-level directories are gone: `backend/`, `frontend/`,
`shared/`, `infrastructure/`, `database/`, `packages/`, `services/`.

Legacy path references remaining in code (Go, Rust, TS/TSX, Python, shell,
JSON, YAML, systemd units): **0**. The one remaining occurrence is the
explanatory comment in `go.yml` that names the four modules Phase 2
consolidated, which is history rather than a live path.

**Correction, 2026-10-06 (`03d50c0`).** That claim was scoped too
narrowly and was wrong on re-audit. Phase 14's exit gate scanned *code*
files, and `check-doc-citations.mjs` gates the 13 markdown documents in
its `DOCS` array — so references in **ungated** surfaces survived the
restructure looking live. Found and fixed:

| Surface | Was wrong |
|---|---|
| `contracts/openapi/fudcourt.yaml` | `info.description` named the deleted `frontend/web/src/platform/executor/types.ts` as the frozen ground truth and described the contract as belonging to `backend/api` + `backend/workers/executor` + `shared/sdk/typescript`; 19 more in-description pointers to `backend/data`, `database/schema/pg-schema.sql`, `shared/contracts/events/catalog.json` and the pre-move TS auth/treasury files |
| `contracts/{README,schemas/README,events/README}.md` | the schemas README was still titled `# shared/contracts/schemas`; its ownership column named `backend/api` / `backend/data` for 15 schemas; the contracts README described a pre-DR-042 TS-owned contract and told the reader to run `node shared/contracts/scripts/check-contract.mjs` |
| `docs/architecture/data-categorization.json` | 73 of 155 rows carried `frontend/web/...` in `code_path`/`evidence`. The companion `.md` is gated and was clean; the JSON sidecar the `.md` calls "the machine-readable form" was not, so the drift was invisible to the gate |
| `apps/web/tests/*.ts` (16 files) | `Usage: cd frontend/web && npm run test:shapers` — the repo is Bun-only (`bun.lock`, no `package-lock.json`), so the documented command did not run |
| `README.md`, `apps/data/README.md`, `db/README.md` | root README mapped `infrastructure/` for the systemd units (it is `deploy/`); apps/data's run/verify blocks said `cd backend/data` and built `./cmd/data`; db/README named the removed `pg-load.ts` by its pre-move path |

Re-measured after the fix: **8** references remain repo-wide, every one
of them the record of a change rather than a pointer to a live file —
`007` naming the `backend/api` → `apps/api` module-path rename,
`canonical-placement.md`'s `git show` commands over historical commits
and its record of a past grep finding, `tsconfig.shaper-tests.json`'s
"moved out of frontend/web" provenance note, and `db/README.md`'s
documentation of the two rename commits. Those are the
"references on historical docs/ADR are allowed" case the plan permits.

The `.md` slice counts in `data-categorization.md` were also stale —
`routes` said 43 while the JSON holds 45 (the two ticker detail
endpoints added later); the totals, status roll-up and category roll-up
are now recomputed from the JSON rather than hand-maintained.

The lesson is recorded rather than hidden: **a gate that scans only code
and only a named list of documents will certify a tree it did not
read.** The fix was to widen the scan, not to add the files to the
allowance list.

**Root cause closed, same day.** Widening the scan by hand fixes this
instance; it does not stop the next one. `check-doc-citations.mjs` now
also walks `docs/architecture/data-categorization.json` — the sidecar
`data-categorization.md` §0 calls "the machine-readable form (with the
full `code_path` and `evidence` per row)" — and requires every
path-shaped token in those two fields to resolve. Reported as
`sidecar_rows=155 sidecar_paths=249` on the `DOCS_OK` line.

A token resolves when the file exists, when it is a **relative
fragment** of a path already given earlier in the same string
(`repository/port_pg.go` after `apps/executor/internal/`), or when its
repo-relative tail matches a real file (an absolute host path,
`/home/<user>/fudcourt/tests/oracle/sync-live.py`). A bare filename
(`modes.go`) is a symbol reference and is skipped. Proven on a hermetic
copy: the unperturbed tree passes with counts identical to the repo; a
re-injected `frontend/web/...` path fails; a `backend/data/...` path
fails; a plausible-but-nonexistent `features/market/quotes.ts` fails;
malformed JSON fails cleanly rather than crashing; and the fragment,
absolute-path and bare-filename cases still pass.

`data-categorization.json` is the only doc sidecar in the tree that
carries path prose — checked by scanning every `docs/**/*.json` for
path-shaped tokens (218 hits, all in this one file). The
`contracts/schemas/**` JSON files are already covered by
`check-schemas.mjs`, which validates their `$ref` graph.


### 2. One Go module

```
$ find . -name go.mod -not -path './.git/*' | wc -l
1
$ head -1 go.mod
module github.com/anvxxr-arch/fudcourt
```

`go.work` and `go.work.sum` are gone. The new module path is a strict
prefix of all four old ones (`fudcourt/backend/api` → `fudcourt/apps/api`
and so on), so no import path needed rewriting — which is why the
consolidation was a one-commit change with a green build before and after.

### 3. One Rust crate

One `Cargo.toml`, at `apps/reconciler/`, package `fudcourt-reconciler`,
two binaries (`fudcourt-reconciler`, `fudcourt-reconciled`).

### 4. Build and tests green

| Surface | Result |
|---|---|
| Go | `go build ./...`, `go vet ./...` clean; `go test ./...` 43 packages ok, 0 fail |
| Rust | `cargo build --release --bins` both binaries; 17 tests across 5 suites; `cargo fmt --check` clean |
| Web | `bunx tsc --noEmit` clean; 249/249 shaper tests; `bun run build` emits every route |
| Contracts | `CONTRACTS_OK` (3 enums, 37 paths, 56 handlers, 28 events, 17 endpoints), `SCHEMAS_OK` (56 files, 344 refs, 148 enums), `DOCS_OK` (1072 citations), `MDTABLES_OK` |
| Integration | `API_CONTRACT_OK`, `check-deploy OK` (10 units), `STRUCTURE_OK`, `DESIGN_TOKENS_OK`, `TOKENS_OK`, `REFERENCE_OK` |
| Oracle | `SYNC_ORACLE_OK` — Python vs Rust byte-identical, 34 rows / 40 request keys |
| Aggregate | `verify-all.sh VERIFY_ALL_OK` |

### 5. Frontend organised by domain, not by vendor

`apps/web/src/` layers: `app/`, `cms/`, `features/`, `lib/`, `server/`,
`styles/`, `ui/`.

Feature slices went 15 → 12, and the four vendor-named directories
(`llama`, `dex`, `ticker`, `market-data`) folded into `market`. One
provider-named directory remains — `features/cryptorank` — and it has
**zero UI consumers**. Only `tests/shaper-tests.ts`,
`tests/rate-limit-tests.ts` and `scripts/verify/check-contract.py` read
it, because it is the TS mirror the TS↔Go parity gate parses. It is a
verification asset, which the plan's own rule allows, not UI architecture.

### 6. Contracts canonical

`contracts/` holds 67 files: schemas, OpenAPI, events, data, and the four
drift gates. The event catalog and the event schema — which held the same
28 ids twice — are one file, `contracts/events/events.json`.

The 56 schema files were **not** merged into a monolithic `schemas.json`.
ADR 005's reasoning applies here too, and the measurement is in the
Phase 7 commit: the fragmentation was 9 files under 20 lines totalling 264
of 6082 lines, and those 9 carry the repo's numeric-type contracts in
their descriptions. Merging them would have required rewriting 314 `$ref`
sites to remove 4% of the tree's lines.

### 7. Deployment clean

`deploy/systemd/` holds 10 unit files. `check-deploy` verifies every
`ExecStart` path exists, every `ExecStart` is absolute, and every
timer-driven service has its timer in-repo.

The Rust sync pair was renamed `fudcourt-sync-rust.*` →
`fudcourt-reconciler.*` to match the crate. Both sync pairs are kept,
because they are a documented either/or: the host runs the Python oracle
pair (`fudcourt-sync.timer` is enabled and fires every 5 minutes), and
the Rust pair was never installed.

### 8. One verify command

```
node tools/fud.ts verify    # exit 0
bun  tools/fud.ts verify    # exit 0
bun run verify              # exit 0
```

`tools/fud.ts` is plain ESM TypeScript importing only node builtins, so it
runs under `node --experimental-strip-types` (node 22, what CI has) or
`bun`, with no dependency install — which is what let the root
`package.json` keep its deliberate no-dependencies/no-lockfile rule.

It is a dispatcher, not a reimplementation: every subcommand shells out to
the script that already owns the check.

### 9. No compatibility layer

Zero `shim`/`compat`/`legacy`/`deprecated` directories. No `go.work`. No
alias re-exports. The one duplicate file that exists — the Go `go:embed`
copy of `executor-schema.sql` — cannot be removed (`go:embed` refuses
parent-directory patterns) and is pinned byte-for-byte by
`TestEmbeddedSchemaMatchesTracked`.

### 10. Documentation is high-signal

`docs/architecture/` went 32 → 28 files by archiving the four restructure
workstream documents (`current`, `target`, `final-review`,
`migration-plan`) to `docs/records/archive/`. They are dated evidence, not
a description of the tree as it stands.

The full collapse the plan sketches (`architecture.md` + `data.md` +
`deployment.md` + `decisions/`) was not performed. 11 of the remaining
documents are named explicitly in `check-doc-citations.mjs`'s `DOCS`
array, and 113 links between them would all have to be rewritten. Those
11 are the canonical data model, the source catalog, the data catalog,
three classification matrices, the acceptance scorecard, the symbol-key
inventory, the design system and its debt ledger — each gated because its
cited paths are what the gate protects. Folding them into one file would
delete the gate's subject, not reduce the documentation.

`docs/decisions/` now holds three ADRs recording the deviations:
005 (no `core/`), 006 (no proxy collapse), 007 (this document).

### 11. Zero behavior change

| Surface | Evidence |
|---|---|
| API response shapes | 37 OpenAPI paths all mapped to handlers |
| Route URLs | 56 handlers, none collapsed or renamed |
| Frontend UX | 249/249 shaper tests; build emits every route |
| Fixture parity | oracle gate byte-identical |
| Generated artifacts | `reference.json` drift-gated, `REFERENCE_OK` |

### 12. Small because structure disappeared, not because boundaries broke

8 top-level directories, each with one job. 14 `internal/` trees intact,
so Go's visibility rule still keeps every app's private packages private.
Zero cross-app imports, re-measured at acceptance.

## Deviations, recorded

| Plan target | Outcome | Record |
|---|---|---|
| `core/{accounts,markets,trading,providers,exchanges,infra}` | not created | ADR 005 — measured zero cross-app imports |
| Collapse pure-proxy routes | not performed | ADR 006 — the handlers are the contract surface |
| `db/migrations/` | not created | Phase 8 — no migration history exists |
| `contracts/` at 3 files | 67 files, events merged | Phase 7 — 314 `$ref` rewrites for 4% of lines |
| `docs/` at 4 files + decisions | 28 architecture docs + 3 ADRs + archive | this document |
| 56 → fewer route handlers | 56 | ADR 006 |

Every deviation has a measurement behind it and an ADR or commit message
recording it. None is an omission.
