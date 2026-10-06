# Tech Stack — Fudcourt

Verified against head `5e68576` (= `origin/main`), 2026-09-29.

## 1. Languages (measured line counts, `apps/` as the tree then stood, 2026-09-29 10:18 UTC)

Measured with `find apps/web -name "*.<ext>"` (the path was `apps/web` when the
snapshot was taken — that directory no longer exists; see the header), excluding `node_modules/`, `.next/`,
the generated `.shaper-tests/` build dir (`scripts/archive/` no longer exists:
30 dead throwaway `.mjs` were removed in the 2026-09-29 structure pass); lines are
`cat` (blank lines included) piped to `wc -l` over that file set. The table is
a point-in-time snapshot and the tree was being edited while it was taken: over
10:01–10:21 UTC repeated runs gave `.ts` = 8,824 / 8,977 / 8,888 / 8,913 while
`.tsx` 6,233, `.py` 4,312, `.go` 5,008 and `.mts` 75 and every file count held
constant. Only the `.ts` line is volatile; re-run the command above for the live
number (file counts are stable).

| Language | Files | Lines | Share | Role |
|----------|------:|------:|------:|------|
| TypeScript (`.ts`) | 65 | 9,208 | 30% | API routes (now proxies), data libs, contracts |
| TSX (`.tsx`) | 47 | 6,519 | 21% | React UI (presentational primitives `src/components/ui/*.tsx` + `app/` route wrappers and `src/components/layout/store-shell.tsx`) |
| Python (`.py`) | 15 | 6,391 | 21% | Verification harnesses (six `verify-*.py`) + the fetch oracle (`cr_fetch.py`) |
| **Go (`.go`)** | **39** | **13,986** | **46%** | `apps/data`: the acquisition sidecar — FIVE families, one process (`cryptorank` tls-client fetch; `khala`, `llama`, `news`, `chainrank` plain `net/http`) plus `httpx` and the served-bytes parity oracle |
| MTScript (`.mts`) | 1 | 75 | <1% | Limiter stress harness |
| **Total** | **167** | **36,179** | | |
| Rust (`.rs`) | 10 | 1,901 | — | `apps/reconciler`: the balance sync (`fudcourt-sync`) **and** the `/api/reconcile` HTTP service (`fudcourt-reconciled`, DR-014) |

**Runtime weighting: Go and Rust own the backend** (46% of the tree's lines are Go; Rust owns the balance sync **and now a served HTTP surface**, DR-014), TypeScript owns the UI/API surface — the owner's stated direction. **Primary language by line count is now Go, not TypeScript.**
**Data-acquisition language: Go** (`apps/data`, [DR-005](../records/DECISIONS.md)) —
the one place where a browser-grade TLS fingerprint is required, so the one
place where the client must *be* a real TLS stack rather than shell out to one.
**Verification/automation language: Python** — chosen because the
reverse-engineering probes need `curl_cffi` (TLS-impersonating Chrome) and
Playwright, both Python-first. Since DR-005 the Python fetch path
(`tests/oracle/cr_fetch.py`) exists **only** as `verify-cryptorank.py`'s independent
oracle.

## 2. Frameworks & runtimes

Single-app tree: every version below is `apps/web/package.json` (DR-017 merged the
blog in); the repo root `package.json` declares **no dependencies** — scripts only.

| Component | Version | Notes |
|-----------|---------|-------|
| Next.js | **16.3.6** | App Router; one Next version across the repo (the blog merged into `apps/web`, DR-017, retiring the 16.3.5 divergence); all 36 `route.ts` under `apps/web/src/app/(frontend)/api` use `force-dynamic` |
| React | 19.2.0 | `react` + `react-dom`, declared in `apps/web/package.json` |
| Payload CMS | 3.89.0 | + `@payloadcms/next`, `@payloadcms/db-postgres`, `@payloadcms/richtext-lexical` |
| Tailwind CSS | 3.4.17 | styling |
| TypeScript | 5.9.3 | `apps/web` dev dependency; the root `package.json` declares none |
| Node.js | v22.22.3 installed; `@types/node` 22.10.2 (`apps/web`) | **fallback runtime only**: Node is still installed for rollback (DR-008) and for `node --test` inside `test:shapers`, but **no fudcourt unit runs on it** — the blog merged into `apps/web` (DR-017) and the last unit on Node moved to `bun --bun next start` in [DR-015](../records/DECISIONS.md) |
| **Bun** | **1.4.2** | installer, task runner and lockfile owner for the app (`bun install --frozen-lockfile`, `bun run …`, `bunx`) *and*, since [DR-008](../records/DECISIONS.md), the **runtime of `apps/web`**: `fudcourt-web.service` is `bun --bun …/next start -p 3100` (measured: the :3100 process's `/proc/<pid>/exe` is `~/.bun/bin/bun`), and `package.json`'s `start` is `bun --bun next start`. Equivalence evidence — build RC=0, same `BUILD_ID`, 15/15 pages, 401 gates, `X-RateLimit-*`, byte-identical `/api/khala` body (that web proxy route was later removed outright, DR-041; the check was a Bun-vs-Node runtime comparison, recorded here as history), byte-identical session signature, ccxt cold sweep 71.2 s (Node parity) — is in DR-008; the toolchain half is [DR-007](../records/DECISIONS.md) |
| Python | 3.12 (local `python3 -V` = 3.12.14) | harnesses + verification oracles (`cr_fetch.py`, `sync-live.py`). Still the language of the verify loop; no longer a runtime path (DR-005 moved the cryptorank fetch into Go, PLAN G9 SG-9.4 moved the balance sync into Rust) |
| **Backend framework** | **none, deliberately** ([DR-016](../records/DECISIONS.md)) | Go: stdlib `net/http` + `http.NewServeMux` (no gin/echo/chi/fiber); Rust: `tokio::net` + hand-rolled bounded HTTP/1.1 framing (zero new crates). The only HTTP client library in the backend is `tls-client`, confined to `apps/data/internal/research/cryptorank` where the Cloudflare ClientHello-fingerprint requirement lives — the other Go packages use plain `net/http`, all of them now through one shared, tuned outbound `http.Transport` in `apps/data/platform/httpx` (raised per-host idle-connection cap, bounded dial, explicit TLS 1.2 floor, HTTP/2 kept on) rather than the stdlib default |
| **Rust** | **1.98.1** (`cargo`) | `apps/reconciler` — two binaries: the live multi-chain balance sync -> Postgres `assets` (built, **not deployed**: the Python oracle is the deployed sync) (Alchemy EVM RPC, Solana RPC, Hyperliquid, `coins.llama.fi` prices), parity-checked against the Python oracle; and `fudcourt-reconciled`, the `/api/reconcile` HTTP service (**zero new crates**, `tokio::net` framing) whose output is diffed byte-for-byte against the TS shaper. Versioned units at `deploy/systemd/fudcourt-{sync-rust,reconciled}.service` |

## 3. Data stores

| Store | Used by | Connection | Contents |
|-------|---------|------------|----------|
| **Postgres 17 + TimescaleDB** | apps/web + `apps/reconciler` + `tests/oracle/sync-live.py` | Bun.sql pooled client (`platform/db/pg.ts`) → `FUDCOURT_PG_URL` (`postgres://…@127.0.0.1:5432/fudcourt`, Docker `postgres-hardened`) | **single system of record (DR-040)**: accounts, transactions, journal, ledger, assets, wallets, trades, venues + the `asset_history`/`price_history` hypertables |
| **Neon Postgres** | the merged app's CMS half (`src/cms`, was apps/blog) | `@payloadcms/db-postgres` via `DATABASE_URL` (pooler, ap-southeast-1) | payload schema: users, posts, media, categories, versions, KV, preferences |

The treasury store is **local and self-hosted** (DR-040); only the Neon CMS half is
managed cloud. The treasury schema is versioned at `db/schema/pg-schema.sql`
(hand-written DDL, `IF NOT EXISTS` throughout) — the generated SQLite dump and its
`dump-schema.mjs --check` drift alarm were deleted with Turso.

## 4. Infrastructure

| Piece | Detail |
|-------|--------|
| Local web | `fudcourt-web.service` (systemd --user, active) → `ExecStart=/home/dwizzy/.bun/bin/bun --bun /home/dwizzy/fudcourt/apps/web/node_modules/next/dist/bin/next start -p 3100` — Bun is the runtime ([DR-008](../records/DECISIONS.md)); absolute paths because a user unit's PATH has no `~/.bun/bin`, and `next` is addressed by its real entry rather than the `node_modules/.bin/next` shim (whose shebang is `#!/usr/bin/env node`). Unit versioned at `deploy/systemd/fudcourt-web.service` (identical to the installed unit, comments aside) |
| Local CryptoRank sidecar | `fudcourt-data.service` (systemd --user) → `apps/data/bin/fudcourt-data`, `:3101`; cache `~/.cache/fudcourt-data`, `Restart=always`. Unit versioned at `deploy/systemd/fudcourt-data.service` (identical to the installed unit) |
| Local Rust reconcile service | `fudcourt-reconciled.service` (systemd --user) → `apps/reconciler/target/release/fudcourt-reconciled`, `127.0.0.1:3102`, `Restart=always`, `EnvironmentFile` the repo `.env`; enabled at boot. **Zero new crates** (tokio `net`+`io-util`; serde_json `preserve_order` is a feature, not a package). Unit versioned at `deploy/systemd/fudcourt-reconciled.service` (identical to the installed unit). `/api/reconcile` on `:3100` proxies to it (DR-014) |
| Local blog | **Retired as a unit (DR-017)** — the blog is served by `fudcourt-web` on `:3100` at `/blog` (public), `/blog/cms/admin` (Payload admin) and `/blog/cms/api/*` (Payload REST/GraphQL). `fudcourt-blog.service` and `:3001` no longer exist; the retirement tombstone is `deploy/systemd/RETIRED-fudcourt-blog.service.txt` |
| Live sync | `fudcourt-sync.timer` → `OnUnitActiveSec=5min` → `fudcourt-sync.service` (`ExecStart=/usr/bin/python3 /home/dwizzy/fudcourt/tests/oracle/sync-live.py`, `WorkingDirectory=/home/dwizzy/fudcourt/apps/web` — the cwd-stable `bun` `ExecStartPost` for `apps/web/.env.local`) → Postgres `assets` (`FUDCOURT_PG_URL`) |
| Local Telegram bot | `fudcourt-bot.service` (systemd --user) → `apps/bot/bin/fudcourt-bot`, **stdlib-only Go module** `apps/bot`, long-poll (`getUpdates`, no webhook, no port), `EnvironmentFile` the repo-root `.env` (`FUDCOURT_TELEGRAM_BOT_TOKEN` — the same key `notify` sends with), `Restart=always`. The **receiving half** of the notification channel; see [bot.md](bot.md). Unit versioned at `deploy/systemd/fudcourt-bot.service` (identical to the installed unit) |
| Deploy | Self-hosted only (DR-002: no third-party deploy target; the Vercel projects are unused/deletable — `apps/web/vercel.json` does not exist, the orphan `.vercel/` link dir is gitignored). The legacy `/portfolio` redirect lives in `apps/web/next.config.js`: `redirects` `/portfolio` → `/team/portfolio` (307) + `rewrites` `/portfolio/:path*` → `/:path*` |
| Monorepo layout | apps/web + apps/data (+ apps/reconciler, apps/api, apps/executor) on disk; **apps/blog is gone (DR-017)**; **no npm `workspaces` field** anywhere (root `package.json` has none — per-app install, each app owns its lockfile, and `npm run <script> --workspace=…` fails with "No workspaces found"). Each app's lockfile is `bun.lock` (Bun 1.4.2) and installs are `bun install --frozen-lockfile`; `npm ci` is not a supported path. **No `package-lock.json` exists anywhere in the tree today** (the root one that once listed the long-gone `apps/balance` / `apps/gateway` has been removed) |
| Git remote | `github.com/anvxxr-arch/fudcourt`, branch `main` |

## 5. Market-data acquisition stack (no API keys, by decision)

```
Browser/agent  ──►  GET /api/cryptorank?mode=…[&key=…][&fresh=1]   (:3100)
                        │  THIN PROXY: forwards the query string verbatim and
                        │  returns the sidecar's body/status/headers unchanged
                        ▼  (no validation, no shaping, no second implementation)
                 apps/data  Go service, fudcourt-data :3101   [DR-005]
                        │  mode/key validation · 400 bad key · 404 upstream miss
                        │  503 decoy refusal (funding/unlocks) · disk cache TTL
                        │  429 backoff-retry ×3 · fetch with
                        │  tls-client chrome_131 ClientHello + HTTP/2
                        ▼
                 cryptorank.io  <script id="__NEXT_DATA__"> SSR payload
                        ▼
                 apps/data/internal/research/cryptorank (Go) → JSON envelope  →  proxy  →  UI panels
```

- **Why Go, measured (spike 2026-09-29, `/home/dwizzy/apicalls-probe/RESULTS.txt`):**
  Cloudflare fingerprints the TLS **ClientHello**, not the request headers. On
  `/all-coins-list`: plain `net/http` with a full Chrome 131 header set → **403**
  (`cf-mitigated: challenge`, 5,979 B); hand-rolled `uTLS HelloChrome_131` over
  **HTTP/1.1** → **403** (6,022 B); the same over HTTP/2 → 200 / 738,673 B;
  `tls-client` profile `chrome_131` → **200** / 738,673 B, `__NEXT_DATA__`
  177,442 B. So *both* a Chrome-131 ClientHello *and* HTTP/2 are required —
  either alone is still a 403. Go reproduces the `curl_cffi chrome131` baseline
  at the JSON level (same `buildId 45c3c525`; `coins[0]` identical at
  `price.USD 83553.22691715157`), which is why one implementation replaced two.
- **Why HTML RE:** `api.cryptorank.io` answers a Cloudflare managed challenge to
  every non-browser client; market pages serve full SSR payloads.
- **Verification stack:** `verify-cryptorank.py` (244 checks incl. ground truth vs
  coins.llama.fi + CoinGecko + publisher-title/oembed GATE3). It keeps driving
  the **Python** oracle `tests/oracle/cr_fetch.py` against the same upstream while
  checking the **Go-served** origin, so the two clients still cross-check each
  other (DR-005); plus Playwright DOM audit (`apps/web/tests/dom_audit.py`,
  4 checks — measured 3 passed / 1 failed: `/tracker` table rows = 0), plus sibling harnesses
  `scripts/verify/verify-{llama,news,chainrank,dex,signals}.py` and `apps/web/tests/verify-limiter.mts`.
- **Offline shaper tests:** `bun run test:shapers` (node --test; shaper/fixture + auth
  + inbound rate-limit suites, ~0.5s)
  runs `apps/web/src/features/cryptorank/shapers.ts` against 26 recorded upstream payloads (`.json.gz`) in
  `tests/fixtures/` (sha256-pinned in `MANIFEST.json`: 26 pinned hashes,
  re-record with `bun run record:fixtures`; `ls tests/fixtures/*.gz | wc -l` = 26). Wired into the pre-push hook and the CI web job, so
  upstream template drift is a red test instead of a silent UI change.
  `scripts/verify/check-contract.py` additionally asserts the Go mode table in
  `apps/data/internal/research/cryptorank/modes.go` **equals** its TS mirror, so the two
  languages can no longer disagree about what a mode is.

## 6. External data sources (independent truth)

| Source | Used for |
|--------|----------|
| coins.llama.fi | price parity gate for every coin-price surface |
| CoinGecko API | quarterly returns daily history; total-mcap sanity band |
| Publisher pages (`<title>`) | news GATE3 ground truth |
| YouTube oembed | media GATE3 ground truth (title + channel per video id) |
| Official exchange announcements / league schedules / official quotes | launchpool, prediction, rwa GATE3 |

## apps/web layout (DR-018)
One `src/` tree — the placement rule, enforced by `apps/web/scripts/checks/check-structure.py`:
```
src/app/         routes only ((frontend)/ route groups (public)|(dashboard)|(admin) + api/, blog/ CMS + frontend) + middleware.ts
src/features/    one slice per data family: client + shaper/types + its panel
src/platform/    auth/  cache/  db/  executor/  http/  routing/   (cross-cutting; never imports a feature)
src/components/  ui/ primitives (leaf) + layout/ the SPA state container that composes features
src/styles/      design tokens + shared view types (leaf)
src/cms/         Payload config, collections, migrations
```
One import alias: `@/x` is `src/x`. Nothing else — no `@lib/`, no layered `../` chains.
## docs/ layout (DR-018)
```
docs/README.md          index — start here
docs/product/           what it is and who it is for   (PRD, ANALYSIS, RECOMMENDATIONS)
docs/architecture/      how it is built                (ARCHITECTURE, TECH-STACK, SCHEMA)
docs/operations/        how it runs / what changed     (PLAN, SECRETS, CHANGELOG)
docs/records/           why each decision was made     (DECISIONS, append-only)
```

## Data layer (DR-040)
```
PostgreSQL 17 + TimescaleDB    SINGLE SYSTEM OF RECORD (local, :5432, db `fudcourt` —
  - accounts/assets/journal/ledger/trades/transactions/venues/wallets   Docker `postgres-hardened`)
  - asset_history, price_history  hypertables (time series; 90-day retention)
  |    writers: sync-live.py (psycopg2) · apps/reconciler (tokio-postgres, uninstalled)
  |             · the web (platform/db/client.ts) · the Rust reconciler
  |    asset_history is appended by the `assets_snapshot` TRIGGER on `assets` INSERT
  |
Bun.sql                        query()/execute() — every read and write is local Postgres

Valkey :6379                   shared L2, survives restarts
  - sidecar (apps/data/platform/cache, valkey-go)  llama / chainrank / news
  - web (platform/cache/valkey.ts, Bun)     the ticker venue sweep
  Both FAIL OPEN: disabled/unreachable/unreadable all mean "do the work as before".
```
There is no read-model split to gate (DR-040 retired the projection, the
`parity-pg.ts` harness and the `fudcourt-pgload` timer together). The SQLite
dialect is still translated in one place, `toPostgres` in `platform/db/pg.ts`,
for the hand-written route statements.
