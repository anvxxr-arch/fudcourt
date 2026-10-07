# Secrets inventory & rotation runbook (SG-4.2 / R-9)

**Rule zero: this document never contains a secret value — names, locations and
commands only.** Length checks are done with `wc -c`, never by printing.

Audit date: 2026-09-28 (blog merged into apps/web 2026-09-30, DR-017). Scope: `apps/web`, repo root, GitHub
Actions CI, and the **self-hosted production** on the homeserver
(`192.168.100.6`, systemd user units). Hosting model: **DR-002 — no Vercel
deploy**; see [DECISIONS.md](../records/DECISIONS.md).

## 1. Inventory

| Name | Consumers (first-party) | Home (file) | Production consumer | CI needs it? |
|------|------------------------|-------------|---------------------|--------------|
| `FUDCOURT_PG_URL` (Postgres DSN, DR-040) | `apps/web/src/platform/db/client.ts`, `apps/reconciler/src/persistence/db.rs`, `tests/oracle/sync-live.py` | `./.env` (root) + `apps/web/.env.local` (documented in `apps/web/.env.example`) | `fudcourt-web` (:3100) + `fudcourt-sync.timer` + `fudcourt-reconciled` (:3102, `EnvironmentFile` the repo-root `.env`) + `fudcourt-digest.timer` (weekly) | no |
| `ALCHEMY_KEY` | `tests/oracle/sync-live.py` (live ETH RPC) + the forensic `apps/web/scripts/archive/*.mjs` one-offs (**deleted 2026-09-29**, after the rotation was recorded) | `./.env` (root) | `fudcourt-sync.timer` | no |
| `FUDCOURT_BOT_TOKEN` | `src/app/(frontend)/api/auth/callback` + `src/app/(frontend)/(admin)` (reads guild member roles with the bot) | `apps/web/.env.local` | `fudcourt-web` | no |
| `FUDCOURT_CLIENT_SECRET` | `src/app/(frontend)/api/auth/callback` (OAuth code exchange) | `apps/web/.env.local` | `fudcourt-web` | no |
| `FUDCOURT_SESSION_SECRET` | `src/platform/auth/session.ts` (HMAC key for the `fud_session` cookie) | `apps/web/.env.local` | `fudcourt-web` | no |
| `FUD_MUTATION_TOKEN` + `NEXT_PUBLIC_FUD_MUTATION_TOKEN` | **RETIRED** — superseded by the session tier. `NEXT_PUBLIC_…` was inlined at build time and shipped in a public JS chunk; the pair is safe to delete from `.env.local` and `.env` | — | — | no |
| `DATABASE_URL` (Neon) | Payload blog (now `apps/web/src/cms`, DR-017) | `apps/web/.env.local` | `fudcourt-web` (:3100) + `fudcourt-digest.timer` | no (build works without it — verified) |
| `PAYLOAD_SECRET` | Payload blog (sessions/cookies) | `apps/web/.env.local` | `fudcourt-web` (:3100) + `fudcourt-digest.timer` | no |
| `CR_PYTHON` | interpreter for the **verifier oracle** `tests/oracle/cr_fetch.py` (no longer a runtime path — DR-005: the route proxies to `fudcourt-data`) | code default (`~/.venvs/crfetch/bin/python`) | `verify-cryptorank.py` runs on this host | no |
| `FUDCOURT_DATA_URL` | upstream base of the CryptoRank route's proxy target | code default (`http://127.0.0.1:3101`) | `fudcourt-web` (`:3100`) | no |
| `VERCEL_OIDC_TOKEN` (legacy residue) | — none anymore — | `apps/web/.env.local` | — | no — **safe to delete this line** |
| **`FUDCOURT_EXECUTOR_MASTER_KEY`** (added with the CEX Executor, DR-021) | `apps/executor/internal/platform/credentials` — seals/opens every exchange credential (AES-256-GCM); was previously read by `apps/web/scripts/executor/worker.ts` through the TS `store.ts`, both now retired (DR-043) | `apps/web/.env.local` (**never** committed; git-ignored) | `fudcourt-executor.service` (:3104 + :3105) | no |
| `FUDCOURT_EXECUTOR_LIVE` | not a secret — the §108 **kill switch**; `=1` is the only value that enables live order placement; was previously read by the TS worker (retired 2026-10-05, DR-043); the Go worker honours it as well | `apps/web/.env.local` (absent = paper only) | `fudcourt-executor.service` | no |
| `FUDCOURT_TELEGRAM_BOT_TOKEN` (the bot's Bot API token) | `apps/bot/internal/config/config.go` (the bot's **only** credential) + `apps/executor/internal/notify/telegram.go` (the sending half — same key) | `./.env` (root) — git-ignored, 0600 | `fudcourt-bot.service` (long-poll) + `fudcourt-executor.service` (notifications) | no |

`./apps/web/.next/standalone/…/.env` is a *build artifact copy* on local disk
(`.next/` is git-ignored) — re-created on every build, never edit it. (It was
`apps/blog/.next/…` before the DR-017 merge.)

## 2. Audit findings (evidence-based)

1. **No `.env` file was ever committed.** `git log --all --diff-filter=A
   --name-only | grep -E '(^|/)\.env'` → empty.
2. **RESOLVED — an Alchemy key literal lived in the tracked tree.**
   `tests/oracle/sync-live.py` carried it as a `os.environ.get(…, '<literal>')`
   default and **14 `apps/web/scripts/archive/*.mjs` scripts embedded it as (that directory was removed in the 2026-09-29 structure pass; the finding and the rotation step below are unchanged)
   `const KEY = '<literal>'`**, introduced in commit `3678b10` ("initial:
   monorepo") — so it is also in **git history**. Fixed in this change: the
   sync now uses `require_env('ALCHEMY_KEY')` (loud stop, no fallback) and the
   archive scripts read `process.env.ALCHEMY_KEY ?? ''` (`node --check` green on
   all 14). **Because history retains the old value, ROTATION IS MANDATORY —
   see §5 step R1 (human step, Alchemy dashboard).**
3. **RESOLVED — dead credential fallback.** `sync-live.py` used to "recover" a
   Turso token by slicing quote-delimited bytes out of `lib/db.ts` (now
   `apps/web/src/platform/db/client.ts`), which since
   the env-ref rewrite can only ever yield the *text* `process.env…` — garbage
   credentials. Removed; both creds now come from the repo-root `.env` via
   `load_env()` or the run stops with an explicit error. Verified by running the
   script (RC 0, real sync, net worth reported).
4. **`apps/web/src/platform/db/client.ts` is clean** — the DSN is
   `process.env`-only (`FUDCOURT_PG_URL`), never a literal. (The Turso token
   and its `dump-schema.mjs` reader were removed with the store by DR-040.)
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
| Blog / Payload (merged into `apps/web`, DR-017) | `fudcourt-web.service` | `127.0.0.1:3100` (`/blog`, `/blog/cms/*`) | `apps/web/.env.local` |
| Live balance sync | `fudcourt-sync.timer` (5 min) | — (outbound only) | repo-root `.env` via `load_env()` |
| Weekly treasury digest → blog (F12) | `fudcourt-digest.timer` (Mon 06:00 UTC, oneshot) | — (writes the CMS) | `apps/web/.env.local` (`FUDCOURT_PG_URL` + `DATABASE_URL` + `PAYLOAD_SECRET`) |
| CEX Executor API + composer (`apps/web`) | `fudcourt-web.service` | `127.0.0.1:3100` (`/executor`, `/api/executor`, tier `team`) | `apps/web/.env.local` (`FUDCOURT_EXECUTOR_MASTER_KEY`; exchange API secrets are **not** in any env file) |
| CEX Executor worker (TS, **TOMBSTONE — retired 2026-10-05 by DR-043; was retired from runtime by DR-042**) | `fudcourt-executor-worker.service` → renamed to `deploy/systemd/RETIRED-fudcourt-executor-worker.service.txt` (preserves history; the unit is **not installed**); the entry script is preserved at `apps/web/scripts/executor/worker.ts` with a tombstone header. The live executor is the Go service below. | — (was outbound only: venue APIs) | `apps/web/.env.local` was the unit's `EnvironmentFile`; that file still carries the executor env names (the Go service reads the same ones). Restarting `fudcourt-web` never stopped an execution; the Go service is the runtime now. |
| CEX Executor **Go** service (`apps/executor`, `7b8dc2d`) | `fudcourt-executor.service` (unit versioned at `deploy/systemd/fudcourt-executor.service`) | `127.0.0.1:3104` (`/healthz`+`/readyz`) and `127.0.0.1:3105` (`/api/executor/*`, `FUDCOURT_EXECUTOR_API_ADDR`) | Needs `FUDCOURT_SESSION_SECRET` (it verifies the same `fud_session` cookie the web tier signs — the unit documents this coupling and deliberately does **not** set the secret itself) + `FUDCOURT_EXECUTOR_PG_URL` + `FUDCOURT_EXECUTOR_MASTER_KEY`. **Env is fail-visible: the unit cannot start until `FUDCOURT_SESSION_SECRET` and `FUDCOURT_EXECUTOR_PG_URL` are present in the process env** (name-only; no value here). Also reads `VALKEY_ADDR`+`VALKEY_PASSWORD` (distributed leases; the host requires AUTH). **Sole live web path since 2026-10-05 (DR-043):** `fudcourt-web` thin-proxies `/api/executor/*` to `:3105` via `src/app/(frontend)/api/executor/_proxy.ts`; the TS executor runtime (`apps/web/src/platform/executor/**`) was retired in this pass and the wire contract is the only survivor at `src/platform/executor/types.ts`. |
| Telegram bot (`apps/bot`, stdlib-only Go) | `fudcourt-bot.service` (unit versioned at `deploy/systemd/fudcourt-bot.service`) | — (outbound only: long-poll `getUpdates` to the Bot API; **opens no port**, so it is not in the tunnel ingress) | repo-root `.env` as its `EnvironmentFile` (`FUDCOURT_TELEGRAM_BOT_TOKEN`, name-only above) — the same `.env` the executor reads, so the token has one home. The **receiving half** of the notification channel; see [bot.md](../architecture/bot.md) |

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
  the credentials package's `masterKeyFromEnv()` refuses anything else, and its
  absence is **fail-closed**: credential operations throw and nothing is stored
  or decrypted. Generate with `openssl rand -hex 32`. The key lives **outside
  Postgres** (only the sealed bytes do), **must never be committed** (it
  belongs in the git-ignored `apps/web/.env.local`), and **must never be
  printed** — check with `grep -c '^FUDCOURT_EXECUTOR_MASTER_KEY='
  apps/web/.env.local` (expect 1), never by echoing the value. The key is
  read lazily at first use, so a missing key surfaces as a credential operation
  throwing, not as the worker refusing to boot.
- **Decryption is server-side only.** The Go credentials package's
  `RevealCredentials` is the ONLY plaintext path; API responses carry the
  masked `CredentialRecord` (`apiKeyMasked`, `***` when the key is ≤8 chars)
  and never the secret, and adapter errors are sanitised so no key, secret,
  passphrase or signed payload can reach a log or an error body. Wrong owner ⇒
  the row is not visible at all (`null`/`[]` server-side, 404 at the API).
- **A lost master key is unrecoverable by design** (there is no escrow): the
  sealed bytes are unreadable, and the operator must re-connect the exchange
  accounts. Rotate with the credentials package's `RotateMasterKey(newKey,
  oldKey)`, not by deleting rows.
- **`FUDCOURT_EXECUTOR_LIVE` is the kill switch, not a credential**: unset or
  anything other than `1` pauses live executions at the placement boundary while
  paper mode and reconciliation keep running.

## 5. Rotation procedures (run in order; verify after each)

**R1. `ALCHEMY_KEY` (URGENT — value is in git history).**
1. Human step: Alchemy dashboard → app → API Keys → *Rotate key* (old key dies
   immediately; the copy in commit `3678b10` becomes useless).
2. Update the value in the repo-root `.env` (`ALCHEMY_KEY=…` — edit in a local
   editor, never `cat`/`grep` it into logs).
3. Verify: `python3 tests/oracle/sync-live.py` → RC 0 and a real net
   worth line (the run stops with `missing ALCHEMY_KEY` if step 2 was skipped).
4. Nothing else to update: the archived scripts read the same env var now.

**R2. `FUDCOURT_PG_URL`.** (Postgres replaced the Turso token entirely — DR-040.)
1. Rotate the `fudcourt` role's password in the `postgres-hardened` container,
   then rebuild the DSN.
2. Update BOTH homes: repo-root `.env` and `apps/web/.env.local`.
3. Verify: `python3 tests/oracle/sync-live.py` (RC 0, real sync); then
   `systemctl --user restart fudcourt-web` and `curl -s -o /dev/null -w
   '%{http_code}' http://127.0.0.1:3100/cryptorank` → 200. The weekly
   digest reads the same DSN, so also `systemctl --user restart
   fudcourt-digest.timer` (its next run picks up the new DSN).

**R3. Discord OAuth trio + session secret.** (Added with the tier split; the
old `FUD_MUTATION_TOKEN` pair is retired and can simply be deleted from
`apps/web/.env.local`.)
1. `FUDCOURT_BOT_TOKEN`: Developer Portal → Bot → *Reset Token*. Never echo it.
2. `FUDCOURT_CLIENT_SECRET`: Developer Portal → OAuth2 → *Reset Secret*.
3. `FUDCOURT_SESSION_SECRET`: `openssl rand -hex 32` → `apps/web/.env.local`.
   **Rotating it signs out every session** (expected). A value shorter than 32
   chars is treated as unset, which disables sessions entirely (fail-closed:
   every tier unreachable, never wide open).
4. Update `apps/web/.env.local`, then `systemctl --user restart fudcourt-web`.
5. Verify: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/all`
   → **401** (proves the guard is live; never test with a real team session),
   and `/login` → 200 with a Discord link.

**R4. `DATABASE_URL` (Neon) and `PAYLOAD_SECRET` (blog).**
1. Neon → Reset password (or a new connection string); update
   `apps/web/.env.local`.
2. `PAYLOAD_SECRET`: `openssl rand -hex 32` → update `apps/web/.env.local`.
   Rotating it invalidates all blog sessions (expected; re-login).
3. Verify: `systemctl --user restart fudcourt-web` then
   `curl -s -o /dev/null -w '%{http_code}'
   'http://127.0.0.1:3100/blog/cms/api/posts?limit=1&depth=0'` → 200. The
   weekly digest writes the same CMS, so also `systemctl --user restart
   fudcourt-digest.timer`.

**R5. `VERCEL_OIDC_TOKEN`** — legacy residue from the retired Vercel target;
delete the line from `apps/web/.env.local`. Nothing reads it.

**R6. `FUDCOURT_EXECUTOR_MASTER_KEY` (added with the CEX Executor, DR-021).**
1. Generate a new key: `openssl rand -hex 32` → **64 hex chars**. Never `echo` it
   into a terminal that logs; paste it into `apps/web/.env.local` in a local editor.
2. Re-encrypt the existing sealed secrets under the new key rather than deleting
   rows: call the Go credentials package's `RotateMasterKey(newMasterKey,
   oldMasterKey)` once, then verify a credential still opens (the count it
   returns is the number of accounts re-sealed).
3. Verify: `systemctl --user restart fudcourt-executor.service` then
   `systemctl --user is-active fudcourt-executor.service` → active. A malformed key
   (not 64 hex chars) throws at the first credential operation with
   `FUDCOURT_EXECUTOR_MASTER_KEY missing or malformed …` — fail-closed, never a
   silent plaintext fallback. Note the boot path itself does not read the key: the
   scheduler starts and the failure surfaces when it opens a credential, so a
   missing key shows up as executions failing to place orders, not as a dead unit.
4. Only then replace the value in `apps/web/.env.local` and restart
   `fudcourt-web`. Verify `/api/executor/accounts` still answers 200 for a team
   session with masked keys only.
5. If the key was exposed (committed, pasted, logged): rotate as above **and**
   revoke/reissue the exchange API keys — the executor stores them sealed, but a
   leaked master key decrypts every account it protects.

**R7. `FUDCOURT_TELEGRAM_BOT_TOKEN` (added with the bot, 2026-10-06).**
1. BotFather → `/mybots` → the bot → *API Token* → **Revoke current token**. The old
   token dies immediately, which silently kills both halves of the channel at once.
2. Replace the single line in the repo-root `.env` (`FUDCOURT_TELEGRAM_BOT_TOKEN=…` —
   edit in a local editor, never `cat`/`grep` it into logs). There is exactly **one**
   home: the bot and the executor's `notify` read the same file, so do not create a
   second copy in `apps/web/.env.local`.
3. `systemctl --user restart fudcourt-bot.service` **and**
   `systemctl --user restart fudcourt-executor.service` — unlike the master-key case
   (read lazily), a stale token breaks both ends immediately.
4. Verify (name-only, never print the value):
   `grep -c '^FUDCOURT_TELEGRAM_BOT_TOKEN=' ./.env` → **1**;
   `systemctl --user is-active fudcourt-bot.service` → `active`;
   `getMe` → `@fudbase_bot`; `getMyCommands` → the 8 public commands
   ([bot.md](../architecture/bot.md) §6). A second concurrent `getUpdates` from the
   same token answering `409 Conflict` confirms the restarted bot is polling.

## 6. Production verification checklist (self-hosted)

```bash
systemctl --user is-active fudcourt-web                  # active (serves the blog too)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/cryptorank      # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/portfolio       # 200 (rewrite kept)
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3100/blog/cms/api/posts?limit=1&depth=0'  # 200 -> Neon live
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3100/api/transactions'           # 200, rows -> Postgres live
curl -s -o /dev/null -X DELETE -w '%{http_code}\n' 'http://127.0.0.1:3100/api/transactions/1'  # 401 -> fail-closed (NO token used here)
grep -c '^FUDCOURT_SESSION_SECRET=' apps/web/.env.local   # 1 (existence only -- never print the value)
python3 apps/web/tests/verify_all_routes.py               # "# session: signed admin cookie accepted"; ZERO "[ENV: ...]" groups
cd ../.. && (cd apps/web && python3 scripts/checks/check-structure.py) && python3 scripts/verify/check-contract.py && (cd apps/web && bun run test:shapers)   # offline gates
systemctl --user is-active fudcourt-bot.service    # active (long-polls Telegram; opens no port)
```

The `verify_all_routes.py` line is the parity check for the tier split: the sweep
discovers the key from the listening process's own `/proc/<pid>/environ`, mints an
admin `fud_session` and expects the groups `mut` (7) and `gate-auth` (3) to be
PRESENT. If either group is missing, or any row carries
`[ENV: no FUDCOURT_SESSION_SECRET discoverable …]`, the secret is not in the
running unit's environment — fix with §5 R3, not by weakening a guard. (Rows that
fail against *upstreams* — `cryptorank`, `news`, coinank's dark 502 — are
external drift, not this checklist's subject.)

A var that is set in the §1 home file but missing at runtime shows up as one of
these checks failing loudly — fix with the matching §5 step (rebuild for every
`NEXT_PUBLIC_*`).

### Change log

| Date | Change | Evidence (no value recorded) |
|------|--------|------------------------------|
| 2026-10-06 | **`FUDCOURT_TELEGRAM_BOT_TOKEN`** added to §1/§3/§5 with the `apps/bot` receiver. The name already lived in `./.env` (the executor's `notify` is the sending half); what is new is a second first-party consumer, so the rotation step now names both units. No new home, no new file. | `grep -c '^FUDCOURT_TELEGRAM_BOT_TOKEN=' ./.env` → 1; `getMe` → `@fudbase_bot`; `getMyCommands` → 8 public commands; `systemctl --user is-active fudcourt-bot.service` → active; `.env` stays git-ignored (`.gitignore` `.env*`), 0600 (name/length only — no value recorded) |
| 2026-10-05 | **K-11** — `FUDCOURT_SESSION_SECRET` set in `apps/web/.env.local` (§5 R3 step 3): `openssl rand -hex 32`, append-only edit, `systemctl --user restart fudcourt-web`. | `grep -c '^FUDCOURT_SESSION_SECRET='` → 1; listening pid environ shows the name at len 64; sweep now prints `# session: signed admin cookie accepted (secret from listening pid <pid> environ)` and runs the 7 `mut` + 3 `gate-auth` probes (10/10 pass); the fail-closed controls still answer 401. File stays git-ignored (`.gitignore` `.env*`), 0600. |

**Open gap this change does NOT close (tracked as K-12).** `/api/auth/login`
still answers **500 `auth_unconfigured`**, and it is *not* a session-secret
symptom: the Go api (`apps/api`, `fudcourt-api.service`, `:3103`) refuses
because `FUDCOURT_CLIENT_ID` and `DISCORD_REDIRECT_URI` are absent from its own
`EnvironmentFile` (repo-root `.env`, which currently holds only `ALCHEMY_KEY`,
`FUDCOURT_DATA_VALKEY_PASSWORD`, `FUDCOURT_PG_URL`). Two couplings to note when
K-12 is picked up: the route is **GET-only** (`POST` → 405; the `Set-Cookie` is
minted by `/api/auth/callback` after the Discord round-trip, never by `/login`
itself), and the Go api also reads `FUDCOURT_SESSION_SECRET` from that same
`EnvironmentFile`, so it needs a second home for a key §1 currently records as
`apps/web/.env.local`-only — decide that home explicitly in K-12 rather than
letting two silent copies drift.

## 7. Standing rules

- Never print a value: check existence/length only (`grep -c '^KEY=' .env`,
  `wc -c`). Never `echo $SECRET`, never log request headers with auth.
- Never `git log -S'<literal>'` with the literal typed in — read it from the
  env file in a script (as this audit did) so the command itself leaks nothing.
- Destructive methods with a valid credential never appear in a probe list
  (banked incident: a credentialed `DELETE` deleted row id=5).
- New secret added to first-party code → add its row to §1 and a step to §5 in
  the same commit; CI must stay secret-free.
