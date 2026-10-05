# Plan — Fudcourt (goal → subgoal → task → subtask)

Baseline: remote head `957836d` (2026-09-27). Status legend: ✅ done · 🔄 in progress · ⬜ not started.
>
> **Read this as a dated execution ledger, not as current state** (note added 2026-10-01, docs-reality
> pass). Every ✅ row describes what was true at the time it was closed; the paths it names are the
> tree *then*. The tree has since moved (`frontend/web/src/**` by DR-018; `backend/{api,workers/executor,data,sync}`,
> `shared/{contracts,sdk/typescript}`, `scripts/{verify,database,githooks}`, `tests/**`,
> `infrastructure/systemd/` by the Phase 1–10 restructure) — so a path or count in a closed row
> (e.g. `frontend/web/lib/…`, `frontend/web/db/…`, `frontend/web/scripts/{verify,tests,fixtures}`,
> `apps/blog`, `services/*`, `.github/workflows/ci.yml`) is historical, even where it carries no
> per-line marker. For the tree today use `docs/architecture/final-review.md` §1 and
> `docs/architecture/target.md` §1; for the dated Phase-0 picture use `docs/architecture/current.md`.

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
- T-0.4.3 ✅ Route/endpoint sweep `frontend/web/tests/verify_all_routes.py` (was `frontend/web/scripts/verify/verify_all_routes.py`; that directory was removed by the Phase-8 tooling relocation) — 133 checks, re-aligned to the repurpose pass (latest measured **122/133**, 2026-09-29 over two byte-identical runs: 11 fails = 1 CoinGecko 403 passthrough + 10 session-gated probes unrunnable on the secret-less :3107 audit target — environmental, zero regressions; full breakdown in ARCHITECTURE §7)
- T-0.4.4 ✅ Resilience: runHelper 429 backoff×3, harness retries, audit cache warm-up
- T-0.4.5 ✅ Pushed to origin (`0ed7ab6..957836d`)

---

## G1 — ✅ COMPLETE: Documentation & project baseline

- SG-1.1 ✅ Review remote head (`957836d`, in sync with local `main`)
- SG-1.2 ✅ Documentation set created in `docs/`:
  - T-1.2.1 ✅ `README.md` (index + repo map)
  - T-1.2.2 ✅ `PRD.md` (vision, personas, FR/NFR, out-of-scope)
  - T-1.2.3 ✅ `SCHEMA.md` (Postgres, Neon/Payload, API envelopes)
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

### SG-2.1 ✅ Schema versioning (R-1, K-1) — **superseded by DR-040**
- T-2.1.1 ✅ Dump live Turso schema → `frontend/web/db/schema.sql` (`scripts/tools/dump-schema.mjs`, 9 objects)
- T-2.1.2 ✅ Committed + `SCHEMA.md` annotated (generated file vs code-derived tables)
- T-2.1.3 ✅ Drift alarm: `dump-schema.mjs --check` (live == committed, exit 1 on diff)
- **DR-040 (2026-10-03): the Turso dump, its generator and the whole `scripts/database/`
  directory are deleted.** The schema is now `database/schema/pg-schema.sql`, hand-written
  and applied by hand — there is no dump and no drift alarm.

### SG-2.2 ✅ CI / pre-push verification (R-2, K-2)
- T-2.2.1 ✅ `scripts/githooks/pre-push` (`core.hooksPath` configured): tsc for touched app + py syntax
- T-2.2.2 ✅ Offline contract gate `check-contract.py` (CR_MODES lib↔sweep consistency + mutation-guard audit)
- T-2.2.3 ✅ GitHub Action `.github/workflows/ci.yml` (3 jobs, green run `36393193712`):
  per-app `npm ci` (root has no workspaces field — each app installs standalone with its own lockfile),
  contract gate + tsc + builds for web/blog, `bash -n` on the hook

### SG-2.3 ✅ Mutation authentication (R-6, K-5)
- T-2.3.1 ✅ `lib/mutation-auth.ts` — fail-closed auth on all 7 write handlers (first the `x-fud-token` header, retired 2026-09-28 by DR-003 for the signed Discord session)
- T-2.3.2 ✅ 401 contract verified: sweep D1 (7×401 no-session fail-closed) + D2 (7 signed-admin-session mutation probes, validation-first 400 / read-only 404 — zero writes), see T-0.4.3 for the latest run
- T-2.3.3 ✅ Reads stay open (LAN); documented in PRD NFR-4 + ANALYSIS K-5

---

## G3 — ✅ Near-term product (P1)

### SG-3.1 ✅ Upstream monitoring (R-4)
- T-3.1.1 ✅ `frontend/web/scripts/verify/monitor.py` — 7-check smoke (unit, board, home
  non-empty+upstream, coins, converter, newstag keyed, funding-must-503),
  concurrent (wall = slowest check, ~1-2s warm), deterministic output
  (byte-stable = silent tick), retry only 429/5xx. Deployed to
  `~/.hermes/scripts/monitor-cryptorank.py` as a thin wrapper (repo = source).
- T-3.1.2 ✅ Deviation → agent wakes + notifies via Hermes cron `monitor-cryptorank`
  (job `f191fe6df16c`, every 15m, deliver=origin). Note: implemented as a Hermes
  cron monitor instead of a systemd timer — same intent, built-in dedup+delivery.

### SG-3.2 ✅ Blog content bootstrapping (R-5)
- T-3.2.1 ✅ Seed 3 posts — `src/cms/seed.ts` via `bunx payload run` (path/app updated by the DR-017 merge; was `apps/blog/src/seed.ts`)
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
  sweep 133 checks (see T-0.4.3) on isolated :3110 + again on production :3100 post
  cutover, DOM audit parity vs Next 14 (17 tables identical; the one BAD
  check fails on 14 too → pre-existing, moved to SG-3.4).
- T-3.3.2 ✅ Decision record `docs/records/DECISIONS.md` DR-001 = **accept
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
  - T-3.4.3 ✅ Post-SG-4.1 follow-up (two live world-state fails, fixed by
  measurement not by guessing): (a) DEX GATE3 now matches the top venue by
  brand when CR lists a chain-scoped deployment llama does not break out
  (`uniswap-robinhood` → brand `uniswap` ∈ llama list; a fabricated venue still
  matches no brand → FAIL); (b) ecosystem native-price bound is now a
  VOLATILITY band — measured gap is a CR price snapshot vs a live quote, so it
  scales with the market (0.467% calm → 1.17% → 1.33% moving, constant within a
  run): band = |ETH 1h move| + 0.75pp, floor 1%, cap 4% (below the measured
  >=5% fabrication class, so detection power holds).

---

## G4 — ✅ Later (P2)

- SG-4.1 ✅ Shaper unit tests from recorded upstream fixtures (R-8) — pure
  shapers extracted verbatim to `lib/shapers.ts` (route keeps fetch/auth/refusals);
  `tests/oracle/record-fixtures.ts` (was `frontend/web/scripts/tools/record-fixtures.ts`) records the helper's raw stdout per live mode
  (26/26, gzipped 7.87 MB -> 1.76 MB, sha256 over the RAW payload in
  `fixtures/MANIFEST.json` = hand-edited fixture fails the tamper check);
  `scripts/tests/shaper-tests.ts` (`npm run test:shapers`, node --test, offline ~0.5s,
  **56/56** shaper-file tests — **79/79** across the whole command once auth (11)
  and rate-limit (12) are included): JSON round-trip identity, no NaN/undefined/Infinity anywhere,
  `count === rows.length`, never-0-for-absent, recorder/route upstream-path
  cross-check, and a fabrication probe per mode (empty upstream -> empty
  envelope OR a loud refusal naming the withheld data — measured: 20 of 26
  modes refuse loudly, 6 tolerate empty; none fabricate). Wired into the
  pre-push hook + CI web job. Gate evidence: zero behavior change —
  tsc 0, `next build` 0, contract OK (28 modes), live harness **244/0**,
  route sweep 133 checks (see T-0.4.3) after restart.
- SG-4.2 ✅ Secret rotation runbook + Vercel/local env parity audit (R-9; Vercel half later retired by DR-002 self-hosting) →
  `docs/operations/SECRETS.md`. Findings fixed in-tree: Alchemy key literal removed from
  `sync-live.py` (now `require_env`, loud stop) **and scrubbed from 14 tracked
  `scripts/archive/*.mjs`** (node --check green; that directory was deleted in the 2026-09-29 structure pass, after this scrub) — the literal predates commit
  `3678b10`, i.e. **it is in git history → R1 rotation is mandatory** (human
  step: Alchemy dashboard, procedure in SECRETS §5); the dead credential fallback (which
  recovered a Turso token from source) that
  sliced quote-bytes out of `lib/db.ts` removed (could only produce garbage
  credentials). Verified: no `.env` ever committed (history scan), CI needs
  zero secrets, sync timer RC 0 after the fix. Parity verdict is honest:
  **unverifiable today** — Vercel CLI unauthenticated (whoami hangs for OAuth)
  and `fudcourt.vercel.app` → `DEPLOYMENT_NOT_FOUND`; §6 checklist turns each
  inventory row into yes/no at the next deploy. Local-only by design:
  `CR_PYTHON` (helper can't exist on serverless → loud 502) and fail-closed
  mutation auth.
- SG-4.3 ✅ Root `README.md` entry point (R-10) — run/verify/house-rules in
  ~45 lines, links `docs/README.md` index (+ DECISIONS/SECRETS/RECOMMENDATIONS).
  Every command it cites was executed this session: contract OK (28 modes),
  `npm run test:shapers` 79/79 (56 shaper/fixture + 11 auth + 12 rate-limit),
  `npx tsc --noEmit` 0, `next build` 0 (CI
  3/3 at `0bfa62d`), harness **244/0/8** LIVE, `monitor.py` HEALTHY,
  `dump-schema.mjs --check` 0.
- SG-4.4 ✅ Standing, not triggered (R-11) — conditional by design: revisit an
  official CryptoRank key only on MEASURED RE breakage. No breakage: harness
  244/0/8 (this session), monitor cron HEALTHY, CI green. Recorded in the root
  README house rules; no key exists, none is wanted.

---

## G5 — 🔄 Family alignment (repurpose pass, 2026-09-28)

Owner direction: *"repurpose this fudcourt apps, and re-architecture biar jelas"* →
align every already-built surface into one clear, gated architecture
(the map: [ARCHITECTURE.md](../architecture/ARCHITECTURE.md)).

- SG-5.1 ✅ `/api/markets` built (was an orphan 404 behind the tracker view), `lib/markets.ts`
  contract, tracker honest labels (pool window, null → `—`, loud errors),
  `verify-markets.py` 49 checks (GATE2 llama / GATE3 cryptorank @ 3%, measured
  0.009–0.287%), `sort=mcap` for the tracker, TrackerPage re-wired off
  browser-direct CoinGecko onto the gated route, news route strict params
  (400 not clamp/NaN/soft-404) + `upstream` labels, monitor covers markets+news
  (8 checks), route sweep 133 checks (see T-0.4.3)
- SG-5.2 ✅ `verify-news.py` deep verifier — **50/50** against the Go sidecar
  (`--base :3101`) and through the `:3100` proxy (2026-09-29). Superseded in
  shape by the family's move into the sidecar (PLAN G12): the verifier now
  asserts the PROXY contract (no `parseInt`/`Math.min`/`<item>`/`stripCdata` in
  the route), the strict `source`/`limit` 400 matrix, `total` vs the served head,
  the cache keyed on the FEED URL (two limits, one upstream read) and an
  anti-fake parity probe against a DIRECT feed fetch. News moved SMOKE -> GATED.
- SG-5.3 ✅ Route sweep `frontend/web/tests/verify_all_routes.py` (was under `frontend/web/scripts/verify/`) re-aligned to the repurpose pass (2026-09-29):
  page list corrected (`/coin`/`/balance` → real-404 absence checks, `/ticker`,`/login`,`/ticker/BTC`/`/ticker/ETH` added, `/ticker/FOO` a real 404), treasury reads
  expect the session-gated 401, the ticker API family added (6 checks incl. strict-param 400 +
  unknown-symbol 404), the retired `x-fud-token` D2 block replaced by signed-admin-session mutation
  probes; measured **122/133** (11 fails = 1 CoinGecko 403 passthrough + 10 session-gated probes
  unrunnable on the secret-less :3107 target — environmental; the production :3100 origin carries the
  secret and answers those paths 401/307). Anchored by T-0.4.3 and ARCHITECTURE §7.
---
## G6 — ✅ Origin hardening (2026-09-29)
Owner direction: *"lets fix rate limit first"*, after a public-surface review
found no inbound limit on the API (DR-004).
- SG-6.1 ✅ `lib/rate-limit-inbound.ts` — per-client, cost-weighted fixed window
  (60 s). Cost is the measured worst-case payload of each route, in 50 KB units:
  `mode=chain` 1,190,228 B → 20 · `converter` 921,588 → 20 · `tag` 110,248 → 3 ·
  `tags`/`gainers`/`losers`/`blockchains` → 2 · `llama mode=chains` 64,245 → 2 ·
  `ticker` 69,445 → 2 · everything else 1. Heavy allowance 80 units (two full
  `/cryptorank` mounts = 32 each), light 120, `AUTHED_MULTIPLIER` 3×,
  `LOCAL_MULTIPLIER` 100× for traffic the origin accepted from its own address
  space (loopback/RFC1918/link-local peer and no `CF-Connecting-IP`). Fails
  open; state bounded by `MAX_CLIENTS` LRU.
- SG-6.2 ✅ `middleware.ts` enforces it on `/api/:path*` **before** the tier
  check and emits `X-RateLimit-{Limit,Remaining,Reset,Cost,Scope}` on passes,
  429 + `Retry-After` on refusals, headers on the 401 too. Tier policy unchanged
  (`lib/guard.ts` still the single table). Pages stay unlimited by decision.
- SG-6.3 ✅ `scripts/tests/rate-limit-tests.ts` (12 offline tests: cost table, real
  mount fits, window rollover, per-client isolation, authed/local exemptions,
  LRU bound, fail-open, key spoof-resistance) wired into `npm run test:shapers`
  → 79 tests total, pre-push + CI.
- SG-6.4 ✅ Deployed + verified: `next build` 0, origin headers present, public
  hostname abuse replay `200 200 200 429 429 429` (was 25× 200), tier gate still
  401/307, public pages 200, `monitor.py` 7/8 (the `markets` FAIL is the
  pre-existing honest `upstream 403 from CoinGecko`).
- Deferred, stated: a distributed budget belongs at Cloudflare's edge; in-memory
  counters are per process (one today). Multi-instance would need a shared store
  (still open — was slated for a G7; G7 went to the DR-005 cutover instead).
- SG-6.5 ✅ **Amendment — the local scope was dead on arrival** (2026-09-29, same
  day, found by the G7 harness run; DR-004 amendment). `clientKey()` classified
  scope from the *presence of a header*, but Next.js 16
  (`base-server.js:612`) does `req.headers['x-forwarded-for'] ??=
  originalRequest?.socket?.remoteAddress`, so every request on this host carries
  `X-Forwarded-For: ::ffff:127.0.0.1` and the `local` branch never executed:
  `LOCAL_MULTIPLIER` was unreachable code and the operator's own harness was
  charged the public budget. Measured: a full `verify-cryptorank.py` run costs
  **137 units across 53 calls** (`chain` ×3 @20, `converter` @20, `tag` ×3 @3,
  `tags` @2, `blockchains` @2, rest 1) against an 80-unit heavy window → 429 from
  call ~25, which is exactly the two `got 429` failures the cutover harness
  reported. Now keyed on the **peer address**: no `CF-Connecting-IP` and a
  loopback/RFC1918/link-local/ULA last hop ⇒ `local`; any public last hop or any
  `CF-Connecting-IP` ⇒ `public` (so a forged `X-Forwarded-For: 127.0.0.1` sent
  through the tunnel still cannot reach the local budget — asserted). Tests
  rewritten to the real keying table + the measured-deployment regression
  (79 offline tests, was 78). One consequence to watch: any route locally
  reachable but unauthenticated can now spend 100× locally, which only matters
  if a non-proxy ingress is ever added — stated in the DR-004 amendment.

---
## G7 — 🔄 CryptoRank runtime cutover: Python helper → Go `fudcourt-data` sidecar (2026-09-29)
Owner direction: one implementation of the CryptoRank contract, the Go one that
holds a real browser TLS fingerprint (→ [DR-005](../records/DECISIONS.md)).
- SG-7.1 ✅ `backend/data` (Go, `module github.com/anvxxr-arch/fudcourt/backend/data`,
  `go 1.24.1`) — `internal/cryptorank` (mode/key/allowlist tables + disabled-mode
  refusal text), `internal/cryptorank` (tls-client `chrome_131` + HTTP/2, disk
  cache TTL, 429 backoff), `internal/cryptorank` (envelope types), `cmd/data`
  (the HTTP surface on `FUDCOURT_DATA_ADDR`, default `127.0.0.1:3101`).
- SG-7.1b ✅ Compatibility caveat (sidecar audit, 2026-09-29): field-for-field,
  **not** byte-for-byte — one trailing newline (`Encoder.Encode` framing) and Go
  struct key order. Consumers all parse JSON, so the surface is unchanged; the
  route header now says so instead of claiming byte-compatibility.
- SG-7.2 ✅ `app/api/cryptorank/route.ts` rewritten as a **thin honest proxy**:
  forwards the query string verbatim to `${FUDCOURT_DATA_URL}/api/cryptorank`
  (default `http://127.0.0.1:3101`), returns the upstream body/status and
  `X-CR-Upstream`/`X-CR-Cache`/`Cache-Control` unchanged, always
  `Content-Type: application/json`; 60 s `AbortSignal` timeout (largest payload
  `mode=chain` ≈ 1.19 MB). Removed from the route: `execFile`, `PYTHON`,
  `HELPER`, `runHelperOnce`/`runHelper` (429 backoff now in Go), the `newstag`
  soft-404 derivation and the funding/unlocks 503 branch (both now Go). Fail
  loud: sidecar unreachable → 502 `fudcourt-data unreachable: <reason>`.
- SG-7.3 ✅ Ops: versioned unit `backend/data/infrastructure/fudcourt-data.service`
  (deployed to `~/.config/systemd/user/`, `Restart=always`, `RestartSec=5`,
  `KillSignal=SIGTERM`, `TimeoutStopSec=15`, cache `~/.cache/fudcourt-data`); pre-push
  hook gained an `backend/data/`/`\.go$` branch running `go build/vet/test`
  (offline, cached go1.24.1); CI gained an `fudcourt-data` job (setup-go 1.24.1,
  cache on `backend/data/go.sum`); root `.gitignore` ignores
  `backend/data/bin/` + `backend/data/.cache/`.
- SG-7.4 ✅ One contract, two implementations, enforced offline:
  `scripts/verify/check-contract.py` (was `frontend/web/scripts/checks/check-contract.py` before
  the Phase-8 move) now parses
  `backend/data/internal/research/cryptorank/modes.go` and asserts it equals
  `frontend/web/src/features/cryptorank/client.ts` — modes, disabled list, exchange/launchpool/nodesale/RWA
  whitelists, keyed + default-key maps — and asserts the route is still a
  proxy (no `execFile`/`cr_fetch`/`CR_PYTHON`/local `CR_MODES.includes`). If the
  Go table is absent it prints an explicit `SKIP:` line rather than passing
  silently.
- SG-7.5 ✅ Proof, all measured on the cut-over build (2026-09-29):
  `go build -o bin/fudcourt-data ./cmd/data` rc=0; sidecar smoke
  `home` 200/2,976 B · `coins` 200/35,878 B · `converter` 200/921,773 B ·
  `funding` **503**/468 B (refusal text intact) · `hack` **400**/331 B (28 modes
  listed); proxy is verbatim (`cmp` identical against the sidecar for
  `mode=coins` cache-hit and `fresh=1`, and for the row shapes the harness
  asserts); key contract through the proxy: `?key=BAD%20KEY` → 400,
  `?key=zzznoexist9999` → 404 passthrough; sidecar stopped →
  `502 {"error":"fudcourt-data unreachable: fetch failed: connect ECONNREFUSED
  127.0.0.1:3101", …}`; offline `go build/vet/test` with `GOPROXY=off`
  = **2.8 s** (hook-safe, no toolchain download).
- SG-7.5b ✅ Live harness, both bases, same session:
  `verify-cryptorank.py --base http://127.0.0.1:3101` → **241 passed / 3 failed /
  8 info**; `verify-cryptorank.py` (default `:3100`) → **235 passed / 5 failed /
  8 info**. The 2-check delta is the DR-004 inbound limiter, not the cutover: the
  harness makes ~55 calls and its own mix (`chain` 20 units × 3 calls +
  `converter` 20) exceeds the 80-unit heavy window in one run, and it is priced
  `scope: public` (no `CF-Connecting-IP`/`X-Forwarded-For` on loopback).
  Reading the same limiters documented at SG-6.1.
- SG-7.6 ⏳ Residual, stated not hidden. Three separate, non-cutover items, each
  with its owner class:
  1. `monitor.py` (R-4) covers the sidecar only **transitively** — its
     `/api/cryptorank` checks fail when `fudcourt-data` is down, but nothing asserts
     the `:3101` unit is active nor alarms on `cf-mitigated: challenge` (the
     profile-rotation tell from DR-005). Same class as R-4's open half.
  2. `verify-cryptorank.py` cannot complete a full run through the :3100
     middleware under the DR-004 budget it helped calibrate (see SG-7.5b).
     Either the harness needs a declared local scope/header, or the budget needs
     a harness allowance in `lib/rate-limit-inbound.ts` — a DR-004 decision and
     outside this cutover's file scope.
     **✅ CLOSED 2026-10-05 — already fixed by the SG-6.5 amendment; no new
     mechanism.** Re-measured on the live origin (`t_7327e6d9`, DR-004 amendment
     2): `:3100` returns `X-RateLimit-Scope: local` (limit 8000 heavy / 12000
     light), a full `verify-cryptorank.py --base :3100` run has **0 `429`
     checks** and its fail set differs from the `:3101` run by **3 `launchpool`
     `got 0` connection blips** (a sibling restarting `fudcourt-web` mid-run),
     the 30 shared fails being the retired-`/cryptorank` shell block
     (`t_dc1fa218`); the AST call table confirms **55 `get()` sites = 137 units
     ≪ 8000**, and the forged-`CF-Connecting-IP` public replay still caps at
     **80** (`200 200 200 200 429 429`). Neither Option A (declared header) nor
     Option B (harness allowance) is adopted — the `local` scope class the card
     proposed to add already exists and fires for this caller.
  3. Two harness checks are stale against upstream/session drift, both proven
     path-independent (the TS `envelope()` over the same payload fails
     identically): `news: titles + publisher URLs intact` (upstream spacer row
     with `url: null`) and `aioverview: digest dominance coherent with home`
     (upstream rotated the `dominance … <n>` phrase). Both are harness
     predicate bugs, and per this repo's rules the fix is the measurement, never
     a widened tolerance.

---
## G8 — ✅ COMPLETE: `khala` family — Khala Research report adapter (2026-09-29)
Owner direction: add the research-report family — Khala Research (khala.io), keyless.
Upstream is **Framer** static SSR (no Next/RSC, no Cloudflare); the design is frozen in
`/home/dwizzy/khala-probe/DESIGN.md` from the read-only probe
`/home/dwizzy/khala-probe/RESULTS.md` (2026-09-29) and recorded in
[DR-006](../records/DECISIONS.md). **As-built state, measured 2026-09-29 ~13:00 UTC** (tree read + `curl` + live harness):
the family is **served**. `cmd/data/main.go` wires `handleKhala` on
`/api/khala` (SG-8.3), `/healthz` reports `{"build":"28 modes","khala":"3 modes"}`,
the `bun run build` at :3100 carries `/khala` + `/api/khala`, and
`verify-khala.py --base http://127.0.0.1:3101` is green at **136/0/0**. The block
above describing an unwired sidecar is the *pre-cutover* record, kept for the
sequence; the ✅/~~strikethrough~~ marks below carry the current state.
- SG-8.1 ✅ **Reconnaissance + design** — `RESULTS.md` (every status/byte measured
  2026-09-29, read-only, scratch outside the repo) and `DESIGN.md` (decisions D1–D12
  each carrying its evidence). Frozen contract **v4** in DESIGN.md §3, re-checked
  against the landed Go types.
- SG-8.2 ✅ **Go package** — `backend/data/internal/khala/{modes,fetch,parse,shape}.go`
  (+ `parse_test.go`, `re_debug_test.go`): one package, plain `net/http` (measured: a
  non-browser UA gets 200 on the homepage 259,008 B, a report page 468,140 B and the
  `framerusercontent.com` index; no challenge), `golang.org/x/net/html` (already in
  `go.sum` at `v0.48.0` — **no new dependency**), `KeyRe = ^[a-z0-9][a-z0-9-]{0,127}$`,
  `MinBodyChars = 4000` drift floor, `defaultTTL = 900`, `maxBodyBytes = 8 MiB`, cache
  root `~/.cache/fudcourt-data` with a `khala/` subdir, and 6 recorded fixtures in
  `testdata/`. **Landed.**
- SG-8.3 ✅ **Sidecar wiring** — landed 2026-09-29 (`main.go`: `handleKhala` +
  `mux.HandleFunc("/api/khala", …)` beside `/api/cryptorank`, `writeKhalaError`,
  `/healthz` reporting `"khala": "3 modes"` as its **own key** so the `build` string
  other gates assert stays `"28 modes"`; the `server` struct carries a `khala.Service`).
  The three reds that had been filed against this family's own tests were **test
  construction bugs, not code defects**, each re-measured against the recorded fixture
  and fixed in the test (never by widening a tolerance): `shape_test.go` injected a
  replacement href that was itself a legal slug (so nothing was removed), cut the report
  fixture at the first heading's `id=` attribute (leaving an empty `<h2></h2>` that
  tripped the "no blocks" guard before the floor), and located the byline by the
  `--font-selector:` prefix shared with the hero title. Two further **real code defects**
  were found and fixed while running the live harness:
  (a) `fullTitle` collapsed whitespace, so `metaTitle` read `… EQUITY - Khala Research`
  where the page itself publishes `… EQUITY  - Khala Research` (double space) — fixed to
  return the raw `<title>` text;
  (b) `fetch` still sent `If-None-Match` on `?fresh=1` (`ttl 0`), so a 304 turned the
  live refetch into a cache `HIT` — the exact opposite of the request and unlike
  cryptorank's `fresh=1 → MISS`. Now the conditional GET is only used when `ttl > 0`.
  Deployed and verified: `go test ./...` green; `/healthz` `{"build":"28 modes","khala":"3 modes"}`;
  `:3100/api/khala` reports 200 (8 rows/8 upstreamTotal), `mode=bad` 400, `mode=report`
  without key 400, `mode=reports&key=x` 400, `mode=latest&limit=99` 400, headers
  `X-KH-Upstream`/`X-KH-Cache`/`Cache-Control`.
- SG-8.7 ✅ **`verify-khala.py` live-green (GATED)** — after the two code fixes above and
  a set of **stale harness checks** corrected to the frozen v4 envelope (the harness still
  asserted a pre-v4 `mode`/`order` pair and `latest.kind == 'reports'`; those are now
  pinned as **absent** with `kind` + `position` + `slice` carrying the same facts, and two
  new assertions name newest-first/`latest` explicitly), the harness runs
  **136 passed / 0 failed / 0 skipped, 2 info in 6.7 s** against the served sidecar
  (`--base http://127.0.0.1:3101`). That is a different claim from the previous recorded
  artifact (133/1 against a scratch `:4101` adapter); this one is the sidecar in
  production use, and DR-006 D12's GATED bar is now met.
- SG-8.8 ✅ **Monitor + route sweep + contract guard** — all three already carried khala:
  `monitor.py` check 8 `/api/khala?mode=reports`, the sweep's **group F** (17 checks:
  3 modes + strict-param 400s + real-404 decoy), and `check-contract.py`'s
  `KH_MODES` ↔ `internal/khala/modes.go` parity + proxy-shape assert. Measured
  this session: sweep **139/150** with khala **17/17** and cryptorank **58/58** — the 11
  fails are 1 known CoinGecko 403 passthrough + 10 session-gated probes unrunnable
  without `FUDCOURT_SESSION_SECRET`.
- SG-8.4 ✅ **Thin verbatim proxy** — `frontend/web/app/api/khala/route.ts`, cloned from
  `app/api/cryptorank/route.ts`: forwards the query string untouched, `FUDCOURT_DATA_URL`
  base, `no-store`, 60 s timeout, `X-KH-*` pass-through, `fudcourt-data unreachable: <reason>`
  502. **Validates nothing** — the sidecar owns every param. **Landed.**
- SG-8.5 ✅ **Typing/display mirror** — `frontend/web/lib/khala.ts` (`KH_MODES`, `KH_KEY_RE`,
  `KH_LIMIT_MIN/MAX`, `KH_DEFAULT_LIMIT`, `KhRow`/`KhReport`/`KhEnvelope`/`KhError`,
  `khalaUrl()`). It is a mirror **for typing only** and re-validates nothing (DR-006 D8
  as-built note); `check-contract.py` deliberately carries no khala table pair.
  **Landed.**
- SG-8.6 ✅ **Board** — `KhalaPage.tsx` (`khalaUrl` → `/api/khala`, `—` for nulls),
  `app/khala/page.tsx`, `lib/view-routes.ts` (`khala: '/khala'`), `store-shell.tsx`
  (`BOARD_TABS` 11th entry + render), `lib/public-routes.ts` (`/khala`), and
  `ROUTE_COST.khala = 2`. **Landed and deployed** — the `bun run build` below now
  carries `/khala` + `/api/khala`, and `/khala` serves 200 on the production
  :3100 origin and on the public hostname.
- SG-8.9 ✅ **Cost + docs close-out** — `ROUTE_COST.khala` (2 units) and the re-derived
  counts in `docs/architecture/ARCHITECTURE.md` (16 views / 18 registry rows / 10 families / 21
  handlers / 42 `<loc>`), `docs/architecture/SCHEMA.md` §3.1b–§3.3, `docs/README.md` and the root
  `README.md`. Counts were recounted from the code, not incremented.
- SG-8.10 ⏳ **Residual, stated not hidden.** (1) `reports` rows carry **no date keys at
  all** — the homepage publishes none, and a `null` would falsely claim a lookup; a
  consumer wanting dates uses `latest` (D4). (2) The report-date anchor is a **text regex
  over the byline region**, not the style attribute, but a restyle can still change the
  region; mitigated by the loud drift arm, never by a guess (D5). (3) `data-framer-name`
  holds stale placeholder copy and must never be read as card text (F1). (4) The report
  count is content-mutable (currently 8) — nothing may hard-code it; assert
  `upstreamTotal` set-equality against the sitemap (F5). (5) The searchIndex hash rotates
  on republish — never hard-code it (F2). (6) `body` flattens inline markup, so link
  targets are not carried — accepted, because it is what keeps HTML out of the API (D7).
  (7) ~~The sidecar's `main.go` must be wired and both services restarted before any of the
  above is observable at `:3100` (SG-8.3)~~ **DONE 2026-09-29** (SG-8.3, above).
  (8) **New, stated:** `latest` resolves a date per row by fetching each report page, so a
  cold `latest` is up to N report fetches behind the homepage+sitemap pair; the cache and
  the ETag revalidation make the repeat case cheap, and the harness measures both.
---
## G10 — ✅ `frontend/web` runtime: Node → Bun (2026-09-29)
Owner direction: *"frontend next js bun runtime"* — one runtime for the web app.
Record: [DR-008](../records/DECISIONS.md) (options + the measured parity evidence). Numbered
`G10` because the sibling `## G9` below ("Bun toolchain + Go weighting + Rust
service") already owned that number: that goal is the *toolchain* half (Bun installs
and builds, Node serves), this one is the *runtime* half, and DR-008 supersedes
DR-007's runtime clause only.
- SG-10.1 ✅ **Proof before cutover** (scratch tree `/tmp/websrc`, a copy — production
  was never built in place first). `bun --bun next build` RC=0 (Turbopack 16.9 s);
  `bun --bun node_modules/.bin/next start` served **every** route: 15 pages 200
  (incl. `/khala`, `/sitemap.xml`, `/robots.txt`, `/ticker/BTC`), `/team/balance`
  307, `/ticker/FOO` 404; APIs 200 (`khala`/`cryptorank`/`llama`/`news`/`dex`/`signals`,
  `markets` 403 passthrough as documented); `/api/all` 401 JSON; `X-RateLimit-*`
  emitted; ccxt ticker 200 with a **71.2 s** cold sweep (Node parity, under the 90 s
  ceiling). Runtime identity proven by `/proc/<pid>/exe` → `~/.bun/bin/bun`.
- SG-10.2 ✅ **Runtime risk checks**: the DB client returns rows under Bun;
  the signed-session payload+signature is **byte-identical** to Node's, so the switch
  cannot invalidate live cookies.
- SG-10.3 ✅ **Cutover**: `frontend/web/package.json` `start` → `bun --bun next start`;
  `fudcourt-web.service` `ExecStart` → `bun --bun …/next/dist/bin/next start -p 3100`
  (absolute); unit now **versioned in-repo** at `frontend/web/infrastructure/fudcourt-web.service`
  (was install-only, like the fudcourt-data unit before SG-7.3). Deployed + restarted.
- SG-10.4 ✅ **Post-cutover parity on the live origin**: `BUILD_ID` unchanged
  (`OMhgA85taz_1n1flx_aT2` — the Node-built `.next` is served as-is), 17/17 page
  statuses unchanged, sitemap `<loc>` 42, `/api/khala?mode=reports` **byte-identical**,
  `cryptorank`/`news` identical in key set and values except the two fields defined to
  vary (`cache` MISS→HIT, `timestamp`), treasury + admin APIs 401, rate-limit headers
  present, `verify-khala.py` green against the served endpoint.
- SG-10.5 ✅ **Honest accounting** (DR-008): boot 0.58 s vs 0.70 s, RSS 114 MB vs 112 MB,
  latency within ±4 % on four routes — **no throughput claim**. The win is one runtime
  in the web stack; the cost is a one-line unit revert (`node_modules/.bin/next`), no
  rebuild, since Node stays installed.
- SG-10.6 ⏳ **Residual, stated not hidden.** (1) ~~`apps/blog` (Payload) is still Node~~ — **resolved** by DR-015 (Bun) and then DR-017 (merged into frontend/web); the item is kept as history. (1a) `apps/blog` (Payload) is still Node —
  its `payload` CLI and `ignoreBuildErrors` build were not in scope, and DR-007 already
  settled blog at install/build level. (2) CI keeps `bun run build` on the Node-executed
  path: CI's gate is the source build, and the runtime decision is a *serving* decision;
  changing CI is a separate call. (3) The `next dev` path is untouched (`dev` script still
  `next dev` under whatever runs it) — dev-server behaviour under `--bun` was not measured,
  so it is not claimed.

---
## G11 — ✅ Repository structure pass: dead weight out, scripts grouped, unit paths guarded (2026-09-29)
Owner direction: *"restructure folders to make it efficient, professional, rapi, maintainable,
scalable"*. Everything below was executed and re-verified; nothing is a proposal.
- SG-11.1 ✅ **Dead weight removed.** (a) `frontend/web/scripts/archive/` — **33 tracked
  throwaway `.mjs`** forensic one-offs (the Alchemy literal they carried was already
  mined and rotated per SECRETS §5). (b) The stale root `package.json` +
  `package-lock.json`: `npm run dev --workspace=…` could only fail ("No workspaces
  found") and the lock still listed `apps/balance` + `apps/gateway`, neither on disk.
  The root is now `.env .github .gitignore .vercel README.md apps docs scripts`.
  (c) `frontend/web/app/api/blog/` — an **empty** route directory. (d) my own spike
  worktree `fudcourt-bun` + branch `spike/bun-runtime` (landed as DR-008).
- SG-11.2 ✅ **Scripts grouped by function** (was a flat 24-file directory that mixed
  gates, harnesses, a subprocess oracle and codegen):
  `checks/` (check-contract, **check-deploy**) · `tests/` (shaper/auth/rate-limit,
  verify-limiter) · `verify/` (7 family harnesses + sweep + monitor + dom_audit) ·
  `oracle/` (cr_fetch.py — used only *by* verify-cryptorank.py) · `tools/` (recorder,
  dump-envelopes, dump-schema, sync-live) · `fixtures/` (unchanged: its `.gz` set +
  MANIFEST are referenced by docs, the Go parity test and the recorder). Path
  resolution fixed in every moved file (Python `parents[2]`, TS `../../lib/`, the
  oracle path, the component path in verify-dex) and every reference rewritten —
  package.json scripts, pre-push, CI, the Hermes cron wrapper, MANIFEST, docstrings.
- SG-11.3 ✅ **New offline guard `scripts/verify/check-deploy.py`** (was `frontend/web/scripts/checks/check-deploy.py`; moved repo-wide by Phase 8) — asserts every
  unit's `ExecStart`/`Documentation` repo path exists, that `ExecStart` is absolute,
  that sync service+timer pairs are both present, and that no two units claim one
  systemd name. Wired into the pre-push hook and CI. **It earns its place:** the
  reorg moved `sync-live.py` and the 5-min timer kept firing at the old path
  (`ExecMainStatus=2`) — the guard reproduces that failure verbatim in its negative
  test.
- SG-11.4 ✅ **Every production entry point is now versioned in-repo** —
  `frontend/web/infrastructure/{fudcourt-web.service, fudcourt-sync.service, fudcourt-sync.timer}`,
  `apps/blog/infrastructure/fudcourt-blog.service` (new at the time; **retired in DR-017**), alongside the existing
  `backend/data/infrastructure/fudcourt-data.service`. Each was diffed against the
  installed unit (identical, comments aside). The two `fudcourt-sync.service`
  variants (Python oracle vs the sibling's Rust replacement) are cross-referenced in
  their headers, because systemd resolves by name and only one can be installed.
- SG-11.5 ✅ **Verified after the pass** (each command run by me): `check-deploy` OK
  (7 units) and its negative test FAILs correctly; `check-contract` CONTRACT_OK;
  `tsc --noEmit` 0; `test:shapers` 80/80; `verify-limiter.mts` 9/9; all moved `.py`
  parse; `verify-khala.py` **136/0/0**; `verify-llama.py` 51/51; `verify-signals.py`
  39/39; `verify-chainrank.py` 50/50; `verify-cryptorank.py` runs with its oracle
  path intact; `dump-schema --check` SCHEMA_OK; `dump:envelopes` regenerates 26
  envelopes; the Go parity test still finds `scripts/fixtures`; `sync-live.py` ran
  live (NET WORTH restored) and the **sync unit now reports `Result=success`** after
  the repoint.
- SG-11.6 ⏳ **Residual, stated not hidden.** (1) `frontend/web/vercel.json` does not exist
  and `.vercel/` is git-ignored yet holds live ids, so it was **left alone** — deleting
  host metadata is an operator action, not a refactor. (2) `verify-markets.py` 19/45:
  **every** failure is the upstream CoinGecko 403 (I re-proved it with a direct
  `curl`, which also 403s) — no structural cause. (3) Some harnesses hard-code
  *frontend source* paths (`src/components/X.tsx`, `app/store/store-shell.tsx`) and the
  sibling session is concurrently moving those files to `src/components/` + `src/styles/`;
  that coupling is theirs to repoint (see the handover in the final summary). (4) The
  repo still has no `git` commit of any of this — the tree is the owner's WIP.
---
## Sequencing rationale
1. **G1 first** (docs) — zero-risk, unblocks every later task with shared vocabulary.
2. **G2 before features** — schema loss and unverified pushes are the only
   *irreversible* risks in the system (ANALYSIS K-1/K-2).
3. **G3 next** — monitoring converts silent upstream drift into alerts;
   blog seeds prove the second product surface.
4. **G4 opportunistic** — quality-of-life items scheduled around G2/G3.
---
## G9 — Bun toolchain + Go weighting + Rust service (2026-09-29)
Owner direction: *"Backend golang, rust, typescripts (bun). frontends next js typescripts
(bun). backend framework weighted on go/rust. frontend on typescripts."* This goal is the
program that direction names; the subgoals below are what this session measured.
- SG-9.1 ✅ **Frontend/TypeScript toolchain = Bun 1.4.2** — both apps install with
  `bun install --frozen-lockfile`, run scripts with `bun run`/`bunx`, and own `bun.lock`;
  the two `package-lock.json` files are retired and CI moves to `oven-sh/setup-bun@v2`
  (Node 22 stays the server *runtime* — **later superseded**: `frontend/web` moved first,
  DR-008, and `apps/blog`'s carve-out was measured away by DR-015, so no fudcourt unit
  runs on Node now). Evidence: sandbox `bun run build` RC=0 for web
  (70 MB) and blog (398 MB) before touching production; frozen installs RC=0 with the
  blog's `overrides.drizzle-orm=0.45.2` honored; `bun run test:shapers` **80/80**;
  live cutover → `fudcourt-web` restarted onto a bun-built tree, 13/13 pages 200,
  `/khala` 200, treasury APIs 401, `/team/balance` 307, public hostname `/khala` +
  `/api/khala` 200. Full record: [DR-007](../records/DECISIONS.md).
- SG-9.2 ✅ **Go weighting: `khala` family served end-to-end (PLAN G8 ✅)** — sidecar
  wiring (SG-8.3), monitor + sweep + contract guard (SG-8.8), the 3 fixture-surgery test
  bugs fixed, and two real code defects found by the live harness and fixed in Go
  (`fullTitle` whitespace collapse → `metaTitle`; `fresh=1` sending `If-None-Match` →
  cache `HIT`). `go test ./...` green; `verify-khala.py` **136/0/0** against the served
  sidecar; route sweep **144/155** at the time (now **154/165** after the news + chainrank families added their checks) with khala
  17/17, cryptorank 58/58 and the whole API group 37/37 minus the one CoinGecko 403.
- SG-9.3 ✅ **Go weighting: `llama` family moved into the sidecar** — new
  `backend/data/internal/llama/` package (modes/fetch/shape + tests) with an in-memory
  TTL cache + single-flight, wired as `/api/llama` on the mux with its own `/healthz`
  key, and `frontend/web/app/api/llama/route.ts` reduced to a verbatim proxy
  (`app/api/khala/route.ts` as the template). Acceptance is the existing live harness:
  Measured: `go build/vet/test` green (20 new package tests + 6 handler tests),
  `verify-llama.py` **51/51 against Go** (`--base :3101`) and **51/51 through the
  production :3100 proxy**, `/llama` + `/api/llama` 200 on the origin and the public
  hostname, `check-contract.py` OK with a new **llama LLAMA_MODES parity** row, the
  sweep gained 5 strict-param checks, and `bun run build` + `bunx tsc --noEmit` stay 0.
- SG-9.4 ✅ **Rust service: the live balance sync** — `backend/sync/` reproduces
  `tests/oracle/sync-live.py` (Postgres `assets` + share %, Alchemy EVM RPC, Solana RPC,
  Hyperliquid, the same "a failed RPC never becomes 0" rule), verified by running both
  binaries back to back and diffing the rows: **17 rows, zero symmetric difference, zero
  quantity mismatches and zero USD mismatches**, `NET WORTH: $170.46` on both (measured).
  Two real defects were caught by that diff and fixed: `hexint` returned `f64` (double
  rounding; now `u128` scaled by `scale_dec`), and `round2/4/10` used multiply-and-round,
  which is wrong exactly when the product lands on a tie — `round(12.345, 2)` must be
  **12.35** (CPython) but the old form gave 12.34. Rounding now goes through Rust's
  correctly-rounded fixed-precision formatting, and the 5 crate tests assert measured
  CPython values. Ops: versioned `backend/sync/infrastructure/fudcourt-sync.{service,timer}`,
  a CI `sync` job and a pre-push `cargo build/test` branch, `backend/sync/target/`
  gitignored. The Python script stays installed as the oracle and the rollback.
- SG-9.5 ✅ **Live incident fixes found on the way** (both measured, both verified):
  `fudcourt-sync.service` had been failing every 5 min since ~09:40 because CoinGecko
  began refusing this host wholesale — the price oracle now reads `coins.llama.fi`
  (`NET WORTH: $170.51` restored, service `Finished` clean, ANALYSIS K-12). Separately,
  the `:3100` build on disk predated the khala route, so the cutover rebuild was required
  to serve `/khala` at all; the rebuild is what surfaced the two Go defects.
- SG-9.6 ⏳ **Residual, stated not hidden.** (1) **K-11 — the operator must create
  `FUDCOURT_SESSION_SECRET`**: it is absent from `frontend/web/.env.local`, so
  `/api/auth/login` → 500 and every tier gate fails closed; the 10 session-gated sweep
  probes cannot run until then. (2) `/api/markets` (CoinGecko) is 403 from this host at
  the upstream's discretion — the route fails loud, it does not fake a board. (3) Every
  change above is **uncommitted**: the tree was already the owner's work-in-progress when
  this goal started, so this session edited in place and left committing to the operator;
  `git status` is the list, `git log` shows none of it.
- SG-9.7 ✅ **Rust weighting: `/api/reconcile` served by a Rust HTTP service (DR-014)** —
  `backend/sync` now builds two binaries: the balance sync (`fudcourt-sync`) and
  `fudcourt-reconciled` (`127.0.0.1:3102`), a **zero-new-dependency** `tokio` TCP/HTTP
  server (bounded framing lives in `src/server.rs`; `tokio` gained `net`+`io-util`,
  `serde_json` gained the `preserve_order` *feature* — no new package).
  `frontend/web/app/api/reconcile/route.ts` is now a thin honest proxy (502 + the real
  reason when the service is down — there is NO silent fallback to TS), and
  `lib/reconcile.ts` keeps the original maths as the independent oracle. Evidence:
  `cargo test --release` **17/17** (12 new); `verify-reconcile.py` **28/28** at `:3102`;
  live parity TS↔Rust **byte-identical on every section incl. JSON key order**
  (`scripts/verify/parity-reconcile.ts` — was `scripts/tools/` before the Phase-8 move; 18 rows / 3 wallets / 10 summaries);
  `:3100` proxy statically proven on a throwaway `:3199` instance (401 for an
  insufficient tier, 200 `{source:"rust"}` for a team session, payload identical,
  `x-reconcile-upstream` naming the service) with production left fail-closed 401
  (K-11 unchanged); enabled at boot under systemd (`fudcourt-reconciled.service`,
  6.5 MB RSS); `check-deploy.py` OK (8 units); `next build` RC=0; TS typecheck 0;
  shaper tests 80/80; `lib/reconcile.ts` guarded by a new `check-contract.py` row
  (asserts the route does NOT import the shaper and keeps its 502 path) — negative-tested:
  injecting a fallback to the TS shaper through the route makes the gate fail. The
  monitor gained the unit + a direct `:3102/healthz` check (a dead Rust service was
  otherwise a silent 502), negative-tested by stopping the unit. Full record:
  [DR-014](../records/DECISIONS.md).
- SG-9.8 ✅ **Frontend runtime: the blog's Node carve-out closed (DR-015)** — the audit
  for this goal found `fudcourt-blog.service` still on `/usr/bin/npm run start` with the
  reason recorded as an *assumption* ("Payload's CLI/build path is Node-shaped") that had
  never been tested. Measured on the existing production build under Bun: Ready in
  120 ms, `/` **200 (10,934 b)**, `/admin` **200 (44,676 b)**, `/api/posts` **200**
  returning the real Payload docs from Neon. Switched the versioned unit + the `start`
  script to `bun --bun next start -p 3001`, deployed, and confirmed through the unit
  (`ExecStart` = Bun, active, all three paths 200). The service had been **inactive since
  2026-09-28 18:31** (killed, never restarted), so the switch also brought the blog back
  up. Full record: [DR-015](../records/DECISIONS.md).
- SG-9.9 ✅ **Two harness defects found and fixed by this goal's audit** — (1)
  `verify-dex.py` crashed with `FileNotFoundError` on `app/components/DexPage.tsx`, a path
  the DR-011 restructure had moved to `src/components/`; repaired, and it now runs
  **78/78** (it had been un-runnable, so the dex family's UI-path coverage was silently
  dead). (2) `verify-markets.py`'s 19 failures were traced to a single root cause —
  CoinGecko **429 from this host**, the documented K-8 residual the route correctly fails
  loud on — not a regression; recorded rather than papered over.
- SG-9.10 ✅ **Backend framework clause resolved and recorded (DR-016)** — the one clause of
  the owner's direction that had no recorded resolution. Measured: the Go sidecar uses
  **no web framework** (`http.NewServeMux` + hand-registered handlers in
  `cmd/data/main.go`), five of its six packages use plain `net/http`, and the single
  HTTP client library (`tls-client`) is confined to `internal/cryptorank`, where the
  Cloudflare ClientHello-fingerprint requirement actually lives; the Rust service is
  `tokio::net` + hand-rolled framing, zero new crates (DR-014). Decision: stdlib routing
  stands, on the rule "a dependency must be paid for by a requirement". Full record:
  [DR-016](../records/DECISIONS.md).
- SG-9.11 ✅ **Backend weighting measured, not asserted** — Go 7,996 runtime LOC (+5,990
  tests) and Rust 1,649 (+252) against 7,000 TS backend LOC = **58% of backend runtime
  LOC in Go/Rust**, with TS owning the UI/API surface the direction assigns it. `go build
  ./...`, `go vet ./...` and `go test ./...` green across all seven packages.
- SG-9.12 ✅ **Frontend consolidation: `fudcourt-web` + `fudcourt-blog` merged into ONE
  Next app ([DR-017](../records/DECISIONS.md), 2026-09-30)** — the dashboard and the Payload blog
  are now one process on `:3100`; `apps/blog`, `fudcourt-blog.service` and `:3001` are
  retired. Three consequences were framework-forced, not chosen: Next allows one root
  layout per app (so the dashboard and Payload each moved into their own top-level route
  group), Payload's `/admin` + `/api/*` collide with the dashboard's (so Payload moved to
  `/blog/cms/admin` + `/blog/cms/api/*`), and `@payloadcms/ui` requires React 19 (the
  repo was on 18.3.1 — verified safe first: zero React-18-only APIs remain, and the
  typecheck passes). Evidence: **route sweep 164/165** (the one failure is the
  documented CoinGecko 403) with the auth-gated checks now RUNNING rather than skipped;
  blog HTML + Payload REST diffed byte-identical against the still-running old app;
  llama/news/chainrank/signals/khala/reconcile harnesses all green; `tsc` 0, `build` 0,
  `test:shapers` 80/80, `CONTRACT_OK`, `check-deploy` OK. Two defects found by the
  harnesses and fixed: `robots.ts` inside a route group registered no route (404), and
  9 stale harness paths.
- SG-9.13 ✅ **Folder architecture optimized and made self-policing ([DR-018](../records/DECISIONS.md), 2026-09-30)** —
  one `src/` tree (the three parallel `app/`/`lib/`/`src/` trees are gone), vertical
  slices (`src/features/<family>/` holds that family's client + shaper + panel) with
  `src/platform/` for cross-cutting infrastructure, `src/ui/` + `src/styles/` as leaves,
  and `src/app/` holding **routes only**. The rule is enforced by a new gate,
  `frontend/web/scripts/checks/check-structure.py` (still app-local), which fails on the six drifts that actually
  happened (a retired location returning, `../` chains escaping a layer, `platform/`
  importing a feature, a leaf importing app code, cross-feature coupling, an empty
  slice) — negative-tested for each. Evidence: route sweep **165/165 PASS, 0 FAIL** on
  the restructured app; `STRUCTURE_OK` (104 files); `CONTRACT_OK`; `tsc` 0; `build` 0;
  offline suite **80/80** (now a single `tsconfig.shaper-tests.json` project + an `@/`
  resolver shim, replacing four `tsc` flag-soup invocations that could not express
  `paths`). Dead artifacts removed: `.vercel/` (retired by DR-002, still held live ids)
  and a stray nested `frontend/web/frontend/web/public/media` tree. `docs/` reorganized the same
  way — by the reader's question: `product/`, `architecture/`, `operations/`, `records/`
  — with all markdown links rewritten and validated (**0 broken**).

- SG-9.14 [OK] **Performance: local Postgres+TimescaleDB and a shared Valkey L2 ([DR-019](../records/DECISIONS.md), 2026-09-30) — the projection half is superseded by DR-040** -
  measured both bottlenecks, then moved the data closer without changing a number. DR-040
  later made that local Postgres the *only* store, so the mirror and its parity gate are gone.
  - T-9.14.1 [OK] Baseline measured: remote round trip 394 ms / 94 ms per SELECT;
    ticker sweep 71-80 s cold, 0.048 s warm.
  - T-9.14.2 [OK] `db/pg-schema.sql` mirrored `db/schema.sql` 1:1 on the existing
    PostgreSQL 17 cluster + TimescaleDB 2.30.1; `asset_history` and
    `price_history` hypertables.
  - T-9.14.3 [OK] `platform/db/mirror.ts` (now `platform/db/pg.ts`, DR-040) projected the
    store -> Postgres idempotently, pruned replaced batches, translated `?`/`rowid`.
    Caught by parity: upserting alone doubled net worth after a `DELETE FROM assets` sync.
  - T-9.14.4 [OK] `scripts/verify/parity-pg.ts` (was `scripts/tools/parity-pg.ts`) gated the
    read model -> **PARITY_OK 8/8**. (Both the projection and this gate were deleted by DR-040.)
  - T-9.14.5 [OK] `internal/cache` (valkey-go) L2 in llama/chainrank/news;
    `platform/cache/valkey.ts` (Bun native) for the ticker sweep. Both fail open.
  - T-9.14.6 [OK] Ticker staged serve-stale-while-revalidate (fresh 60 s, stale
    1 h, L2 1 h): first call after a restart **73.78 s -> 0.12 s**.
  - T-9.14.7 [OK] Result: **94 ms -> 0.2 ms** per treasury query, dashboard 5.1 ms
    warm; `fudcourt-pgload.timer` every 60 s + `ExecStartPost` on the sync unit.
---
## G11 - STRUCTURE: directory naming to best practice (PLAN DR-011)
> *"buat penamaan folders menjadi best practices"* — one job per directory, no
> cryptic prefixes, every rename covered by a gate.
### SG-11.1 [OK] Go: one package per family
- T-11.1.1 [OK] `internal/{crfetch,crmodes,crshape}` → `internal/cryptorank`
  (collision check first: 0 collisions over 211 names)
- T-11.1.2 [OK] qualification split: in-package refs unqualified, the two
  external test files gained one import; `check-contract.py` re-pointed at
  `internal/cryptorank/modes.go` (parity assertion still active)
### SG-11.2 [OK] frontend/web: routes vs components vs state
- T-11.2.1 [OK] `app/components/` → `src/components/` (18 files)
- T-11.2.2 [OK] `lib/ui/shared.ts` → `src/styles/shared.ts`
- T-11.2.3 [OK] `app/home-shell.tsx` → `app/store/store-shell.tsx` (+ `StoreShell`
  symbol; 18 route wrappers updated)
- T-11.2.4 [OK] `app/admin/member-table.tsx` → `members-table.tsx`
### SG-11.3 [OK] Rust + blog + fudcourt-data script
- T-11.3.1 [OK] `backend/sync-rs` → `backend/sync`, crate/binary `sync-rs` →
  `fudcourt-sync`; CI job, pre-push branch, docs and both versioned units updated
- T-11.3.2 [OK] `apps/blog/scripts/seed.ts` → `src/seed.ts` (import fixed) — later relocated to `frontend/web/src/cms/seed.ts` by DR-017
- T-11.3.3 [OK] `backend/data/scripts/smoke.sh` → `smoke-data.sh`
### SG-11.4 [OK] Gates + live verification (the equivalence proof)
- T-11.4.1 [OK] `go build/vet/test` green (cryptorank parity oracle included),
  `cargo build/test` 5/5, `tsc` 0, `test:shapers` 80/80, `build` 0,
  `check-contract.py` OK, `dump-schema.mjs --check` SCHEMA_OK
- T-11.4.2 [OK] **13-route SSR diff, pre-change tree vs post-change tree:
  12/13 byte-identical, the 1 diff is the intended footer path fix** (chunk
  hashes/build-id/module-ids normalised)
- T-11.4.3 [OK] live harnesses on the rebuilt services: khala 51 pass, llama
  51/51 (`:3101` and `:3100`), cryptorank harness re-run with needles fixed:
  **239 pass / 2 fail / 11 info**, the 2 fails being upstream data conditions
  (null news url; upstream digest dominance 56.75 vs home 56.15), not rename drift
- T-11.4.4 [OK] DR-011 records the two failed intermediate attempts (an `rm` on a
  rename target and an over-broad regex that hit `cryptorank.io` in literals) and
  why the fixture parity oracle is the gate that catches such damage
- T-11.4.5 [OK] stale-reference sweep: 11 code comments + a live-test invocation
  + the Python unit's Rust-swap comment updated; `~/.cache/crfetch` deliberately kept
- T-11.4.6 [OK] `check-deploy.py` green on all 7 unit files (ExecStart paths exist)
---
## G12 - BACKEND: the `news` family moves into the Go sidecar (DR-012)
> Owner direction, continued: *"backend framework weighted on go/rust"*. Fourth
> acquisition family in `backend/data`; first one whose upstream is a DOCUMENT.
### SG-12.1 [OK] The Go package `internal/news`
- T-12.1.1 [OK] `modes.go` — the feed table (`Sources`), `labelOf`, the strict
  `source`/`limit` validators (`LimitMin/Max = 1/100`, `LimitDefault = 30`) with
  the TS route's exact 400 phrases and the empty-value case as a 400
- T-12.1.2 [OK] `fetch.go` — plain net/http fetcher, 15 s in-process TTL cache +
  single-flight KEYED ON THE FEED URL, 20 s timeout, 4 MiB body cap, gzip
  handling, the real-status/no-fake-200 rule, and a loud refusal on an empty feed
- T-12.1.3 [OK] `parse.go` — the RSS parse the TS route used to do: `<item>`
  split, a bounded per-tag regex set (CDATA and bare arms), HTML-stripped
  descriptions clipped to 200 runes, the six-key projection with no omitempty
- T-12.1.4 [OK] `shape.go` — `{items,total,upstream,timestamp}` with `total` the
  FULL parsed count and `items` the limit head
### SG-12.2 [OK] Tests (offline, deterministic)
- T-12.2.1 [OK] 19 package tests: six-key presence, absent→`""` (never null),
  CDATA/bare parity, the 200-rune clip incl. multi-byte, `nil` on no items, the
  strict param matrices, MISS→HIT, TTL expiry, 8-way single-flight (ONE upstream
  call), non-table URL refused without entering the cache, the bounded-cache
  observable, 403/429/500/503 with the real status and quoted body, transport
  with no body, gzip decode, head-vs-total, and "never substitute a payload"
- T-12.2.2 [OK] 7 handler wire tests: healthz reports four families, default
  source+limit, cached repeat sharing one fetch, strict 400 matrix with the exact
  phrases, unknown source 400 + detail, real upstream statuses, empty feed → 502,
  non-GET → 405
### SG-12.3 [OK] Wiring + ops
- T-12.3.1 [OK] `cmd/data/main.go`: `handleNews` + `writeNewsError`, mux
  registration, `/healthz` gains `"news":"1 feeds"`, startup log line
- T-12.3.2 [OK] `app/api/news/route.ts` reduced to the verbatim proxy;
  `lib/news.ts` added as the typing/display mirror (no validation)
- T-12.3.3 [OK] `check-contract.py`: news NEWS_SOURCES parity + a proxy-shape
  needle list that fails if `parseInt`/`Math.min`/`<item>`/`stripCdata` return
- T-12.3.4 [OK] Route sweep gained 6 strict-param checks; monitor already covered
  the route and keeps covering it through the proxy
### SG-12.4 [OK] Live verification
- T-12.4.1 [OK] `verify-news.py` **50/50** against `:3101` and **50/50** through
  `:3100` (strict params incl. empty values, `total` vs head, cache keyed on the
  feed URL, anti-fake parity: 10/10 served titles matched a DIRECT feed fetch in
  upstream's own order)
- T-12.4.2 [OK] `/news` + `/api/news` 200 on the origin; `bunx tsc --noEmit` 0;
  `bun run build` 0; `go build/vet/test` green (76 tests)
---
## G13 - BACKEND: the `chainrank` family moves into the Go sidecar (DR-013)
> Owner direction, continued: *"backend framework weighted on go/rust"*. Fifth
> acquisition family in `backend/data`; reads only — the write surface stays
> unproxied by design.
### SG-13.1 [OK] The Go package `internal/chainrank`
- T-13.1.1 [OK] `modes.go` — the two-mode table, `UpstreamURL` (pagination
  relayed byte-for-byte, param order canonicalised, params dropped for `stats`),
  the `AllowedURL` allowlist, the 400 detail string
- T-13.1.2 [OK] `fetch.go` — plain net/http, 15 s TTL cache + single-flight
  keyed on the FULL upstream URL, an explicit 32-entry ceiling with oldest-first
  eviction (pagination makes the key space unbounded, unlike the other families),
  the UA/From identification headers, gzip, and the real-status/no-fake-200 rule
- T-13.1.3 [OK] `shape.go` — the envelope SPREADS upstream's object and stamps
  `kind`/`upstream`/`fetchedAt`; `CheckShape` refuses a 200 missing the rendered
  fields (`null` is not a number, `rows=null` is not an array)
### SG-13.2 [OK] Tests (offline, deterministic)
- T-13.2.1 [OK] 17 package tests: the table, the relay matrix incl. param-order
  canonicalisation, the allowlist refusing writes/foreign hosts, MISS→HIT, TTL
  expiry, 8-way single-flight with 1 MISS + 7 COALESCED, the ceiling held under a
  60-URL walk, 405/429/403/500/503 with real statuses, non-JSON, transport with
  no body, gzip, and every shape rule (incl. `null`/string/missing per field)
- T-13.2.2 [OK] 10 handler wire tests: healthz reports five families, the stats
  default, the relay reaching UPSTREAM verbatim (observed at the fake Doer, not
  inferred from our own builder), unknown mode 400 + detail, shape refusals 502,
  real upstream statuses, non-JSON 502, POST 405 and `/api/click` 404, per-URL
  caching, and param-order sharing one entry
### SG-13.3 [OK] Wiring + ops
- T-13.3.1 [OK] `cmd/data/main.go`: `handleChainrank` + `writeChainrankError`
  (405/429 keep their own meaning), mux registration, `/healthz` gains
  `"chainrank":"2 modes"`, startup log line
- T-13.3.2 [OK] `app/api/chainrank/route.ts` reduced to the verbatim proxy;
  `lib/chainrank.ts` gained the two envelope types as a typing mirror
- T-13.3.3 [OK] `check-contract.py`: chainrank CR_MODES parity, a proxy-shape
  needle list including `Math.min`/`pageSize`, and an explicit assert that no
  write path (`/api/click|presence|claim|upload`) appears in the route
- T-13.3.4 [OK] Route sweep gained 4 relay-verbatim checks
### SG-13.4 [OK] Live verification
- T-13.4.1 [OK] `verify-chainrank.py` **50/50** against `:3101` and **50/50**
  through `:3100`, including the relay matrix measured against REAL upstream
  (`page=0|-1|abc → 1`, `pageSize=0 → 50`, `pageSize=1000 → 200`) and the
  write-gate probes fired at upstream directly (no side effects)
- T-13.4.2 [OK] `/chainrank` + `/api/chainrank` 200 on the origin;
  `bunx tsc --noEmit` 0; `bun run build` 0; `go build/vet/test` green (111 tests)
---
## G14 - PRODUCT: the FUDCourt CEX Executor — a risk-aware execution layer over Binance/Bybit/MEXC ([DR-020](../records/DECISIONS.md), [DR-021](../records/DECISIONS.md), 2026-09-30)
> PRD `docs/prd/cex-executor.md` (non-custodial / BYOK; spot + USDT linear
> perps). The premise: the user defines the RISK or the OUTCOME, the engine derives
> quantity, notional, margin and leverage. Paper mode is the default posture; live
> placement needs `FUDCOURT_EXECUTOR_LIVE=1`.
### SG-14.1 [OK] The pure core — risk engine, planner, strategy engine
- T-14.1.1 [OK] `platform/executor/types.ts` — the frozen contract: request,
  sizing/leverage/execution definitions, constraints, `ExecutionPlan`,
  `PreviewResult`, records, `ExchangeAdapter`, `ExecutorStore`, `ExecutionLock`
- T-14.1.2 [OK] `platform/executor/risk.ts` — pure `decimal.js` engine (no HTTP,
  no DB): fee-aware sizing, 9 sizing modes, `auto_safe` leverage selection,
  liquidation approximation, `maxSafeQuantity` under partial fills; every
  exposure quantity rounded DOWN to the step grid (PRD §106 invariants hold by
  construction)
- T-14.1.3 [OK] `platform/executor/plan.ts` — request → plan + preview:
  strict field-named validation, Risk+Profit conflicts returned as `conflicts`,
  entry priced at the touch for market entries, a missing stop makes stop-based
  figures `null` (never 0)
- T-14.1.4 [OK] `platform/executor/engine.ts` — 8 strategy state machines
  (market, limit, TWAP, adaptive TWAP, iceberg, chase-limit, scale-in, scale-out),
  deterministic (seeded mulberry32 persisted in the strategy state), with an
  engine-side over-order clamp
### SG-14.2 [OK] Persistence, locking, execution runtime
- T-14.2.1 [OK] `platform/executor/store.ts` — Postgres store in the dedicated
  `executor` schema (DR-020), 10 tables, embedded DDL asserted byte-identical to
  `db/executor-schema.sql`, every statement user-scoped, AES-256-GCM per-field
  credential envelope
- T-14.2.2 [OK] `platform/executor/lock.ts` — Valkey lease per execution
  (`SET NX PX` + Lua compare-and-act heartbeat/release). FAIL-CLOSED: any Valkey
  error means `acquire` false → the worker does not trade. Unlike the JSON cache
  in `platform/cache/valkey.ts`, which fails open
- T-14.2.3 [OK] `platform/executor/worker.ts` — the scheduler: owns RUNNING
  executions under the lease, reconciles against the venue before acting, applies
  the worker's own `clampChild` over-order clamp, `RISK_STOPPED` on a breached
  budget, stable exit-leg client-order ids, `emergencyStop` (cancels managed
  orders, never closes positions)
- T-14.2.4 [OK] `scripts/executor/worker.ts` composition root + versioned unit
  `infrastructure/fudcourt-executor-worker.service` (Bun runtime, independent of
  `fudcourt-web`: closing the browser never stops an execution)
### SG-14.3 [OK] Adapters (live + paper)
- T-14.3.1 [OK] `platform/executor/exchange.ts` — the `ExchangeAdapter` interface
  plus ccxt-backed adapters for binance / bybit / mexc (spot + linear_perp),
  symbol normalisation, the capability registry, lazy ccxt binding, and `mapError`
  sanitising every adapter error so no key/secret can escape
- T-14.3.2 [OK] `PaperExchangeAdapter` implements the SAME interface with a
  simulated matcher, so the worker drives paper and live through one code path
### SG-14.4 [OK] API + UI
- T-14.4.1 [OK] `platform/executor/runtime.ts` — one composition root for every
  handler: session + ownership (wrong owner ⇒ 404), credential connect/test,
  preview, execution creation with the immutable plan snapshot, lifecycle intents
  (start/pause/resume/cancel), emergency stop, risk settings
- T-14.4.2 [OK] 15 route handlers under `src/app/(frontend)/api/executor/**`
  (accounts + test, executions + start/pause/resume/cancel/orders/fills/events,
  preview, emergency, settings); `guard.ts` gates `/executor` and `/api/executor`
  at `team`
- T-14.4.3 [OK] `features/executor/` (client + shapers + panel) behind 6 pages:
  `/executor`, `/executor/new` (composer + live risk preview), `/executor/[id]`,
  `/executor/accounts`, `/executor/history`, `/executor/settings`
### SG-14.5 [OK] Verification
- T-14.5.1 [OK] 137 offline tests across `executor-{risk,engine,exchange,store,plan,worker,ui}-tests.ts`,
  wired into `bun run test:shapers` (CommonJS `node --test` + the `@/` resolver
  shim; no network)
- T-14.5.2 [OK] `bun run verify:executor` — paper-mode E2E against the REAL
  Postgres + Valkey + worker loop (no mocks): **38/38 PASS** measured 2026-09-30.
  Risk sizing from a $40 budget → qty 0.0198 < 0.02, projected risk 39.996 ≤ budget;
  `Σ child 0.0171 ≤ planned 0.0198`; over-order still holds after a worker restart;
  lock contention refuses a second worker; cancel leaves protective legs on the
  venue; 30 events recorded; the plaintext secret appears in neither the API list
  payload nor the database row

### SG-14.6 [OK] Portfolio risk gates — §73 open risk, §74 daily loss
- T-14.6.1 [OK] `store.summarizePortfolioRisk` — one statement, so the ceiling is
  checked against a consistent snapshot: `SUM(COALESCE(current_risk, planned_risk))`
  over the user's live executions, plus today's realized P&L (exit-leg proceeds −
  average-entry-price × exited quantity − all fees) and the live count. A foreign
  user reads zeros; there is no per-row loop.
- T-14.6.2 [OK] `evaluatePortfolioGates` — the gate DECISION as a pure function of
  `{intent, equity, openRisk, realizedPnlToday, ownRisk, profile}`, so the rule is
  testable with no database and no venue. The wrapper only gathers numbers. Both
  ceilings are hard constraints (§117's default): a breach is REFUSED, never
  resized, and there is no override.
- T-14.6.3 [OK] Wired into `createExecution` BEFORE the row is created, so a refusal
  leaves no execution behind to reconcile. 409 carries `openRisk`, `requestedRisk`,
  `maxOpenRiskUsd` and `maxOpenRiskPct` so the UI explains the refusal instead of
  leaving the user guessing.
- T-14.6.4 [OK] Exits are never gated. `close` and `reduce` return `null` from the
  gate by construction: a guard that could refuse an exit would trap the user inside
  the very risk it exists to bound.
- T-14.6.5 [OK] Settings UI states what each limit does (`Field` gained an optional
  `hint`), so a ceiling that actually blocks is never mistaken for a stored
  preference, and the stale "stored but not yet blocking" comment is gone.
- **Evidence:** `bun run verify:executor` 11 gate checks PASS against real Postgres —
  a terminal execution commits no open risk; a live one counts at its CURRENT risk
  (30.59 reconciled from fills, not the stale 39.996 plan); a breach refuses 409
  with the committed and requested figures; the ceiling is a share of equity
  (0.001% of $100,000 = $1); §74 blocks a new opening at the loss limit and never
  blocks a close or a reduce. `bun run test:shapers` 207/207; tsc 0; `next build`
  green. DR-021 §2f.
- T-14.6.6 [OK] The E2E purges its own rows at the end, so repeated verification
  does not accumulate executions in a real database (the purge runs after every
  check, so cleanup can never mask a failure).
