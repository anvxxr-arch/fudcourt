# Secrets inventory & rotation runbook (SG-4.2 / R-9)

**Rule zero: this document never contains a secret value — names, locations and
commands only.** Length checks are done with `wc -c`, never by printing.

Audit date: 2026-09-28. Scope: `apps/web`, `apps/blog`, repo root, GitHub
Actions CI, Vercel projects (`fudcourt`, `web`, `blog` — team `team_YpBtudy…`).

## 1. Inventory

| Name | Consumers (first-party) | Local home | Vercel side | CI needs it? |
|------|------------------------|------------|-------------|--------------|
| `TURSO_AUTH_TOKEN` | `apps/web/lib/db.ts`, `scripts/sync-live.py`, `scripts/dump-schema.mjs` | `./.env` (root) + `apps/web/.env.local` | `web` + `fudcourt` (expected) | no |
| `ALCHEMY_KEY` | `apps/web/scripts/sync-live.py` (live ETH RPC) + `scripts/archive/*.mjs` (forensic one-offs) | `./.env` (root) | no | no |
| `FUD_MUTATION_TOKEN` | `apps/web/lib/mutation-auth.ts` (server, fail-closed `x-fud-token`) | `apps/web/.env.local` | `web` (expected) | no |
| `NEXT_PUBLIC_FUD_MUTATION_TOKEN` | client guard — **inlined at build time** | `apps/web/.env.local` | `web` (expected, needs deploy) | no |
| `DATABASE_URL` (Neon) | Payload blog (`apps/blog/src`) | `apps/blog/.env` | `blog` (expected) | no (build works without it — verified) |
| `PAYLOAD_SECRET` | Payload blog (sessions/cookies) | `apps/blog/.env` | `blog` (expected) | no |
| `CR_PYTHON` | cryptorank route helper interpreter path | machine default in code | **N/A — local only** (see §4) | no |
| `VERCEL_OIDC_TOKEN` | Vercel OIDC federation (transient) | `apps/web/.env.local` | auto-issued | no |

`./apps/blog/.next/standalone/…/.env` is a *build artifact copy* on local disk
(`.next/` is git-ignored) — re-created on every build, never edit it.

## 2. Audit findings (evidence-based)

1. **No `.env` file was ever committed.** `git log --all --diff-filter=A
   --name-only | grep -E '(^|/)\.env'` → empty.
2. **RESOLVED — an Alchemy key literal lived in the tracked tree.**
   `apps/web/scripts/sync-live.py` carried it as a `os.environ.get(…, '<literal>')`
   default and **14 `apps/web/scripts/archive/*.mjs` scripts embedded it as
   `const KEY = '<literal>'`**, introduced in commit `3678b10` ("initial:
   monorepo") — so it is also in **git history**. Fixed in this change: the
   sync now uses `require_env('ALCHEMY_KEY')` (loud stop, no fallback) and the
   archive scripts read `process.env.ALCHEMY_KEY ?? ''` (`node --check` green on
   all 14). **Because history retains the old value, ROTATION IS MANDATORY —
   see §5 step R1 (human step, Alchemy dashboard).**
3. **RESOLVED — dead credential fallback.** `sync-live.py` used to "recover" a
   Turso token by slicing quote-delimited bytes out of `lib/db.ts`, which since
   the env-ref rewrite can only ever yield the *text* `process.env…` — garbage
   credentials. Removed; both creds now come from the repo-root `.env` via
   `load_env()` or the run stops with an explicit error. Verified by running the
   script (RC 0, real sync, net worth reported).
4. **`lib/db.ts` / `dump-schema.mjs` are clean** — Turso *URL* is public form
   (`libsql://…turso.io`), the token is `process.env`-only.
5. **CI requires zero secrets.** The GitHub Actions web job (contract + tsc +
   build + shaper fixture tests) and blog job pass with no env configured.
6. **Local env files are git-ignored** (root `.gitignore` `.env*` with
   `.env.example` exception) and `apps/web/.env.local` was already
   removed from the spike worktree before deletion (SG-3.3).
7. **`fudcourt-sync` systemd timer carries no credentials of its own** —
   `Environment=` only clears `NODE_ENV`; secrets come from `load_env()` reading
   the repo-root `.env`. Rotation therefore needs only the `.env` edit + the
   next 5-minute tick.

## 3. Vercel / local parity audit

Projects located: root `fudcourt` (`prj_uJv1ed…`), `web` (`prj_HXP2Vf…`),
`blog` (`prj_YVUh9D…`) in the same team; `.vercel/project.json` present per app.

| Check | Result | Evidence |
|-------|--------|----------|
| Vercel CLI listable from this machine | **NO** | `vercel whoami` → waits for OAuth login (non-interactive hang; needs `vercel login` or `VERCEL_TOKEN`) |
| Live prod reachable for behavioral parity | **NO** | `https://fudcourt.vercel.app/*` → `404 DEPLOYMENT_NOT_FOUND` (project exists, no active deployment) |
| Therefore: per-var Vercel presence | **UNVERIFIABLE today** | re-run §6 checklist at the next deploy |
| Local inventory complete | **YES** | §1 (every first-party `process.env` read is mapped to a home) |

Honest status: **parity is not proven — it is unprovable right now**, because
there is no live deployment to probe and the CLI is unauthenticated. Nothing in
§1 is claimed as "present on Vercel" without that evidence; the checklist in §6
converts each row into a yes/no at deploy time.

## 4. Local-only surfaces (by design, not a gap)

- `CR_PYTHON` points at the curl_cffi venv; the cryptorank helper is a spawned
  process. On Vercel serverless the helper cannot exist, so that family fails
  **loud 502 by design** (never a substituted payload). Re-confirm on next
  deploy: `curl -o /dev/null -w '%{http_code}' 'https://<prod>/api/cryptorank?mode=home'`
  → expect 502 with `error` carrying the helper text, not 200-with-phantom-data.
- Mutation auth is **fail-closed**: if `FUD_MUTATION_TOKEN` is absent on Vercel,
  every write is refused (401) rather than open — absence degrades to safe.

## 5. Rotation procedures (run in order; verify after each)

**R1. `ALCHEMY_KEY` (URGENT — value is in git history).**
1. Human step: Alchemy dashboard → app → API Keys → *Rotate key* (old key dies
   immediately; the copy in commit `3678b10` becomes useless).
2. Update the value in the repo-root `.env` (`ALCHEMY_KEY=…` — edit in a local
   editor, never `cat`/`grep` it into logs).
3. Verify: `cd apps/web && python3 scripts/sync-live.py` → RC 0 and a real net
   worth line (the run stops with `missing ALCHEMY_KEY` if step 2 was skipped).
4. Nothing else to update: the archived scripts read the same env var now.

**R2. `TURSO_AUTH_TOKEN`.**
1. Turso dashboard → database → *Create token* (least privilege: read/write on
   the fudcourt DB), copy it, then revoke the old token.
2. Update BOTH homes: repo-root `.env` and `apps/web/.env.local`.
3. Verify: `cd apps/web && node scripts/dump-schema.mjs --check` (RC 0) and
   `python3 scripts/sync-live.py` (RC 0); then `systemctl --user restart
   fudcourt-web` and `curl -s -o /dev/null -w '%{http_code}'
   http://127.0.0.1:3100/cryptorank` → 200.
4. Vercel: `cd apps/web && vercel env rm TURSO_AUTH_TOKEN && vercel env add
   TURSO_AUTH_TOKEN production` (paste at the prompt — the CLI never echoes it),
   redeploy.

**R3. `FUD_MUTATION_TOKEN` + `NEXT_PUBLIC_FUD_MUTATION_TOKEN` (always paired).**
1. Generate: `openssl rand -hex 32` (local shell, do not paste into chat).
2. Put the SAME value in both lines of `apps/web/.env.local` (server reads the
   private name; the client bundle inlines the `NEXT_PUBLIC_` name **at build**,
   so a one-sided change bricks writes on that side — fail-closed, not open).
3. `systemctl --user restart fudcourt-web`; verify locally: a `DELETE
   /api/transactions/<id>` **without** the header → 401 (proves the guard is
   live; never run it *with* the token against a real row).
4. Vercel: update both names under the `web` project, **redeploy** (build-time
   inlining), then verify prod: no-header mutation → 401.

**R4. `DATABASE_URL` (Neon) and `PAYLOAD_SECRET` (blog).**
1. Neon → Reset password (or a new connection string); update
   `apps/blog/.env`.
2. `PAYLOAD_SECRET`: `openssl rand -hex 32` → update `apps/blog/.env`.
   Rotating it invalidates all blog sessions (expected; re-login).
3. Verify: `systemctl --user restart fudcourt-blog` then
   `curl -s -o /dev/null -w '%{http_code}'
   'http://127.0.0.1:3001/api/posts?limit=1&depth=0'` → 200.
4. Vercel: add both to the `blog` project, redeploy, verify the same endpoint
   through the prod domain.

**R5. `VERCEL_OIDC_TOKEN`** — transient, re-issued by Vercel; stale values in
`apps/web/.env.local` may simply be deleted. Never rotated by hand.

## 6. Parity checklist (run at the next deploy — turns §3 into yes/no)

```bash
vercel whoami                                   # must print the account, not hang
cd apps/web  && vercel env ls                   # expect: TURSO_AUTH_TOKEN,
cd apps/blog && vercel env ls                   #   FUD_MUTATION_TOKEN,
                                                #   NEXT_PUBLIC_FUD_MUTATION_TOKEN,
                                                #   DATABASE_URL, PAYLOAD_SECRET
curl -s -o /dev/null -w '%{http_code}\n' 'https://<prod>/api/transactions'          # 200, rows present -> Turso live
curl -s -o /dev/null -w '%{http_code}\n' 'https://<prod>/blog/api/posts?limit=1'    # 200 -> Neon live
curl -s -o /dev/null -w '%{http_code}\n' 'https://<prod>/api/cryptorank?mode=home'  # 502 loud -> helper local-only, as designed
curl -s -o /dev/null -X DELETE -w '%{http_code}\n' 'https://<prod>/api/transactions/1' # 401 -> fail-closed live (NO token used here)
```

Any row that is `present locally` but `missing on Vercel` is a parity defect:
fix it with the matching §5 step (redeploy for every `NEXT_PUBLIC_*`).

## 7. Standing rules

- Never print a value: check existence/length only (`grep -c '^KEY=' .env`,
  `wc -c`). Never `echo $SECRET`, never log request headers with auth.
- Never `git log -S'<literal>'` with the literal typed in — read it from the
  env file in a script (as this audit did) so the command itself leaks nothing.
- Destructive methods with a valid credential never appear in a probe list
  (banked incident: a credentialed `DELETE` deleted row id=5).
- New secret added to first-party code → add its row to §1 and a step to §5 in
  the same commit; CI must stay secret-free.
