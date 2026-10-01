# Fudcourt — Documentation

**Fudcourt** is a personal multi-chain treasury & market-intelligence OS: a Next.js
dashboard that tracks wallets, balances, reconciliation and live market boards
(cryptorank / chainrank / dexscreener / defillama / news / signals), plus a
Payload CMS blog — now ONE Next app (`frontend/web`) rather than two (DR-017), installed with Bun — there is no npm `workspaces` field. A **`khala`** research-report
family (khala.io, Framer SSR) is **served** (sidecar-registered, on the board and the
public hostname) — PLAN G8 ✅, [DR-006](records/DECISIONS.md), design record
`/home/dwizzy/khala-probe/DESIGN.md`.

- Repo: `github.com/anvxxr-arch/fudcourt` · remote head at time of writing: `957836d`
- Local stack: `fudcourt-web` (`:3100` — dashboard **and** blog), `fudcourt-data`
  (Go CryptoRank sidecar, `:3101`), `fudcourt-reconciled` (Rust `/api/reconcile`
  service, `:3102`), `fudcourt-sync.timer` (5 min). The blog has no unit of its own
  (DR-017)
- Hosting: **self-hosted** on the homeserver (DR-002) — no third-party deploy
  target; production = the systemd units above (`/portfolio` rewrite lives in
  `frontend/web/next.config.js`)

## Documents — grouped by the question you arrive with
```
docs/
  product/       what it is and who it is for
  architecture/  how it is built
  operations/    how it runs and what changed
  records/       why each decision was made (append-only)
```
| Group | Doc | Contents |
|-------|-----|----------|
| product | [PRD.md](product/PRD.md) | Product requirements: goals, personas, FR/NFR, scope, out-of-scope |
| product | [ANALYSIS.md](product/ANALYSIS.md) | Fully comprehensive analysis: architecture, reasoning, evidence, risks |
| product | [RECOMMENDATIONS.md](product/RECOMMENDATIONS.md) | Ranked recommendations with impact/effort |
| architecture | [ARCHITECTURE.md](architecture/ARCHITECTURE.md) | **The clear map**: product statement, system picture, 16-view shell (18-row registry), 10 data families + trust classes, verification tiers, deploy model |
| architecture | [TECH-STACK.md](architecture/TECH-STACK.md) | Languages, frameworks, data stores, infra, verification tooling |
| architecture | [SCHEMA.md](architecture/SCHEMA.md) | Data schemas: Turso tables, Payload/Neon tables, API envelopes |
| operations | [PLAN.md](operations/PLAN.md) | Goal → subgoal → task → subtask breakdown with status |
| operations | [SECRETS.md](operations/SECRETS.md) | Secret inventory, production (self-hosted) env model, rotation runbook |
| operations | [CHANGELOG.md](operations/CHANGELOG.md) | What shipped, in change-sized rows |
| records | [DECISIONS.md](records/DECISIONS.md) | Decision records (DR-xxx): context, options, gate evidence, outcome |
## One-line map of the repo

```
apps/
  web/    Next.js 16.3.6 portfolio OS (16 views, 21 API routes: 18 data + 3 auth)
          + the Payload blog + verify harnesses
  fudcourt-data/ Go sidecar :3101 — one package per family: `internal/cryptorank`
            (mode tables, tls-client fetch, cache, shaping), `internal/khala`
            (research reports, plain net/http), `internal/llama` (DeFiLlama TVL),
            `internal/news` (Cointelegraph RSS: feed table, strict source/limit,
            RSS parse), `internal/chainrank` (chainrank.fyi reads; pagination
            relayed verbatim) + `internal/httpx` (shared escaping rule);
            /api/{cryptorank,khala,llama,news,chainrank} proxy to it
            (DR-005/DR-006/DR-009/DR-012/DR-013)
  sync/ Rust services — TWO binaries from one crate: `fudcourt-sync` (the live
            multi-chain balance sync → Turso + share %, parity-checked against
            scripts/tools/sync-live.py; SG-9.4) and `fudcourt-reconciled`
            (:3102, the `/api/reconcile` HTTP service — zero new dependencies,
            parity-checked byte-for-byte against the TS shaper; DR-014)
  (blog)  Payload CMS 3.89 merged INTO frontend/web (DR-017): collections +
          migrations + the admin/API routes live at src/cms and
          app/blog/(payload), served at /blog, /blog/cms/admin, /blog/cms/api/*.
          Posts/media/categories/users still live in Neon (DATABASE_URL)
```
`frontend/web/` splits routes from React by role (DR-011): `app/` holds the Next route
tree (`api/`, one wrapper per deep link) plus `app/store/store-shell.tsx` (the SPA
state container), `src/components/` the 18 panel components and `src/styles/` the
design tokens + view types. The Go sidecar is one package per family —
`internal/{cryptorank,khala,llama,news,chainrank}` — and `backend/sync/` is the Rust
crate behind both of its services (`fudcourt-sync`, `fudcourt-reconciled`).
`/api/reconcile` is a thin proxy to `fudcourt-reconciled` on `:3102` (DR-014), with
`lib/reconcile.ts` kept as the independent oracle rather than a fallback path.
`frontend/web/scripts/` is grouped by function — one directory per job, so a reader
never has to guess whether a file is a gate or a one-off:
```
  checks/   offline gates ......... check-contract.py (TS↔Go tables, mutation guards)
  tests/    offline unit suites ... shaper/auth/rate-limit tests, verify-limiter.mts
  verify/   live harnesses ........ verify-<family>.py, verify_all_routes.py,
                                    monitor.py (continuous), dom_audit.py
  oracle/   independent oracle .... cr_fetch.py (only used BY verify-cryptorank.py)
  tools/    codegen/maintenance ... record-fixtures.ts, dump-envelopes.ts,
                                    dump-schema.mjs, sync-live.py
  fixtures/ recorded payloads ..... 26 .gz + expected/ envelopes, sha256 in MANIFEST.json
```
The frontend installs and runs through **Bun 1.4.2** (`bun install --frozen-lockfile`,
`bun run …`, `bunx`) and is *served* by Bun ([DR-008](records/DECISIONS.md)). There is one
Next app now — the blog merged into it ([DR-017](records/DECISIONS.md)) — so the earlier
"both frontends on Bun" note ([DR-015](records/DECISIONS.md)) now describes one app: the
dashboard and the CMS blog both run under Bun at `:3100`, and Node stays only as the
rollback runtime.
