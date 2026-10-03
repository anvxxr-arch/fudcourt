# PRD — Fudcourt

- **Status:** v1.1 — re-aligned 2026-09-28 to the running system ([ARCHITECTURE.md](../architecture/ARCHITECTURE.md)); v1.0 verified against remote head `957836d` (2026-09-27)
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
| **Public reader** | Portfolio view (`/portfolio`, self-hosted DR-002) + blog posts |
| **The agent (Fox)** | Machine-checkable contracts: harnesses, gates, loud failures |

## 3. Functional requirements

### FR-1 — Treasury core (portfolio/balance)
- FR-1.1 Aggregate balances per wallet/chain into net worth (`getAll()` → accounts, assets, transactions, journal, ledger, wallets, trades).
- FR-1.2 Transactions CRUD: create (single + bulk), list with filters (limit/offset/search/chain/venue/direction/date range), bulk update/delete.
- FR-1.3 Wallets: list, upsert-by-address (alias/emoji/color/notes).
- FR-1.4 **Exactness rule:** balance reconciliation is exact wallet+address+hash;
  amount/date-only matches are rejected as fake; every balance shows closing arithmetic.

### FR-2 — Live multi-chain sync
- FR-2.1 `sync-live.py` runs every 5 minutes (`fudcourt-sync.timer`) writing to Postgres `assets` (`FUDCOURT_PG_URL`, DR-040).
- FR-2.2 **Hard rule:** a failed RPC **raises** — it never becomes `0`. Absent data renders as absent, not zero.

### FR-3 — Market intelligence boards (frontend/web)
- FR-3.1 **CryptoRank integration** — 28 modes reverse-engineered from HTML SSR
  payloads (no API key, by explicit owner decision): home, coins, trending, gainers,
  losers, categories, exchanges (CEX/DEX/perps/transparency), coin detail, listings,
  blockchains/chain, launchpool (past/active/upcoming), nodesale, news, tags/tag,
  ecosystems/ecosystem, rwa/rwaasset, quarterly returns, prediction markets,
  converter, media, newstag, ai-overview; plus loud-503 refusals for `funding`/`unlocks`.
- FR-3.2 DEX Screener proxy (8 types),
  DefiLlama proxy (`chains`, `protocols`, `historical`), News proxy (strict
  `source`/`limit`), Signals proxy, **CoinGecko markets proxy** (`/api/markets`,
  top-250 pool — powers the Price Tracker; the tracker's former
  browser-direct CoinGecko call was re-aligned into this gated route). The
  ChainRank and Khala families remain API-only on the `backend/data` sidecar
  (`:3101`); their web boards and Next proxy routes were removed (DR-041).
- FR-3.3 Every board must fail loudly: upstream error → HTTP 502 with the real
  upstream status; never an empty-successful table.
- FR-3.4 Every family ships a verifier (`scripts/verify/verify-<family>.py`) asserting
  real/request-varying data, strict 400s on our params, honest `derived`
  labels, cache observability and independent ground-truth gates; families and
  their verifier status are tabulated in ARCHITECTURE.md §4 (news: monitor
  smoke only, deep verifier pending — PLAN SG-5.2).

### FR-4 — Blog (served by `frontend/web` at `/blog`, DR-017)
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
- Every route/endpoint live-verified (re-aligned sweep, latest measured **122/133**
  on 2026-09-29 over two byte-identical runs: 11 fails = 1 CoinGecko 403
  passthrough + 10 session-gated probes unrunnable on the :3107 audit target,
  which carries no `FUDCOURT_SESSION_SECRET` — both classes environmental, zero
  regressions). Production (:3100, systemd `EnvironmentFile`) does carry the
  secret and answers those gated paths correctly: `/api/admin/members` → 401,
  gated pages → 307.
- Regression harness `scripts/verify/verify-cryptorank.py`: **244 passed / 0 failed / 8 info**.
- Browser DOM audit: **109/109** checks.
- All claims in docs must trace to tool output, not code reading.

### NFR-3 — Operations
- Local: systemd --user units `fudcourt-web` (dashboard **and** blog), `fudcourt-data`, `fudcourt-reconciled`, `fudcourt-sync.timer`; enabled at boot. `fudcourt-blog` was retired by the DR-017 merge.
- Build gate: `unset NODE_ENV` before any `bun install`/`bun run build` (env trap).
- Runtime split (owner direction): acquisition families in Go (`backend/data`), the
  balance sync in Rust (`backend/sync`), the UI/API surface in TypeScript on Bun
  (`frontend/web` only — the blog merged into it, DR-017); Python remains the verification-oracle language.
  See docs/records/DECISIONS.md DR-005/DR-006/DR-007/DR-008/DR-009/DR-010/DR-012/DR-013.
- Git: commits authored `Fox <fox@local>`; debug artifacts never committed.

### NFR-4 — Security posture
- Blog: Payload access control (403 on user list), introspection off, playground prod-off.
- Web API: Discord-session tier gating ✅ 2026-09-28. Treasury **reads**
  (`/api/all`, `/api/wallets`, `/api/coins`, `/api/reconcile`,
  `/api/transactions`) require `team`; all 7 write handlers re-check the
  session server-side (`lib/mutation-auth.ts`). Builds without the env —
  fail-closed, every gated path refused rather than open. Replaces the
  `x-fud-token` scheme, which shipped its token in the client bundle.
- Web API: public hostname (`https://fc.dwirijal.my.id` → loopback `:3100`).
  **Inbound rate limit live 2026-09-29** (`lib/rate-limit-inbound.ts` +
  `middleware.ts`, DR-004): a per-client, cost-weighted 60 s window priced from
  each route's measured worst-case payload, `429` + `Retry-After` on refusal,
  `X-RateLimit-*` on every response. Anonymous heavy routes get 80 units
  (`mode=converter` = 20, so the fourth request of a window is refused); a
  signed-in caller 3×; traffic the origin accepted from its own address space
  (loopback/RFC1918/link-local peer with no `CF-Connecting-IP` — the operator's
  harness) 100×, decided by the peer address rather than by a missing header
  (DR-004 amendment, 2026-09-29). Fails open — a limiter bug must not take the
  public boards down. Outbound pacing (`lib/rate-limit.ts`) is unchanged and
  separate.
- Secrets never printed; `.env` values redacted in all tooling output.

## 5. Out of scope (decided, with reasons)

| Item | Reason |
|------|--------|
| CryptoRank official API v3 (keys) | Owner: *"We don't have API keys, the reverse engineering way we choose"* (re-affirmed twice) |
| `/ath`, `/performance`, `/funds/*`, ICO analytics, token-unlock, insights | WAF 403 to every client **or** literal `N/A`/empty ROI — no honest source |
| `/_next/data/*` funding/unlocks/ico routes | Measured synthetic decoy (nonexistent slugs return 200 fabricated payloads) |
| `/avg-roi-by-sector` | No constituents disclosed → no falsifiable claim path; offering filter broken upstream (500) |
| Multi-user / public auth for web API | Single-operator LAN surface; mutation auth implemented (R-6 ✅), full user auth still out of scope |
