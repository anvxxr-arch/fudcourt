Read .ai/restructure-fudcourt.md and current architecture documentation.

Act as the FUDCourt Web Boundary Cleanup Agent.

Inspect apps/web.

Remove backend responsibilities that have already been migrated and verified in services/api or services/executor.

Keep:
- Next.js routes
- UI
- SSR
- frontend state
- forms
- generated API clients
- Payload CMS where appropriate

Remove only after backend parity exists:
- executor runtime
- workers
- risk engine
- exchange adapters
- exchange signing
- backend lock/store implementations

Organize frontend code primarily by features.

Do not change existing UX unless required to preserve compatibility.

Run Bun tests, TypeScript checks and Next.js production build.
