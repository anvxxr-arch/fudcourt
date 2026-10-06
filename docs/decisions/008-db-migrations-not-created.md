# 008 — Phase 8 `db/migrations/` not created: there is no migration history to hold
## Status
Accepted — `db/` keeps `schema/`, not `migrations/`. The acceptance criterion
"one canonical schema/migration source: `db/migrations`" is **not met**,
deliberately, with this record as the justification.

## Context
Phase 8 targets a single migration source:

```
db/migrations/
├── 001_base.sql
├── 002_executor.sql
└── 003_reconciliation.sql
```

and instructs the agent to squash historical development schemas *only if*
"project belum memiliki migration history yang harus dipertahankan secara
production" — the project has no production migration history that must be
preserved.

The inventory is three files, and the classification is unambiguous:

| Path | Class | Applied by |
|---|---|---|
| `db/schema/pg-schema.sql` | canonical schema (treasury, `public`) | CI `reconcile-live` via `psql -f` (`.github/workflows/integration.yml:82-83`); out-of-band on the host |
| `db/schema/executor-schema.sql` | canonical schema (`executor`) | in-process at startup — `apps/executor/internal/repository/schema.go` `//go:embed` + `EnsureSchema` |
| `apps/executor/internal/repository/schema/executor-schema.sql` | byte-pinned `go:embed` copy | the embed itself; drift-pinned by `TestEmbeddedSchemaMatchesTracked` |

There is no migration runner anywhere in the tree. `grep` for `psql`/`migrate`
across `apps/`, `tests/` and `scripts/` finds no application-side invocation —
the only `psql` call is the CI job above, and it applies the whole file. The
Payload CMS keeps its own `apps/web/src/cms/migrations/` by Payload convention
and is out of scope (it owns content, not the trading/financial surface).

## Decision
**Do not create `db/migrations/`.** Keep `db/schema/` as the canonical home.
Both files are already idempotent — every statement is
`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` /
`CREATE TRIGGER` guarded — which is what makes a single-file source correct
without a runner. `db/README.md` already documents this as the migration
policy, per store, and records the roadmap items as **NOT DONE** rather than
claiming them.

## Rationale
1. **A `migrations/` directory needs a runner to be meaningful.** Numbered
   files that nothing applies in order are not a migration history; they are
   a directory that looks like one. The plan's own objective says "do not
   introduce a new migration framework unnecessarily", and DR-020 records
   the same decision.
2. **It would add a second source of truth.** `001_base.sql` would have to be
   kept in sync with `pg-schema.sql`, or replace it and break the CI `psql -f`
   line, the `db/README.md` consumer map and the doc-citation gate's
   `code_path` rows — for zero behavioural gain.
3. **Squashing is already done.** There is exactly one file per store. The
   "squash historical development schemas" branch of the instruction has
   nothing left to squash.
4. **The plan's fallback principle applies.** "Whenever an agent must choose
   between `smaller tree` and `clearer ownership` — prefer clearer ownership."
   `db/schema/pg-schema.sql` names what it is; `db/migrations/001_base.sql`
   would name a history that does not exist.

## Consequences
- The `db/migrations` acceptance criterion is unmet by choice, recorded here
  beside 005 (no `core/`) and 006 (no proxy collapse).
- If a real ordered history is ever needed, the move is: add the runner first,
  then split. Not the other way round.

## Verification
```bash
find . -iname '*.sql' -not -path './node_modules/*' -not -path '*/target/*'
# db/schema/pg-schema.sql
# db/schema/executor-schema.sql
# apps/executor/internal/repository/schema/executor-schema.sql   (go:embed copy)

grep -rn 'psql' .github/workflows/   # the only applier: integration.yml:82
```
