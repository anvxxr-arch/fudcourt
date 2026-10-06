# Recommendations — Fudcourt

Ranked by (impact ÷ effort), tied to risks in [ANALYSIS.md §5](ANALYSIS.md).

| ID | Recommendation | Closes | Impact | Effort | Priority |
|----|----------------|--------|--------|--------|----------|
| **R-1** | **Version the schema.** Originally: export `SELECT sql FROM sqlite_master` into a tracked schema file. **Closed and since simplified (DR-040):** the SQLite dump and its `dump-schema.mjs --check` drift alarm were deleted; `db/schema/pg-schema.sql` is the hand-written DDL for the single Postgres system of record, annotated in `docs/architecture/SCHEMA.md`. | K-1 | High | S | **done** |
| **R-2** | **Wire verification into CI / git hook.** A pre-push hook (or GitHub Action) running `verify-cryptorank.py --offline-ish subset` + `tsc --noEmit` + `next build` on changed apps. Even a reduced offline subset (contract checks, no upstream) catches 80% of regressions. | K-2 | High | M | **P0** |
| **R-3** | **Decide the Next.js version story.** Either upgrade `apps/web` 14→16 (aligns React 18→19, single toolchain) or document web-stays-14 as a policy with an expiry. Do not let the divergence grow silently. | K-3 | Med | M | P1 |
| **R-4** | **Add an upstream monitor.** A cron (15 min) that runs a 5-check smoke (`home`, `coins`, `converter`, `newstag`, `funding`-must-503) and notifies on deviation — converts K-4 from "found on next manual run" to "found in ≤15 min". | K-4 | Med | S | P1 |
| **R-5** | **Backfill blog content.** 3 seed posts (methodology: how a board is gated; decoy post-mortem; sync integrity rules) prove the CMS end-to-end and give `/blog/[slug]` real traffic. | K-9 | Med | S | P1 |
| **R-6** | **Authorization on mutating endpoints.** Keep LAN binding, but require a shared-secret header (env `FUD_API_TOKEN`) for `POST/PUT/PATCH/DELETE` on `/api/transactions|wallets`. Validation already exists; this adds *authentication*, currently absent. | K-5 | High | S | **P0** |
| **R-7** | **Time-skew-aware gating.** In harnesses, fetch ground truth and subject back-to-back (single helper that interleaves), so tolerance bounds measure *data agreement* instead of *fetch skew* (root cause of both threshold fixes this session). | §6 | Med | S | P1 |
| **R-8** | **Unit-test the shapers.** The shaper functions are pure (payload → envelope); snapshot tests with recorded `__NEXT_DATA__` fixtures make gates runnable offline and deterministic — complements R-2. | K-6 | Med | M | P2 |
| **R-9** | **Secret hygiene rotation plan.** Move `FUDCOURT_PG_URL` / `DATABASE_URL` into one documented rotation runbook; ~~confirm Vercel env parity~~ superseded by DR-002 (self-hosted — production env model documented in `docs/operations/SECRETS.md` §3). | K-7 | Low | S | P2 |
| **R-10** | **Publish `docs/` as the entry point.** Link `docs/README.md` from repo root README; add a root `README.md` (30 lines) pointing at it — the repo currently has no root README. | K-8 | Low | XS | P2 |
| **R-11** | **Keep the no-key posture.** Re-visit an official CryptoRank key only if HTML-RE breakage actually occurs (R-4 will tell you). Today the RE route is verified, cheaper, and owner-preferred; do not pre-emptively add credentials. | — | — | — | standing |

## Explicit non-recommendations (anti-goals)

- **Do not** re-enable `funding`/`unlocks`/ICO modes without both decoy gates
  re-passing (nonexistent-slug 404 **and** independent source match).
- **Do not** expose any `?page=`/filter param that doesn't vary upstream body.
- **Do not** widen tolerance bounds to "make CI green" — a gate that can't fail
  is decoration; fix the measurement (R-7) instead.
