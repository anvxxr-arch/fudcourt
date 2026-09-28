# Secrets inventory & rotation runbook (SG-4.2 / R-9)

**Rule zero: this document never contains a secret value — names, locations and
commands only.** Length checks are done with `wc -c`, never by printing.

Audit date: 2026-09-28. Scope: `apps/web`, `apps/blog`, repo root, GitHub
Actions CI, and the **self-hosted production** on the homeserver
(`192.168.100.6`, systemd user units). Hosting model: **DR-002 — no Vercel
deploy**; see [DECISIONS.md](./DECISIONS.md).

## 1. Inventory

| Name | Consumers (first-party) | Home (file) | Production consumer | CI needs it? |
|------|------------------------|-------------|---------------------|--------------|
| `TURSO_AUTH_TOKEN` | `apps/web/lib/db.ts`, `scripts/sync-live.py`, `scripts/dump-schema.mjs` | `./.env` (root) + `apps/web/.env.local` | `fudcourt-web` (:3100) + `fudcourt-sync.timer` (both read the repo-root `.env` via `load_env()`) | no |
| `ALCHEMY_KEY` | `apps/web/scripts/sync-live.py` (live ETH RPC) + `apps/web/scripts/archive/*.mjs` (forensic one-offs) | `./.env` (root) | `fudcourt-sync.timer` | no |
| `FUD_MUTATION_TOKEN` | `apps/web/lib/mutation-auth.ts` (server, fail-closed `x-fud-token`) | `apps/web/.env.local` | `fudcourt-web` (read at build+run; restart after change) | no |
| `NEXT_PUBLIC_FUD_MUTATION_TOKEN` | client guard — **inlined at build time** | `apps/web/.env.local` | `fudcourt-web` (build must be re-run) | no |
| `DATABASE_URL` (Neon) | Payload blog (`apps/blog/src`) | `apps/blog/.env` | `fudcourt-blog` (:3001) | no (build works without it — verified) |
| `PAYLOAD_SECRET` | Payload blog (sessions/cookies) | `apps/blog/.env` | `fudcourt-blog` | no |
| `CR_PYTHON` | cryptorank route helper interpreter path | code default (`~/.venvs/crfetch/bin/python`) | `fudcourt-web` (the venv lives on this host) | no |
| `VERCEL_OIDC_TOKEN` (legacy residue) | — none anymore — | `apps/web/.env.local` | — | no — **safe to delete this line** |

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

## 3. Production model (self-hosted, DR-002)

Production == this homeserver:

| Surface | Unit | Bind | Credential source |
|---------|------|------|-------------------|
| Board + CryptoRank proxy (`apps/web`) | `fudcourt-web.service` | `127.0.0.1:3100` | `apps/web/.env.local` (+ repo-root `.env` for shared vars) |
| Blog / Payload (`apps/blog`) | `fudcourt-blog.service` (enabled) | `127.0.0.1:3001` | `apps/blog/.env` |
| Live balance sync | `fudcourt-sync.timer` (5 min) | — (outbound only) | repo-root `.env` via `load_env()` |

- **No third-party deploy target.** The `fudcourt.vercel.app` domain answers
  `404 DEPLOYMENT_NOT_FOUND` (measured 2026-09-28) — there is nothing deployed
  and nothing to keep in parity. Residual `.vercel/` directories and the
  `VERCEL_OIDC_TOKEN` line are leftovers: optional cleanup, no functional use
  (the tracked `apps/web/vercel.json` was removed; its `/portfolio` rewrite now
  lives in `apps/web/next.config.js`, so the path works on any host).
- **Vercel-side parity is moot by decision**, not "unverified": the audit
  question is retired with DR-002. If the projects are ever wanted, the only
  required env names are exactly the §1 rows.
- **Exposure: public via Cloudflare Tunnel, origin stays loopback.** The units
  bind `127.0.0.1` only; the sole path in is the tunnel ingress
  `fc.dwirijal.my.id → http://127.0.0.1:3100` (proxied CNAME, zone
  `dwirijal.my.id`). Verified public: page 200, cryptorank 200 with real
  upstream JSON, mutation without token → **401** (fail-closed holds on the
  public hostname).

## 4. Runtime surfaces

- `CR_PYTHON` points at the curl_cffi venv **on this host**; the cryptorank
  helper is a spawned process and works in production because production *is*
  this host (no serverless sandbox in the path).
- Mutation auth is **fail-closed**: if `FUD_MUTATION_TOKEN` is absent, every
  write is refused (401) rather than open — absence degrades to safe, on LAN
  and on any future public exposure alike.

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

**R3. `FUD_MUTATION_TOKEN` + `NEXT_PUBLIC_FUD_MUTATION_TOKEN` (always paired).**
1. Generate: `openssl rand -hex 32` (local shell, do not paste into chat).
2. Put the SAME value in both lines of `apps/web/.env.local` (server reads the
   private name; the client bundle inlines the `NEXT_PUBLIC_` name **at build**,
   so a one-sided change bricks writes on that side — fail-closed, not open).
3. Rebuild + restart (`npm run build`, `systemctl --user restart fudcourt-web`);
   verify: a `DELETE /api/transactions/<id>` **without** the header → 401 (proves
   the guard is live; never run it *with* the token against a real row).

**R4. `DATABASE_URL` (Neon) and `PAYLOAD_SECRET` (blog).**
1. Neon → Reset password (or a new connection string); update
   `apps/blog/.env`.
2. `PAYLOAD_SECRET`: `openssl rand -hex 32` → update `apps/blog/.env`.
   Rotating it invalidates all blog sessions (expected; re-login).
3. Verify: `systemctl --user restart fudcourt-blog` then
   `curl -s -o /dev/null -w '%{http_code}'
   'http://127.0.0.1:3001/api/posts?limit=1&depth=0'` → 200.

**R5. `VERCEL_OIDC_TOKEN`** — legacy residue from the retired Vercel target;
delete the line from `apps/web/.env.local`. Nothing reads it.

## 6. Production verification checklist (self-hosted)

```bash
systemctl --user is-active fudcourt-web fudcourt-blog      # both: active
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/cryptorank      # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/portfolio       # 200 (rewrite kept)
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3001/api/posts?limit=1&depth=0'  # 200 -> Neon live
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3100/api/transactions'           # 200, rows -> Turso live
curl -s -o /dev/null -X DELETE -w '%{http_code}\n' 'http://127.0.0.1:3100/api/transactions/1'  # 401 -> fail-closed (NO token used here)
cd apps/web && python3 scripts/check-contract.py && npm run test:shapers        # offline gates
```

A var that is set in the §1 home file but missing at runtime shows up as one of
these checks failing loudly — fix with the matching §5 step (rebuild for every
`NEXT_PUBLIC_*`).

## 7. Standing rules

- Never print a value: check existence/length only (`grep -c '^KEY=' .env`,
  `wc -c`). Never `echo $SECRET`, never log request headers with auth.
- Never `git log -S'<literal>'` with the literal typed in — read it from the
  env file in a script (as this audit did) so the command itself leaks nothing.
- Destructive methods with a valid credential never appear in a probe list
  (banked incident: a credentialed `DELETE` deleted row id=5).
- New secret added to first-party code → add its row to §1 and a step to §5 in
  the same commit; CI must stay secret-free.
