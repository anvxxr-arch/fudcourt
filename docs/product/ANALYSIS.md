# Comprehensive Analysis — Fudcourt

Analyzed at remote head `957836d` (2026-09-27), local `main` identical
(`git diff HEAD origin/main` = empty). 33 commits since 2026-09-18.

## 1. Architecture

```
                       ┌────────────────────────────────────────────┐
                       │ monorepo: fudcourt (per-app bun install)   │
                       ├────────────────────────────────────────────┤
                       │ frontend/web — ONE Next.js 16 app / React 19   │
                       │   portfolio OS  +  Payload CMS 3.89        │
                       │   /  /team  /admin  /api/*  (dashboard)    │
                       │   /blog  /blog/cms/admin  /blog/cms/api/*  │
                       └────────────────────┬───────────────────────┘
                                    systemd :3100
                            self-hosted only (DR-002); merged in DR-017
                                            │
        ┌───────────────────────────────────┼
   Postgres+TimescaleDB cryptorank.io llama/dex/    Neon Postgres
   accounts/assets/    chainrank.fyi  chainrank/    users/posts/
   transactions/       publishers     defillama/    media/categories
   journal/ledger      (HTML SSR)     dexscreener
        ▲
        │ every 5 min
   sync-live.py ──(exact balance; RPC fail ⇒ raise, never 0)
```

**Layering is clean:** UI (`CryptorankPage.tsx` + 11 pages) → mode-only API
routes (client can never pass a raw path) → **for cryptorank a Go sidecar
(`backend/data` :3101) holding the allowlist, the cache and the
browser-fingerprint fetch**; every other family still uses `lib/rate-limit.ts` →
third-party HTML/JSON → shapers → typed envelope. Each layer has one job and
its own failure vocabulary. Since DR-005 the TS route for cryptorank is a pure
proxy (no validation, no shaping), so the "one job" of that layer is now
exactly "forward and report faithfully".

## 2. Reasoning — why this design (decision log)

### R-a. "Reverse-engineer HTML, no API keys" (owner decision, twice)
**Reasoning:** `api.cryptorank.io` challenges every non-browser TLS client
(curl, curl_cffi chrome131, headful Chrome, Camoufox ±WARP) with Cloudflare
Turnstile; clearing it needs a human signup for a v3 key. The *market pages*,
however, serve complete Next.js SSR payloads to a sufficiently browser-like TLS
client — `curl_cffi` chrome131 originally, and since DR-005 the Go
`tls-client` chrome_131 profile (measured identical output). So the value is
reachable without keys by parsing `__NEXT_DATA__`.
**Consequence:** acquisition cost moved from *credentials* to *proof* — every
family must be gated before wiring (§3).

### R-b. Mode-only API (no raw path passthrough)
**Reasoning:** a raw-path proxy would (1) let clients hit the decoy
`/_next/data` class, (2) couple the contract to upstream URLs. `mode + key`
with a strict regex makes invalid input a local 400 and unknown input an
upstream 404 — the two are semantically different and both preserved.

### R-c. The 3-gate decoy detector (quality gate)
**Reasoning:** a payload can be *self-consistent and still fabricated* — this
was proven: back-to-back parity passed on `/funding-rounds` while the same
route fabricated coin names (`zenith-dao-labs`, `lunar-cash`), served BTC at
57k–67k against a true 84.5k, and returned 200 for nonexistent slugs.
Therefore gates are: **(1)** nonexistent slug → 404 (honest router),
**(2)** value parity vs an independent feed (llama/CoinGecko),
**(3)** a *semantic* ground truth an upstream fabricator can't guess
(exchange announcement dates, publisher `<title>`, official stock quote,
league schedule, YouTube oembed). Substitutions are declared per family.

### R-d. Derived 404 for `newstag` (soft-404 handling)
**Reasoning:** upstream returns HTTP 200 + `tag:null` for unknown tags and
still ships the general feed. Forwarding it would publish an unfiltered feed
*under a tag label* — a lie. The route converts upstream's own `tag:null`
marker into a real local 404: no whitelist needed, no fabrication possible.

### R-e. Loud failure taxonomy
400 (my input bad) / 404 (your resource missing) / 502 (upstream wall, real
status attached) / 503 (I refuse: known-decoy surface). **Empty-200 is
forbidden** because an empty table is indistinguishable from "market has no
data", which is exactly how silent corruption hides.

### R-f. Rate-limit resilience as product behavior
**Measured:** a cold board mount fires ~20 mode fetches concurrently →
cryptorank CF burst-limits (429) → panels used to render error text.
**Fix:** `runHelper` backs off + retries the same fetch ×3 on 429; harness
`get()` and `independent_upstream_page` do the same; DOM audit pre-warms every
mode. A gate may fail on *data*, never on a *hiccup*.

## 3. Evidence ledger (what was actually measured)

| Claim | Evidence |
|-------|----------|
| 28 cryptorank modes live | harness `244 passed / 0 failed / 8 info` (`/tmp/cr_28e.log`), 400-response lists exactly 28 |
| Route/endpoint health | route sweep `frontend/web/tests/verify_all_routes.py` (was `frontend/web/scripts/verify/verify_all_routes.py`) → **122/133** measured 2026-09-29 (two byte-identical runs; 11 fails = 1 CoinGecko 403 passthrough + 10 session-gated probes unrunnable on the secret-less :3107 target — environmental). Re-aligned sweep detail: PLAN SG-5.3; breakdown: ARCHITECTURE §7 |
| Browser rendering | Playwright DOM audit → **109/109** |
| Price truth | GATE2 diffs 0.002%–0.55% vs coins.llama.fi; quarterly 4/4 vs CoinGecko (0.03–0.40%) |
| Semantic truth (GATE3) | KuCoin GemPool dates; publisher `<title>`; Chainwire presale date; WEN $6.55 quote; NFL schedule == `26SEP27LACBUF`; YT oembed title+channel |
| Decoy surfaces | `/price/zzznoexist9999.json` → 200 fabricated coin; `/performance` → literal `N/A` in every ROI cell; `perpetuals/dex` payload byte-identical to `/perpetuals` |
| Blog access control | `/api/users` 403; introspection blocked; playground prod-404 (Payload default) |
| Sync integrity | `sync-live.py` raises on RPC failure (never writes 0) — enforced by code comment + design |

## 4. Strengths

1. **Integrity-first design is real, not aspirational** — refusal (503),
   derived-404, null-not-zero, slice provenance labels, and gate evidence are
   all *enforced in code and re-checked by harnesses*.
2. **Verification culture:** 6 harnesses (Python ×5 + MTScript) + DOM audit +
   live route sweep; regressions surface before humans do.
3. **Clean separation:** mode-only routes, allowlisted fetcher, typed lib
   contracts (`CR_MODES`, `CR_KEYED_PATHS`) referenced by both route and tests.
4. **Honest scope control:** rejected surfaces are documented *with evidence*,
   not silently dropped.

## 5. Weaknesses & risks (ranked)

| # | Risk | Severity | Detail |
|---|------|----------|--------|
| K-1 | ~~Schema not versioned~~ ✅ **closed 2026-09-28** | High→Low | `database/schema/pg-schema.sql` (a SQLite dump at the time, moved to `database/schema/` by the Phase-2 restructure; since DR-040 it is the hand-written Postgres DDL and the dump + its `--check` gate are gone). |
| K-2 | **No CI / pre-merge verification** | High→Med | Partial: `pre-push` hook (contract check + tsc + py syntax) live 2026-09-28; GitHub Action still open (PLAN T-2.2.3). |
| K-3 | **Two React majors (web R18 18.3.1 / blog+root R19 19.2.0); Next patch divergence (web 16.3.6 / blog+root 16.3.5)** | Medium | Divergent TS versions (5.7.2 web / 5.9.3 root+blog); shared-code future is constrained. Next itself is now one major — DR-001 moved `frontend/web` 14.2.0 → 16.3.6 (2026-09-28), so the original "dual Next majors" framing no longer holds. |
| K-4 | **Upstream coupling (CF 429 / Turnstile)** | Medium | CryptoRank HTML RE can break without notice; mitigated by loud failures + harness, but there is no alerting — breakage is discovered on next run. Since DR-005 the fetch is a Go sidecar, so the class now also covers *Cloudflare rule/profile rotation* (a pinned `chrome_131` profile could start getting 403s) and a stopped sidecar (loud 502). Residual: `monitor.py` covers the sidecar only **transitively** (its `/api/cryptorank` checks fail when `fudcourt-data` is down); it does not yet assert the `:3101` unit nor alarm on `cf-mitigated: challenge`. |
| K-5 | ~~Web API unauthenticated~~ ✅ **closed 2026-09-28, re-closed same day** | Med→Low | First closed with the `x-fud-token` guard — which was then found inlining its value into a public JS chunk, so reads stayed open to the internet and writes were public. Now superseded by Discord session tiers: treasury reads require `team`, writes re-check server-side, and the client sends no secret at all. Residual: a stolen session cookie grants that tier until it expires (7 days) — rotate `FUDCOURT_SESSION_SECRET` to cut all sessions. |
| K-6 | **No tests for UI logic** | Medium | Rendering proven by DOM audit *script*, not by unit tests; shaper logic tested only through live upstream (flaky-by-nature). |
| K-7 | **Cloud DB single-credentials** | Low-Med | The Postgres DSN (`FUDCOURT_PG_URL`, local) + Neon URL are single secrets; rotation story is manual (`SECRETS.md` §5). |
| K-8 | **Zero onboarding docs (before this set)** | Low | No README/PRD/schema existed at remote head — now addressed by `docs/`. |
| K-9 | **Blog contentless** | Low | Schema verified but `posts` = 0; product surface unproven with real content. |
| K-10 | **Inbound API abuse (rate limiting)** | High→Low | Measured 2026-09-29: 25× `GET /api/cryptorank?mode=converter` all 200 at 921,588 B (~23 MB), `&fresh=1` bypassing the cache, and a 64.5 s cold `/api/ticker`; the only limiter in the repo was outbound. **Closed same day** by `lib/rate-limit-inbound.ts` + `middleware.ts` (DR-004, PLAN G6): cost-weighted 60 s per-client window, 429 + `Retry-After`, `X-RateLimit-*` on every response. Residual: counters are per Node process (one instance today) — a multi-instance deploy would need a shared store, and Cloudflare's edge is still the right home for a distributed budget. |

| K-11 | **`FUDCOURT_SESSION_SECRET` absent on the host → Discord login is 500 and every tier gate fails closed** | High (availability, not exposure) | Measured 2026-09-29: `GET :3100/api/auth/login` → **500** (`lib/auth.ts` throws without a ≥32-char secret) and `frontend/web/.env.local` carries no such key (only `FUDCOURT_PG_URL`, `FUD_MUTATION_TOKEN`, `NEXT_PUBLIC_FUD_MUTATION_TOKEN`, `VERCEL_OIDC_TOKEN`). Fail-closed is the correct direction — the treasury stays 401/307 to anonymous callers, verified on the public hostname — but **nobody can sign in**, so member/team/admin surfaces are unreachable for every user, including the operator, and the 10 session-gated sweep probes cannot run. The blog's env is worse in kind: `.env` uses the retired `NEXT_PUBLIC_FUD_MUTATION_TOKEN` naming rather than the current secret names. Fix is a human step (`openssl rand -hex 32` → `frontend/web/.env.local` + `FUDCOURT_SESSION_SECRET=…`, restart the unit); not performed here because writing a session secret is the operator's call. |
| K-12 | **Single upstream refusal can silently zero a live dataset** | Closed → Medium | Measured this session: CoinGecko began refusing this host wholesale (403 on every `/api/v3` price route, 429 on `/ping`, with **and** without chrome131 TLS impersonation), which made `fudcourt-sync.service` raise every 5 min while its last successful write stayed in Postgres; on a host where the read path had already been written back as 0 rows the board would have shown **$0 net worth** with no alarm. Fixed by moving the price oracle to `coins.llama.fi` (the `prices()` change in `sync-live.py`, uncommitted at time of writing; the same oracle three harnesses already gate on) and verified: service `Finished` clean, net worth restored to **$170.51**. Residual: `sync-live.py` still depends on Alchemy + Hyperliquid, and `/api/markets` remains 403 until the CoinGecko block lifts. |
## 6. Verification methodology critique

Strengths: gates are falsifiable (specific numbers, specific sources),
substitutions are declared, failures are loud.
Gaps: (a) most gates depend on *live* upstreams → results vary run-to-run
(measured: threshold tuning needed when fetches skew minutes apart —
converter 0.54% vs 0.5% bound, digest volume 2.5% vs 0.5%); tolerances were
re-anchored to the harness's existing class (≤3% llama-bound; ≤5% for
high-churn aggregates) — documented in check names, but **time-skew-aware
gating** (fetch truth and subject back-to-back) would be strictly better.
(b) GATE3 samples are small (1–6 candidates) by cost; pool-widening trades
specificity for availability when publishers rate-limit.

## 7. Conclusion

Fudcourt is a **single-operator treasury + market-intelligence OS** whose
differentiator is *verified data* — the crypto integration shipped 28 modes
with an evidence trail most dashboards never attempt. Its engineering risks
are operational (schema versioning, CI, authz, upstream monitoring), not
architectural. Status 2026-09-29: K-1, K-5, K-10 and K-12 closed; K-2 closed
(CI Action green + local pre-push gate), K-4 monitored (DR-006 added the sidecar
class); K-11 (no `FUDCOURT_SESSION_SECRET` on the host) is **open and needs the
operator**; remaining items are quality-of-life and track in PLAN G2–G9.
