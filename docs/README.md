# Fudcourt — Documentation

**Fudcourt** is a personal multi-chain treasury & market-intelligence OS: a Next.js
dashboard that tracks wallets, balances, reconciliation and live market boards
(cryptorank / dexscreener / defillama / news / signals), plus a
Payload CMS blog — now ONE Next app (`apps/web`) rather than two (DR-017), installed with Bun — there is no npm `workspaces` field. The **`chainrank`** and **`khala`** research
families (chainrank.fyi, khala.io) are served **API-only** by the Go sidecar on `:3101`;
their web boards were removed (DR-041) — [DR-006](records/DECISIONS.md), design record
`/home/dwizzy/khala-probe/DESIGN.md`.

- Repo: `github.com/anvxxr-arch/fudcourt` · remote head at time of writing: `957836d`
- Local stack: `fudcourt-web` (`:3100` — dashboard **and** blog), `fudcourt-data`
  (Go CryptoRank sidecar, `:3101`), `fudcourt-reconciled` (Rust `/api/reconcile`
  service, `:3102`), `fudcourt-sync.timer` (5 min). The blog has no unit of its own
  (DR-017)
- Hosting: **self-hosted** on the homeserver (DR-002) — no third-party deploy
  target; production = the systemd units above (`/portfolio` rewrite lives in
  `apps/web/next.config.js`)

## Documents — grouped by the question you arrive with
```
docs/
  product/       what it is and who it is for
  prd/           the CEX executor product requirements (deep spec)
  architecture/  how it is built
  operations/    how it runs and what changed
  records/       why each decision was made (append-only)
  decisions/     the architecture decision records for this restructure
```
| Group | Doc | Contents |
|-------|-----|----------|
| product | [PRD.md](product/PRD.md) | Product requirements: goals, personas, FR/NFR, scope, out-of-scope |
| product | [ANALYSIS.md](product/ANALYSIS.md) | Fully comprehensive analysis: architecture, reasoning, evidence, risks |
| product | [RECOMMENDATIONS.md](product/RECOMMENDATIONS.md) | Ranked recommendations with impact/effort |
| architecture | [architecture.md](architecture.md) | **Start here for code**: the short index — "I want to change X, which path?" for risk, sizing, adapters, ingestion, runtime, market UI, schema, database, deploy, and the one command that verifies everything |
| architecture | [ARCHITECTURE.md](architecture/ARCHITECTURE.md) | **The clear map**: product statement, system picture, 14-view shell (18-row registry), 10 data families + trust classes, verification tiers, deploy model |
| architecture | [TECH-STACK.md](architecture/TECH-STACK.md) | Languages, frameworks, data stores, infra, verification tooling |
| architecture | [DESIGN-SYSTEM.md](architecture/DESIGN-SYSTEM.md) | The design system: `src/styles/tokens.ts` as SSOT, the generated `:root` block + `tailwind.tokens.json`, the drift/design gates, allowlists, the atom shelf, and the zero-visual-change rule |
| architecture | [design-inventory.md](architecture/design-inventory.md) | Read-only baseline the design system was built from: raw colour inventory, scale histograms, value→token mapping, orphan audit |
| architecture | [design-debt.md](architecture/design-debt.md) | The design-system debt ledger (measured, re-runnable): soft layout-value counts, atom adoption census with zero-use atoms, routes the pixel harness cannot see, and surfaces still hand-rolling chrome the atoms cover |
| architecture | [cryptorank-mode-audit.md](architecture/cryptorank-mode-audit.md) | Per-mode audit of the CryptoRank family (28 modes): live shapes, page-1 truncation, uniqueness vs duplication (DUP/UNIQUE/MIXED/REFUSED) and the 28→15 disposition |
| architecture | [provider-deep-dive.md](architecture/provider-deep-dive.md) | Live-probed shapes + uniqueness verdicts for the seven non-CryptoRank families (llama, markets, dex, signals, news, khala, chainrank) |
| architecture | [provider-consolidation.md](architecture/provider-consolidation.md) | The decision map: 14 public pages → 5 surfaces, per-page disposition, CryptoRank 28→15 demotion and the step-by-step migration order |
| architecture | [SCHEMA.md](architecture/SCHEMA.md) | Data schemas: Postgres treasury tables, Payload/Neon tables, API envelopes |
| architecture | [canonical-model.md](architecture/canonical-model.md) | The canonical data model: 7-layer pipeline, entity list with identity/owner, domain taxonomy, time semantics, precision rules, duplicate-concept decisions |
| architecture | [source-catalog.md](architecture/source-catalog.md) | Every data source actually in the repo: provider/feed/account kept distinct, freshness/durability/auth/status + the sources that are absent |
| architecture | [data-catalog.md](architecture/data-catalog.md) | Per-dataset detail: today's layer, provider carrier, canonical target, identity, time semantics, consumers |
| architecture | [data-classification.md](architecture/data-classification.md) | The classification matrix + provider-DTO leak audit + duplicate-concept audit |
| architecture | [database-classification.md](architecture/database-classification.md) | Every table in Postgres `public`/executor-schema/Neon classified: canonical/event/snapshot/cache/provider-specific/legacy/unknown, owner, durability, sensitivity, writer gaps |
| architecture | [data-categorization.md](architecture/data-categorization.md) | The 2026-10-02 refresh: 156 data surfaces across four slices (sidecar acquisition modes, web routes, persistence objects, upstream feeds), each row evidence-backed — closes the gap where `coinglass`/`coinank` appeared zero times in the 2026-10-01 catalogs; 161 after `coinmarketcap` folded in |
| architecture | [canonical-acceptance.md](architecture/canonical-acceptance.md) | The acceptance-criteria scorecard: every criterion mapped to observed evidence, with unresolved ambiguities and P0/P1/P2 next actions |
| operations | [PLAN.md](operations/PLAN.md) | Goal → subgoal → task → subtask breakdown with status |
| operations | [SECRETS.md](operations/SECRETS.md) | Secret inventory, production (self-hosted) env model, rotation runbook |
| operations | [CHANGELOG.md](operations/CHANGELOG.md) | What shipped, in change-sized rows |
| records | [DECISIONS.md](records/DECISIONS.md) | Decision records (DR-xxx): context, options, gate evidence, outcome |
| records | [archive/](records/archive/) | The restructure workstream's own history: the pre-migration `current`/`target` snapshots, the migration plan and the final review. Kept as the record of what changed and why; superseded by the tree itself |
| decisions | [005-no-shared-go-logic.md](decisions/005-no-shared-go-logic.md) | Why no `core/` was extracted: measured zero cross-app Go imports |
| decisions | [006-proxy-collapse-deferred.md](decisions/006-proxy-collapse-deferred.md) | Why the 56 route handlers were not collapsed at first: they are the machine-checked contract surface (superseded by 010) |
| decisions | [010-proxy-collapse-executed.md](decisions/010-proxy-collapse-executed.md) | How the collapse was finally executed: one catch-all gateway that keeps the 502 envelope and the tier-gate auth boundary |
| decisions | [refactor-baseline.md](decisions/refactor-baseline.md) | The measured before-state this restructure started from |
| decisions | [007-architecture-acceptance.md](decisions/007-architecture-acceptance.md) | The end state: every acceptance criterion with its evidence, and every deviation with its measurement |
| architecture | [cryptorank-data-types.md](architecture/cryptorank-data-types.md) | CryptoRank data-type inventory: 81 endpoints / 16 tags with per-endpoint tier + credit cost, the free **Sandbox** tier (21 endpoints at $0), the keyless HTML path the repo runs, and the v2→v3 migration |
| architecture | [coinglass-source-recon.md](architecture/coinglass-source-recon.md) | CoinGlass recon **and the shipped Go implementation**: official V4 (key-gated) vs the keyless `capi` surface, the AES-128-ECB×2 + gzip decryptor, the full `v` table, the endpoints the live probe dropped, and the `CgEnvelope` provenance contract |
| architecture | [coinank-data-types.md](architecture/coinank-data-types.md) | CoinAnk data-type inventory: 78 endpoints / 20 categories, VIP1–VIP4 gating on the official host, and the **keyless** `api.coinank.com` client-computed signature — reconstructed and verified live; constants kept in code, not prose |
| architecture | [coinmarketcap-data-types.md](architecture/coinmarketcap-data-types.md) | CoinMarketCap recon **and the shipped Go implementation**: the documented `pro-api` (key-gated, NOT wired) vs the keyless `data-api/v3` dashboard backend (no credential at all — the third keyless mechanism, after CoinGlass's decryption and CoinAnk's signature), the live probe matrix, and the quiet failure modes (`error_code != "0"` on a 200 → 502; `limit=0` is a success envelope with an empty list, hence LOCAL bounds) |

| prd | [cex-executor.md](prd/cex-executor.md) | The CEX Executor PRD: planner, risk, sizing, strategies (market/limit/TWAP/adaptive-TWAP/iceberg/chase-limit/scale), Binance/Bybit/MEXC adapters, worker and state machine |
| architecture | [executor.md](architecture/executor.md) | CEX executor architecture: the domain map, module boundaries and the Go port table (reality-first — when it and the code disagree, the code wins) |
| architecture | [bot.md](architecture/bot.md) | The Telegram bot (`apps/bot`): the receiving half of the notification channel — module/unit shape, the 11-command surface (8 public + 3 admin), config names, and the `/healthz` map `/status` probes |
| architecture | [events.md](architecture/events.md) | Canonical event contracts read off `contracts/` and the executor enums: the envelope and the event catalog (PRD §63) |
| architecture | [security.md](architecture/security.md) | Security model: Discord session auth, the tier guard, the executor store/lock and audit — every claim names a file |
| architecture | [parity-matrix.md](architecture/parity-matrix.md) | The TS→Go executor cutover gate: no TS module is deleted until its row is `DONE` and `verify:executor` passes against the Go worker |
| architecture | [canonical-placement.md](architecture/canonical-placement.md) | The placement companion to `canonical-model.md`: where each node lands today, the frozen envelope behind it, and its migration phase |
| architecture | [domain-map.md](architecture/domain-map.md) | Phase-0 audit: today's owner → target owner per node, with the `apps/api` bounded-context regroup |
| records | [migration-plan.md](records/archive/migration-plan.md) | The phased restructure plan: phases 0–4/6/8–10 landed; 5 (delete the TS executor) + 7 (frontend cleanup) deliberately gated on the money-path cutover |
| records | [target.md](records/archive/target.md) | The intended end-state for the domain restructure: per-section **landed / pending** markers, reconciled against the tree 2026-10-01 |
| records | [current.md](records/archive/current.md) | Phase-0 audit snapshot (2026-10-01): the tree right after the Phase-1/2 moves — **historical, pinned at capture, not a living document** |
| records | [final-review.md](records/archive/final-review.md) | Independent current-state review of the `refactor/domain-architecture` branch, each incomplete phase's blocker named |
| operations | [BASELINE.md](operations/BASELINE.md) | Pre-move baseline (2026-10-01): every command run on the old `apps/{web,apicalls,sync}` tree — the regression reference a phase may not worsen |

## One-line map of the repo
```
apps/web/       Next.js 16.3.6 portfolio OS (14 views; the API routes live at
                 `src/app/(frontend)/api/**`) + the Payload blog + verify harnesses
apps/api/       Go — primary HTTP API (unit `fudcourt-api` :3103;
                 `internal/{access,accounts,markets,platform}`)
apps/executor/  Go — CEX execution engine (`internal/{execution,orders,planner,risk,
                 sizing,strategies,exchanges,runtime,platform,repository,tests}`)
apps/data/      Go sidecar :3101 — one package per family, under `internal/research/`:
                 `cryptorank` (mode tables, tls-client fetch, cache, shaping),
                 `khala` (research reports, plain net/http), `llama` (DeFiLlama TVL),
                 `news` (Cointelegraph RSS: feed table, strict source/limit, RSS
                 parse), `chainrank` (chainrank.fyi reads; pagination relayed
                 verbatim) + `platform/httpx` (shared escaping rule) and
                 `platform/cache`; /api/{cryptorank,llama,news} proxy to it
                 (DR-005/DR-009/DR-012); the mux still serves /api/khala and
                 /api/chainrank API-only, with no web proxy (DR-006/DR-013, DR-041)
apps/reconciler/ Rust crate — TWO binaries: `fudcourt-reconciler` (the live
                 multi-chain balance reconciliation → Postgres + share %,
                 parity-checked against tests/oracle/sync-live.py; SG-9.4) and
                 `fudcourt-reconciled` (:3102, the `/api/reconcile` HTTP service —
                 zero new dependencies, parity-checked byte-for-byte against the
                 TS shaper; DR-014)
contracts/      OpenAPI + event catalog + JSON schemas — the one shared artifact,
                 plus the four drift gates that police it
db/schema/      pg-schema.sql (treasury system of record) ·
                executor-schema.sql (execution ledger)
deploy/systemd/ 10 unit files (web, api, bot, data, executor, reconciled,
                 reconciler, sync)
tests/          fixtures/ · integration/ · oracle/ — cross-system suites and the
                independent oracle (there is no `tests/e2e/`: the executor E2E is
                `apps/executor/internal/tests/e2e/paper_e2e_test.go`)
scripts/        verify/ · githooks/ — repo-wide gates and the pre-push hook
tools/          fud.ts — the one command surface (`node tools/fud.ts verify`)
(blog)           Payload CMS 3.89 merged INTO apps/web (DR-017): collections +
                 migrations + the admin/API routes live at src/cms and
                 app/blog/(payload), served at /blog, /blog/cms/admin, /blog/cms/api/*.
                 Posts/media/categories/users still live in Neon (DATABASE_URL)
```
`apps/web/` splits routes from React by role (DR-011/DR-018): `src/app/` holds the
Next route tree (`(frontend)/api/**`, one wrapper per deep link, plus the blog CMS
tree), `src/features/overview/store-shell.tsx` is the SPA state container,
`src/ui/` the presentational leaves and `src/styles/` the
design tokens + view types. The Go sidecar is one package per family under
`apps/data/internal/research/` —
`{cryptorank,khala,llama,news,chainrank}` — and `apps/reconciler/` is the Rust
crate behind both of its services (`fudcourt-reconciler`, `fudcourt-reconciled`).
`/api/reconcile` is a thin proxy to `fudcourt-reconciled` on `:3102` (DR-014), with
the web-side `src/features/overview/reconcile.ts` kept as the oracle rather than a
fallback path.
`apps/web/scripts/` holds the web-app-only tooling and harnesses
(`checks/check-structure.py` — the layer gate — plus `design/` token emission and
`tools/` maintenance such as `read-path-probe.ts`); the repo-wide verifiers, fixtures and cross-system suites have moved out of
`apps/web`:
```
  scripts/verify/        repo-wide harnesses + one-command gate: check-contract.py,
                         check-deploy.py, verify-<family>.py, verify-sync.py,
                         verify-reconcile.py, monitor.py, verify-all.sh
  scripts/githooks/      pre-push hook
  apps/web/tests/         web-only suites + probes: auth, cache-control, db, economy,
                           executor-ui, imf, mappool, market-route, median, nav,
                           rate-limit, regime, routing, shaper, signals, ticker-cache
                           and trade tests (`<name>-tests.ts`), plus
                           design-system-tests.ts, verify-limiter.mts, dom_audit.py,
                           verify_all_routes.py, dbg-smoke.cjs, preload.ts
  apps/executor/internal/tests/e2e/  the executor paper E2E (paper_e2e_test.go)
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
