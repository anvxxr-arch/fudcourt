/**
 * client-fetch-market.ts — ticker/market fetchers of the trade domain.
 *
 * Composes the endpoints that already exist (`/api/ticker`,
 * `/api/ticker/instrument`); invents no private aggregate. Every call here is
 * BOUNDED (see FETCH_TIMEOUT_MS in `./client-fetch-transport`).
 */
import type { MarketRow } from '@/features/trade/model';
import { MARKET_TYPE_BY_ID, type MarketType, type TickerType } from '@/features/trade/model';
import { getJSON } from '@/lib/fetch';
import { bounded } from './client-fetch-transport';

// ---------------------------------------------------------------------------
// The ticker envelope (the fields this module reads, not the whole shape)
// ---------------------------------------------------------------------------
type TickerVenueQuote = {
  exchange: string;
  last: number | null;
};
type TickerRowLite = {
  symbol: string;
  base: string;
  quote: string;
  type: TickerType;
  price: number | null;
  /** 24h change in PERCENT (1.39 = +1.39%), not a fraction. See `formatChange`. */
  change24h: number | null;
  quoteVolume: number | null;
  venues: TickerVenueQuote[];
  spread: number | null;
};
type TickerEnvelope = {
  rows: TickerRowLite[];
  count: number;
  total: number;
  /** Row counts per ticker type across the WHOLE filtered set, not the page. */
  typeCounts: Partial<Record<TickerType, number>>;
  /** Null-valued when the route answered an error body; see `fetchMarketRows`. */
  error?: string;
  detail?: string;
};

/**
 * The ticker's own vocabulary does not have a slot for every market type
 * (`margin` is an account setting, not a quotable instrument). A market type
 * with no `tickerType` is a stated gap, so the board renders its structure with
 * an honest empty board rather than silently showing spot rows under a Margin
 * heading.
 */
export function tickerTypeFor(marketType: MarketType): TickerType | null {
  return MARKET_TYPE_BY_ID[marketType].tickerType;
}

/** The canonical route for a market type (`perpetual` → `/trade/perpetual`). */
export function marketTypeHref(marketType: MarketType): string {
  return `/trade/${marketType}`;
}

function toMarketRow(row: TickerRowLite, marketType: MarketType): MarketRow {
  return {
    instrumentId: `${row.base}-${row.quote}`.toLowerCase(),
    base: row.base,
    quote: row.quote,
    marketType,
    price: row.price,
    change24h: row.change24h,
    quoteVolume: row.quoteVolume,
    // `/api/ticker` can answer a DEGRADED row that carries none of these — one row
    // `{symbol, base, tag:'recovered'}` with no venues/price/type (caught live, and
    // the crash it caused is what killed the Markets panel). Guard rather than
    // assume: an unstated venue list is not an empty one, so it degrades to `[]`
    // and the cells say so, instead of throwing and blanking the whole board.
    venues: (row.venues ?? []).map((v) => ({ venue: v.exchange, price: v.last })),
    spreadPct: row.spread,
  };
}

/** The market type a ticker row belongs to, in the ticker's own vocabulary. */
function marketTypeOfTickerRow(type: TickerType): MarketType {
  switch (type) {
    case 'swap':
      return 'perpetual';
    case 'future':
      return 'futures';
    case 'option':
      return 'options';
    default:
      return 'spot';
  }
}

/**
 * The market board for one market type, or `'all'` for the command center's
 * cross-type board.
 *
 * `'all'` asks the ticker for every type at once (its default) and labels each
 * row by the type the ticker reported. A specific type asks only for that type.
 * A type the ticker cannot quote (`margin`) is NOT mapped to another type — it
 * returns an empty board, which the caller renders as a stated gap.
 */
export async function fetchMarketRows(
  marketType: MarketType | 'all',
  signal?: AbortSignal,
): Promise<MarketRow[]> {
  const params = new URLSearchParams({ sort: 'volume', order: 'desc', limit: '50' });
  if (marketType !== 'all') {
    const tickerType = tickerTypeFor(marketType);
    if (tickerType === null) return [];
    params.set('type', tickerType);
  }
  const body = await getJSON<TickerEnvelope>(`/api/ticker?${params.toString()}`, { signal: bounded(signal), cache: 'no-store' });
  return (body.rows ?? []).map((r) =>
    toMarketRow(r, marketType === 'all' ? marketTypeOfTickerRow(r.type) : marketType),
  );
}

/**
 * One venue's answer for ONE instrument, as `/api/ticker/instrument` reports it.
 * A `last` of null with an `error` is a MISS, never a price (the null-vs-0 rule).
 */
export type InstrumentQuote = {
  exchange: string;
  /** The venue's OWN symbol for this instrument (e.g. `BTC/USDT`). Read, not built. */
  symbol: string;
  /** The unit this venue's number is in, or null when it has no price. */
  settle: string | null;
  last: number | null;
  bid: number | null;
  ask: number | null;
  high24h: number | null;
  low24h: number | null;
  quoteVolume: number | null;
  change24h: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  /** Unix ms the venue's quote is stamped, or null when it did not report one. */
  at: number | null;
  error: string | null;
};

/** The per-instrument detail response — the fields this module actually reads. */
export type InstrumentDetail = {
  base: string;
  type: TickerType;
  quotes: InstrumentQuote[];
  /** How many venues priced it. */
  priced: number;
  /** Median of the venues that priced it, or null when none did. */
  price: number | null;
  /** Venues that list no such instrument — a fact about the market, not a failure. */
  notListed: string[];
  /** Venues that should have answered and did not. */
  failed: string[];
  timestamp: number;
};

/**
 * Cross-venue quotes for ONE instrument, from the ticker family's own endpoint
 * (`/api/ticker/instrument`). The trade domain COMPOSES it (DR-018) rather than
 * reading exchange APIs itself, so there is one source of truth for a price.
 *
 * A base no venue quotes is NOT an error: the endpoint answers with an empty
 * `quotes` list and `price: null`, and this module reports that as-is — the page
 * renders "no venue quotes this", never a fabricated zero.
 */
export async function fetchInstrumentDetail(
  base: string,
  tickerType: TickerType,
  signal?: AbortSignal,
): Promise<InstrumentDetail> {
  const params = new URLSearchParams({ base, type: tickerType });
  const body = await getJSON<Partial<InstrumentDetail> & { error?: string; detail?: string }>(`/api/ticker/instrument?${params.toString()}`, { signal: bounded(signal), cache: 'no-store' });
  return {
    base: typeof body.base === 'string' ? body.base : base,
    type: (body.type ?? tickerType) as TickerType,
    quotes: Array.isArray(body.quotes) ? (body.quotes as InstrumentQuote[]) : [],
    priced: typeof body.priced === 'number' ? body.priced : 0,
    price: typeof body.price === 'number' ? body.price : null,
    notListed: Array.isArray(body.notListed) ? (body.notListed as string[]) : [],
    failed: Array.isArray(body.failed) ? (body.failed as string[]) : [],
    timestamp: typeof body.timestamp === 'number' ? body.timestamp : Date.now(),
  };
}
