Read .ai/restructure-fudcourt.md and inspect the complete repository.

Act as an independent architecture and regression reviewer.

Do not assume previous migration work is correct.

Verify:

1. repository boundaries
2. forbidden cross-domain imports
3. duplicated implementations
4. stale files
5. broken scripts
6. broken systemd paths
7. broken CI paths
8. OpenAPI consistency
9. Go build/tests
10. Rust build/tests
11. Bun/Next.js build/tests
12. integration tests
13. executor parity
14. database schema references
15. deployment definitions

Search specifically for backend executor logic that still remains inside apps/web.

Search for Next.js code that directly owns PostgreSQL executor persistence.

Search for Go or Rust services importing implementation code from another service.

Search for duplicated risk/order sizing logic.

Fix safe architectural violations.

Do not perform unrelated rewrites.

Produce:

docs/architecture/final-review.md

Include:
- final architecture
- remaining violations
- technical debt
- test results
- performance concerns
- recommended follow-up work.
