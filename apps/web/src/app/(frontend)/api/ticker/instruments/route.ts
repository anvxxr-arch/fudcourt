import { NextResponse } from 'next/server';
import {
  TICKER_EXCHANGES,
  TICKER_SEARCH_MAX,
  TICKER_SYMBOLS,
  TICKER_TTL_MS,
  TICKER_TYPES,
  TICKER_TYPE_LABELS,
  TICKER_VENUES,
  medianPrice,
  venueServes,
  venuesForType,
  type TickerExchange,
  type TickerType,
  type TickerInstrument,
  } from '@/features/market/ticker/client';
import {
  defaultInstrument,
  ensureMarkets,
  expiriesFor,
  instrumentsFor,
  strikesFor,
  tickerClients,
  type TypeInstrumentSummary,
} from '@/features/market/ticker/venues';

/**
 * Browser/shared-cache lifetime for a SUCCESSFUL body, derived from the same
 * TICKER_TTL_MS the in-process validated cache uses, so the two never
 * disagree: a body the route would still serve from its own cache is also
 * fresh for a downstream cache. The board route (/api/ticker) has carried
 * this header since the perf pass; the two detail endpoints did not, which
 * meant every navigation re-requested metadata the server had just served.
 *
 * Only successful bodies carry it — a 400 (bad strike, unknown base) or a
 * 502 (upstream failure) must never be cached, and those return early
 * without it.
 */
const CACHE_CONTROL = `public, max-age=${Math.floor(TICKER_TTL_MS / 1000)}`;
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';


// Route-local validated-payload cache with single-flight. Map keyed by
// normalized query string (the allowlist bounds this route to 30 symbols),
// TTL from the TICKER_TTL_MS family contract, LRU cap 100. Only bodies that
// pass isValidInstrumentsBody are admitted; 400s/404s/502s stay uncached and
// retry upstream on every request. Route-local (not shared) so a bad
// instruments payload can never poison another family's cache entry. No CCXT
// call logic is changed.
const VALID_MAX_ENTRIES = 100;
type ValidEntry = { at: number; body: unknown };
const validated = new Map<string, ValidEntry>();
const validInflight = new Map<string, Promise<{ status: number; body: unknown }>>();

function takeValid(key: string): ValidEntry | undefined {
  const hit = validated.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at >= TICKER_TTL_MS) {
    validated.delete(key);
    return undefined;
  }
  validated.delete(key);
  validated.set(key, hit);
  return hit;
}

function storeValid(key: string, entry: ValidEntry) {
  validated.delete(key);
  validated.set(key, entry);
  while (validated.size > VALID_MAX_ENTRIES) {
    const oldest = validated.keys().next();
    if (oldest.done) break;
    validated.delete(oldest.value);
  }
}

// Fail-loud shape gate: runs BEFORE cache admission. A body that is not a
// populated instruments payload must 502 loud, never be stored, and never be
// served as an authoritative instrument list. Strengthened: requires at least
// one populated venue/type (non-empty priced data), not just the
// always-created types object, so an empty listing is never cached.
function isValidInstrumentsBody(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const b = data as Record<string, unknown>;
  if (typeof b.symbol !== 'string' || typeof b.types !== 'object' || b.types === null) return false;
  const types = b.types as Record<string, unknown>;
  return Object.values(types).some((t) => {
    if (typeof t !== 'object' || t === null) return false;
    const venues = (t as Record<string, unknown>).venues;
    const def = (t as Record<string, unknown>).default;
    const hasVenues = Array.isArray(venues) && venues.length > 0;
    const hasDefault = def !== null && def !== undefined;
    const expiries = (t as Record<string, unknown>).expiries;
    const hasExpiries = Array.isArray(expiries) && expiries.length > 0;
    return hasVenues || hasDefault || hasExpiries;
  });
}
/**
 * Which dated instruments exist for a coin, so the detail page can offer a real
 * choice of expiry and strike instead of a hardcoded one.
 *
 * The alternative — picking an instrument here and hiding the rest — would
 * leave the board unable to show anything but the front of the curve, and an
 * option at a 30% strike is a completely different instrument from the
 * at-the-money one. Everything offered here comes from the venues' own market
 * lists, so every selectable option is known to be listed rather than
 * constructed and hoped for.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();

  if (!symbol) {
    return NextResponse.json(
      { error: 'missing_symbol', detail: 'pass ?symbol=BTC/USDT' },
      { status: 400 }
    );
  }
  if (symbol.length > TICKER_SEARCH_MAX) {
    return NextResponse.json(
      { error: 'symbol_too_long', detail: `max ${TICKER_SEARCH_MAX} characters` },
      { status: 400 }
    );
  }
  if (!(TICKER_SYMBOLS as readonly string[]).includes(symbol)) {
    return NextResponse.json(
      { error: 'unknown_symbol', detail: `${symbol} is not on the ticker allowlist` },
      { status: 404 }
    );
  }

  const key = `symbol=${symbol}`;
  const cached = takeValid(key);
  if (cached) {
    return NextResponse.json(cached.body, {
      headers: { 'X-Cache': 'HIT', 'Cache-Control': CACHE_CONTROL },
    });
  }
  const pending = validInflight.get(key);
  if (pending) {
    const shared = await pending;
    return NextResponse.json(shared.body, {
      status: shared.status,
      headers: { 'X-Cache': 'COALESCED', 'Cache-Control': CACHE_CONTROL },
    });
  }

  const run = (async (): Promise<{ status: number; body: unknown }> => {
    const [base, quote] = symbol.split('/');
    const clients = tickerClients();

    // Loading markets pulls thousands of instruments per venue and takes
    // seconds, so ensureMarkets caches it for a day and de-duplicates concurrent
    // callers. This is the only expensive step in the route.
    await Promise.all(TICKER_EXCHANGES.map(v => ensureMarkets(v, c => c.loadMarkets())));

    // The reference price that makes "near the money" mean something here too.
    // The board sweeps spot first for the same reason; this route had no price
    // at all, so its preselected option was the median strike by construction
    // while the board's was near-the-money — the two selectors disagreed for a
    // reason that had nothing to do with what the reader picked. One ticker per
    // spot venue, issued in parallel, reusing the spot markets the market list
    // already identifies. A venue that fails or lists no spot market contributes
    // nothing rather than a guessed price; if none answers, spotPrice stays null
    // and defaultInstrument falls back to the median strike, as before.
    const spotPrices = await Promise.all(
      TICKER_EXCHANGES.filter(v => venueServes(v, 'spot')).map(async (venue) => {
        const client = clients.get(venue);
        const markets = client?.markets;
        if (!client || !markets) return null;
        const spots = instrumentsFor(markets, base, 'spot');
        const spot = spots.length ? defaultInstrument(spots, null) : null;
        if (!spot) return null;
        const last = await client
          .fetchTicker(spot.symbol)
          .then((t) => t?.last)
          .catch(() => null);
        return typeof last === 'number' && Number.isFinite(last) ? last : null;
      })
    );
    const spotPrice = medianPrice(spotPrices.filter((p): p is number => p !== null));
    const perVenue = new Map<TickerExchange, TickerInstrument[]>();
    const byType: Record<TickerType, TypeInstrumentSummary> = {
      spot: { venues: [], expiries: [], strikesByExpiry: {}, default: null },
      swap: { venues: [], expiries: [], strikesByExpiry: {}, default: null },
      future: { venues: [], expiries: [], strikesByExpiry: {}, default: null },
      option: { venues: [], expiries: [], strikesByExpiry: {}, default: null },
    };

    for (const venue of TICKER_EXCHANGES) {
      const markets = clients.get(venue)?.markets;
      if (!markets) continue;

      for (const type of TICKER_TYPES) {
        if (!venueServes(venue, type)) continue;
        // Settlement is not pinned to the row's quote currency: each venue's own
        // convention is the correct one for that venue, and instrumentsFor
        // already restricts the set to USD / USD-pegged, so neither a
        // coin-margined contract nor a fiat market can enter the offered list.
        const found = instrumentsFor(markets, base, type);
        if (found.length === 0) continue;

        perVenue.set(venue, [...(perVenue.get(venue) ?? []), ...found]);
        if (!byType[type].venues.includes(venue)) byType[type].venues.push(venue);

        const expiries = expiriesFor(found);
        byType[type].expiries = [...new Set([...byType[type].expiries, ...expiries])].sort();
        // Strikes are reported PER EXPIRY, because they genuinely differ by date:
        // the nearest option chain ladders strikes around spot, a later month
        // lists a different and wider ladder. One flat strike list would offer
        // the reader strikes their chosen expiry does not list, and the page
        // would then honestly but uselessly say no venue prices it.
        for (const e of expiries) {
          const forDate = strikesFor(found, e);
          const existing = byType[type].strikesByExpiry[e] ?? [];
          byType[type].strikesByExpiry[e] = [...new Set([...existing, ...forDate])].sort((a, b) => a - b);
        }

        // The default is computed with the same helper the board uses, and with
        // a real spot price, so the instrument preselected here and the one a
        // row lands on cannot disagree.
        if (!byType[type].default) {
          const pick = defaultInstrument(found, spotPrice);
          if (pick) {
            byType[type].default = {
              symbol: pick.symbol,
              expiry: pick.expiry === null ? null : new Date(pick.expiry).toISOString().slice(0, 10),
              strike: pick.strike,
              optionKind: pick.optionKind,
            };
          }
        }
      }
    }

    const body = {
      symbol,
      base,
      quote,
      types: byType,
      venues: Object.fromEntries(
        TICKER_EXCHANGES
          .filter(v => perVenue.has(v))
          .map(v => [v, { types: TICKER_VENUES[v], instruments: perVenue.get(v)?.length ?? 0 }])
      ),
      typeLabels: TICKER_TYPE_LABELS,
      // Which venues are read per type, so the UI can show a per-type venue list
      // without hardcoding the table a second time.
      venuesForType: Object.fromEntries(TICKER_TYPES.map(t => [t, venuesForType(t)])),
      timestamp: Date.now(),
    };

    // Discriminator BEFORE cache admission: an empty listing never enters the
    // cache and 502s loud instead.
    if (!isValidInstrumentsBody(body)) {
      return { status: 502, body: { error: 'instruments malformed: body failed shape check' } };
    }
    return { status: 200, body };
  })();

  validInflight.set(key, run);
  try {
    const winner = await run;
    // Only validated 200s are admitted. Non-200s are shared with coalesced
    // waiters but never stored, so the next request retries upstream instead
    // of replaying the failure.
    if (winner.status === 200) {
      storeValid(key, { at: Date.now(), body: winner.body });
    }
    return NextResponse.json(winner.body, {
      status: winner.status,
      headers: { 'X-Cache': 'MISS', 'Cache-Control': CACHE_CONTROL },
    });
  } finally {
    validInflight.delete(key);
  }
}
