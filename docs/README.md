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
| architecture | [DESIGN-SYSTEM.md](architecture/DESIGN-SYSTEM.md) | The design system: `src/styles/tokens.ts` as SSOT, the generated `:root` block + `tailwind.tokens.json`, the drift/design gates, allowlists, the atom shelf, and the zero-visual-change rule |
| architecture | [design-inventory.md](architecture/design-inventory.md) | Read-only baseline the design system was built from: raw colour inventory, scale histograms, value→token mapping, orphan audit |
| architecture | [design-debt.md](architecture/design-debt.md) | The design-system debt ledger (measured, re-runnable): soft layout-value counts, atom adoption census with zero-use atoms, routes the pixel harness cannot see, and surfaces still hand-rolling chrome the atoms cover |
| architecture | [cryptorank-mode-audit.md](architecture/cryptorank-mode-audit.md) | Per-mode audit of the CryptoRank family (28 modes): live shapes, page-1 truncation, uniqueness vs duplication (DUP/UNIQUE/MIXED/REFUSED) and the 28→15 disposition |
| architecture | [provider-deep-dive.md](architecture/provider-deep-dive.md) | Live-probed shapes + uniqueness verdicts for the seven non-CryptoRank families (llama, markets, dex, signals, news, khala, chainrank) |
| architecture | [provider-consolidation.md](architecture/provider-consolidation.md) | The decision map: 14 public pages → 5 surfaces, per-page disposition, CryptoRank 28→15 demotion and the step-by-step migration order |
| architecture | [SCHEMA.md](architecture/SCHEMA.md) | Data schemas: Turso tables, Payload/Neon tables, API envelopes |
| architecture | [canonical-model.md](architecture/canonical-model.md) | The canonical data model: 7-layer pipeline, entity list with identity/owner, domain taxonomy, time semantics, precision rules, duplicate-concept decisions |
| architecture | [source-catalog.md](architecture/source-catalog.md) | Every data source actually in the repo: provider/feed/account kept distinct, freshness/durability/auth/status + the sources that are absent |
| architecture | [data-catalog.md](architecture/data-catalog.md) | Per-dataset detail: today's layer, provider carrier, canonical target, identity, time semantics, consumers |
| architecture | [data-classification.md](architecture/data-classification.md) | The classification matrix + provider-DTO leak audit + duplicate-concept audit |
| architecture | [database-classification.md](architecture/database-classification.md) | Every table in Turso/Postgres/executor-schema/Neon classified: canonical/event/snapshot/cache/provider-specific/legacy/unknown, owner, durability, sensitivity, writer gaps |
| architecture | [canonical-acceptance.md](architecture/canonical-acceptance.md) | The acceptance-criteria scorecard: every criterion mapped to observed evidence, with unresolved ambiguities and P0/P1/P2 next actions |
| operations | [PLAN.md](operations/PLAN.md) | Goal → subgoal → task → subtask breakdown with status |
| operations | [SECRETS.md](operations/SECRETS.md) | Secret inventory, production (self-hosted) env model, rotation runbook |
| operations | [CHANGELOG.md](operations/CHANGELOG.md) | What shipped, in change-sized rows |
| records | [DECISIONS.md](records/DECISIONS.md) | Decision records (DR-xxx): context, options, gate evidence, outcome |
| architecture | [cryptorank-data-types.md](architecture/cryptorank-data-types.md) | CryptoRank data-type inventory: 81 endpoints / 16 tags with per-endpoint tier + credit cost, the free **Sandbox** tier (21 endpoints at $0), the keyless HTML path the repo runs, and the v2→v3 migration |
| architecture | [coinglass-source-recon.md](architecture/coinglass-source-recon.md) | CoinGlass recon **and the shipped Go implementation**: official V4 (key-gated) vs the keyless `capi` surface, the AES-128-ECB×2 + gzip decryptor, the full `v` table, the endpoints the live probe dropped, and the `CgEnvelope` provenance contract |
| architecture | [coinank-data-types.md](architecture/coinank-data-types.md) | CoinAnk data-type inventory: 78 endpoints / 20 categories, VIP1–VIP4 gating on the official host, and the **keyless** `api.coinank.com` client-computed signature — reconstructed and verified live; constants kept in code, not prose |

## One-line map of the repo

```
frontend/web/    Next.js 16.3.6 portfolio OS (16 views; the API routes live at
                 `src/app/(frontend)/api/**`) + the Payload blog + verify harnesses
backend/api/     Go — primary HTTP API (unit `fudcourt-api` :3103, `cmd/api`;
                 `internal/{access,accounts,finance,markets,notifications,audit,jobs,
                 platform}`)
backend/workers/executor/
                 Go — CEX execution engine (`cmd/executor`;
                 `internal/{core,strategies,exchanges,runtime,platform,repository,tests}`)
backend/data/    Go sidecar :3101 — one package per family, under `internal/research/`:
                 `cryptorank` (mode tables, tls-client fetch, cache, shaping),
                 `khala` (research reports, plain net/http), `llama` (DeFiLlama TVL),
                 `news` (Cointelegraph RSS: feed table, strict source/limit, RSS
                 parse), `chainrank` (chainrank.fyi reads; pagination relayed
                 verbatim) + `platform/httpx` (shared escaping rule) and
                 `platform/cache`; /api/{cryptorank,khala,llama,news,chainrank}
                 proxy to it (DR-005/DR-006/DR-009/DR-012/DR-013)
backend/sync/    Rust crate — TWO binaries: `fudcourt-sync` (the live multi-chain
                 balance sync → Turso + share %, parity-checked against
                 tests/oracle/sync-live.py; SG-9.4) and
                 `fudcourt-reconciled` (:3102, the `/api/reconcile` HTTP service —
                 zero new dependencies, parity-checked byte-for-byte against the
                 TS shaper; DR-014)
shared/contracts/      OpenAPI + event catalog + JSON schemas — the one shared artifact
shared/sdk/typescript/ generated TS client over the contract
database/schema/       schema.sql (Turso) · pg-schema.sql (read model) ·
                       executor-schema.sql (execution ledger)
infrastructure/systemd/ 12 unit files + 2 retired tombstones (web, api, data, executor,
                       executor-worker, sync, sync-rust, reconciled, pgload)
tests/           integration/ · e2e/ · fixtures/ · oracle/ — cross-system suites
scripts/         verify/ · database/ · githooks/ — repo-wide gates, tooling, hook
(blog)           Payload CMS 3.89 merged INTO frontend/web (DR-017): collections +
                 migrations + the admin/API routes live at src/cms and
                 app/blog/(payload), served at /blog, /blog/cms/admin, /blog/cms/api/*.
                 Posts/media/categories/users still live in Neon (DATABASE_URL)
```
`frontend/web/` splits routes from React by role (DR-011/DR-018): `src/app/` holds the
Next route tree (`(frontend)/api/**`, one wrapper per deep link, plus the blog CMS
tree), `src/components/layout/store-shell.tsx` is the SPA state container,
`src/components/ui/primitives.tsx` the presentational leaves and `src/styles/` the
design tokens + view types. The Go sidecar is one package per family under
`backend/data/internal/research/` —
`{cryptorank,khala,llama,news,chainrank}` — and `backend/sync/` is the Rust
crate behind both of its services (`fudcourt-sync`, `fudcourt-reconciled`).
`/api/reconcile` is a thin proxy to `fudcourt-reconciled` on `:3102` (DR-014), with
the web-side `src/features/treasury/reconcile.ts` kept as the oracle rather than a
fallback path.
`frontend/web/scripts/` holds the web-app-only tooling and harnesses
(`checks/check-structure.py` — the layer gate — plus `executor/worker.ts` and `tools/` maintenance:
`pg-load.ts`, `read-path-probe.ts`); the repo-wide verifiers, fixtures and cross-system suites have moved out of
`frontend/web`:
```
  scripts/verify/        repo-wide harnesses + one-command gate: check-contract.py,
                         check-deploy.py, verify-<family>.py, verify-sync.py,
                         verify-reconcile.py, monitor.py, verify-all.sh
  scripts/database/      dump-schema.mjs (Turso schema drift alarm)
  scripts/githooks/      pre-push hook
  frontend/web/tests/      web-only suites + probes: shaper/auth/rate-limit/db/executor-ui
                           tests, verify-limiter.mts, dom_audit.py, verify_all_routes.py,
                           dbg-smoke.cjs
  tests/e2e/executor/      executor E2E suites + executor-paper-e2e.ts (+ probe-sizing.cjs)
  tests/integration/       cross-service gates (api contract, executor integration)
  tests/fixtures/          recorded payloads: 26 .gz + expected/ envelopes,
                           sha256 in MANIFEST.json
  tests/oracle/            independent oracle: cr_fetch.py (only used BY verify-cryptorank.py)
                           + the fixture recorder/dumper (record-fixtures.ts, dump-envelopes.ts)
```
The frontend installs and runs through **Bun 1.4.2** (`bun install --frozen-lockfile`,
`bun run …`, `bunx`) and is *served* by Bun ([DR-008](records/DECISIONS.md)). There is one
Next app now — the blog merged into it ([DR-017](records/DECISIONS.md)) — so the earlier
"both frontends on Bun" note ([DR-015](records/DECISIONS.md)) now describes one app: the
dashboard and the CMS blog both run under Bun at `:3100`, and Node stays only as the
rollback runtime.
