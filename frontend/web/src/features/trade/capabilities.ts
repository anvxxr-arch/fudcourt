/**
 * capabilities.ts — the trade domain's declared venue capability matrix
 * (plan Phase 3 board + Phase 5 data).
 *
 * WHAT THIS IS. One row per (venue × market type) the taxonomy says a venue
 * serves — never a pairing outside `VENUE_MARKET_TYPES`, because the board must
 * not offer an impossible combination. Each row states, EXHAUSTIVELY, every
 * `OrderType` as true or false: the supported set is written down, and every
 * other type is an explicit `false`, so a missing capability is a STATED
 * limitation the board renders as `✕`, never an absent column. An absent key is
 * a bug, not a missing feature (the `model.ts` honesty rule).
 *
 * WHERE THE VALUES COME FROM. They are the domain's DECLARED capabilities, not a
 * live probe. For Binance, Bybit and MEXC they agree with the executor's own
 * probed registry (`backend/workers/executor/internal/exchanges` EXCHANGE_CAPABILITIES): a
 * `nativeTwap: false` there is a `nativeTwap: false` here, so the board's
 * "TWAP: executor" cell matches the engine that actually slices the order. The
 * venues the executor does not route yet (OKX, Hyperliquid, Uniswap, Jupiter)
 * are declared from their public order-type surface and called out in the row's
 * own comment. The board never claims more than this table: a `false` is a
 * statement about the VENUE, and the executor's synthetic engine covers the gap
 * (PRD §28) — that is the whole point of stating the gap rather than hiding it.
 *
 * The matrix is BUILT from `VENUE_MARKET_TYPES`, so the two can never disagree:
 * adding a market type to a venue without a capability row is a hard error, and
 * a row for a pairing the taxonomy does not carry is impossible by construction.
 */
import {
  ORDER_TYPES,
  VENUES,
  VENUE_MARKET_TYPES,
  type MarketType,
  type OrderType,
  type OrderTypeEntry,
  type VenueId,
} from '@/features/trade/taxonomy';
import type { VenueCapability } from '@/features/trade/model';

/**
 * The supported set written down; every other `OrderType` becomes an explicit
 * `false`. The returned record is TOTAL by construction — the seven keys are
 * always present — so a capability that omits a type cannot be represented.
 */
function orderTypeRecord(supported: readonly OrderType[]): Readonly<Record<OrderType, boolean>> {
  const set = new Set<OrderType>(supported);
  const record = {} as Record<OrderType, boolean>;
  for (const orderType of ORDER_TYPES) record[orderType.id] = set.has(orderType.id);
  return record;
}

/** The order types an order-book venue has for a spot-like (unleveraged) product. */
const BOOK_SPOT: readonly OrderType[] = ['market', 'limit', 'stop_market', 'stop_limit', 'take_profit'];
/** The same book, plus a stop that follows the price (the venue offers trailing). */
const BOOK_TRAILING: readonly OrderType[] = [...BOOK_SPOT, 'trailing_stop'];
/** A derivatives book: the spot set plus trailing; reduce-only is a separate flag. */
const BOOK_DERIV = BOOK_TRAILING;
/** An AMM/DEX swap has exactly one executable order type: market. */
const AMM_SWAP: readonly OrderType[] = ['market'];

/** One capability row's input, minus the venue/market-type the builder supplies. */
type CapabilityFlags = {
  /** The canonical instrument the board uses to represent this row. */
  instrumentId: string;
  /** The order types the venue ACTUALLY has here; everything else is stated false. */
  supported: readonly OrderType[];
  nativeTwap?: boolean;
  nativeVwap?: boolean;
  nativeIceberg?: boolean;
  leverage?: boolean;
  /** Null for a market type with no margin concept (spot, swap). */
  marginModes?: { cross: boolean; isolated: boolean } | null;
  reduceOnly?: boolean;
  postOnly?: boolean;
};

/**
 * The declared flags per venue × market type. Typed `Partial` so a venue only
 * names the market types it serves — the BUILDER iterates `VENUE_MARKET_TYPES`,
 * not this object, so a missing entry is a thrown error and an extra entry is
 * simply unreachable. That keeps the taxonomy the single source of truth for
 * which pairings exist.
 */
const CAPABILITY_INPUTS: Readonly<Record<VenueId, Readonly<Partial<Record<MarketType, CapabilityFlags>>>>> = {
  // ── Binance — the executor's own registry (exchange.ts) is the source ──────
  binance: {
    // spot: OCO is native, iceberg via `icebergQty`, no native TWAP/VWAP.
    spot: { instrumentId: 'btc-usdt', supported: [...BOOK_SPOT, 'trailing_stop', 'oco'], nativeIceberg: true, postOnly: true },
    margin: { instrumentId: 'btc-usdt', supported: [...BOOK_SPOT, 'trailing_stop', 'oco'], nativeIceberg: true, leverage: true, marginModes: { cross: true, isolated: true }, postOnly: true },
    perpetual: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    futures: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    // options: an option book takes market/limit only; no adjustable leverage.
    options: { instrumentId: 'btc-usdt', supported: ['market', 'limit'] },
  },
  // ── Bybit — probed by the executor: trailing true, iceberg/twap/oco false ──
  bybit: {
    spot: { instrumentId: 'btc-usdt', supported: BOOK_TRAILING, postOnly: true },
    perpetual: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    futures: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    options: { instrumentId: 'btc-usdt', supported: ['market', 'limit'] },
  },
  // ── MEXC — probed by the executor: trailing false (trigger orders only) ────
  mexc: {
    spot: { instrumentId: 'btc-usdt', supported: BOOK_SPOT, postOnly: true },
    perpetual: { instrumentId: 'btc-usdt', supported: BOOK_SPOT, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    futures: { instrumentId: 'btc-usdt', supported: BOOK_SPOT, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
  },
  // ── OKX — not routed by the executor yet; declared from its order surface ──
  okx: {
    spot: { instrumentId: 'btc-usdt', supported: [...BOOK_SPOT, 'trailing_stop', 'oco'], postOnly: true },
    margin: { instrumentId: 'btc-usdt', supported: [...BOOK_SPOT, 'trailing_stop', 'oco'], leverage: true, marginModes: { cross: true, isolated: true }, postOnly: true },
    perpetual: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    futures: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    options: { instrumentId: 'btc-usdt', supported: ['market', 'limit'] },
  },
  // ── Hyperliquid — an on-chain perp book with a NATIVE TWAP and ALO ─────────
  hyperliquid: {
    perpetual: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, nativeTwap: true, leverage: true, marginModes: { cross: true, isolated: false }, reduceOnly: true, postOnly: true },
  },
  // ── Uniswap / Jupiter — AMM swaps: the pool takes a market swap, nothing else
  uniswap: {
    swap: { instrumentId: 'eth-usdc', supported: AMM_SWAP },
  },
  jupiter: {
    swap: { instrumentId: 'sol-usdc', supported: AMM_SWAP },
  },
};

/** Build one `VenueCapability` row from its flags (omitted flags are stated false/null). */
function toCapability(venue: VenueId, marketType: MarketType, flags: CapabilityFlags): VenueCapability {
  return {
    venue,
    instrumentId: flags.instrumentId,
    marketType,
    orderTypes: orderTypeRecord(flags.supported),
    nativeTwap: flags.nativeTwap ?? false,
    nativeVwap: flags.nativeVwap ?? false,
    nativeIceberg: flags.nativeIceberg ?? false,
    leverage: flags.leverage ?? false,
    marginModes: flags.marginModes ?? null,
    reduceOnly: flags.reduceOnly ?? false,
    postOnly: flags.postOnly ?? false,
  };
}

/**
 * The whole matrix, in taxonomy order: venues as declared, market types in the
 * order `VENUE_MARKET_TYPES` lists them. A venue × market-type pairing with no
 * declared flags throws at module load — the board must never silently drop a
 * pairing the taxonomy says exists.
 */
function buildMatrix(): readonly VenueCapability[] {
  const rows: VenueCapability[] = [];
  for (const venue of VENUES) {
    for (const marketType of VENUE_MARKET_TYPES[venue.id]) {
      const flags = CAPABILITY_INPUTS[venue.id][marketType];
      if (flags === undefined) {
        throw new Error(`capability matrix: no declared flags for ${venue.id} × ${marketType}`);
      }
      rows.push(toCapability(venue.id, marketType, flags));
    }
  }
  return rows;
}

export const CAPABILITY_MATRIX: readonly VenueCapability[] = buildMatrix();

/** The board's columns: every `OrderType`, exhaustively, in taxonomy order. */
export const CAPABILITY_COLUMNS: readonly OrderTypeEntry[] = ORDER_TYPES;

/** The board's rows plus its columns, so a renderer never restates either. */
export function capabilityBoard(): { columns: readonly OrderTypeEntry[]; rows: readonly VenueCapability[] } {
  return { columns: CAPABILITY_COLUMNS, rows: CAPABILITY_MATRIX };
}

/** One venue's rows, in taxonomy order. */
export function capabilitiesForVenue(venue: VenueId): readonly VenueCapability[] {
  return CAPABILITY_MATRIX.filter((row) => row.venue === venue);
}

/** The row for one (venue, market type), or `undefined` when the pairing does not exist. */
export function capabilityFor(venue: VenueId, marketType: MarketType): VenueCapability | undefined {
  return CAPABILITY_MATRIX.find((row) => row.venue === venue && row.marketType === marketType);
}

/**
 * A "supports X, Y, Z but not W" split of a row's order types, for the accounts
 * capability summary. Both lists are derived from the exhaustive record, so the
 * two always account for every `OrderType` — nothing is quietly dropped.
 */
export function capabilityOrderTypeSplit(capability: VenueCapability): {
  supports: readonly OrderTypeEntry[];
  missing: readonly OrderTypeEntry[];
} {
  const supports: OrderTypeEntry[] = [];
  const missing: OrderTypeEntry[] = [];
  for (const entry of ORDER_TYPES) {
    (capability.orderTypes[entry.id] ? supports : missing).push(entry);
  }
  return { supports, missing };
}
