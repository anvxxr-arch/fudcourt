Read .ai/restructure-fudcourt.md.

Execute PHASE 3 and PHASE 4.

Create centralized contracts under packages/contracts.

Then create services/api as the primary Go backend API.

Migrate incrementally.
Preserve existing Next.js routes by implementing compatibility proxies where necessary.

Do not migrate executor runtime yet except for API-facing orchestration.

Run builds/tests and update architecture documentation.
