# Tech Stack — Fudcourt

Verified against remote head `957836d`, 2026-09-27.

## 1. Languages (measured line counts, `apps/`, excluding node_modules/.next)

| Language | Files | Lines | Share | Role |
|----------|------:|------:|------:|------|
| TypeScript (`.ts`) | 32 | 4,918 | 36% | API routes, data libs, contracts |
| TSX (`.tsx`) | 34 | 5,212 | 38% | React UI (12 pages + board components) |
| Python (`.py`) | 7 | 3,497 | 26% | Fetch helper, verification harnesses, live sync |
| MTScript (`.mts`) | 1 | 75 | 1% | Limiter stress harness |
| **Total** | **74** | **~13,700** | | |

**Primary language: TypeScript** (UI + API + contracts, ~74%).
**Verification/automation language: Python** (~26%) — chosen because the
reverse-engineering probes need `curl_cffi` (TLS-impersonating Chrome) and
Playwright, both Python-first.

## 2. Frameworks & runtimes

| Component | Version | Notes |
|-----------|---------|-------|
| Next.js (apps/web) | **14.2.0** | App Router, `force-dynamic` API routes |
| React (apps/web) | 18.3.1 | |
| Next.js (apps/blog + root) | **16.3.5** | Version divergence from web — see ANALYSIS R-3 |
| React (blog/root) | 19.2.0 | |
| Payload CMS | 3.89.0 | + `@payloadcms/next`, `@payloadcms/db-postgres`, lexical richtext |
| Tailwind CSS | 3.4.17 | styling for web |
| TypeScript | 5.7.2 (web) / 5.9.3 (root) | |
| Node.js | 22 types (`@types/node` 20/22) | systemd units run `npx next start` / `npm run start` |
| Python | 3.12 | helper + harnesses |

## 3. Data stores

| Store | Used by | Connection | Contents |
|-------|---------|------------|----------|
| **Turso** (libSQL) | apps/web | `@libsql/client` → `libsql://fud-balance-anvxxr.aws-ap-northeast-1.turso.io`, token `TURSO_AUTH_TOKEN` | accounts, transactions, journal, ledger, assets, wallets, trades |
| **Neon Postgres** | apps/blog | `@payloadcms/db-postgres` via `DATABASE_URL` (pooler, ap-southeast-1) | payload schema: users, posts, media, categories, versions, KV, preferences |

No local database: both stores are managed cloud (schema for Turso is
**server-side only**, not versioned in the repo — see RECOMMENDATIONS R-1).

## 4. Infrastructure

| Piece | Detail |
|-------|--------|
| Local web | `fudcourt-web.service` (systemd --user) → `npx next start -p 3100` |
| Local blog | `fudcourt-blog.service` (systemd --user) → `npm run start` → `:3001` (recreated 2026-09-27; was missing) |
| Live sync | `fudcourt-sync.timer` → `OnUnitActiveSec=5min` → `sync-live.py` → Turso `assets` |
| Deploy | Vercel (`apps/web/vercel.json`): `/portfolio` → `/` rewrites |
| Monorepo | npm workspaces (`dev/build` per workspace at root) |
| Git remote | `github.com/anvxxr-arch/fudcourt`, branch `main` |

## 5. Market-data acquisition stack (no API keys, by decision)

```
Browser/agent  ──►  /api/cryptorank?mode=…        (Next route, mode-only input)
                        │  validation: 400 bad key / 404 upstream miss / 503 decoy refusal
                        ▼
                 scripts/cr_fetch.py              (dedicated venv: curl_cffi, chrome131 TLS)
                        │  path allowlist (exact + regex), cache TTL, 429 backoff-retry ×3
                        ▼
                 cryptorank.io  <script id="__NEXT_DATA__"> SSR payload
                        ▼
                 route shapers → CrEnvelope JSON  →  UI panels
```

- **Why HTML RE:** `api.cryptorank.io` answers a Cloudflare managed challenge to
  every non-browser client; market pages serve full SSR payloads.
- **Verification stack:** `verify-cryptorank.py` (244 checks incl. ground truth vs
  coins.llama.fi + CoinGecko + publisher-title/oembed GATE3), plus Playwright DOM
  audit (109 checks), plus sibling harnesses `verify-{llama,chainrank,dex,signals}.py`
  and `verify-limiter.mts`.

## 6. External data sources (independent truth)

| Source | Used for |
|--------|----------|
| coins.llama.fi | price parity gate for every coin-price surface |
| CoinGecko API | quarterly returns daily history; total-mcap sanity band |
| Publisher pages (`<title>`) | news GATE3 ground truth |
| YouTube oembed | media GATE3 ground truth (title + channel per video id) |
| Official exchange announcements / league schedules / official quotes | launchpool, prediction, rwa GATE3 |
