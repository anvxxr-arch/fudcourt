# Plan — Fudcourt (goal → subgoal → task → subtask)

Baseline: remote head `957836d` (2026-09-27). Status legend: ✅ done · 🔄 in progress · ⬜ not started.

---

## G0 — ✅ COMPLETED: Full CryptoRank reverse-engineering integration

> *"reverse engineer cryptorank and fully integrate with fudcourt — no API keys"*

### SG-0.1 ✅ Recon & classification
- T-0.1.1 ✅ SSR payload mapping (`__NEXT_DATA__` on every market surface)
- T-0.1.2 ✅ HAR/XHR mining → 53 JS chunks → 0 private endpoints (pure SSR confirmed)
- T-0.1.3 ✅ `/_next/data` decoy detection (fabricated coins/names, 200-on-404) → class rejected
- T-0.1.4 ✅ Sitemap sweep (~50k nested URLs) → families classified: DATA / 403-wall / INITDATA-only / marketing

### SG-0.2 ✅ Gating framework (3-gate detector)
- T-0.2.1 ✅ GATE1: nonexistent slug → 404 (per family)
- T-0.2.2 ✅ GATE2: value parity vs coins.llama.fi / CoinGecko
- T-0.2.3 ✅ GATE3: semantic ground truth (official announcements, publisher titles, official quotes, league schedules, YT oembed)
- T-0.2.4 ✅ Rejections with evidence: `/ath`, `/performance`, `funds/*`, `perpetuals/dex`, `avg-roi-by-sector`, data-route funding/unlocks/ico (503 refusal)

### SG-0.3 ✅ 28 wired modes (11 commits `d65b6ba…957836d`)
- T-0.3.1 ✅ Market core: home, coins, trending, gainers, losers, categories, exchanges×4, coin, listings
- T-0.3.2 ✅ Chains: blockchains, chain detail
- T-0.3.3 ✅ Events: launchpool×3, nodesale×3, news, tags, tag
- T-0.3.4 ✅ Sectors & assets: ecosystems, ecosystem, rwa, rwaasset, quarterly, prediction
- T-0.3.5 ✅ Final batch: converter, media, newstag (derived-404), aioverview (coherence-gated)

### SG-0.4 ✅ Verification artifacts
- T-0.4.1 ✅ `verify-cryptorank.py` harness — **244/0/8**
- T-0.4.2 ✅ Playwright DOM audit — **109/109**
- T-0.4.3 ✅ Route/endpoint sweep `verify_all_routes.py` — **100/100**
- T-0.4.4 ✅ Resilience: runHelper 429 backoff×3, harness retries, audit cache warm-up
- T-0.4.5 ✅ Pushed to origin (`0ed7ab6..957836d`)

---

## G1 — 🔵 CURRENT (in progress): Documentation & project baseline

- SG-1.1 ✅ Review remote head (`957836d`, in sync with local `main`)
- SG-1.2 ✅ Documentation set created in `docs/`:
  - T-1.2.1 ✅ `README.md` (index + repo map)
  - T-1.2.2 ✅ `PRD.md` (vision, personas, FR/NFR, out-of-scope)
  - T-1.2.3 ✅ `SCHEMA.md` (Turso, Neon/Payload, API envelopes)
  - T-1.2.4 ✅ `TECH-STACK.md` (languages, frameworks, infra, RE stack)
  - T-1.2.5 ✅ `ANALYSIS.md` (architecture, reasoning log, evidence, risks K-1…K-9)
  - T-1.2.6 ✅ `RECOMMENDATIONS.md` (R-1…R-11 + anti-goals)
  - T-1.2.7 ✅ `PLAN.md` (this file)
- SG-1.3 ✅ Commit + push the docs set to origin/main (`d2447a5`)

---

## G2 — ✅ COMPLETE: Integrity hardening (P0)

> Closed 2026-09-28: schema versioned + drift gate, offline pre-push gate live,
> CI green (`.github/workflows/ci.yml`, run `36393193712`), mutation auth fail-closed
> on all 7 write handlers. Remaining risks tracked in ANALYSIS §5.

### SG-2.1 ✅ Schema versioning (R-1, K-1)
- T-2.1.1 ✅ Dump live Turso schema → `apps/web/db/schema.sql` (`scripts/dump-schema.mjs`, 9 objects)
- T-2.1.2 ✅ Committed + `SCHEMA.md` annotated (generated file vs code-derived tables)
- T-2.1.3 ✅ Drift alarm: `dump-schema.mjs --check` (live == committed, exit 1 on diff)

### SG-2.2 ✅ CI / pre-push verification (R-2, K-2)
- T-2.2.1 ✅ `scripts/githooks/pre-push` (`core.hooksPath` configured): tsc for touched app + py syntax
- T-2.2.2 ✅ Offline contract gate `check-contract.py` (CR_MODES lib↔sweep consistency + mutation-guard audit)
- T-2.2.3 ✅ GitHub Action `.github/workflows/ci.yml` (3 jobs, green run `36393193712`):
  per-app `npm ci` (root has no workspaces field — apps install standalone, as Vercel builds them),
  contract gate + tsc + builds for web/blog, `bash -n` on the hook

### SG-2.3 ✅ Mutation authentication (R-6, K-5)
- T-2.3.1 ✅ `lib/mutation-auth.ts` — fail-closed `x-fud-token` on all 7 write handlers
- T-2.3.2 ✅ 401 contract verified: sweep D1 (7×401 no/wrong token) + D2 (7×validation with token), 107/107
- T-2.3.3 ✅ Reads stay open (LAN); documented in PRD NFR-4 + ANALYSIS K-5

---

## G3 — ⬜ Near-term product (P1)

### SG-3.1 ✅ Upstream monitoring (R-4)
- T-3.1.1 ✅ `apps/web/scripts/monitor.py` — 7-check smoke (unit, board, home
  non-empty+upstream, coins, converter, newstag keyed, funding-must-503),
  concurrent (wall = slowest check, ~1-2s warm), deterministic output
  (byte-stable = silent tick), retry only 429/5xx. Deployed to
  `~/.hermes/scripts/monitor-cryptorank.py` as a thin wrapper (repo = source).
- T-3.1.2 ✅ Deviation → agent wakes + notifies via Hermes cron `monitor-cryptorank`
  (job `f191fe6df16c`, every 15m, deliver=origin). Note: implemented as a Hermes
  cron monitor instead of a systemd timer — same intent, built-in dedup+delivery.

### SG-3.2 ✅ Blog content bootstrapping (R-5)
- T-3.2.1 ✅ Seed 3 posts — `apps/blog/scripts/seed.ts` via `npx payload run`
  (REST writes need an authenticated user we don't have; Payload local API
  bypasses access). Upsert-by-slug idempotent (rerun = same 3 ids). Content:
  how-a-board-is-gated · the-decoy-that-passed-parity · never-fake-rules,
  2 categories, 1 hero (sharp SVG→PNG, 1200×630).
- T-3.2.2 ✅ Verified live: REST `/api/posts` total=3 all published; all 3
  `/blog/<slug>` → 200 with title + body in SSR HTML; hero
  `/api/media/file/fudcourt-hero.png` → 200, 62 KB, PNG magic 89504e47;
  rerun keeps total=3. `media/` is git-ignored (regenerated by seed).
- Pitfalls banked: (a) `payload run` = `await import(script)` then
  `process.exit(0)` — floating `main()` is killed between the two, silent
  no-op exit 0; script must use **top-level await** (throw → loud exit 1).
  (b) Payload 3.89 upload field is `file.name`, not `filename` (TS said so;
  casting around the compiler only hid the bug). (c) relationship ids stay
  numeric — stringifying fails validation. (d) blog `next build` passes with
  pre-existing `src/migrations` drizzle type errors only because
  `typescript.ignoreBuildErrors: true` — seed.ts itself is tsc-clean.

### SG-3.3 ✅ Next.js version decision (R-3)
- T-3.3.1 ✅ Spike `spike/next16` (worktree, merged `8329669`): 14.2.0 →
  **16.3.6** exact-pinned. Broke = async route params (TS2344, fixed
  `Promise<{id}>` + await in `transactions/[id]`), Turbopack execFile
  tracing (fixed `turbopackIgnore`), tsconfig auto-migration (committed).
  React stays 18.3.1 (peer accepts ^18.2.0). Gates: build/tsc/contract 0,
  sweep **107/107** on isolated :3110 + again on production :3100 post
  cutover, DOM audit parity vs Next 14 (17 tables identical; the one BAD
  check fails on 14 too → pre-existing, moved to SG-3.4).
- T-3.3.2 ✅ Decision record `docs/DECISIONS.md` DR-001 = **accept
  upgrade** (evidence + consequences incl. benign turbopack root warning).

### SG-3.4 ✅ Harness precision (R-7)
- T-3.4.1 ✅ Interleaving + de-flaking. `truth_fresh()` (20s TTL) replaced the
  minutes-old global truth snapshot at all 14 reuse sites; tight compares take
  the subject with `fresh=1` (no cache) so both sides bracket within seconds.
  Also fixed what fresh runs exposed: aioverview digest parser de-templated
  (upstream rotated 'to $N' -> 'stands at N', no $, U+2011 hyphens;
  dominance ships without '%'); DEX top venue -> independent **llama top-20
  GATE3** (the old 'uniswap is #1' was a stale world-state claim — measured
  top = pancakeswap-v3-bsc, llama hit PancakeSwap AMM V3); news/newstag
  publisher-title gate = prefix-50 OR **LCS>=40** (CR rotates editorial
  prefixes like 'Crypto-friendly institution ...'); aioverview volume band
  **age-scaled** vs digest updatedAt (measured ~2.75%/h churn: 34.997B@06:00
  vs 39.64B@11:05 = 11.7%); DOM stats-strip check case-fixed (CSS
  text-transform uppercase -> innerText all-caps).
- T-3.4.2 ✅ Bound re-audit on n=4 interleaved samples (back-to-back <2s):
  parity BTC **0.5% -> 0.1%** (measured 0.0000% — same source, seconds apart);
  ecosystem **0.5% -> 1.0%** (measured constant 0.4670% methodology gap
  CR-vs-llama — structural, old bound sat 0.033pp from it = flake trap);
  3% llama bands kept (fresh gap measured 0.125% + <=90s skew envelope;
  fabrication class >=5% — detection power untouched). Final gates:
  harness **244/0/8 RC=0**, DOM audit 0 BAD, bounds documented in-code.

---

## G4 — ⬜ Later (P2)

- SG-4.1 ⬜ Shaper unit tests from recorded `__NEXT_DATA__` fixtures (R-8)
- SG-4.2 ⬜ Secret rotation runbook + Vercel/local env parity audit (R-9)
- SG-4.3 ⬜ Root `README.md` entry point linking `docs/` (R-10)
- SG-4.4 ⬜ Revisit official CryptoRank key **only if** R-4 reports RE breakage (R-11)

---

## Sequencing rationale

1. **G1 first** (docs) — zero-risk, unblocks every later task with shared vocabulary.
2. **G2 before features** — schema loss and unverified pushes are the only
   *irreversible* risks in the system (ANALYSIS K-1/K-2).
3. **G3 next** — monitoring converts silent upstream drift into alerts;
   blog seeds prove the second product surface.
4. **G4 opportunistic** — quality-of-life items scheduled around G2/G3.
