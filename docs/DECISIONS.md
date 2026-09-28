# Decision Records

## DR-001 — apps/web Next.js 14.2.0 → 16.3.6 ✅ Accepted (2026-09-28)

**Status:** accepted, deployed to production (`fudcourt-web` on :3100 runs 16.3.6).

**Context.** `apps/web` sat on Next 14.2.0 while `apps/blog` already ran
Payload/Next 16 — two majors apart meant two sets of security patches, two
toolchains, and a growing gap in shared patterns (docs claimed one stack,
repo ran two). R-3 in RECOMMENDATIONS called for either upgrading or
recording a documented exception.

**Spike.** Branch `spike/next16` in a separate git worktree
(`/home/dwizzy/fudcourt-next16`, later merged as `8329669`) so the live
checkout never ran a half-upgraded tree.

**What actually broke (both fixes landed before merge):**

1. **Async route params** — the only hard failure. Next 15+ types
   `context.params` as `Promise<{…}>`; `app/api/transactions/[id]/route.ts`
   (PUT/PATCH/DELETE) still declared the sync shape → TS2344 in Next's
   generated `validator.ts`. Fix: declare `params: Promise<{ id: string }>`
   and `await` it — backward compatible, `await` on a plain object works
   under 14 too.
2. **Turbopack dynamic-filesystem tracing** (warning): `execFile` in
   `app/api/cryptorank/route.ts` (runHelper spawning the python helper)
   made Turbopack trace the whole project into the output bundle. Fix:
   the sanctioned `execFile(/*turbopackIgnore: true*/ …)` marker.
3. **tsconfig auto-migration** by `next build` itself: `moduleResolution`
   `node`→`bundler`, `jsx` `preserve`→`react-jsx`, added
   `.next/dev/types` — committed as-is (Next wrote it, Next owns it).
4. React stayed at **18.3.1**: next@16 peer range still accepts `^18.2.0`,
   so no React major had to ride along.

**Evidence (why "accepted" and not "exception"):**

- `npm run build` RC=0 (Turbopack, ~1-9s compile), `tsc --noEmit` RC=0,
  `check-contract.py` OK (28 modes, mutation guards).
- Route sweep **107/107 PASS** against an isolated spike instance on :3110
  AND against production :3100 after cutover (12 pages, 23 API GETs,
  7×401 fail-closed, 7 validation-first mutations, 58 cryptorank checks).
- DOM audit (playwright/Chrome) on :3110 vs :3100: identical results —
  17 tables with identical row counts, all panels present, no NaN/
  undefined. The single failing check ("stats strip PRESENT") fails
  **identically on Next 14 production** → pre-existing check/UI drift,
  not a 16 regression (candidate cleanup for SG-3.4 harness precision).
- `mode=home` API body byte-identical across both instances (shared
  cache HIT, count=12).

**Consequences.**

- Production + CI now build with Turbopack; webpack path untouched/unused.
- Known benign warning remains: Turbopack infers workspace root from the
  repo's multiple lockfiles (root lock is stale — see RECOMMENDATIONS;
  silencing requires `turbopack.root`, deferred as noise).
- `next@16.3.6` exact-pinned (repo convention; `^` auto-written by npm
  was corrected back to exact).
- Blog and web now share one Next major → one patch train.

---

## DR-002 — Hosting: self-hosted on the homeserver; no Vercel publish (2026-09-28)

**Context.** `docs/SECRETS.md` was auditing "Vercel ↔ local env parity" when
both probes came back negative: the CLI is unauthenticated and
`fudcourt.vercel.app` answers `404 DEPLOYMENT_NOT_FOUND` — a project shell with
no deployment. Owner decision (dwizzy): **"We don't publish on Vercel, let's
self hosting."**

**Options.** (a) Keep Vercel as a deploy target and finish the parity audit
when credentials exist; (b) hybrid — board stays on the homeserver, only the
public reader goes to Vercel; (c) drop Vercel entirely, production = this
homeserver.

**Decision. (c).** Production is the homeserver stack that already runs:
`fudcourt-web` (`127.0.0.1:3100`), `fudcourt-blog` (`127.0.0.1:3001`),
`fudcourt-sync.timer`. The tracked `apps/web/vercel.json` is deleted and its
`/portfolio` rewrite moves into `apps/web/next.config.js` (host-independent).
Exposure stays LAN/loopback today; publishing through the existing Cloudflare
tunnel would be a separate, explicit decision (mutation auth stays fail-closed
whenever it happens).

**Evidence.** Units active; board `200`; blog `200`; CI is gates-only (no
deploy step), so nothing in CI referenced Vercel; `DEPLOYMENT_NOT_FOUND`
measured 2026-09-28.

**Consequences.**

- The Vercel half of `docs/SECRETS.md` §3/§5/§6 is retired — parity questions
  are moot by decision, not "unverified"; the runbook now documents the
  self-hosted units (SECRETS §3/§6 rewritten).
- Residual cleanup (optional, human): delete the three Vercel projects
  (`fudcourt`, `web`, `blog`) and the `.vercel/` dirs + the
  `VERCEL_OIDC_TOKEN` line in `apps/web/.env.local`.
- `NEXT_PUBLIC_FUD_MUTATION_TOKEN` still requires a rebuild after rotation —
  build-time inlining is host-independent.
- Managed data services (Turso, Neon) are unchanged — this decision is about
  compute hosting only.

**Follow-up (same day): published at `https://fc.dwirijal.my.id`.** Owner:
"Publish aja di fc.dwirijal.my.id untuk sementara." The existing Cloudflare
tunnel (`39bdfeef…`, config `~/.cloudflared/config.yml`) gained an ingress
`fc.dwirijal.my.id → http://127.0.0.1:3100` plus a proxied CNAME in zone
`dwirijal.my.id`. Origin stays loopback-only; verified over the public
hostname: `/` 200, `/cryptorank` 200 (real upstream JSON), `/portfolio` 200,
`DELETE /api/transactions/1` without token → **401** (fail-closed holds in
public), tunnel regression `ai.karepmuwes.my.id` + `zura.dwirijal.my.id` 200.
