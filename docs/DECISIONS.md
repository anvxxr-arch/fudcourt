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
