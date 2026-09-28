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
- SG-1.3 ⬜ Commit + push the docs set to origin/main

---

## G2 — ⬜ Next: Integrity hardening (P0)

> Closes the two high risks before any new feature work.

### SG-2.1 ⬜ Schema versioning (R-1, K-1)
- T-2.1.1 ⬜ Dump live Turso schema → `apps/web/db/schema.sql`
- T-2.1.2 ⬜ Commit + document authoritative vs reconstructed columns (align `SCHEMA.md` §1)
- T-2.1.3 ⬜ Harness check: live `sqlite_master` == committed dump (drift alarm)

### SG-2.2 ⬜ CI / pre-push verification (R-2, K-2)
- T-2.2.1 ⬜ `.git/hooks/pre-push` (or `husky`): `tsc --noEmit` for touched app
- T-2.2.2 ⬜ Offline harness subset (contract + shaper fixture checks, no upstream)
- T-2.2.3 ⬜ GitHub Action on PR: build web + blog, run offline subset

### SG-2.3 ⬜ Mutation authentication (R-6, K-5)
- T-2.3.1 ⬜ `FUD_API_TOKEN` env + header check on all write methods in `/api/transactions|wallets`
- T-2.3.2 ⬜ 401 contract + harness checks (present/absent/incorrect token)
- T-2.3.3 ⬜ Keep reads public (LAN), document in PRD §4.4 update

---

## G3 — ⬜ Near-term product (P1)

### SG-3.1 ⬜ Upstream monitoring (R-4)
- T-3.1.1 ⬜ `monitor.sh`: 5-check smoke every 15 min (systemd timer)
- T-3.1.2 ⬜ Deviation → notification (Telegram bot already in stack)

### SG-3.2 ⬜ Blog content bootstrapping (R-5)
- T-3.2.1 ⬜ Seed 3 posts via Payload REST (methodology, decoy post-mortem, sync rules)
- T-3.2.2 ⬜ Verify `/blog/[slug]` with real slug + hero media upload path

### SG-3.3 ⬜ Next.js version decision (R-3)
- T-3.3.1 ⬜ Spike: `apps/web` 14 → 16 upgrade branch, `tsc` + build + 100-check sweep
- T-3.3.2 ⬜ Decision record (upgrade vs documented exception) in `docs/`

### SG-3.4 ⬜ Harness precision (R-7)
- T-3.4.1 ⬜ Interleaved truth/subject fetch helper (kills fetch-skew false fails)
- T-3.4.2 ⬜ Re-audit tolerance bounds against interleaved measurements

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
