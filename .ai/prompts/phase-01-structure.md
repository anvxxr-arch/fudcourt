Read .ai/restructure-fudcourt.md and all docs/architecture documents.

Execute PHASE 1 only.

Move:
- apps/apicalls -> services/data
- apps/sync -> services/sync

Use git mv where possible.
Update imports, CI, deployment paths, scripts, documentation and build paths.

Do not redesign or rewrite application behavior.

Run all relevant Go, Rust and web build/tests after the move.
Fix regressions caused by this phase.
Update architecture documentation.
