# Secrets inventory & rotation runbook (SG-4.2 / R-9)

**Rule zero: this document never contains a secret value — names, locations and
commands only.** Length checks are done with `wc -c`, never by printing.

Audit date: 2026-09-28 (blog merged into frontend/web 2026-09-30, DR-017). Scope: `frontend/web`, repo root, GitHub
Actions CI, and the **self-hosted production** on the homeserver
(`192.168.100.6`, systemd user units). Hosting model: **DR-002 — no Vercel
deploy**; see [DECISIONS.md](../records/DECISIONS.md).

## 1. Inventory

| Name | Consumers (first-party) | Home (file) | Production consumer | CI needs it? |
|------|------------------------|-------------|---------------------|--------------|
| `TURSO_AUTH_TOKEN` | `frontend/web/src/platform/db/client.ts`, `backend/sync/src/persistence/db.rs`, `frontend/web/scripts/tools/sync-live.py`, `scripts/database/dump-schema.mjs` | `./.env` (root) + `frontend/web/.env.local` | `fudcourt-web` (:3100) + `fudcourt-sync.timer` + `fudcourt-reconciled` (:3102, `EnvironmentFile` the repo-root `.env`; it REFUSES TO START without the token) | no |
| `ALCHEMY_KEY` | `frontend/web/scripts/tools/sync-live.py` (live ETH RPC) + `frontend/web/scripts/archive/*.mjs` (forensic one-offs **deleted 2026-09-29**, after the rotation was recorded) | `./.env` (root) | `fudcourt-sync.timer` | no |
| `FUDCOURT_BOT_TOKEN` | `src/app/(frontend)/api/auth/callback` + `src/app/(frontend)/(admin)` (reads guild member roles with the bot) | `frontend/web/.env.local` | `fudcourt-web` | no |
| `FUDCOURT_CLIENT_SECRET` | `src/app/(frontend)/api/auth/callback` (OAuth code exchange) | `frontend/web/.env.local` | `fudcourt-web` | no |
| `FUDCOURT_SESSION_SECRET` | `src/platform/auth/session.ts` (HMAC key for the `fud_session` cookie) | `frontend/web/.env.local` | `fudcourt-web` | no |
| `FUD_MUTATION_TOKEN` + `NEXT_PUBLIC_FUD_MUTATION_TOKEN` | **RETIRED** — superseded by the session tier. `NEXT_PUBLIC_…` was inlined at build time and shipped in a public JS chunk; the pair is safe to delete from `.env.local` and `.env` | — | — | no |
| `DATABASE_URL` (Neon) | Payload blog (now `frontend/web/src/cms`, DR-017) | `frontend/web/.env.local` | `fudcourt-web` (:3100) | no (build works without it — verified) |
| `PAYLOAD_SECRET` | Payload blog (sessions/cookies) | `frontend/web/.env.local` | `fudcourt-web` (:3100) | no |
| `CR_PYTHON` | interpreter for the **verifier oracle** `tests/oracle/cr_fetch.py` (no longer a runtime path — DR-005: the route proxies to `fudcourt-data`) | code default (`~/.venvs/crfetch/bin/python`) | `verify-cryptorank.py` runs on this host | no |
| `FUDCOURT_DATA_URL` | upstream base of the CryptoRank route's proxy target | code default (`http://127.0.0.1:3101`) | `fudcourt-web` (`:3100`) | no |
| `VERCEL_OIDC_TOKEN` (legacy residue) | — none anymore — | `frontend/web/.env.local` | — | no — **safe to delete this line** |
| **`FUDCOURT_EXECUTOR_MASTER_KEY`** (added with the CEX Executor, DR-021) | `src/platform/executor/store.ts` — seals/opens every exchange credential (AES-256-GCM) and is read by `scripts/executor/worker.ts` indirectly through the store | `frontend/web/.env.local` (**never** committed; git-ignored) | `fudcourt-web` (`:3100`) + `fudcourt-executor-worker` | no |
| `FUDCOURT_EXECUTOR_LIVE` | not a secret — the §108 **kill switch**; `=1` is the only value that enables live order placement | `frontend/web/.env.local` (absent = paper only) | `fudcourt-executor-worker` | no |

`./frontend/web/.next/standalone/…/.env` is a *build artifact copy* on local disk
(`.next/` is git-ignored) — re-created on every build, never edit it. (It was
`apps/blog/.next/…` before the DR-017 merge.)

## 2. Audit findings (evidence-based)

1. **No `.env` file was ever committed.** `git log --all --diff-filter=A
   --name-only | grep -E '(^|/)\.env'` → empty.
2. **RESOLVED — an Alchemy key literal lived in the tracked tree.**
   `frontend/web/scripts/tools/sync-live.py` carried it as a `os.environ.get(…, '<literal>')`
   default and **14 `frontend/web/scripts/archive/*.mjs` scripts embedded it as (that directory was removed in the 2026-09-29 structure pass; the finding and the rotation step below are unchanged)
   `const KEY = '<literal>'`**, introduced in commit `3678b10` ("initial:
   monorepo") — so it is also in **git history**. Fixed in this change: the
   sync now uses `require_env('ALCHEMY_KEY')` (loud stop, no fallback) and the
   archive scripts read `process.env.ALCHEMY_KEY ?? ''` (`node --check` green on
   all 14). **Because history retains the old value, ROTATION IS MANDATORY —
   see §5 step R1 (human step, Alchemy dashboard).**
3. **RESOLVED — dead credential fallback.** `sync-live.py` used to "recover" a
   Turso token by slicing quote-delimited bytes out of `lib/db.ts` (now
   `frontend/web/src/platform/db/client.ts`), which since
   the env-ref rewrite can only ever yield the *text* `process.env…` — garbage
   credentials. Removed; both creds now come from the repo-root `.env` via
   `load_env()` or the run stops with an explicit error. Verified by running the
   script (RC 0, real sync, net worth reported).
4. **`frontend/web/src/platform/db/client.ts` / `scripts/database/dump-schema.mjs` are clean** — Turso *URL* is public form
   (`libsql://…turso.io`), the token is `process.env`-only.
5. **CI requires zero secrets.** The GitHub Actions web job (contract + tsc +
   build + shaper fixture tests) and blog job pass with no env configured.
6. **Local env files are git-ignored** (root `.gitignore` `.env*` with
   `.env.example` exception) and `frontend/web/.env.local` was already
   removed from the spike worktree before deletion (SG-3.3).
7. **`fudcourt-sync` systemd timer carries no credentials of its own** —
   `Environment=` only clears `NODE_ENV`; secrets come from `load_env()` reading
   the repo-root `.env`. Rotation therefore needs only the `.env` edit + the
   next 5-minute tick.

## 3. Production model (self-hosted, DR-002)

Production == this homeserver:

| Surface | Unit | Bind | Credential source |
|---------|------|------|-------------------|
| Board + CryptoRank proxy (`frontend/web`) | `fudcourt-web.service` | `127.0.0.1:3100` | `frontend/web/.env.local` (+ repo-root `.env` for shared vars) |
| Blog / Payload (merged into `frontend/web`, DR-017) | `fudcourt-web.service` | `127.0.0.1:3100` (`/blog`, `/blog/cms/*`) | `frontend/web/.env.local` |
| Live balance sync | `fudcourt-sync.timer` (5 min) | — (outbound only) | repo-root `.env` via `load_env()` |
| CEX Executor API + composer (`frontend/web`) | `fudcourt-web.service` | `127.0.0.1:3100` (`/executor`, `/api/executor`, tier `team`) | `frontend/web/.env.local` (`FUDCOURT_EXECUTOR_MASTER_KEY`; exchange API secrets are **not** in any env file) |
| CEX Executor worker | `fudcourt-executor-worker.service` (`bun scripts/executor/worker.ts`, unit versioned at `infrastructure/systemd/fudcourt-executor-worker.service`) | — (outbound only: venue APIs) | `frontend/web/.env.local` via the unit's `EnvironmentFile`; **independent of `fudcourt-web`** — restarting the web unit never stops an execution |

- **No third-party deploy target.** The `fudcourt.vercel.app` domain answers
  `404 DEPLOYMENT_NOT_FOUND` (measured 2026-09-28) — there is nothing deployed
  and nothing to keep in parity. Residual `.vercel/` directories and the
  `VERCEL_OIDC_TOKEN` line are leftovers: optional cleanup, no functional use
  (the tracked `frontend/web/vercel.json` was removed; its `/portfolio` rewrite now
  lives in `frontend/web/next.config.js`, so the path works on any host).
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

- `CR_PYTHON` points at the curl_cffi venv **on this host**, and since DR-005 it
  is read only by the verification oracle (`tests/oracle/cr_fetch.py`), never by a
  request. The CryptoRank runtime is the Go `fudcourt-data` service
  (`fudcourt-data`, `:3101`); `/api/cryptorank` is a thin proxy to it, so a
  stopped sidecar is a loud 502 rather than a silent fallback.
- Auth is **fail-closed**: no `FUDCOURT_SESSION_SECRET` (or one under 32 chars)
  means no session can be signed or verified, so every gated surface — reads
  *and* writes — is refused rather than open. Missing Discord guild/role env
  can only lower access.
- **Exchange API credentials are never an environment secret** — they are
  **BYOK**: the user pastes them once into `/executor/accounts`, and each secret is
  sealed **individually** with **AES-256-GCM** under a fresh 12-byte IV and stored in
  the `executor.exchange_accounts` row (`api_key_encrypted`,
  `api_secret_encrypted`, `passphrase_encrypted`, plus the concatenated
  `iv`/`auth_tag` — 12 + 16 bytes per secret). Per-field sealing means a wrong key or
  a tampered row **throws** on the GCM tag rather than returning garbage.
- **`FUDCOURT_EXECUTOR_MASTER_KEY` must be exactly 64 hex chars (32 bytes)** —
  `masterKeyFromEnv()` refuses anything else, and its absence is **fail-closed**:
  credential operations throw and nothing is stored or decrypted. Generate with
  `openssl rand -hex 32`. The key lives **outside Postgres** (only the sealed bytes
  do), **must never be committed** (it belongs in the git-ignored
  `frontend/web/.env.local`), and **must never be printed** — check with
  `grep -c '^FUDCOURT_EXECUTOR_MASTER_KEY=' frontend/web/.env.local` (expect 1), never by
  echoing the value. The key is read lazily at first use, so a missing key surfaces
  as a credential operation throwing, not as the worker refusing to boot.
- **Decryption is server-side only.** The store's `revealCredentials` is the ONLY
  plaintext path; API responses carry the masked `CredentialRecord`
  (`apiKeyMasked`, `***` when the key is ≤8 chars) and never the secret, and adapter
  errors are sanitised by `mapError` so no key, secret, passphrase or signed payload
  can reach a log or an error body. Wrong owner ⇒ the row is not visible at all
  (`null`/`[]` server-side, 404 at the API).
- **A lost master key is unrecoverable by design** (there is no escrow): the sealed
  bytes are unreadable, and the operator must re-connect the exchange accounts.
  Rotate with `store.rotateCredentialKeys(newKey, oldKey)`, not by deleting rows.
- **`FUDCOURT_EXECUTOR_LIVE` is the kill switch, not a credential**: unset or
  anything other than `1` pauses live executions at the placement boundary while
  paper mode and reconciliation keep running.

## 5. Rotation procedures (run in order; verify after each)

**R1. `ALCHEMY_KEY` (URGENT — value is in git history).**
1. Human step: Alchemy dashboard → app → API Keys → *Rotate key* (old key dies
   immediately; the copy in commit `3678b10` becomes useless).
2. Update the value in the repo-root `.env` (`ALCHEMY_KEY=…` — edit in a local
   editor, never `cat`/`grep` it into logs).
3. Verify: `cd frontend/web && python3 scripts/tools/sync-live.py` → RC 0 and a real net
   worth line (the run stops with `missing ALCHEMY_KEY` if step 2 was skipped).
4. Nothing else to update: the archived scripts read the same env var now.

**R2. `TURSO_AUTH_TOKEN`.**
1. Turso dashboard → database → *Create token* (least privilege: read/write on
   the fudcourt DB), copy it, then revoke the old token.
2. Update BOTH homes: repo-root `.env` and `frontend/web/.env.local`.
3. Verify: `node scripts/database/dump-schema.mjs --check` (RC 0, from the repo root) and
   `cd frontend/web && python3 scripts/tools/sync-live.py` (RC 0); then `systemctl --user restart
   fudcourt-web` and `curl -s -o /dev/null -w '%{http_code}'
   http://127.0.0.1:3100/cryptorank` → 200.

**R3. Discord OAuth trio + session secret.** (Added with the tier split; the
old `FUD_MUTATION_TOKEN` pair is retired and can simply be deleted from
`frontend/web/.env.local`.)
1. `FUDCOURT_BOT_TOKEN`: Developer Portal → Bot → *Reset Token*. Never echo it.
2. `FUDCOURT_CLIENT_SECRET`: Developer Portal → OAuth2 → *Reset Secret*.
3. `FUDCOURT_SESSION_SECRET`: `openssl rand -hex 32` → `frontend/web/.env.local`.
   **Rotating it signs out every session** (expected). A value shorter than 32
   chars is treated as unset, which disables sessions entirely (fail-closed:
   every tier unreachable, never wide open).
4. Update `frontend/web/.env.local`, then `systemctl --user restart fudcourt-web`.
5. Verify: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/all`
   → **401** (proves the guard is live; never test with a real team session),
   and `/login` → 200 with a Discord link.

**R4. `DATABASE_URL` (Neon) and `PAYLOAD_SECRET` (blog).**
1. Neon → Reset password (or a new connection string); update
   `frontend/web/.env.local`.
2. `PAYLOAD_SECRET`: `openssl rand -hex 32` → update `frontend/web/.env.local`.
   Rotating it invalidates all blog sessions (expected; re-login).
3. Verify: `systemctl --user restart fudcourt-web` then
   `curl -s -o /dev/null -w '%{http_code}'
   'http://127.0.0.1:3100/blog/cms/api/posts?limit=1&depth=0'` → 200.

**R5. `VERCEL_OIDC_TOKEN`** — legacy residue from the retired Vercel target;
delete the line from `frontend/web/.env.local`. Nothing reads it.

**R6. `FUDCOURT_EXECUTOR_MASTER_KEY` (added with the CEX Executor, DR-021).**
1. Generate a new key: `openssl rand -hex 32` → **64 hex chars**. Never `echo` it
   into a terminal that logs; paste it into `frontend/web/.env.local` in a local editor.
2. Re-encrypt the existing sealed secrets under the new key rather than deleting
   rows: call `store.rotateCredentialKeys(newMasterKey, oldMasterKey)` once, then
   verify a credential still opens (the count it returns is the number of accounts
   re-sealed).
3. Verify: `systemctl --user restart fudcourt-executor-worker` then
   `systemctl --user is-active fudcourt-executor-worker` → active. A malformed key
   (not 64 hex chars) throws at the first credential operation with
   `FUDCOURT_EXECUTOR_MASTER_KEY missing or malformed …` — fail-closed, never a
   silent plaintext fallback. Note the boot path itself does not read the key: the
   scheduler starts and the failure surfaces when it opens a credential, so a
   missing key shows up as executions failing to place orders, not as a dead unit.
4. Only then replace the value in `frontend/web/.env.local` and restart
   `fudcourt-web`. Verify `/api/executor/accounts` still answers 200 for a team
   session with masked keys only.
5. If the key was exposed (committed, pasted, logged): rotate as above **and**
   revoke/reissue the exchange API keys — the executor stores them sealed, but a
   leaked master key decrypts every account it protects.

## 6. Production verification checklist (self-hosted)

```bash
systemctl --user is-active fudcourt-web                  # active (serves the blog too)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/cryptorank      # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/portfolio       # 200 (rewrite kept)
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3100/blog/cms/api/posts?limit=1&depth=0'  # 200 -> Neon live
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3100/api/transactions'           # 200, rows -> Turso live
curl -s -o /dev/null -X DELETE -w '%{http_code}\n' 'http://127.0.0.1:3100/api/transactions/1'  # 401 -> fail-closed (NO token used here)
cd ../.. && (cd frontend/web && python3 scripts/checks/check-structure.py) && python3 scripts/verify/check-contract.py && (cd frontend/web && bun run test:shapers)   # offline gates
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
