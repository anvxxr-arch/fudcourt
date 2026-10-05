# Trade domain — foundation settled, Phase 3+ is next

This directory is the FUDCourt trading domain. **Phase 1–2 is settled and
committed**: the canonical taxonomy and the canonical data model. Read the file
headers before changing either shape — each carries the design rationale that
drove it, and they are the contract later phases build on.

| File | What it is |
| --- | --- |
| `taxonomy.ts` | 6 market types · 7 venues · 7 execution strategies · 7 order types · 2 margin modes · the `VENUE_MARKET_TYPES` capability matrix |
| `model.ts` | `Instrument` · `VenueCapability` · `Position` · `TradingAccount` · `MarketRow` · `PortfolioSummary` |
| `client.ts` | the browser-side typed surface; **composes** `/api/ticker` + `/api/executor/*` |
| `ui/parts.tsx` | the shared atoms (Card, DataTable, Value, ErrorState, …) |
| `ui/dashboard.tsx` | `<TradeDashboard />` — the command-center shell, optional `marketType` prop |
| `../../app/(frontend)/(public)/trade/` | the routes: `/trade` and `/trade/[marketType]` |

## The rules the shape encodes (do not re-litigate)

1. **A route is a market type, never a venue.** `/trade/perpetual`, never
   `/trade/binance`. Venue and execution strategy are METADATA on an order, not
   URL segments; a venue route would force a second copy of every market type
   under every venue. No venue id is a market type — that invariant is asserted
   in `tests/trade-tests.ts`.
2. **`Instrument.id` is canonical** (`btc-usdt`, lowercased `<base>-<quote>`).
   The venue's own symbol (`BTCUSDT`) is a FIELD (`venueSymbol`) the adapter
   resolves; a view never builds a native symbol.
3. **`MarketRow.venues[].venue` is `string`, not `VenueId`.** A price source is
   not the same list as a tradable venue: the ticker reads ten sources to
   establish a price, FUDCourt can only route to the seven in `VENUES`. Typing
   it `VenueId` would silently drop sources.
4. **Honesty lives in the types.** A measurement nobody published is
   `number | null`, never `0`; `VenueCapability.orderTypes` is a total record
   (every `OrderType` present as `true`/`false` — an absent key is a bug, not a
   missing feature); `TradingAccount` carries `apiKeyMasked` and has **no**
   `apiKey` field, so a secret has nowhere to live.
5. **`client.ts` composes existing endpoints; it invents no private aggregate.**
   The market board reads `/api/ticker`, the account panels read
   `/api/executor/*`. A bespoke `/api/trade/dashboard` would be a second source
   of truth for numbers other pages already serve. Feature families are
   independent (DR-018).

`tests/trade-tests.ts` pins rules 1–4 (plus the taxonomy counts, id uniqueness,
the exhaustive capability matrix, and the null-vs-0 behaviour of the client and
the formatters). Run it with `bun run test:shapers`.

## What is NOT built yet (Phase 3+)

- **Phase 3 — Capability board.** The "what does venue X support" table. One row
  per (venue × market type × instrument), one column per `OrderType`, each
  rendered `true`/`false` exhaustively; `nativeTwap`/`nativeVwap`/`nativeIceberg`
  state whether the venue or the FUDCourt executor slices. Reads
  `VenueCapability` directly.
- **Phase 4 — Composer.** "Buy 0.01 BTC on Binance spot" → preview → risk figures
  → place. Reuses the executor's risk engine (G14) for sizing, never a parallel
  implementation. PRD §98: a preview persists nothing.
- **Phase 5 — Venue capability data + adapter bindings.** The truth of which order
  types each venue ACTUALLY has, and a per-venue adapter file for trade-domain
  reads (positions, account, balance). Boundary: the executor owns order
  placement; the trade domain owns positions + account + balance reads.
- **Phase 6 — Route seams: WIRED.** `/trade` is registered in `PUBLIC_ROUTES`
  (`public-routes.ts`), carries its own navbar section (`site-nav.ts`, key
  `trade`), and the six market-type boards are enumerated in
  `app/(frontend)/sitemap.ts` from `MARKET_TYPES`. `tests/routing-tests.ts` and
  `tests/nav-tests.ts` pin the registration, so a new market type cannot ship a
  page that is missing from the sitemap or the bar.
- **Phase 17 — TradingAccount UI.** A connected-accounts surface showing
  `apiKeyMasked`, `hasWithdrawPermission` (warn, never hide), venue type, and a
  "supports X, Y, Z but not W" capability summary.
- **Phase 18 — BYOK credential binding.** Reuses the executor's
  `FUDCOURT_EXECUTOR_MASTER_KEY` (already sealed per-field, AES-256-GCM). The
  trade-domain secret surface is a strict SUBSET of the executor's — never
  re-implement the crypto.

## Out of scope for this domain

Order placement is the executor (G14). This domain exposes trading surfaces; the
executor executes. A market type whose `tickerType` is `null` (margin) renders a
"this market type is account-level" empty state, never a market board.
