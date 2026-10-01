# Architecture — fudcourt
> **The clear map** of what this repo actually is: two apps, **16 views**, **10 data
> families**, one self-hosted origin. Written 2026-09-28 during the
> repurpose/re-alignment pass — every row below was read out of the running
> system (routes on disk, live probes), not from memory. When this file and
> the code disagree, the code wins and this file is wrong: fix it same day.
>
> Counts are re-derived, never inherited. **Re-derived 2026-09-29 11:45 UTC** by
> reading the code once the `khala` family landed: **16** views = `TEAM_TABS` (5) +
> `BOARD_TABS` (**11**) in `src/components/layout/store-shell.tsx`; the §3 registry adds the `member`
> and `admin` surfaces, so it carries **18** rows. **10** data families = the §4
> table rows. **21** `/api` route handlers = **18** data routes (17 across the 10 §4
> families + the `/api/admin/members` admin control API in §5) + **3** auth routes
> (`/api/auth/login`, `/callback`, `/logout`) — counted, not incremented:
> `find frontend/web/src/app/api -name route.ts | wc -l` = **21**, three of them
> `src/app/(frontend)/api/auth/*`. Sitemap: **12** static routes in `src/platform/routing/public-routes.ts` + **30**
> `TICKER_SYMBOLS` = **42** `<loc>` (§5 moved 41 → 42).
>
> Runtime facts now match the source tree (2026-09-29 ~13:00 UTC): `GET :3100/api/khala`
> answers **200** because the `bun run build` deployed on `:3100` carries
> `src/app/(frontend)/api/khala/route.ts`, and the Go sidecar **has** registered khala on its mux
> (`/healthz` → `{"build":"28 modes","khala":"3 modes"}`). The khala rows in §3/§4 are
> therefore **served**, and `verify-khala.py` against the served sidecar is
> **136 passed / 0 failed / 0 skipped**.

## 1. Product statement

**fudcourt = a self-hosted crypto data platform with a personal treasury OS
inside it, plus a blog at `/blog`.** One Next.js 16 app (the blog merged in by
DR-017) on the homeserver:

| | What it answers | Where |
|---|---|---|
| Treasury OS | what do I own / is it accounted for | `frontend/web` views `dashboard, portfolio, wallets, transactions, reconciliation` |
| Market intelligence | what is the market doing — prices, ranks, chains, DEX, launches, news, signals, research | `frontend/web` views `ticker, tracker, trench, dex, signals, scoreboard, chainrank, cryptorank, llama, news` (plus the `khala` research board) |
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
   │  app/page.tsx = SPA shell (initialPage state + tab nav + shared db fetch)│
   │  app/<view>/page.tsx = deep-link wrapper → <Home initialPage=…>          │
   │  app/api/* = 21: 18 data (17 family §4 + /admin/members §5) + 3 auth     │
   └──────┬────────────────────────────────────────────┬──────────────────────┘
          │ Turso (treasury, synced every 5 min        │ keyless upstreams:
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
          ▼ more — /api/{cryptorank,llama,khala} are thin proxies (no validation,
            no shaping; body+status forwarded verbatim; DR-005/006/008)
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
package `backend/data/internal/research/khala/`, plus a typing-only TS mirror
(`src/features/khala/client.ts`). Measured upstream (2026-09-29): khala.io answers **200** to a
non-browser UA with no Cloudflare in the path at all, so the `chrome_131`
ClientHello stack above is **required for cryptorank only and must never be
generalised** into a shared client (DR-006, DESIGN.md D1/D9). It is registered on
the sidecar's mux and served (measured: `:3101/healthz` →
`{"build":"28 modes","khala":"3 modes","llama":"3 modes"}`; `/api/khala` → 200).

The **`llama`** family joined the same sidecar the same day (PLAN G9 SG-9.3,
[DR-009](../records/DECISIONS.md)) as `backend/data/internal/research/llama/`: a JSON pass-through
with the sort/trim the TS route used to do, its own 15 s in-process TTL cache and
single-flight, and the strict `top`/`days` matrix — with the TS route reduced to a
verbatim proxy. Three families, three clients, three caches: cryptorank needs the
browser fingerprint, khala and llama need nothing but `net/http`.

The 5-minute treasury sync is now also a Rust service, `backend/sync` ([DR-010](../records/DECISIONS.md)):
same Turso pipeline, same Alchemy/Solana/Hyperliquid reads, verified row-for-row
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
- `src/app/(frontend)/page.tsx` (`/`) reads the session **server-side** and mounts the shell
  with `isTeam = hasTier(user, 'team')`, so an anonymous visitor never even
  requests the treasury bundle. Deep links under `/team/**` and `/admin/**`
  call `requireTier(...)` before rendering.
- Public deep links (`/ticker`, `/cryptorank`, …) are one-line wrappers:
  `<StoreShell initialPage="ticker" />` — no server data of their own.
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
| public | ticker | `/ticker` | `TickerPage` | `/api/ticker?sort&order&type` + `/api/ticker/instruments?symbol` + `/api/ticker/instrument?base&type&expiry&strike&kind` |
| public | tracker | `/tracker` | `TrackerPage` | `/api/markets` (was: browser-direct CoinGecko — re-aligned) |
| public | trench | `/trench` | `TrenchPage` | `/api/dex?type=profiles&limit=50` |
| public | dex | `/dex` | `DexPage` | `/api/dex?type=profiles&limit=10` |
| public | signals | `/signals` | `SignalsPage` | `/api/signals?chain&type` |
| public | scoreboard | `/scoreboard` | `ScoreboardPage` | `/api/signals?type=scoreboard` |
| public | chainrank | `/chainrank` | `ChainrankPage` | `/api/chainrank?mode=listings/stats` |
| public | cryptorank | `/cryptorank` | `CryptorankPage` | `/api/cryptorank?mode=…` (28 modes) |
| public | llama | `/llama` | `LlamaPage` | `/api/llama?mode=chains/protocols/historical` |
| public | news | `/news` | `NewsPage` | `/api/news?limit=30` |
| public | khala *(source-landed; :3100 build predates it)* | `/khala` | `KhalaPage` | `/api/khala?mode=reports` · `/api/khala?mode=report&key=…` · `/api/khala?mode=latest&limit=N` |

Legacy `/portfolio` now **307s** to `/team/portfolio` (it used to rewrite to
`/`, which is now a duplicate of the landing page).

## 4. Data families (the contract spine)

Every upstream source is **keyless** (owner decision: no API keys — HTML/endpoint
reverse-engineering or public feeds only). Each family: one route, one `src/features/<family>/` slice
(client + shaper/types + panel) and one verifier script — see DR-018.

| Family | Upstream | Route(s) | Contract | Verifier | Trust |
|---|---|---|---|---|---|
| **treasury** | Turso DB (own data) | `/api/all`, `/coins`, `/wallets`, `/reconcile`, `/transactions(+/[id])` | `src/platform/db/client.ts` (env-ref only); `/reconcile` is a proxy to the **Rust** `fudcourt-reconciled` `:3102` (DR-014) | `check-contract.py` (mutation-guard) + `sync-live.py` fail-loud + `verify-reconcile.py` (28 checks incl. live TS↔Rust parity) | INTERNAL |
| **cryptorank** | cryptorank.io SSR (RE) — fetched by the Go `fudcourt-data` sidecar :3101, not by the route | `/api/cryptorank` (28 modes, thin proxy to `fudcourt-data`) | runtime: `backend/data/internal/research/cryptorank` · TS mirror `src/features/cryptorank/client.ts` + `src/features/cryptorank/shapers.ts` | `verify-cryptorank.py` 244 checks (oracle `tests/oracle/cr_fetch.py`) · 3-gate · shaper fixtures 56/56 | GATED |
| **chainrank** | chainrank.fyi — fetched by the Go `fudcourt-data` sidecar :3101, not by the route | `/api/chainrank` (2 modes, thin verbatim proxy to `fudcourt-data`) | runtime: **`backend/data/internal/research/chainrank`** (mode table, pagination relayed verbatim into the upstream URL and the cache key, explicit 32-entry cache ceiling, shape check); `src/features/chainrank/client.ts` is the typing/display mirror + the documented write surface | `verify-chainrank.py` 50 checks (incl. the relay matrix vs real upstream) | GATED |
| **llama** | api.llama.fi — fetched by the Go `fudcourt-data` sidecar :3101, not by the route | `/api/llama` (3 modes, thin proxy to `fudcourt-data`) | runtime: **`backend/data/internal/research/llama`** (mode table, strict `top`/`days`, in-process 15 s TTL cache + single-flight, sort/trim); `src/features/llama/client.ts` is the typing/display mirror | `verify-llama.py` 51 checks (incl. anti-fake parity against a direct `/v2/chains`) | GATED |
| **dex** | dexscreener | `/api/dex` | `src/features/dex/client.ts` | `verify-dex.py` | GATED |
| **signals** | data-public.vercel.app (external dataset) | `/api/signals` | route-local | `verify-signals.py` | GATED |
| **markets** | api.coingecko.com (`/coins/markets`, top-250 pool) | `/api/markets` | `src/features/markets/client.ts` | `verify-markets.py` 49 checks (GATE2 llama · GATE3 cryptorank, 3%) | GATED |
| **ticker** | 10 CEX natives via CCXT (okx, bybit, bitget, mexc, phemex, bingx, bitfinex, htx, coinbase, kraken) | `/api/ticker`, `/api/ticker/instruments`, `/api/ticker/instrument` | `src/features/ticker/client.ts` | route sweep (status/shape/400 contract); deep verifier pending | **SMOKE** — deep verifier pending |
| **news** | cointelegraph.com/rss — fetched by the Go `fudcourt-data` sidecar :3101, not by the route | `/api/news` (thin verbatim proxy to `fudcourt-data`) | runtime: **`backend/data/internal/research/news`** (feed table, strict `source`/`limit` 1..100, RSS parse into the six-key projection, in-process 15 s TTL cache + single-flight keyed on the FEED URL); `src/features/news/client.ts` is the typing/display mirror | `verify-news.py` 50 checks (incl. anti-fake parity against a direct feed fetch) | GATED |
| **khala** (wired: the sidecar mux serves `/api/khala`; `verify-khala.py` **136/0/0**) | khala.io (Framer SSR; `framerusercontent.com` search index unused by design) | `/api/khala` (**3 modes**: `reports`, `report`, `latest`; thin verbatim proxy to `fudcourt-data`; `upstream` scalar, provenance in `slice`, structured `body` — no HTML shipped) | runtime: **`backend/data/internal/research/khala`** — one Go package (no 3-way split: this family has one upstream artifact, not three). Its TS side is a **typing/display mirror only** (`src/features/khala/client.ts`: mode list, key regex, `limit` bounds, envelope types) — the route validates nothing, so the sidecar stays the single validator; that is why `check-contract.py` carries **no** khala table pair (contrast the cryptorank row above, whose two real mode tables are kept equal by that gate) — [DR-006](../records/DECISIONS.md) | `verify-khala.py` — **written, not run by this doc's author**; its recorded artifact `scripts/khala-report.json` (scratch `:4101` adapter) reports **133 pass / 1 fail / 0 skip**; 2 independent ground-truth gates (sitemap slug-set equality · site title/date parity, oracle = direct khala.io fetches) | **SMOKE** — GATED not claimed until it runs green against a served endpoint |

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
| `public` | `/`, the 11 market boards (`BOARD_TABS`), public market APIs | none (deliberate) |
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
- The treasury bundle is never fetched for a non-team shell: `app/page.tsx`
  reads the session server-side and mounts `StoreShell` with `isTeam`, which
  gates both the fetch and every treasury render.
- `public/robots.txt` does not exist as a file — `app/robots.ts` serves real
  `text/plain` and `app/sitemap.ts` yields **42** `<loc>` entries (re-derived
  2026-09-29 from the source — 41 was the count before `/khala` landed): the **12**
  static routes in `src/platform/routing/public-routes.ts` (the single source of truth for the crawl
  tier) plus **30** per-coin `/ticker/<base>` pages enumerated from `TICKER_SYMBOLS`
  (bounded allowlist, never crawled). Measurement split: source = **42**; the running
  build still serves **41** (`curl -s :3100/sitemap.xml | grep -c '<loc>'` = 41, with
  no `/khala` entry), because `frontend/web/.next` predates `src/platform/routing/public-routes.ts` — see §9.

## 6. Trust classes

- **GATED** — a verifier script exists asserting: real data, request-varying
  body, strict params, honest labels, cache observability, and independent
  ground-truth gates (§4 table). Cryptorank additionally has the full
  3-gate decoy detector + offline fixture suite.
- **SMOKE** — monitor asserts status/shape only (currently: news). `khala` files here
  for now: its verifier **exists** (`verify-khala.py`) but its recorded run was against
  a **scratch :4101 adapter** (133 pass / 1 fail / 0 skip), it is not in `monitor.py`'s
  `CHECKS`, and the production sidecar does not serve the route — so GATED is **not**
  claimed (PLAN G8 / [DR-006](../records/DECISIONS.md)).
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
| Offline | `check-contract.py` (CR_MODES ↔ sweep consistency + **TS↔Go mode-table parity** + **khala KH_MODES parity** + **news NEWS_SOURCES parity** + **chainrank CR_MODES parity** + mutation-guard + proxy-shape), `test:shapers` (`80 tests` = 56 shaper/fixture + 11 auth + 13 rate-limit, over 26 gz fixtures, sha256 over raw payload), `tsc`, both builds (Bun), `cargo build/test` (backend/sync), `go build/vet/test` (backend/data: cryptorank + khala + llama + news + chainrank packages, 111 tests) | pre-push hook + CI on every push |
| Live | per-family verifiers (§4) — plus `verify-khala.py` **green against the served sidecar: 136 pass / 0 fail / 0 skip, 6.7 s** (`--base http://127.0.0.1:3101`; GATED met 2026-09-29, PLAN G8 ✅), cryptorank harness (244 checks; since DR-005 run it against the Go sidecar for a full pass — through :3100 the DR-004 inbound budget stops a ~55-call run, PLAN G7 SG-7.6), route sweep **154/165** (18 page checks = 13 HTML + `/robots.txt` + `/sitemap.xml` + 3 real-404 retired/unknown · 7 gate-307 · 47 API incl. the whole ticker, llama, news and chainrank families · 7 mut no-session 401 · 10 session-gated probes · 58 CR · 17 khala; 11 fails = 1 CoinGecko 403 passthrough + 10 session-gated probes unrunnable because no `FUDCOURT_SESSION_SECRET` exists on this host, ANALYSIS K-11), DOM audit of the /tracker board (asserts /api/markets is proxied and the browser never calls CoinGecko) | on demand + this repo's loop |
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
- CI (`.github/workflows/ci.yml`) = gates only, **no deploy step**, zero
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
 │   fudcourt-executor-worker.service — bun scripts/executor/worker.ts   │
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
| Worker service | `frontend/web/scripts/executor/worker.ts`, unit `infrastructure/fudcourt-executor-worker.service` (Bun, versioned in-repo) | **independent of `fudcourt-web`**: closing the browser or restarting the web unit never stops an execution |
| Valkey lease | `src/platform/executor/lock.ts` | one worker owns one execution; **FAIL-CLOSED** — a lock that fails open means duplicate orders, so any Valkey error makes `acquire` false and the worker does not trade (the inverse of the JSON cache in `platform/cache/valkey.ts`, which fails open) |
| Postgres store | `src/platform/executor/store.ts` → `executor` schema | its own schema, never `public`: the treasury read model is pruned wholesale by the Turso→Postgres mirror, and the executor writes live data. No migration runner — the embedded DDL is asserted byte-identical to `database/schema/executor-schema.sql` |
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
| `khala` **runtime wiring** | ✅ **closed 2026-09-29** — the sidecar's mux registers `/api/khala` (SG-8.3) and the `:3100` build carries the route. Measured: `:3101/healthz` → `{"build":"28 modes","khala":"3 modes"}`, `:3101/api/khala?mode=reports` → **200**, `:3100/api/khala?mode=reports` → **200**, public `https://fc.dwirijal.my.id/api/khala?mode=reports` → 200; `verify-khala.py` **136/0/0** | design frozen in `/home/dwizzy/khala-probe/DESIGN.md` ([DR-006](../records/DECISIONS.md)); residual limits in PLAN SG-8.10 |
| `khala` monitor check + route-sweep entry + `check-contract.py` proxy guard | ✅ **closed 2026-09-29** — all three carry khala; measured sweep group F = 17/17 (3 modes + strict-param 400s + real-404 decoy) |
| `khala` list rows carry **no date keys at all** (absent, not null) — the homepage publishes none, so a list date would need an N+1 fan-out | by design — PLAN SG-8.10, DESIGN.md D4 |
| `khala` `body` flattens inline markup (links/emphasis) into `text`, so no HTML crosses the API and no sanitizer is needed | accepted tradeoff — DESIGN.md D7 / [DR-006](../records/DECISIONS.md) |
| Framer markup fragility: `data-framer-name` holds stale placeholder copy, class names/sentinels can change on any republish, and the `searchIndex-<hash>` name rotates | by design (loud 502 drift arm) — DESIGN.md D2/D6/F1/F2 |
