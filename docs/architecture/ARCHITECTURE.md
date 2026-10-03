# Architecture — fudcourt
> **The clear map** of what this repo actually is: two apps, **14 views**, **10 data
> families**, one self-hosted origin. Written 2026-09-28 during the
> repurpose/re-alignment pass — every row below was read out of the running
> system (routes on disk, live probes), not from memory. When this file and
> the code disagree, the code wins and this file is wrong: fix it same day.
>
> Counts are re-derived, never inherited. **Re-derived 2026-10-03 UTC** by
> reading the code: **14** views = `TEAM_TABS` (5) + `BOARD_TABS` (**4**) + the five
> market-hub section views in `src/components/layout/store-shell.tsx`; the §3 registry
> enumerates the shell views plus the tier surfaces around them, so it carries **18** rows. **10** data families = the §4
> table rows. Re-derived 2026-10-03 the app carries **40** `/api` route handlers under
> `src/app/(frontend)/api/**` (3 auth + 37 data incl. the executor surface and the
> keyless-proxy families) — the older **21** *(2026-09-29; 18 data + 3 auth)* and **36**
> *(2026-10-01; 3 auth + 33 data)* counts are kept as the dated measurements they were.
> `find "frontend/web/src/app/(frontend)/api" -name route.ts` = **40** today, three of them
> `src/app/(frontend)/api/auth/*`; the **chainrank** and **khala** Next proxy routes are gone
> with their boards (DR-041). Sitemap: **11** static routes in `src/platform/routing/public-routes.ts` + **30**
> `TICKER_SYMBOLS` = **41** `<loc>` (the `/chainrank` and `/khala` entries left `PUBLIC_ROUTES` with DR-041).
>
> **The `chainrank` and `khala` web surfaces are removed (DR-041):** their page routes, feature
> slices and Next proxy routes are gone, so `:3100` serves neither path. Both Go families STAY —
> the `fudcourt-data` sidecar registers `/api/chainrank` and `/api/khala` on its mux and reports
> them on `/healthz` → `{"build":"28 modes","chainrank":"2 modes","khala":"3 modes"}` — so the §4
> rows describe **sidecar-only** families and `verify-chainrank.py` / `verify-khala.py` remain
> their live harnesses.

## 1. Product statement

**fudcourt = a self-hosted crypto data platform with a personal treasury OS
inside it, plus a blog at `/blog`.** One Next.js 16 app (the blog merged in by
DR-017) on the homeserver:

| | What it answers | Where |
|---|---|---|
| Treasury OS | what do I own / is it accounted for | `frontend/web` views `dashboard, portfolio, wallets, transactions, reconciliation` |
| Market intelligence | what is the market doing — prices, ranks, chains, DEX, launches, news, signals, research | `frontend/web` views `ticker, tracker, trench, dex, signals, scoreboard, cryptorank, llama, news` (the `chainrank` and `khala` families are sidecar-only, DR-041) |
| Publishing | what's the story | `frontend/web` → `/blog`, Payload CMS merged in (DR-017) |

Public entry: **https://fc.dwirijal.my.id** (Cloudflare Tunnel → loopback
origin; DR-002 — no third-party deploy target, ever).

## 2. System picture

```
                    ┌─ Cloudflare Tunnel (39bdfeef…) ─────────────────┐
 browser ──HTTPS──▶  │ fc.dwirijal.my.id → 127.0.0.1:3100            │
 (LAN or public)    │ (blog served by :3100 at /blog — DR-017)        │
                    └────────────────┬────────────────────────────────┘
                                     ▼
   ┌──────────────────── frontend/web (Next 16, fudcourt-web) ────────────────────┐
   │  src/app/(frontend)/page.tsx = SPA shell (initialPage state + tab nav + db)│
   │  src/app/(frontend)/<view>/page.tsx = deep-link wrapper → <StoreShell …> │
   │  src/app/(frontend)/api/* = 40: 37 data (families §4 + admin §5 + executor)│
   │                            + 3 auth                                     │
   └──────┬────────────────────────────────────────────┬──────────────────────┘
          │ Postgres (treasury, synced every 5 min     │ keyless upstreams:
          │ by fudcourt-sync.timer → backend/sync,     │ chainrank.fyi RE,
          │ the Rust port; sync-live.py = oracle)      │ api.llama.fi (served by
          ▼                                            │ fudcourt-data §4 llama),
   ┌────────────────────┐                              │ dexscreener,
   │ frontend/web (Payload)│  Neon Postgres (DATABASE_URL)│ api.coingecko.com,
   │  /blog + /blog/cms│  (same app, same process)    │ cointelegraph RSS,
   └────────────────────┘                              │ data-public.vercel.app
                                                       │ www.khala.io (Framer SSR;
                                                       │ plain net/http — PLAN G8)
                                                       ▼
                                          src/platform/http/rate-limit.ts (shared limiter for the
                                          families still fetched here: min-gap + TTL
                                          cache + single-flight)

          │ cryptorank.io, api.llama.fi and khala.io are NOT fetched here any
          ▼ more — /api/{cryptorank,llama} are thin proxies (no validation,
            no shaping; body+status forwarded verbatim; DR-005/009)
   ┌───────── backend/data (Go, fudcourt-data :3101) ──────────┐
   │  three families, three clients (DR-005/006/008):               │
   │  · cryptorank: mode/key validation, disabled-mode refusal      │
   │    (503), disk cache, 429 backoff, tls-client chrome_131       │
   │    ClientHello + HTTP/2 (the only combo measured to beat       │
   │    Cloudflare's ClientHello fingerprinting)                    │
   │  · khala (DR-006) and llama (DR-009): plain net/http, own      │
   │    cache, HTML/JSON shaping — no fingerprint needed            │
   └──────────────────────────────┬─────────────────────────────────┘
                                  ▼ cryptorank.io <script id="__NEXT_DATA__">
```
`tests/oracle/cr_fetch.py` is retained **only** as the independent oracle of
`verify-cryptorank.py` (it is what makes the harness a cross-check rather than
a self-confirmation); it is no longer a runtime path — [DR-005](../records/DECISIONS.md).

The **`khala`** family lives in the same sidecar (PLAN G8, [DR-006](../records/DECISIONS.md))
with a deliberately **different client**: a plain `net/http` fetcher in a single Go
package `backend/data/internal/research/khala/`. Measured upstream (2026-09-29): khala.io answers **200** to a
non-browser UA with no Cloudflare in the path at all, so the `chrome_131`
ClientHello stack above is **required for cryptorank only and must never be
generalised** into a shared client (DR-006, DESIGN.md D1/D9). Its web board is removed
(DR-041); it is registered on the sidecar's mux and served API-only (measured: `:3101/healthz` →
`{"build":"28 modes","khala":"3 modes","llama":"3 modes"}`; `:3101/api/khala` → 200).

The **`llama`** family joined the same sidecar the same day (PLAN G9 SG-9.3,
[DR-009](../records/DECISIONS.md)) as `backend/data/internal/research/llama/`: a JSON pass-through
with the sort/trim the TS route used to do, its own 15 s in-process TTL cache and
single-flight, and the strict `top`/`days` matrix — with the TS route reduced to a
verbatim proxy. Three families, three clients, three caches: cryptorank needs the
browser fingerprint, khala and llama need nothing but `net/http`.

The 5-minute treasury sync is now also a Rust service, `backend/sync` ([DR-010](../records/DECISIONS.md)):
same Postgres pipeline, same Alchemy/Solana/Hyperliquid reads, verified row-for-row
against the Python oracle `sync-live.py`, which stays installed as the rollback.

### 2a. `backend/api` package layout (as-built, 2026-10-01)
The primary Go API module (`github.com/anvxxr-arch/fudcourt/backend/api`) is one process
(`cmd/api`: `main.go` route table + `routes.go`/`errors.go`/`cookies.go`/`discord.go` handlers,
loopback `127.0.0.1:3103`, `/healthz` + `/readyz`). Its `internal/` is grouped by **bounded
context**, not one flat package per noun:
```
internal/
├── access/          identity/ authorization/ entitlements/ credentials/
├── accounts/        exchange/ (was exchangeaccounts/)  wallets/
├── finance/         ledger/ portfolio/ treasury/ transactions/
├── markets/         instruments/ overview/ (was markets/)
├── notifications/   audit/   jobs/
└── platform/        errs/ health/ httpx/
```
A directory exists only where real code lives. There is deliberately **no** `bank/`, `cash/`,
`sources/`, `finance/assets`, `finance/valuation`, `executor/` or `admin/` package: those names
are reserved for functionality that does not exist in this module yet, and an empty placeholder
would misdescribe the tree. `executor/` here is a facade name (commands/queries over the real
engine in `backend/workers/executor`); the `/api/executor/**` orchestration plane is still TS
(§8b), and the `/api/admin/members` plane is an api route plane, not an `internal/admin` package.
Domain ownership of the tables these packages model is in [domain-map.md](domain-map.md) §1-§2;
the full judgment record for the grouping is §4 of that file.

## 3. `frontend/web` — SPA shell anatomy

- `src/components/layout/store-shell.tsx` owns `page` state (`initialPage` prop) and renders one
  view per tab. It takes an `isTeam` prop: **false → market boards only** (no
  treasury fetch, no treasury render); true → the full tab strip.
- `src/app/(frontend)/page.tsx` (`/`) is the **landing page** — it mounts `features/home/ui.tsx`,
  not the shell. It reads the session **server-side** only to choose its second call to action
  (a team visitor gets `/team/balance`, everyone else `/login`), and it renders no treasury data:
  an anonymous visitor never even requests the treasury bundle. It adds no route of its own: every
  section is a read-only read of a public family that already ships, and each degrades
  independently — one upstream failing withholds that section (loud banner, never a zero-filled
  grid) without taking its siblings down. The families it composes: `/api/cryptorank?mode=home`
  (market header + funding/launch slices), `/api/markets?limit=10&sort=mcap&order=desc`,
  `/api/cryptorank?mode={trending,gainers,losers}`, `/api/llama?mode=protocols`,
  `/api/market/{forex,commodity}`, `/api/market/stock?region=us`, `/api/market/macro`,
  `/api/news?limit=6` and `/api/signals?type=scoreboard`. The `sort` on the markets call is passed
  **explicitly** because the route's default is `sort=volume`; a bare `?limit=10` would be a volume
  board under a market-cap heading. `/api/signals` without `type=scoreboard` is deliberately NOT
  read: the index payload is ~2.7 MB / 7310 rows. The macro panel renders a yield's delta in
  **basis points** (`Δ × 100`, the rate convention) rather than a percent-of-percent; the row's
  `unit`/`group`/`note` ride in the macro payload so the page reads them from the API rather than
  importing another feature's module (the structure gate forbids a cross-feature import).
- Deep links under `/team/**` and `/admin/**` call `requireTier(...)` before rendering.
- Public deep links (`/market/crypto`, `/market/trench`, `/signals`, `/scoreboard`, `/news`, …)
  are one-line wrappers: `<StoreShell initialPage="…" />` — no server data of their own.
- Route paths are centralised in `src/platform/routing/view-routes.ts` (`viewPath`), used by
  BOTH the nav `href` and the `history.replaceState` effect, so a tab can
  never link to a 404 again (this replaced two hand-written nested ternaries
  that fell through to `/${key}` and 404'd on `/wallets`, `/transactions`,
  `/reconciliation`).

| Tier | View | Deep link | Component | Data in |
|---|---|---|---|---|
| team | dashboard | `/team/balance` | `DashboardPage` | `/api/all` + `/api/wallets` + `/api/coins` + `/api/reconcile` (props) |
| team | portfolio | `/team/portfolio` | `PortfolioPage` | props |
| team | wallets | `/team/wallets` | `WalletPage` | props |
| team | transactions | `/team/transactions` | `TransactionPage` | `/api/transactions` |
| team | reconciliation | `/team/reconciliation` | `ReconciliationPage` | props |
| member | overview | `/member` | shell (boards) | session only |
| admin | control panel | `/admin` | `MemberTable` + audit | `/api/admin/members` + `/api/all` |
| public | home | `/` | `HomePage` (11 sections) | `/api/cryptorank?mode={home,trending,gainers,losers}` · `/api/markets` · `/api/llama?mode=protocols` · `/api/market/{forex,commodity,stock,macro}` · `/api/news` · `/api/signals?type=scoreboard` |
| public | market (hub) | `/market` | `MarketHub` (section overview) | — (links the sections below) |
| public | market · crypto | `/market/crypto` | `MarketHub section="crypto"` → `TickerPage` · `TrackerPage` · `LlamaPage` | `/api/ticker?sort&order&type` · `/api/markets` · `/api/llama?mode=chains/protocols/historical` |
| public | market · coin | `/market/ticker/[ticker]` | `TickerDetailPage` | `/api/ticker/instruments?symbol` + `/api/ticker/instrument?base&type&expiry&strike&kind` |
| public | market · forex | `/market/forex` | `MarketHub section="forex"` → `ForexBoard` | `/api/market/forex` |
| public | market · commodity | `/market/commodity` | `MarketHub section="commodity"` → `CommodityBoard` | `/api/market/commodity` |
| public | market · stock | `/market/stock` | `MarketHub section="stock"` → `StockBoard` (`?region=us\|asia\|europe`) | `/api/market/stock?region=…` |
| public | market · macro (API-only) | — (read by `/` and any board) | `MacroBoard` in `features/home/ui.tsx` | `/api/market/macro` (US curve 13w/5y/10y/30y · DXY · VIX · VVIX · locally-derived curve spreads) |
| public | market · trench | `/market/trench` | `MarketHub section="trench"` → `DexPage` · `TrenchPage` | `/api/dex?type=profiles&limit=50` |
| public | signals | `/signals` | `SignalsPage` | `/api/signals?chain&type` |
| public | scoreboard | `/scoreboard` | `ScoreboardPage` | `/api/signals?type=scoreboard` |
| public | news | `/news` | `NewsPage` | `/api/news?limit=30` |

Legacy `/portfolio` now **307s** to `/team/portfolio` (it used to rewrite to `/`,
the landing page). The boards that folded into
the hub redirect the same way (`next.config.js`): `/ticker`, `/tracker`, `/llama`
and `/market/ticker` → `/market/crypto`; `/dex` and `/trench` → `/market/trench`;
`/markets` → `/market`; `/ticker/:ticker` → `/market/ticker/:ticker`. The hub
itself lives in `components/layout/market-hub.tsx`, not in `features/market/` —
it composes other families, which the structure gate (DR-018 rule 5) forbids
inside a feature slice.

## 4. Data families (the contract spine)

Every upstream source is **keyless** (owner decision: no API keys — HTML/endpoint
reverse-engineering or public feeds only). Each family with a web surface: one route, one `src/features/<family>/` slice
(client + shaper/types + panel) and one verifier script — see DR-018. `chainrank` and `khala` are the
exceptions after DR-041: their web route and feature slice are removed, so each is a sidecar package
plus its verifier only.

| Family | Upstream | Route(s) | Contract | Verifier | Trust |
|---|---|---|---|---|---|
| **treasury** | Postgres `public` (own data, DR-040) | `/api/all`, `/coins`, `/wallets`, `/reconcile`, `/transactions(+/[id])` | `src/platform/db/client.ts` (env-ref only); `/reconcile` is a proxy to the **Rust** `fudcourt-reconciled` `:3102` (DR-014) | `check-contract.py` (mutation-guard) + `sync-live.py` fail-loud + `verify-reconcile.py` (28 checks incl. live TS↔Rust parity) | INTERNAL |
| **cryptorank** | cryptorank.io SSR (RE) — fetched by the Go `fudcourt-data` sidecar :3101, not by the route | `/api/cryptorank` (28 modes, thin proxy to `fudcourt-data`) | runtime: `backend/data/internal/research/cryptorank` · TS mirror `src/features/cryptorank/client.ts` + `src/features/cryptorank/shapers.ts` | `verify-cryptorank.py` 244 checks (oracle `tests/oracle/cr_fetch.py`) · 3-gate · shaper fixtures 56/56 | GATED |
| **chainrank** | chainrank.fyi — fetched by the Go `fudcourt-data` sidecar :3101, not by the web app (web surface removed, DR-041) | sidecar `/api/chainrank` (2 modes; no web route) | runtime: **`backend/data/internal/research/chainrank`** (mode table, pagination relayed verbatim into the upstream URL and the cache key, explicit 32-entry cache ceiling, shape check) | `verify-chainrank.py` 50 checks (incl. the relay matrix vs real upstream) | GATED |
| **llama** | api.llama.fi — fetched by the Go `fudcourt-data` sidecar :3101, not by the route | `/api/llama` (3 modes, thin proxy to `fudcourt-data`) | runtime: **`backend/data/internal/research/llama`** (mode table, strict `top`/`days`, in-process 15 s TTL cache + single-flight, sort/trim); `src/features/llama/client.ts` is the typing/display mirror | `verify-llama.py` 51 checks (incl. anti-fake parity against a direct `/v2/chains`) | GATED |
| **dex** | dexscreener | `/api/dex` | `src/features/dex/client.ts` | `verify-dex.py` | GATED |
| **signals** | data-public.vercel.app (external dataset) | `/api/signals` | route-local | `verify-signals.py` | GATED |
| **markets** | api.coingecko.com (`/coins/markets`, top-250 pool) | `/api/markets` | `src/features/markets/client.ts` | `verify-markets.py` 49 checks (GATE2 llama · GATE3 cryptorank, 3%) | GATED |
| **market** (hub sections) | open.er-api.com (forex, ECB daily) + Yahoo Finance chart (commodity, stock, macro) — all keyless | `/api/market/forex`, `/api/market/commodity`, `/api/market/stock` (`?region=us\|asia\|europe`), `/api/market/macro` | `src/features/market/forex/client.ts` + `src/features/market/{commodity,stock,macro}/client.ts`, sharing `src/features/market/quotes.ts` | `verify-all.sh` (tsc + shapers); live: 4 boards 200, `?region=amer` → 400; deep verifier pending | **SMOKE** — deep verifier pending |
| **ticker** | 10 CEX natives via CCXT (okx, bybit, bitget, mexc, phemex, bingx, bitfinex, htx, coinbase, kraken) | `/api/ticker`, `/api/ticker/instruments`, `/api/ticker/instrument` | `src/features/ticker/client.ts` | route sweep (status/shape/400 contract); deep verifier pending | **SMOKE** — deep verifier pending |
| **news** | cointelegraph.com/rss — fetched by the Go `fudcourt-data` sidecar :3101, not by the route | `/api/news` (thin verbatim proxy to `fudcourt-data`) | runtime: **`backend/data/internal/research/news`** (feed table, strict `source`/`limit` 1..100, RSS parse into the six-key projection, in-process 15 s TTL cache + single-flight keyed on the FEED URL); `src/features/news/client.ts` is the typing/display mirror | `verify-news.py` 50 checks (incl. anti-fake parity against a direct feed fetch) | GATED |
| **khala** (sidecar-only after DR-041: the Go mux serves `/api/khala`; `verify-khala.py` **136/0/0**) | khala.io (Framer SSR; `framerusercontent.com` search index unused by design) | sidecar `/api/khala` (**3 modes**: `reports`, `report`, `latest`; no web route after DR-041; `upstream` scalar, provenance in `slice`, structured `body` — no HTML shipped) | runtime: **`backend/data/internal/research/khala`** — one Go package (no 3-way split: this family has one upstream artifact, not three). Its TS typing/display mirror was removed with the board (`features/khala/`, DR-041) — the route never validated, so the sidecar stays the single validator; that is why `check-contract.py` carries **no** khala table pair — [DR-006](../records/DECISIONS.md) | `verify-khala.py` — the live sidecar harness, run green against `:3101`: **136 pass / 0 fail / 0 skip**; 2 independent ground-truth gates (sitemap slug-set equality · site title/date parity, oracle = direct khala.io fetches) | **GATED** — `verify-khala.py` green against the served `:3101` sidecar |
| **coinglass** | capi.coinglass.com (dashboard backend, keyless by DECRYPTION: AES-128-ECB ×2 + gzip) — fetched by the Go `fudcourt-data` sidecar :3101, not by the route | `/api/coinglass` (4 modes: `statistics`, `openInterest`, `fundingRate`, `markets`; thin verbatim proxy to `fudcourt-data`, forwarding `X-CG-Upstream`/`X-CG-Cache`/`X-CG-Cipher`) | runtime: **`backend/data/internal/research/coinglass`** (mode table, param scoping, the `v` rotation table, decrypt+gunzip, 60 s disk-cache TTL keyed on the upstream URL, shape check); `src/features/coinglass/client.ts` is the typing/display mirror | no dedicated verifier yet (the family's hermetic tests + live probes stand in); `check-contract.py` keeps `CG_MODES` TS↔Go equal + the route a proxy | GATED |
| **coinank** | api.coinank.com (dashboard backend, keyless by a COMPUTED client signature) — fetched by the Go `fudcourt-data` sidecar :3101, not by the route | `/api/coinank` (5 modes: `fundingRate`, `liquidation`, `longShort`, `etf`, `whales`; thin verbatim proxy to `fudcourt-data`, forwarding `X-CA-Upstream`/`X-CA-Cache`) | runtime: **`backend/data/internal/research/coinank`** (mode table, the `interval` allowlist, the reconstructed signature, 60 s disk-cache TTL keyed on the upstream URL, shape check); `src/features/coinank/client.ts` is the typing/display mirror | `verify-coinank.py` 114 checks; `check-contract.py` keeps `CN_MODES` TS↔Go equal + the route a proxy | GATED (DARK — every mode is upstream's 502 `403`; DR-038) |
| **coinmarketcap** | api.coinmarketcap.com/data-api/v3 (dashboard backend, keyless by having NO credential at all) — fetched by the Go `fudcourt-data` sidecar :3101, not by the route | `/api/coinmarketcap` (4 modes: `listing`, `global`, `marketPairs`, `exchanges`; thin verbatim proxy to `fudcourt-data`, forwarding `X-CMC-Upstream`/`X-CMC-Cache`) | runtime: **`backend/data/internal/research/coinmarketcap`** (mode table, param scoping, LOCAL `start`/`limit` bounds validated before any fetch, 60 s disk-cache TTL keyed on the upstream URL, shape check); `src/features/coinmarketcap/client.ts` is the typing/display mirror | `verify-coinmarketcap.py` 70 checks (incl. a direct oracle); `check-contract.py` keeps `CMC_MODES` TS↔Go equal + the route a proxy | GATED |

House rules every family obeys (see `docs/product/ANALYSIS.md` + PLAN):

- **Our params are validated strictly** — bad value → local 400 naming the
  field, never clamped, never silently ignored (probed in every verifier).
- **Upstream status is preserved** — a 429/502 from upstream is not a fake 200.
- **Empty upstream ≠ valid answer** — loud 502/503 with the real reason.
- **Null stays null** — sparse metric renders `—`, never `0`.
- **Derived/local work is labelled** (`derived` + `upstreamTotal` + `pool`).
- **Shared limiter** (`src/platform/http/rate-limit.ts`): TTL cache, min-gap, single-flight,
  `X-Cache` header so caching is observable. **Outbound only** — it protects
  upstreams from us.
- **Inbound limiter** (`src/platform/http/rate-limit-inbound.ts`, enforced by `src/middleware.ts`
  on `/api/:path*`): a per-client, cost-weighted 60 s window, where cost is the
  measured worst-case payload of the route (unit = 50 KB). Heavy routes get 80
  units, light 120; a signed-in caller 3×, and traffic the origin accepted from
  its own address space (loopback/RFC1918/link-local peer, no `CF-Connecting-IP`
  — the operator's own harness, never crossed the tunnel) 100×. The scope is
  decided by the **peer address**, not by the absence of headers: Next.js
  synthesises `X-Forwarded-For` from the socket, so a header-based test was dead
  code (DR-004 amendment, 2026-09-29). Every response
  carries `X-RateLimit-{Limit,Remaining,Reset,Cost,Scope}`; a refusal is 429 +
  `Retry-After`. Fails open; state is bounded (LRU) and per process. Rationale
  and measurements: [DR-004](../records/DECISIONS.md) · PLAN G6.

## 5. Access tiers (Discord OAuth)

One signed session cookie (`fud_session`, HMAC-SHA256, httpOnly + Secure +
SameSite=Lax, 7 days) carries the tier. Login is Discord OAuth2
(`identify` + `guilds`); the guild member's role ids are read with the bot
token and mapped `admin > team > member`. The tier is a **rank**, so admin
implies team implies member.

| Tier | Reaches | Enforced by |
|---|---|---|
| `public` | `/`, the market boards (`BOARD_TABS`: `market`, `signals`, `scoreboard`, `news`), public market APIs | none (deliberate) |
| `member` | `/member` | middleware + page `requireTier('member')` |
| `team` | `/team/{balance,portfolio,wallets,transactions,reconciliation}` + treasury APIs | middleware + page + server-side write check |
| `admin` | `/admin` (member list, role grant/revoke, treasury audit) + `/api/admin/members` | middleware + page + API re-check |

- Route policy is one table (`src/platform/auth/guard.ts` → `requiredTierForPath`), consumed
  by `middleware.ts` before a route runs: protected pages get a redirect to
  `/login?next=…`, protected APIs get a JSON 401 — never an HTML login page
  to a fetch caller.
- **Fail-closed throughout.** No `FUDCOURT_SESSION_SECRET` (or one under 32
  chars) means no session can be signed or verified, so every tier is
  unreachable. Missing guild/role env can only *lower* access: an unresolvable
  member becomes `member`, never `team`.
- The treasury bundle is never fetched for a non-team shell: `src/app/(frontend)/page.tsx`
  reads the session server-side and mounts `StoreShell` with `isTeam`, which
  gates both the fetch and every treasury render.
- `public/robots.txt` does not exist as a file — `src/app/robots.ts` serves real
  `text/plain` and `src/app/(frontend)/sitemap.ts` yields **41** `<loc>` entries
  (re-derived 2026-10-03 from the source: `PUBLIC_ROUTES` in
  `src/platform/routing/public-routes.ts` — the single source of truth for the crawl
  tier — holds **11** entries, plus **30** per-coin `/ticker/<base>` pages enumerated
  from `TICKER_SYMBOLS`). The `/chainrank` and `/khala` boards left `PUBLIC_ROUTES`
  with their pages (DR-041); `/blog` is public and crawlable (individual posts are not
  enumerated — the index links them). `curl -s :3100/sitemap.xml | grep -c '<loc>'` re-confirms the served
  count on any running build.

## 6. Trust classes

- **GATED** — a verifier script exists asserting: real data, request-varying
  body, strict params, honest labels, cache observability, and independent
  ground-truth gates (§4 table). Cryptorank additionally has the full
  3-gate decoy detector + offline fixture suite.
- **SMOKE** — monitor asserts status/shape only (currently: news). `khala` is **sidecar-only**
  after DR-041: its board, Next proxy route and `monitor.py` probe are gone, and
  `verify-khala.py` (run against `:3101`) is its standing live check
  (PLAN G8 / [DR-006](../records/DECISIONS.md)).
- **INTERNAL** — our own database. Gated by the Discord session tier: the
  treasury reads (`/api/all`, `/api/wallets`, `/api/coins`, `/api/reconcile`,
  `/api/transactions`) require `team`, and every write additionally re-checks
  the session server-side (`src/platform/auth/mutation.ts`). The retired `x-fud-token`
  header is gone: it was sent from a `NEXT_PUBLIC_` variable and shipped
  verbatim inside a public JS chunk, so any visitor could write to wallets and
  transactions.

## 7. Verification tiers

| Tier | What | Where it runs |
|---|---|---|
| Offline | `check-contract.py` (CR_MODES ↔ sweep consistency + **TS↔Go mode-table parity** + **news NEWS_SOURCES parity** + mutation-guard + proxy-shape; the **khala** and **chainrank** parity blocks became “web surface removed (sidecar-only)” rows at DR-041), `test:shapers` (`240 tests` as of 2026-10-01), `tsc`, both builds (Bun), `cargo build/test` (backend/sync), `go build/vet/test` (backend/data: cryptorank + khala + llama + news + chainrank packages — **179** `func Test` as of 2026-10-01, was 111 in the 2026-09-29 figure this row used to carry) | pre-push hook + CI on every push |
| Live | per-family verifiers (§4) — plus `verify-khala.py` **green against the served sidecar: 136 pass / 0 fail / 0 skip, 6.7 s** (`--base http://127.0.0.1:3101`; GATED met 2026-09-29, PLAN G8 ✅), cryptorank harness (244 checks; since DR-005 run it against the Go sidecar for a full pass — through :3100 the DR-004 inbound budget stops a ~55-call run, PLAN G7 SG-7.6), route sweep (the 2026-09-29 recorded run was **154/165**: 18 page checks = 13 HTML + `/robots.txt` + `/sitemap.xml` + 3 real-404 retired/unknown · 7 gate-307 · API incl. the whole ticker, llama and news families · mut no-session 401 · session-gated probes · 58 CR; 11 fails = 1 CoinGecko 403 passthrough + 10 session-gated probes unrunnable because no `FUDCOURT_SESSION_SECRET` exists on this host, ANALYSIS K-11 — a point-in-time measurement, not a live claim; DR-041 has since removed the chainrank probes and the khala group F from the sweep), DOM audit of the /tracker board (asserts /api/markets is proxied and the browser never calls CoinGecko) | on demand + this repo's loop |
| Continuous | `monitor.py` — unit active + 8 endpoint checks (board page, 5 cryptorank modes incl. decoy-refusal 503, markets, news), deterministic output, parallel | cron `f191fe6df16c` every 15 min, silent when `HEALTHY` |

## 8. Deploy & hosting (DR-002)

- **Production = this homeserver.** Units: `fudcourt-web` (`127.0.0.1:3100`),
  `fudcourt-data` (Go acquisition sidecar, `127.0.0.1:3101`, unit versioned
  at `infrastructure/systemd/fudcourt-data.service`),
  `fudcourt-reconciled` (**Rust** `/api/reconcile` service, `127.0.0.1:3102`, unit
  versioned at `infrastructure/systemd/fudcourt-reconciled.service`; DR-014),
  `fudcourt-sync.timer` (5 min). **`fudcourt-blog` is retired (DR-017)**: the blog
  is served by `fudcourt-web` at `/blog`, so there is no second Next process.
- Origin binds loopback; the **only** path in is the tunnel ingress
  `fc.dwirijal.my.id → http://127.0.0.1:3100` (proxied CNAME, zone
  `dwirijal.my.id`).
- CI (`.github/workflows/` — five path-filtered workflows: `web.yml`, `go.yml`, `rust.yml`,
  `contracts.yml`, `integration.yml`; the single `ci.yml` this line used to name was split by
  Phase 9) = gates only, **no deploy step**, zero
  secrets. Vercel projects exist but are unused and deletable (see
  `docs/operations/SECRETS.md` §3).
- Secrets live in git-ignored `.env*` files only — inventory + rotation in
  `docs/operations/SECRETS.md`.

## 8b. CEX Executor runtime (the execution plane)

The market families above **read**; the executor **moves money**, so it is a
separate plane with its own process, its own schema and its own failure posture.
Non-custodial/BYOK: the user brings their own Binance/Bybit/MEXC API key (spot +
USDT linear perps) and the funds never leave the exchange. Records:
[DR-020](../records/DECISIONS.md), [DR-021](../records/DECISIONS.md); PRD
`docs/prd/cex-executor.md`; PLAN G14.

**Request flow — Browser → FUDCourt API → Worker → Exchange.**

```
 browser ──▶ /executor/new  (composer + live risk preview)      [team tier]
    │ POST /api/executor/preview
    ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │            frontend/web :3100 — the same Next app, tier `team`            │
 ├───────────────────────────────────────────────────────────────────────┤
 │ src/app/(frontend)/api/executor/**  — 15 thin route handlers          │
 │     ↓ parse → call → respond                                          │
 │ src/platform/executor/runtime.ts — the ONE composition root:          │
 │     requireExecutorUser()  (fail-closed session; wrong owner ⇒ 404)   │
 │     bootstrapExecutor()  →  ensureExecutorSchema()                    │
 │ src/platform/executor/plan.ts → risk.ts  (decimal.js, pure):          │
 │     sizing + fees + leverage + margin + liquidation + constraints     │
 │     ⇒ ExecutionPlan (immutable)  +  PreviewResult                     │
 │ POST /api/executor/executions → row + execution_plans snapshot        │
 │     (PREVIEW persists nothing; the API writes INTENT, never performs) │
 └───────────────────────────────────────────────────────────────────────┘
    │                                          │
    │ intent + immutable plan                 │ Valkey lease
    ▼                                          ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │            executor.* Postgres — 10 tables, never `public`            │
 ├───────────────────────────────────────────────────────────────────────┤
 │ exchange_accounts    AES-256-GCM per field, master                    │
 │                      key from env (only sealed bytes stored)          │
 │ executions · execution_plans · child_orders · fills                   │
 │ execution_events (append-only) · balance_snapshots ·                  │
 │ positions_snapshots · risk_profiles · audit_logs                      │
 └───────────────────────────────────────────────────────────────────────┘

 ┌───────────────────────────────────────────────────────────────────────┐
 │   fudcourt-executor-worker.service — bun frontend/web/scripts/executor/worker.ts   │
 ├───────────────────────────────────────────────────────────────────────┤
 │ · Valkey lease per execution: SET NX PX + Lua heartbeat               │
 │ · reconcile the venue BEFORE acting on local state                    │
 │ · engine.ts: one deterministic tick at a time (2 s), seeded RNG       │
 │ · worker clampChild: over-order cap + RISK_STOPPED                    │
 │ · crash recovery = the same path with placement disabled              │
 │ · no dependency on fudcourt-web: closing the browser never stops it   │
 └───────────────────────────────────────────────────────────────────────┘
                                     ▼
        ExchangeAdapter — the SAME interface for live and paper:
          live:  ccxt (binance · bybit · mexc; spot + linear_perp)
          paper: PaperExchangeAdapter (simulated matcher)
                                     ▼
                              Binance · Bybit · MEXC
```

**Why the pieces are where they are.**

| Piece | Where | Why |
|---|---|---|
| Web app + API | `frontend/web`, `:3100`, `src/app/(frontend)/api/executor/**` | one origin, one session, one tier gate (`/executor` and `/api/executor` are `team` — the same tier as the treasury surface it sits beside) |
| Worker service | `frontend/web/scripts/executor/worker.ts`, unit `infrastructure/systemd/fudcourt-executor-worker.service` (Bun, versioned in-repo) | **independent of `fudcourt-web`**: closing the browser or restarting the web unit never stops an execution |
| Valkey lease | `src/platform/executor/lock.ts` | one worker owns one execution; **FAIL-CLOSED** — a lock that fails open means duplicate orders, so any Valkey error makes `acquire` false and the worker does not trade (the inverse of the JSON cache in `platform/cache/valkey.ts`, which fails open) |
| Postgres store | `src/platform/executor/store.ts` → `executor` schema | its own schema, never `public`: the executor owns its writes and the treasury tables belong to the sync, so neither prunes the other's rows. No migration runner — the embedded DDL is asserted byte-identical to `database/schema/executor-schema.sql`. **Both runtimes apply it at startup** (added `8d87df1`): TS `ensureExecutorSchema()` and Go `repository.EnsureSchema` (`backend/workers/executor/internal/repository/schema.go`, before the worker/API serve, fatal on failure), each with its own drift guard (TS §59 normalized; Go `TestEmbeddedSchemaMatchesTracked` byte-exact) |
| Adapters | `src/platform/executor/exchange.ts` | one translation layer per venue; paper and live implement the SAME interface, so the worker has a single code path |

**Determinism, ownership and the switch.** Time comes from the tick clock and
randomness from a seeded mulberry32 stream persisted in the strategy state, so a
restart recomputes the same decisions; every risk figure is read from the immutable
`execution_plans` snapshot, never re-derived. Every user-scoped store statement
binds `user_id` (a wrong user reads `null`/`[]` → API 404). Placement requires
`FUDCOURT_EXECUTOR_LIVE=1` — off, live executions pause at the placement boundary
while paper mode and reconciliation keep running, so **paper is the default posture**.
Offline: **143 tests** across seven `executor-*-tests.ts` suites in `test:shapers`;
live: `bun run verify:executor` — **38/38** paper-mode checks against the real
Postgres + Valkey + worker loop (PLAN G14).

**Portfolio ceilings gate creation, not just the settings screen.** `maxOpenRiskPct`
and `maxDailyLossPct` are checked in `createExecution` *before* the row exists, so a
refusal leaves nothing to reconcile. `store.summarizePortfolioRisk` aggregates the
committed book in one statement — `SUM(COALESCE(current_risk, planned_risk))` over
the user's live executions — so the ceiling is compared against a single consistent
snapshot rather than a sum that could straddle a concurrent fill; the current risk
the worker recalculates after each fill (PRD §36) wins over the stale plan, because
committed risk is what it stands at. The rule itself is a pure function,
`evaluatePortfolioGates`, so it is testable with no database and no venue. Exits are
never gated — a guard that could refuse a `close` or `reduce` would trap the user
inside the risk it exists to bound. Refusals are 409 and carry the committed figure,
the requested figure and the computed ceiling.

## 9. Open alignment items

| Item | State |
|---|---|
| `verify-news.py` deep verifier (strict params, feed shape, headline ground truth) | ✅ **closed 2026-09-29** — the family moved into the Go sidecar ([DR-012](../records/DECISIONS.md), PLAN G12) and shipped with its harness: `verify-news.py` **50/50** against `:3101` and through the `:3100` proxy (strict `source`/`limit` 400s incl. the empty-value pair, `total` vs head, the cache-keyed-on-feed-URL proof, and an anti-fake parity probe comparing the served head against a DIRECT feed fetch for titles, links and order) |
| `verify-ticker.py` deep verifier (per-venue price cross-checks, stale-quote and allowlist ground truth, and that the option/future default is ATM-anchored at the nearest expiry; tolerate ±1 rung on a near-tie, since the board sweep and the instruments route sample spot independently, so a strike equidistant from two rungs can legitimately differ) — ticker currently covered by the route sweep's status/shape/400 contract + unknown-symbol 404 only | TODO — verifier pending |
| Ticker cold-sweep latency (**71.9s** median of 3 cold samples on build `5hofb1Jb2_fApQp5zYI-W`, 71.3/71.9/72.4s — each sample after a `systemctl --user restart fudcourt-web.service`, warm ~5ms, 72.2s via the public host; one `fetchTicker` per (symbol,type,venue), ≈1000+ calls under `enableRateLimit`) | **measured, under the 90s origin ceiling — no mitigation applied**; the per-symbol two-pass spot barrier is unchanged, so bounded concurrency across symbols (chunks of 5-8) is the cheap lever if the ceiling is ever approached — batching still open: batch each (venue,type) leg into one ccxt `fetchTickers([symbols])` (~40 calls, seconds), or lengthen `TICKER_TTL_MS` / add stale-while-revalidate on `memoSweep` |
| Blog public hostname (e.g. `blog.fc…` ingress) | **closed by DR-017** — the merge removed the reason for a second hostname: the blog is public on the existing origin at `https://fc.dwirijal.my.id/blog` (verified 200), so no second ingress is needed |
| Signals dataset provenance (`data-public.vercel.app` is third-party) | documented; verifier asserts shape/parity only |
| DOM audit coverage for non-tracker views (`/tracker` is now audited; every other board is not) | gap tracked as ANALYSIS K-6 |
| `khala` **runtime wiring** | **superseded by DR-041** — the `:3100` web route and the public path are removed; the sidecar's mux still registers `/api/khala` (SG-8.3). Measured: `:3101/healthz` → `{"build":"28 modes","chainrank":"2 modes","khala":"3 modes"}`, `:3101/api/khala?mode=reports` → **200**; `verify-khala.py` **136/0/0** against the sidecar — design frozen in `/home/dwizzy/khala-probe/DESIGN.md` ([DR-006](../records/DECISIONS.md)) |
| `khala` monitor check + route-sweep entry + `check-contract.py` proxy guard | **reversed by DR-041** — the web board, its `monitor.py` check, the route-sweep group F and the `check-contract.py` proxy guard are all removed with the web surface; the sidecar family itself is unchanged |
| `khala` list rows carry **no date keys at all** (absent, not null) — the homepage publishes none, so a list date would need an N+1 fan-out | by design — PLAN SG-8.10, DESIGN.md D4 |
| `khala` `body` flattens inline markup (links/emphasis) into `text`, so no HTML crosses the API and no sanitizer is needed | accepted tradeoff — DESIGN.md D7 / [DR-006](../records/DECISIONS.md) |
| Framer markup fragility: `data-framer-name` holds stale placeholder copy, class names/sentinels can change on any republish, and the `searchIndex-<hash>` name rotates | by design (loud 502 drift arm) — DESIGN.md D2/D6/F1/F2 |
