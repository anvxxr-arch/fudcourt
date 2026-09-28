# Architecture — fudcourt

> **The clear map** of what this repo actually is: two apps, 15 views, 8 data
> families, one self-hosted origin. Written 2026-09-28 during the
> repurpose/re-alignment pass — every row below was read out of the running
> system (routes on disk, live probes), not from memory. When this file and
> the code disagree, the code wins and this file is wrong: fix it same day.

## 1. Product statement

**fudcourt = a self-hosted crypto data platform with a personal treasury OS
inside it, plus a blog.** One Next.js 16 monorepo on the homeserver:

| | What it answers | Where |
|---|---|---|
| Treasury OS | what do I own / is it accounted for | `apps/web` views `dashboard, portfolio, wallets, transactions, reconciliation` |
| Market intelligence | what is the market doing — prices, ranks, chains, DEX, launches, news, signals | `apps/web` views `coin, tracker, trench, dex, signals, scoreboard, chainrank, cryptorank, llama, news` |
| Publishing | what's the story | `apps/blog` (Payload CMS) |

Public entry: **https://fc.dwirijal.my.id** (Cloudflare Tunnel → loopback
origin; DR-002 — no third-party deploy target, ever).

## 2. System picture

```
                    ┌─ Cloudflare Tunnel (39bdfeef…) ─────────────────┐
 browser ──HTTPS──▶  │ fc.dwirijal.my.id → 127.0.0.1:3100            │
 (LAN or public)    │ (blog :3001 not routed publicly — open decision)│
                    └────────────────┬────────────────────────────────┘
                                     ▼
   ┌──────────────────── apps/web (Next 16, fudcourt-web) ────────────────────┐
   │  app/page.tsx = SPA shell (initialPage state + tab nav + shared db fetch)│
   │  app/<view>/page.tsx = deep-link wrapper → <Home initialPage=…>          │
   │  app/api/* = 13 route handlers → 8 data families (§4)                    │
   └──────┬────────────────────────────────────────────┬──────────────────────┘
          │ Turso (treasury, synced every 5 min        │ keyless upstreams:
          │ by fudcourt-sync.timer → sync-live.py)     │ cryptorank.io SSR RE,
          ▼                                            │ chainrank.fyi RE,
   ┌────────────────────┐                              │ api.llama.fi,
   │ apps/blog (Payload)│  Neon Postgres (DATABASE_URL)│ dexscreener,
   │ fudcourt-blog :3001│                              │ api.coingecko.com,
   └────────────────────┘                              │ cointelegraph RSS,
                                                       │ data-public.vercel.app
                                                       ▼
                                          lib/rate-limit.ts (shared limiter:
                                          min-gap + TTL cache + single-flight)
```

## 3. `apps/web` — SPA shell anatomy

- `app/page.tsx` owns `page` state (`initialPage` prop) and renders one view
  per tab; it prefetches the treasury payload once (`/api/all`, `/api/wallets`,
  `/api/coins`, `/api/reconcile` in parallel) and passes it down as props.
- Deep links (`/coin`, `/cryptorank`, …) are one-line wrappers:
  `<Home initialPage="coin" />` — no server data of their own.
- 15 views, 11 with deep links (the sweep's 12 `page` checks = these 11 + `/`):

| View | Deep link | Component | Data in |
|---|---|---|---|
| dashboard | `/balance` | inline + `DashboardPage` | `/api/all` + `/api/wallets` + `/api/coins` + `/api/reconcile` (props) |
| portfolio | *(tab only)* | `PortfolioPage` | props |
| wallets | *(tab only)* | `WalletPage` | props |
| transactions | *(tab only)* | `TransactionPage` | `/api/transactions` |
| reconciliation | *(tab only)* | `ReconciliationPage` | props |
| coin | `/coin` | `CoinPage` | `/api/markets` |
| tracker | `/tracker` | `TrackerPage` | `/api/markets` (was: browser-direct CoinGecko — re-aligned) |
| trench | `/trench` | `TrenchPage` | `/api/dex?type=profiles&limit=50` |
| dex | `/dex` | `DexPage` | `/api/dex?type=profiles&limit=10` |
| signals | `/signals` | `SignalsPage` | `/api/signals?chain&type` |
| scoreboard | `/scoreboard` | `ScoreboardPage` | `/api/signals?type=scoreboard` |
| chainrank | `/chainrank` | `ChainrankPage` | `/api/chainrank?mode=listings/stats` |
| cryptorank | `/cryptorank` | `CryptorankPage` | `/api/cryptorank?mode=…` (28 modes) |
| llama | `/llama` | `LlamaPage` | `/api/llama?mode=chains/protocols/historical` |
| news | `/news` | `NewsPage` | `/api/news?limit=30` |

## 4. Data families (the contract spine)

Every upstream source is **keyless** (owner decision: no API keys — HTML/endpoint
reverse-engineering or public feeds only). Each family: one route, one `lib/`
contract where applicable, one verifier script.

| Family | Upstream | Route(s) | Contract | Verifier | Trust |
|---|---|---|---|---|---|
| **treasury** | Turso DB (own data) | `/api/all`, `/coins`, `/wallets`, `/reconcile`, `/transactions(+/[id])` | `lib/db.ts` (env-ref only) | `check-contract.py` (mutation-guard) + `sync-live.py` fail-loud | INTERNAL |
| **cryptorank** | cryptorank.io SSR (RE) | `/api/cryptorank` (28 modes) | `lib/cryptorank.ts` + `lib/shapers.ts` | `verify-cryptorank.py` 244 checks · 3-gate · shaper fixtures 56/56 | GATED |
| **chainrank** | chainrank.fyi (RE) | `/api/chainrank` | `lib/chainrank.ts` | `verify-chainrank.py` | GATED |
| **llama** | api.llama.fi | `/api/llama` (3 modes) | `lib/llama.ts` | `verify-llama.py` | GATED |
| **dex** | dexscreener | `/api/dex` | `lib/dex.ts` | `verify-dex.py` | GATED |
| **signals** | data-public.vercel.app (external dataset) | `/api/signals` | route-local | `verify-signals.py` | GATED |
| **markets** | api.coingecko.com (`/coins/markets`, top-250 pool) | `/api/markets` | `lib/markets.ts` | `verify-markets.py` 49 checks (GATE2 llama · GATE3 cryptorank, 3%) | GATED |
| **news** | cointelegraph.com/rss | `/api/news` | route-local (strict `source`/`limit`) | monitor smoke only | **SMOKE** — deep verifier pending (PLAN SG-5.2) |

House rules every family obeys (see `docs/ANALYSIS.md` + PLAN):

- **Our params are validated strictly** — bad value → local 400 naming the
  field, never clamped, never silently ignored (probed in every verifier).
- **Upstream status is preserved** — a 429/502 from upstream is not a fake 200.
- **Empty upstream ≠ valid answer** — loud 502/503 with the real reason.
- **Null stays null** — sparse metric renders `—`, never `0`.
- **Derived/local work is labelled** (`derived` + `upstreamTotal` + `pool`).
- **Shared limiter** (`lib/rate-limit.ts`): TTL cache, min-gap, single-flight,
  `X-Cache` header so caching is observable.

## 5. Trust classes

- **GATED** — a verifier script exists asserting: real data, request-varying
  body, strict params, honest labels, cache observability, and independent
  ground-truth gates (§4 table). Cryptorank additionally has the full
  3-gate decoy detector + offline fixture suite.
- **SMOKE** — monitor asserts status/shape only (currently: news).
- **INTERNAL** — our own database; guarded by the mutation auth contract
  (fail-closed `x-fud-token`, 401 without it — verified on the public hostname).

## 6. Verification tiers

| Tier | What | Where it runs |
|---|---|---|
| Offline | `check-contract.py` (CR_MODES ↔ sweep consistency + mutation-guard), `test:shapers` (56 tests / 26 gz fixtures, sha256 over raw payload), `tsc`, both builds | pre-push hook + CI on every push |
| Live | per-family verifiers (§4), cryptorank harness (244 checks), route sweep **110/110** (12 page URLs = 11 deep links + `/` · 26 API · 7 mut-auth · 7 mut · 58 CR), DOM audit of the cryptorank board | on demand + this repo's loop |
| Continuous | `monitor.py` — unit active + 8 endpoint checks (board page, 5 cryptorank modes incl. decoy-refusal 503, markets, news), deterministic output, parallel | cron `f191fe6df16c` every 15 min, silent when `HEALTHY` |

## 7. Deploy & hosting (DR-002)

- **Production = this homeserver.** Units: `fudcourt-web` (`127.0.0.1:3100`),
  `fudcourt-blog` (`127.0.0.1:3001`, enabled), `fudcourt-sync.timer` (5 min).
- Origin binds loopback; the **only** path in is the tunnel ingress
  `fc.dwirijal.my.id → http://127.0.0.1:3100` (proxied CNAME, zone
  `dwirijal.my.id`).
- CI (`.github/workflows/ci.yml`) = gates only, **no deploy step**, zero
  secrets. Vercel projects exist but are unused and deletable (see
  `docs/SECRETS.md` §3).
- Secrets live in git-ignored `.env*` files only — inventory + rotation in
  `docs/SECRETS.md`.

## 8. Open alignment items

| Item | State |
|---|---|
| `verify-news.py` deep verifier (strict params, feed shape, headline ground truth) | TODO — PLAN SG-5.2 |
| Blog public hostname (e.g. `blog.fc…` ingress) | open decision, not routed |
| Signals dataset provenance (`data-public.vercel.app` is third-party) | documented; verifier asserts shape/parity only |
| DOM audit coverage for non-cryptorank views | gap tracked as ANALYSIS K-6 |
