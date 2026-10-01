# Security model
> Reality-first. Written 2026-10-01. Every claim names a file.
> Sources: `frontend/web/src/platform/auth/{session,guard,mutation}.ts`,
> `frontend/web/src/middleware.ts`, `frontend/web/src/platform/executor/store.ts`,
> `frontend/web/src/platform/executor/{runtime,exchange,types,lock}.ts`,
> `database/schema/executor-schema.sql`, PRD §43–§47, §108–§110,
> `docs/operations/SECRETS.md`, `backend/api/internal/audit/audit.go`.

## 1. Session auth
- **Discord OAuth2 + one HMAC-signed cookie.** `fud_session` is HMAC-SHA256,
  httpOnly + Secure + SameSite=Lax (docs/architecture/ARCHITECTURE.md §5);
  sign/verify in `frontend/web/src/platform/auth/session.ts`.
- **`FUDCOURT_SESSION_SECRET` fail-closed, ≥ 32 chars.** `sessionSecret()`
  (`session.ts`) returns null below 32 chars; without a valid secret **no
  session can be signed or verified** — every tier is unreachable, reads return
  null, signing throws. A forged/stale cookie degrades to anonymous
  (`readSession`), never to an error page.
- **Tier guard: `public < member < team < admin`, per path.** The single route
  policy is `requiredTierForPath` in `frontend/web/src/platform/auth/guard.ts`
  (`/team`→team, `/admin`→admin, `/member`→member, `/executor`→team + team API
  routes); `frontend/web/src/middleware.ts` consumes it before a route runs —
  protected pages redirect to `/login?next=…`, protected APIs get JSON 401.
  `hasTier` is the rank comparison (admin > team > member); pages and API
  handlers re-check server-side (`requireTier`, `mutation.ts`). Missing
  guild/role env can only **lower** access (unresolvable member → member).
- The executor surface is `team`-tier and owner-scoped: every store statement
  binds `user_id`; a wrong owner reads `null`/`[]` and the API answers **404**
  (existence is not leaked) — DR-021 §2e.

## 2. Credential vault (BYOK, non-custodial)
One connected account = one credential set (`executor.exchange_accounts`,
merged §59+§45 — `database/schema/executor-schema.sql`):

| Property | Rule | Evidence |
|---|---|---|
| Cipher | **AES-256-GCM per field** — each secret sealed individually (`api_key`, `api_secret`, `passphrase`) | `store.ts` `sealSecret`/`sealCredentials` |
| Nonce/tag | fresh **12-byte IV + 16-byte tag per secret** (a GCM nonce must never repeat under one key), concatenated in **fixed column order: api_key, api_secret, [passphrase]** | `store.ts` `IV_LEN`/`TAG_LEN`, envelope helpers; `executor-schema.sql` `iv`, `auth_tag` columns ("12-byte IV + 16-byte tag per secret, in column order") |
| Master key | `FUDCOURT_EXECUTOR_MASTER_KEY` from env — 64 hex chars = 32 bytes; missing/malformed ⇒ every credential operation **throws** (fail-closed); the key never enters Postgres | `store.ts` `masterKeyFromEnv` (PRD §44) |
| Rotation | `rotateCredentialKeys` re-encrypts all secrets under a new master key; a lost key is unrecoverable by design (no escrow) | `store.ts` `rotateAccounts`/`rotateUpdate`, DR-021 §2c |
| Plaintext path | exactly one, server-side: `store.revealCredentials(userId, id)`, user-scoped, used at the adapter boundary only; never returned to a browser, never logged, never in an error | `store.ts`, DR-021 §2d |
| References outside the vault | **credential_id-only**: execution/fill/order rows reference `account_id` (FK → `executor.exchange_accounts(id)`) and carry no key material; only the masked key (`api_key_masked`) leaves the vault layer | `executor-schema.sql` FKs; `types.ts` `CredentialRecord.apiKeyMasked` |

Masked display is `abc...xyz` (`maskApiKey`, `types.ts`; `***` for ≤8 chars) —
the full key exists in exactly one column, encrypted.

## 3. Never-secrets
Plaintext key material (API secret, full API key, signed payload, auth headers
— PRD §109's forbidden list) appears in **no** surface:

| Surface | Rule | Evidence |
|---|---|---|
| logs | PRD §109 allowed list only (exchange, account id, execution id, symbol, order id, status, latency, error code) | PRD §109 |
| events | events never carry credentials/secrets | `docs/architecture/events.md` §4 |
| analytics | analytics tables (`assets`, `asset_history`, `price_history`) hold market data only — no credential columns exist | `database/schema/schema.sql` |
| audit | `Redact` replaces values under sensitive keys with `[REDACTED]`, recursively, before storage | `backend/api/internal/audit/audit.go` |
| frontend state | secrets leave the browser exactly once (connect form) and are cleared immediately; the API only ever answers with the masked key | `ui.tsx` comment + PRD §109 |
| URLs | secrets never travel in URLs; request URLs carry ids and filters only | `frontend/web/src/features/executor/client.ts` |
| errors | `mapError` + `SECRET_PATTERNS` sanitize adapter errors so no key/secret/passphrase or signed payload can appear in an `ExecutorError` | `frontend/web/src/platform/executor/exchange.ts` (PRD §109) |

Persistence stores only `api_key_masked` + the sealed envelope; the E2E asserts
a secret appears in neither API payloads nor raw DB rows (DR-021 measured
evidence; `tests/integration/executor/executor-store-tests.ts` §44/§109 tests).

## 4. Withdrawal permission policy
**FUDCourt NEVER requests, holds, or uses withdrawal capability** (PRD §43:
"withdrawal permission harus dianggap unsupported dan undesirable").

- The connect/test probe reports `withdraw: false` — it is never requested
  (`exchange.ts` `AccountPermissions` construction).
- A key whose restrictions report `withdraw: true` is **refused at
  connect/test** with the reason spelled out (`runtime.ts` —
  "withdrawal permission not supported", PRD §43).
- `AccountPermissions.withdraw` semantics (`types.ts`): MUST be false or null
  in effect; `null` = venue silent; `true` would mean the **user** granted it
  on the key — the UI MUST render that as a warning
  (`ui.tsx` renders `· remove it` in red when `withdraw === true`).
- Recommended key permissions remain Read + Spot Trading + Futures Trading
  (PRD §43). FUDCourt is non-custodial: funds never leave the exchange.

## 5. Fail-closed list
Every safety control fails **closed** (refuse/pause/no-op), never open:

| Control | Env / mechanism | Failure behavior | Evidence |
|---|---|---|---|
| Live trading kill switch | `FUDCOURT_EXECUTOR_LIVE=1` (server-side only, never client) | unset ⇒ live creation refused 403; live executions **PAUSE** at the placement boundary (recoverable); paper + reconciliation keep running | `runtime.ts`, `worker.ts` `liveBlocked`, PRD §108/§118 |
| Session secret | `FUDCOURT_SESSION_SECRET` ≥ 32 chars | no session at all; every tier unreachable | `session.ts` |
| Credential master key | `FUDCOURT_EXECUTOR_MASTER_KEY` (64 hex) | credential operations throw; nothing is stored or decrypted | `store.ts` |
| Execution lock | Valkey `execution:{id}:lock`, `SET NX PX` + compare-and-act Lua; Go `internal/lock` mirrors it | any lock error ⇒ `acquire` false ("the caller must not trade"), `Renew` false (lease lost); only `release` is best-effort | `lock.ts` ("FAIL-CLOSED … a lock that fails open means duplicate orders"), `internal/lock/lock.go` |
| Lifecycle transitions | table-driven `EXECUTION_TRANSITIONS` | illegal transition refused (409 naming both states); terminal states accept nothing | `types.ts`, `internal/executor/lifecycle.go` |
| Live tests | opt-in per service via env; never in default runs | skip unless explicitly enabled | `backend/data`: `FUDCOURT_DATA_LIVE=1` gates `internal/cryptorank/live_test.go` (README §live smoke); executor suites run OFFLINE, no venue (`executor-worker-tests.ts` header); `bun run verify:executor` is env-gated on `FUDCOURT_EXECUTOR_MASTER_KEY` and was **run green** on 2026-10-01 with a dev key in the gitignored `frontend/web/.env.local` (`current.md` §2) |

Reality note (2026-10-01): the tree contains **no** `FUDCOURT_LIVE_TESTS`
flag and no `backend/data/tests/live/` directory — the live-test gate that
exists today is `FUDCOURT_DATA_LIVE=1` in `backend/data`. Any `FUDCOURT_LIVE_TESTS`
convention is in flight and must be labelled as such until it lands.
