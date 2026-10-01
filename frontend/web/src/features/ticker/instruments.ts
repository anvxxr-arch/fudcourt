/**
 * Instrument discovery for the ticker family.
 *
 * Futures and options are not one price each: an exchange lists many expiries,
 * and an option adds a strike and a call/put on top. The set of instruments
 * therefore has to come from the venues themselves rather than from a guess
 * hardcoded here — a hand-written symbol like 'BTC/USDT:BTC-240927C50000' is
 * rejected outright by the exchange it was written for.
 *
 * Cost matters: `loadMarkets` pulls thousands of instruments per venue and
 * takes seconds, so the market maps are cached for a long window and shared
 * across every request. Instrument *prices* are not cached here; those go
 * through the TTL memo in lib/ticker.ts.
 */
import type { Exchange as CcxtExchange } from 'ccxt';
import { TICKER_EXCHANGES, isQuotableSettlement, type TickerExchange, type TickerInstrument, type TickerType, venueServes } from '@/features/ticker/client';
import { tickerClients } from '@/features/ticker/venues';

// Re-exported so consumers get the instrument model and the discovery helpers
// from one place, rather than importing both modules.
export type { TickerInstrument };

/**
 * Market maps change only when an exchange lists or delists something, so
 * this is far longer than any price TTL. A day is still short enough that a
 * newly listed contract appears within a day of being live.
 */
const MARKETS_TTL_MS = 24 * 60 * 60 * 1000;

type LoadedMarkets = { at: number; markets: Record<string, CcxtExchange['markets'][string]> };

const marketsCache = new Map<TickerExchange, LoadedMarkets>();
const marketsInFlight = new Map<TickerExchange, Promise<void>>();

/**
 * A usable market list for one venue, loaded once per MARKETS_TTL_MS.
 *
 * Failure is cached too, but only for a short window: a venue that is briefly
 * unreachable should not be written off for a day, and a load that throws on
 * every request would hammer an upstream that is already struggling.
 */
export async function ensureMarkets(
  venue: TickerExchange,
  load: (client: CcxtExchange) => Promise<unknown>,
): Promise<CcxtExchange['markets'] | null> {
  const hit = marketsCache.get(venue);
  if (hit && Date.now() - hit.at < MARKETS_TTL_MS) return hit.markets;

  const running = marketsInFlight.get(venue);
  if (running) {
    await running;
    return marketsCache.get(venue)?.markets ?? null;
  }

  const client = tickerClients().get(venue);
  if (!client) return null;

  const task = load(client)
    .then(() => {
      marketsCache.set(venue, { at: Date.now(), markets: client.markets });
    })
    .catch(() => {
      // A failed load must not be memoised for the full TTL: record it as a
      // short-lived empty result so the next request retries.
      marketsCache.delete(venue);
    })
    .finally(() => {
      marketsInFlight.delete(venue);
    });
  marketsInFlight.set(venue, task);
  await task;
  return marketsCache.get(venue)?.markets ?? null;
}

/** The type ccxt's unified symbol implies, or null if it is not one of ours. */
function marketType(market: CcxtExchange['markets'][string]): TickerType | null {
  if (market.option) return 'option';
  if (market.future) return 'future';
  if (market.swap) return 'swap';
  if (market.spot) return 'spot';
  return null;
}

/**
 * Every instrument a venue lists for one base asset and market type.
 *
 * `settle` optionally pins the settlement currency (e.g. 'USDT'). The same
 * coin is listed settled in USD at one venue and USDT at another, and those
 * are genuinely different contracts whose prices differ by a real basis.
 * Callers that need to compare prices across venues pass the settlement they
 * want; the sweep deliberately does not, because it groups by settlement
 * instead so a basis is never reported as venue disagreement.
 */
export function instrumentsFor(
  markets: CcxtExchange['markets'],
  base: string,
  type: TickerType,
  settle?: string,
): TickerInstrument[] {
  const out: TickerInstrument[] = [];
  for (const [symbol, market] of Object.entries(markets)) {
    if (!market.active) continue;
    if (marketType(market) !== type) continue;
    if (market.base !== base) continue;
    if (settle && market.settle !== settle && market.quote !== settle) continue;
    // Only USD, USD-pegged and coin-margined settlements. Fiat is excluded: a
    // BTC/AUD market quoted next to BTC/USDT would differ by the AUD/USD rate
    // and the board would report that exchange rate as venue disagreement.
    if (!settle && !isQuotableSettlement(market.settle ?? market.quote, base)) continue;

    out.push({
      symbol,
      type,
      settle: market.settle ?? market.quote ?? null,
      expiry: typeof market.expiry === 'number' ? market.expiry : null,
      strike: typeof market.strike === 'number' ? market.strike : null,
      // ccxt's `market.contract` is a boolean flag, NOT the 'call'/'put' string
      // its docs imply — verified on OKX, where a -C symbol reports
      // `contract: true`. Reading the kind off that field silently labels every
      // option a put, so it is parsed from the symbol's own -C/-P suffix,
      // which is unambiguous in ccxt's unified format.
      optionKind: market.option
        ? (symbol.endsWith('-P') ? 'put' : 'call')
        : null,
      contractSize: typeof market.contractSize === 'number' ? market.contractSize : null,
    });
  }
  return out;
}

/**
 * The per-type summary the instruments route returns for the UI selectors.
 *
 * Strikes are keyed by expiry date rather than flattened, because an option
 * chain's strike ladder is a function of its expiry: the nearest chain ladders
 * around spot, a later month lists a different and wider ladder. One flat
 * list would offer strikes the chosen expiry does not list.
 */
export interface TypeInstrumentSummary {
  venues: TickerExchange[];
  expiries: string[];
  strikesByExpiry: Record<string, number[]>;
  default: {
    symbol: string;
    expiry: string | null;
    strike: number | null;
    optionKind: 'call' | 'put' | null;
  } | null;
}
/**
 * Pick the instrument a board row should show when the reader has not chosen
 * one. Spot and perpetual have exactly one; dated and option do not.
 *
 * For a future the nearest expiry is the front of the curve and the one people
 * mean by "the BTC future". For an option the choice is near-the-money at the
 * nearest expiry: an option far out of the money is a different trade, not a
 * better default.
 *
 * `spotPrice` is the reference that makes near-the-money meaningful, and it
 * must be the spot for the SAME base asset at the time of the call. Callers
 * that hold one pass it; callers that do not pass null, which selects the
 * median strike at the nearest expiry — the honest fallback, since without a
 * spot there is nothing to be near. Passing a stale or absent price as if it
 * were spot would mislabel the default rather than fall back.
 */
export function defaultInstrument(
  instruments: TickerInstrument[],
  spotPrice: number | null,
): TickerInstrument | null {
  if (instruments.length === 0) return null;
  if (instruments.length === 1) return instruments[0];

  const dated = instruments.filter(i => i.expiry !== null);
  if (dated.length === 0) return instruments[0];
  const nearestExpiry = Math.min(...dated.map(i => i.expiry as number));

  const atExpiry = dated.filter(i => i.expiry === nearestExpiry);
  const strikes = atExpiry.filter(i => i.strike !== null);
  if (strikes.length === 0) return atExpiry[0];
  if (spotPrice === null) {
    // Without a spot price we cannot call anything at-the-money, so fall back
    // to the median strike rather than picking arbitrarily.
    const sorted = strikes.map(i => i.strike as number).sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)];
    return strikes.find(i => i.strike === mid) ?? strikes[0];
  }
  let best = strikes[0];
  let bestDist = Math.abs((best.strike as number) - spotPrice);
  for (const i of strikes) {
    const d = Math.abs((i.strike as number) - spotPrice);
    if (d < bestDist) { best = i; bestDist = d; }
  }
  return best;
}

/**
 * The distinct expiries present, as ISO dates, ascending.
 *
 * ISO dates rather than raw timestamps because that is what the UI can both
 * display and use as a stable selector value, and because ccxt's expiry is a
 * timestamp at market open whose time-of-day component carries no meaning
 * here.
 */
export function expiriesFor(instruments: TickerInstrument[]): string[] {
  const seen = new Set<string>();
  for (const i of instruments) {
    if (i.expiry === null) continue;
    seen.add(new Date(i.expiry).toISOString().slice(0, 10));
  }
  return [...seen].sort();
}

export function strikesFor(instruments: TickerInstrument[], expiryIso: string): number[] {
  const seen = new Set<number>();
  for (const i of instruments) {
    if (i.strike === null) continue;
    // Expiries are timestamps at market open; compare by calendar day.
    if (new Date(i.expiry as number).toISOString().slice(0, 10) !== expiryIso) continue;
    seen.add(i.strike);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Venues that list at least one instrument for this base + type. */
export function venuesWithInstruments(
  perVenue: Map<TickerExchange, TickerInstrument[]>,
  type: TickerType,
): TickerExchange[] {
  return TICKER_EXCHANGES.filter(v => venueServes(v, type) && (perVenue.get(v)?.length ?? 0) > 0);
}
