# PRD — Fudcourt

- **Status:** v1.0, verified against remote head `957836d` (2026-09-27)
- **Owner:** Dwi (`dwizzy`)
- **Repo:** `github.com/anvxxr-arch/fudcourt`

## 1. Product vision

One private surface where the owner can answer, at any moment:

1. **What do I own?** — every wallet, every chain, exact balances (never a fake 0).
2. **Is it accounted for?** — reconciliation against an auditable journal/ledger.
3. **What is the market doing?** — price, rankings, sectors, launches, funding,
   prediction markets, news — sourced live and **verified** against independent truth.
4. **What's the story?** — a self-hosted blog to publish conclusions.

"Fudcourt" = treasury OS (balance/portfolio) + market-intelligence boards + blog.

## 2. Personas

| Persona | Need |
|---------|------|
| **Owner (Dwi)** — sole daily user | Fast local board (`:3100`), live sync every 5 min, zero fabricated numbers |
| **Public reader** | Vercel-deployed portfolio view (`/portfolio`) + blog posts |
| **The agent (Fox)** | Machine-checkable contracts: harnesses, gates, loud failures |

## 3. Functional requirements

### FR-1 — Treasury core (portfolio/balance)
- FR-1.1 Aggregate balances per wallet/chain into net worth (`getAll()` → accounts, assets, transactions, journal, ledger, wallets, trades).
- FR-1.2 Transactions CRUD: create (single + bulk), list with filters (limit/offset/search/chain/venue/direction/date range), bulk update/delete.
- FR-1.3 Wallets: list, upsert-by-address (alias/emoji/color/notes).
- FR-1.4 **Exactness rule:** balance reconciliation is exact wallet+address+hash;
  amount/date-only matches are rejected as fake; every balance shows closing arithmetic.

### FR-2 — Live multi-chain sync
- FR-2.1 `sync-live.py` runs every 5 minutes (`fudcourt-sync.timer`) writing to Turso `assets`.
- FR-2.2 **Hard rule:** a failed RPC **raises** — it never becomes `0`. Absent data renders as absent, not zero.

### FR-3 — Market intelligence boards (apps/web)
- FR-3.1 **CryptoRank integration** — 28 modes reverse-engineered from HTML SSR
  payloads (no API key, by explicit owner decision): home, coins, trending, gainers,
  losers, categories, exchanges (CEX/DEX/perps/transparency), coin detail, listings,
  blockchains/chain, launchpool (past/active/upcoming), nodesale, news, tags/tag,
  ecosystems/ecosystem, rwa/rwaasset, quarterly returns, prediction markets,
  converter, media, newstag, ai-overview; plus loud-503 refusals for `funding`/`unlocks`.
- FR-3.2 ChainRank proxy (`stats`, `listings`), DEX Screener proxy (8 types),
  DefiLlama proxy (`chains`, `protocols`, `historical`), News proxy, Signals proxy.
- FR-3.3 Every board must fail loudly: upstream error → HTTP 502 with the real
  upstream status; never an empty-successful table.

### FR-4 — Blog (apps/blog)
- FR-4.1 Payload CMS 3.89 collections: posts, media, categories, users on Neon Postgres.
- FR-4.2 Public REST (`/api/posts|categories|media`) read-only; users list ACL-protected (403).
- FR-4.3 GraphQL endpoint with introspection disabled; playground disabled in production (Payload default).

## 4. Non-functional requirements

### NFR-1 — Data integrity is the product (highest priority)
- **Never fake data.** Sparse upstream metric → `null` → renders `—`, never `0`.
- **No-op parameters are lies** — expose only what varies the upstream body.
- **Never clamp invalid input** — bad format → local 400; unknown key → upstream 404 passthrough.
- **A response body that does not vary with the request is not data** (measured: `/exchanges/perpetuals/dex` rejected for byte-identical payload).
- **Parity proves self-consistency, never truth** — every wired family must clear the
  3-gate decoy detector: (1) nonexistent slug → 404, (2) value parity vs an independent
  source (coins.llama.fi / CoinGecko), (3) independent ground truth (official
  exchange announcements, publisher `<title>`, official quotes, league schedules,
  YouTube oembed — substitutions must be declared).

### NFR-2 — Verification
- Every route/endpoint live-verified: **100/100** (12 pages, 23 API GETs,
  7 mutation validation probes, 58 cryptorank contract checks) on 2026-09-27.
- Regression harness `apps/web/scripts/verify-cryptorank.py`: **244 passed / 0 failed / 8 info**.
- Browser DOM audit: **109/109** checks.
- All claims in docs must trace to tool output, not code reading.

### NFR-3 — Operations
- Local: systemd --user units `fudcourt-web`, `fudcourt-blog`, `fudcourt-sync.timer`; enabled at boot.
- Build gate: `unset NODE_ENV` before any `npm install`/`npm run build` (env trap).
- Git: commits authored `Fox <fox@local>`; debug artifacts never committed.

### NFR-4 — Security posture
- Blog: Payload access control (403 on user list), introspection off, playground prod-off.
- Web API mutations: fail-closed `x-fud-token` auth on all 7 write handlers ✅ 2026-09-28
  (`lib/mutation-auth.ts`, env `FUD_MUTATION_TOKEN`); builds without the env — public
  Vercel — reject every mutation with 401. Reads stay open on the LAN deployment.
- Web API: LAN-facing (`127.0.0.1:3100`), rate-limit helper present (`lib/rate-limit.ts`).
- Secrets never printed; `.env` values redacted in all tooling output.

## 5. Out of scope (decided, with reasons)

| Item | Reason |
|------|--------|
| CryptoRank official API v3 (keys) | Owner: *"We don't have API keys, the reverse engineering way we choose"* (re-affirmed twice) |
| `/ath`, `/performance`, `/funds/*`, ICO analytics, token-unlock, insights | WAF 403 to every client **or** literal `N/A`/empty ROI — no honest source |
| `/_next/data/*` funding/unlocks/ico routes | Measured synthetic decoy (nonexistent slugs return 200 fabricated payloads) |
| `/avg-roi-by-sector` | No constituents disclosed → no falsifiable claim path; offering filter broken upstream (500) |
| Multi-user / public auth for web API | Single-operator LAN surface; mutation auth implemented (R-6 ✅), full user auth still out of scope |
