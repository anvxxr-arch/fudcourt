/**
 * The trade domain's canonical taxonomy (plan Phase 1–2).
 *
 * WHY A TAXONOMY AND NOT A PROVIDER LIST. Three concepts get constantly
 * confused in trading UIs, and confusing them is what makes an engine
 * impossible to extend later:
 *
 *   Market type — WHAT is traded   (spot, margin, perpetual, futures, options, swap)
 *   Venue       — WHERE it trades  (Binance, Bybit, OKX, Hyperliquid, Uniswap…)
 *   Execution   — HOW it is worked (direct, TWAP, VWAP, iceberg, scaled, DCA…)
 *
 * They are orthogonal: a perpetual on Binance worked with a TWAP uses one of
 * each. So NONE of them is a route segment by itself. The routes are market
 * types (`/trade/perpetual`), and the venue and the strategy are METADATA on an
 * order. A `/trade/binance` route would make the venue structural and force a
 * second copy of every market type under every venue — the exact blow-up this
 * file exists to prevent.
 *
 * `venueType` (CEX vs DEX) is a property of the VENUE, not a market type: the
 * same swap can be a CEX order or a DEX pool, and the distinction is where it
 * executes, not what it is.
 *
 * A market type also declares its `tickerType`, which is the vocabulary the
 * public ticker board already speaks (`/api/ticker`). That mapping lives HERE,
 * once, so the board can render a market type without a second hard-coded table
 * — and so a market type the ticker cannot quote yet (margin) is an explicit
 * `null`, never a silent fall-through to spot that answers a different question.
 */

/**
 * model-taxonomy.ts — barrel over the split taxonomy modules.
 *
 * `model-markets.ts` owns market types, instruments and domain entities;
 * `model-venues.ts` owns venues and the capability matrix. Every previous
 * importer keeps importing from `@/features/trade/model` (via `model.ts`).
 */
export * from './model-markets';
export * from './model-venues';
