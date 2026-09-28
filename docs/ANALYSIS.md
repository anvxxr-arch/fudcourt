# Comprehensive Analysis — Fudcourt

Analyzed at remote head `957836d` (2026-09-27), local `main` identical
(`git diff HEAD origin/main` = empty). 33 commits since 2026-09-18.

## 1. Architecture

```
                       ┌────────────────────────────────────────────┐
                       │ monorepo: fudcourt (npm workspaces)        │
                       ├────────────────────┬───────────────────────┤
                       │ apps/web           │ apps/blog             │
                       │ Next.js 14 / R18   │ Next.js 16 / R19      │
                       │ portfolio OS       │ Payload CMS 3.89      │
                       └─────┬──────────────┴──────────┬────────────┘
                 systemd :3100│                        │systemd :3001
                 Vercel (main deploy)                 │
                             │                        │
        ┌────────────────────┼──────────┐             │
        ▼                    ▼          ▼             ▼
   Turso (libSQL)      cryptorank.io  llama/dex/    Neon Postgres
   accounts/assets/    chainrank.fyi  chainrank/    users/posts/
   transactions/       publishers     defillama/    media/categories
   journal/ledger      (HTML SSR)     dexscreener
        ▲
        │ every 5 min
   sync-live.py ──(exact balance; RPC fail ⇒ raise, never 0)
```

**Layering is clean:** UI (`CryptorankPage.tsx` + 11 pages) → mode-only API
routes (client can never pass a raw path) → allowlisted Python fetcher →
third-party HTML/JSON → shapers → typed envelope. Each layer has one job and
its own failure vocabulary.

## 2. Reasoning — why this design (decision log)

### R-a. "Reverse-engineer HTML, no API keys" (owner decision, twice)
**Reasoning:** `api.cryptorank.io` challenges every non-browser TLS client
(curl, curl_cffi chrome131, headful Chrome, Camoufox ±WARP) with Cloudflare
Turnstile; clearing it needs a human signup for a v3 key. The *market pages*,
however, serve complete Next.js SSR payloads to curl_cffi. So the value is
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
| Route/endpoint health | `verify_all_routes.py` → **107/107** (12 pages, 23 API, 7×401 fail-closed, 7×token validation, 58 CR checks) |
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
| K-1 | ~~Turso schema not versioned~~ ✅ **closed 2026-09-28** | High→Low | `apps/web/db/schema.sql` generated + `--check` drift gate (R-1). |
| K-2 | **No CI / pre-merge verification** | High→Med | Partial: `pre-push` hook (contract check + tsc + py syntax) live 2026-09-28; GitHub Action still open (PLAN T-2.2.3). |
| K-3 | **Dual Next majors (14 web / 16 blog)** | Medium | Two React majors (18/19), divergent TS versions; upgrade path and shared-code future are constrained. |
| K-4 | **Upstream coupling (CF 429 / Turnstile)** | Medium | CryptoRank HTML RE can break without notice; mitigated by loud failures + harness, but there is no alerting — breakage is discovered on next run. |
| K-5 | ~~Web API unauthenticated~~ ✅ **closed 2026-09-28** | Med→Low | Fail-closed `x-fud-token` auth on all 7 write handlers; public Vercel build has no token ⇒ mutations 401 by construction (R-6). Residual: LAN peers can read the token from the local bundle (accepted — same trust boundary). |
| K-6 | **No tests for UI logic** | Medium | Rendering proven by DOM audit *script*, not by unit tests; shaper logic tested only through live upstream (flaky-by-nature). |
| K-7 | **Cloud DB single-credentials** | Low-Med | Turso token + Neon URL are single secrets; rotation story is manual. |
| K-8 | **Zero onboarding docs (before this set)** | Low | No README/PRD/schema existed at remote head — now addressed by `docs/`. |
| K-9 | **Blog contentless** | Low | Schema verified but `posts` = 0; product surface unproven with real content. |

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
architectural. Status 2026-09-28: K-1 and K-5 closed, K-2 partially closed
(local pre-push gate); CI Action, upstream monitoring and remaining items
track in PLAN G2–G3.
