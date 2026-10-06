# Trade domain — the canonical trading surface

This directory is the FUDCourt trading domain. Read the file headers before
changing any shape — each carries the design rationale that drove it, and they
are the contract the later phases build on.

| File | What it is |
| --- | --- |
| `taxonomy.ts` | 6 market types · 7 venues · 7 execution strategies · 7 order types · 2 margin modes · the `VENUE_MARKET_TYPES` matrix |
| `model.ts` | `Instrument` · `VenueCapability` · `Position` · `TradingAccount` · `MarketRow` · `PortfolioSummary` |
| `instrument.ts` | the canonical instrument REGISTRY — the `<base>-<quote>` id space a route resolves |
| `client.ts` | the browser-side typed surface; **composes** `/api/ticker` + `/api/executor/*` |
| `capabilities.ts` | the declared venue × market-type capability matrix the board renders |
| `intent.ts` | the composer's request builder — a pure `ComposerState` → `ExecutionRequest` |
| `adapters/` | one read-binding per venue (symbol resolution + where to read positions/balance) |
| `ui/dashboard.tsx` | `<TradeDashboard />` — the command-center shell, optional `marketType` prop |
| `ui/composer.tsx` | `<TradeComposer />` — intent → preview → place |
| `ui/capability-board.tsx` | `<CapabilityBoard />` — the "what does venue X support" table |
| `ui/accounts.tsx` | the connected-venue surface (masked key, permissions, capability summary) |
| `ui/instrument.tsx` | `<TradeInstrument />` — one instrument's cross-venue quotes + composer |
| `../../app/(frontend)/(public)/trade/` | the routes: `/trade`, `/trade/[marketType]`, `/trade/[marketType]/[instrument]`, `/trade/accounts` |

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
   The market board reads `/api/ticker`, the instrument page reads
   `/api/ticker/instrument`, the account panels read `/api/executor/*`. A bespoke
   `/api/trade/dashboard` would be a second source of truth for numbers other
   pages already serve. Feature families are independent (DR-018), and the
   structure gate enforces it — so the trade domain declares its OWN instrument
   registry rather than importing the ticker family's symbol list.
6. **The instrument URL space is a CLOSED set.** `instrument.ts` is the registry;
   `/trade/<marketType>/<instrument>` 404s an id it does not carry, the same rule
   the ticker detail route keeps. A shape-only check would make every well-formed
   pair an indexable page whose own data source answers "no venue quotes this".
   A market board row whose id is not in the registry is left UNLINKED (never a
   broken link), and `margin` (`tickerType: null`) has no instrument page at all.

`tests/trade-tests.ts` pins rules 1–4 and 6 (plus the taxonomy counts, id
uniqueness, the exhaustive capability matrix, the instrument-registry
invariants, and the null-vs-0 behaviour of the client and the formatters). Run it
with `bun run test:shapers`.

## Built

- **Phase 1–2 — Taxonomy + model.** The canonical vocabulary and the four
  entities, with the honesty rules in the types.
- **Phase 3 — Capability board.** One row per (venue × market type), one column
  per `OrderType`, each `true`/`false` exhaustively; `nativeTwap`/`nativeVwap`/
  `nativeIceberg` state whether the venue or the FUDCourt executor slices.
- **Phase 4 — Composer.** "Buy 0.01 BTC on Binance spot" → preview → risk figures
  → place, reusing the executor's risk engine (G14). PRD §98: a preview persists
  nothing. The instrument page pre-fills the pair.
- **Phase 5 — Adapter bindings.** One read-binding per venue (symbol resolution +
  where to read positions/balance). Boundary: the executor owns order placement;
  the trade domain owns positions + account + balance reads.
- **Phase 6 — Route seams.** `/trade` and `/trade/accounts` are in
  `PUBLIC_ROUTES`; the navbar carries a `trade` section (`site-nav.ts`); the
  market-type boards and the per-instrument pages are enumerated in
  `app/(frontend)/sitemap.ts` from `MARKET_TYPES` × `INSTRUMENTS`.
- **Phase 17 — TradingAccount UI.** The connected-venue surface: `apiKeyMasked`,
  `hasWithdrawPermission` (warn, never hide), venue type, and a capability
  summary.

## Not built yet

- **Phase 18 — BYOK credential binding.** Reuses the executor's
  `FUDCOURT_EXECUTOR_MASTER_KEY` (already sealed per-field, AES-256-GCM). The
  trade-domain secret surface is a strict SUBSET of the executor's — never
  re-implement the crypto.
- **Dated / option instrument ids.** `instrument.ts` carries the `<base>-<quote>`
  space; a dated future (`btc-20261225`) or a specific option strike needs a
  richer id shape and is a deliberate extension, not an oversight. Today
  `/trade/futures/btc-usdt` resolves the nearest dated contract per venue.
- **Live capability PROBES.** `capabilities.ts` values are DECLARED (Binance,
  Bybit, MEXC agree with the executor's probed registry; OKX, Hyperliquid and the
  DEXs are declared from their public order surface). A live probe is not wired.

## Out of scope for this domain

Order placement is the executor (G14). This domain exposes trading surfaces; the
executor executes. A market type whose `tickerType` is `null` (margin) renders a
"this market type is account-level" empty state, never a market board.
