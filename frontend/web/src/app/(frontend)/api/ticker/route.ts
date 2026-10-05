import { NextResponse } from 'next/server';
import {
  TICKER_EXCHANGES,
  TICKER_ORDERS,
  TICKER_PAGE_SIZE_MAX,
  TICKER_SEARCH_MAX,
  TICKER_SORTS,
  TICKER_SYMBOLS,
  TICKER_TTL_MS,
  TICKER_TYPES,
  TICKER_TYPE_LABELS,
  medianOf,
  medianPrice,
  spreadBetween,
  venueServes,
  venuesForType,
  type TickerExchange,
  type TickerOrder,
  type TickerRow,
  type TickerSort,
  type TickerType,
  type VenueQuote,
  type TickerInstrument,
} from '@/features/ticker/client';
import {
  SWEEP_FRESH_MS,
  SWEEP_STALE_MS,
  primeSweep,
  readSweepL2,
  runSweep,
  sweepSnapshot,
  ensureMarkets,
  defaultInstrument,
  instrumentsFor,
  tickerClients,
} from '@/server/ticker';
import type { Exchange as CcxtExchange } from 'ccxt';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

function fail(message: string, status: number, detail?: string) {
  return NextResponse.json(
    { error: message, ...(detail ? { detail } : {}) },
    { status }
  );
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read-only exchange ticker board (OKX + Bybit, keyless, via CCXT).
 *
 * Replaces the CoinGecko `/api/markets` family for the public board. The point
 * of this family is the cross-venue check: every row carries each venue's own
 * price plus their divergence, so one venue going wrong is visible instead of
 * silently becoming the number everyone reads.
 *
 * Honest-by-construction (same rules as every other family here):
 *  - search / sort / order / page / limit are OUR params -> strict 400s, never
 *    clamped and never silently ignored.
 *  - the sweep covers TICKER_SYMBOLS, an explicit list of pairs this host can
 *    actually quote. It is NOT a market-cap ranking, and `universe` says so.
 *  - a venue that fails for one symbol is recorded in that row's `failed`; the
 *    row still renders. Only an empty universe is a loud 502.
 *  - no market cap / supply / rank: no venue reports them keyless, so they are
 *    absent rather than invented.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp = url.searchParams;
  const sortRaw = sp.get('sort') ?? 'volume';
  if (!(TICKER_SORTS as readonly string[]).includes(sortRaw)) {
    return fail('bad_request', 400, `sort must be one of ${TICKER_SORTS.join(', ')}`);
  }
  const sort = sortRaw as TickerSort;
  const orderRaw = sp.get('order') ?? 'desc';
  if (!(TICKER_ORDERS as readonly string[]).includes(orderRaw)) {
    return fail('bad_request', 400, `order must be one of ${TICKER_ORDERS.join(', ')}`);
  }
  const order = orderRaw as TickerOrder;
  const search = sp.get('search') ?? '';
  if (search.length > TICKER_SEARCH_MAX) {
    return fail('bad_request', 400, `search must be at most ${TICKER_SEARCH_MAX} characters`);
  }
  const limitRaw = sp.get('limit') ?? String(TICKER_PAGE_SIZE_MAX);
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > TICKER_PAGE_SIZE_MAX) {
    return fail('bad_request', 400, `limit must be an integer 1..${TICKER_PAGE_SIZE_MAX}`);
  }
  const pageRaw = sp.get('page') ?? '1';
  const page = Number(pageRaw);
  if (!Number.isInteger(page) || page < 1) {
    return fail('bad_request', 400, 'page must be an integer >= 1');
  }
  // Market type is an OUR param: an unknown type is a 400, never a silent
  // fall-through to spot, which would quietly answer a different question
  // than the one asked.
  const typeRaw = sp.get('type') ?? 'all';
  if (typeRaw !== 'all' && !(TICKER_TYPES as readonly string[]).includes(typeRaw)) {
    return fail('bad_request', 400, `type must be 'all' or one of ${TICKER_TYPES.join(', ')}`);
  }
  const typeFilter = typeRaw as TickerType | 'all';
  // One sweep per venue serves every search/sort/page/type. The sweep costs
  // 71-80 s cold, so this is staged rather than simply cached:
  //
  //   1. a fresh in-memory copy (<= 60 s) is used as-is;
  //   2. otherwise the L2 is consulted — that is what makes the first call after
  //      a restart fast, since module state does not survive one;
  //   3. a copy inside the stale window (<= 1 h) is served IMMEDIATELY and a
  //      refresh is kicked off in the background, so no request ever blocks on
  //      the sweep at all;
  //   4. only when nothing usable exists does the caller wait for a real sweep,
  //      and a failure there is reported (502), never papered over with old
  //      numbers presented as live.
  const svc = { run: sweepVenues };
  let universe: TickerRow[];
  const mem = sweepSnapshot();
  if (mem && Date.now() - mem.at < SWEEP_FRESH_MS) {
    universe = mem.rows;
  } else {
    const l2 = await readSweepL2();
    if (l2) primeSweep(l2);
    const snapshot = sweepSnapshot();
    const age = snapshot ? Date.now() - snapshot.at : Number.POSITIVE_INFINITY;
    if (snapshot && age < SWEEP_STALE_MS) {
      universe = snapshot.rows;
      if (age >= SWEEP_FRESH_MS) {
        // Stale-but-usable: refresh without making the caller wait. A rejection
        // here is dropped on purpose — this request already has an answer, and
        // the next caller will retry.
        void runSweep(svc.run).catch(() => {});
      }
    } else {
      try {
        universe = await runSweep(svc.run);
      } catch (err) {
        return fail('upstream_unreachable', 502, err instanceof Error ? err.message : String(err));
      }
    }
  }
  if (!universe.length) {
    return fail('upstream_empty', 502, 'no venue returned a quote for any symbol');
  }
  let rows = universe;
  if (typeFilter !== 'all') rows = rows.filter(r => r.type === typeFilter);
  if (search) {
    const q = search.trim().toUpperCase();
    rows = rows.filter(r => r.symbol.includes(q) || r.base.includes(q));
  }
  const dir = order === 'asc' ? 1 : -1;
  // Nulls always sort last, whichever direction was asked for: a missing
  // metric is not "smallest", and burying it under real data hides it.
  rows = [...rows].sort((a, b) => {
    const av = sortValue(a, sort);
    const bv = sortValue(b, sort);
    if (av === null && bv === null) return a.symbol.localeCompare(b.symbol);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av === bv) return a.symbol.localeCompare(b.symbol);
    return (av - bv) * dir;
  });
  const total = rows.length;
  const start = (page - 1) * limit;
  const window = rows.slice(start, start + limit);
  return NextResponse.json(
    {
      rows: window,
      count: window.length,
      total,
      limit,
      offset: start,
      page,
      hasMore: start + window.length < total,
      exchanges: TICKER_EXCHANGES,
      types: TICKER_TYPES,
      typeLabels: TICKER_TYPE_LABELS,
      // Which venues are read per market type, so the UI can name the sources
      // for the type on screen without hardcoding the table a second time.
      venuesForType: Object.fromEntries(TICKER_TYPES.map(t => [t, venuesForType(t)])),
      // Row counts per market type across the *whole* filtered set, not the
      // current page, so the type tabs show real totals rather than the number
      // that happened to fit in this page.
      typeCounts: Object.fromEntries(
        TICKER_TYPES.map(t => [t, rows.filter(r => r.type === t).length])
      ),
      universe: TICKER_SYMBOLS,
      // The board is an allowlist of quotable pairs, NOT a market-cap ranking.
      universeNote: 'fixed symbol allowlist; exchanges expose no keyless market-cap ranking',
      scopeNote: 'centralized-exchange instruments only; DEX pools are a separate family',
      derived: { search, sort, order, type: typeFilter, filteredLocally: true },
      timestamp: Date.now(),
    },
    { headers: { 'Cache-Control': `public, max-age=${Math.floor(TICKER_TTL_MS / 1000)}` } }
  );
}

function sortValue(row: TickerRow, sort: TickerSort): number | null {
  switch (sort) {
    case 'symbol': return null; // handled by the locale tiebreak below
    case 'price': return row.price;
    case 'change': return row.change24h;
    case 'volume': return row.quoteVolume;
    case 'spread': return row.spread;
  }
}

/**
 * Query every venue for every symbol and every market type, then fold the
 * answers into rows.
 *
 * Three things make this more than the obvious nested loop:
 *
 *  - It runs in two passes per symbol, and the order between them is the point.
 *    A symbol's spot legs are issued and awaited first; the median of the
 *    prices that answered is then a real spot price for that symbol before any
 *    of its swap / future / option instruments are chosen, which is what makes
 *    the near-the-money branch of `defaultInstrument` reachable. A price that
 *    only arrives after the derivatives were built cannot inform how they were
 *    built. The barrier costs one extra round trip per symbol — the spot ticks
 *    are the same ones the spot rows need, so nothing is fetched twice — and
 *    it does not serialise the derivative legs of different symbols, which
 *    still overlap.
 *  - Each (venue, type) pair quotes a *different* instrument. A venue's
 *    perpetual and its dated future are separate contracts with separate
 *    expiries, so a sweep cannot ask one symbol of all of them. The instrument
 *    per venue is resolved from that venue's own market list, and the row keeps
 *    the instrument it actually quoted so the UI can label it.
 *  - Open interest and funding rate are not on the ticker payload; ccxt needs
 *    separate calls. They are fetched only for the type that defines them, and
 *    a failure there degrades one field rather than failing the sweep.
 *
 * Failures are per-(venue, symbol, type) throughout: a timeout on one contract
 * must not discard the other several hundred, and must not be reported as if
 * the instrument does not exist.
 */
async function sweepVenues(): Promise<TickerRow[]> {
  const clients = tickerClients();
  // Market lists are needed to resolve instruments. Cached for a day, so this
  // is a no-op after the first sweep of the process lifetime.
  await Promise.all([...clients.keys()].map(v => ensureMarkets(v, c => c.loadMarkets())));

  interface Job {
    symbol: string;
    type: TickerType;
    venue: TickerExchange;
    quote: VenueQuote | null;
    failed: TickerExchange | null;
    instrument: TickerRow['instrument'];
  }

  /**
   * One (venue, symbol, type) quote job.
   *
   * Resolving the instrument happens before the job exists, so a venue that
   * does not list the contract simply contributes nothing — which is a
   * different thing from a venue that failed, and only the latter lands in
   * `failed`.
   */
  const quoteInstrument = (
    symbol: string,
    type: TickerType,
    venue: TickerExchange,
    client: CcxtExchange,
    instrument: TickerInstrument,
  ): Promise<Job> =>
    client
      .fetchTicker(instrument.symbol)
      .then(async (t): Promise<Job> => {
        // ccxt reports `last: undefined` for instruments it lists but
        // cannot price — Bybit's options do exactly this. Treating that
        // as a price would print a fabricated row, so it counts as a
        // venue failure and the row reports it in `failed`.
        const last = num(t?.last);
        if (last === null) {
          return { symbol, type, venue, quote: null, failed: venue, instrument };
        }
        const quote: VenueQuote = {
          exchange: venue,
          last,
          bid: num(t.bid),
          ask: num(t.ask),
          high24h: num(t.high),
          low24h: num(t.low),
          baseVolume: num(t.baseVolume),
          quoteVolume: num(t.quoteVolume),
          // ccxt's `percentage` is already in percent units — verified
          // against OKX, where a -1.36% move arrives as -1.36. Dividing
          // it again here is what made every 24h change read 100x too
          // small. The UI appends the "%" sign.
          change24h: num(t.percentage),
          at: num(t.timestamp) ?? Date.now(),
          // ccxt's Ticker interface does not declare these, but exchange
          // implementations do populate them on derivative symbols —
          // verified on OKX for both. They are read off an index
          // signature rather than cast, so an exchange that does not
          // send the field yields undefined and num() turns that into
          // null, which is the honest "not reported".
          openInterest: num((t as unknown as Record<string, unknown>).openInterest),
          fundingRate: num((t as unknown as Record<string, unknown>).fundingRate),
        };
        // Funding is a perpetual concept; open interest exists on swaps
        // and dated contracts but OKX only exposes it inline for some.
        // Each is best-effort: an absent value stays null and is shown
        // as "—", which is the honest answer.
        if (type === 'swap' && quote.fundingRate === null) {
          quote.fundingRate = await client
            .fetchFundingRate(instrument.symbol)
            .then((f) => num(f?.fundingRate))
            .catch(() => null);
        }
        if (type === 'swap' && quote.openInterest === null) {
          quote.openInterest = await client
            .fetchOpenInterest(instrument.symbol)
            .then((oi) => num(oi?.openInterestAmount ?? (oi as unknown as Record<string, unknown> | undefined)?.openInterest))
            .catch(() => null);
        }
        return { symbol, type, venue, quote, failed: null, instrument };
      })
      .catch((): Job => ({ symbol, type, venue, quote: null, failed: venue, instrument }));

  const jobs: Promise<Job>[] = [];
  for (const symbol of TICKER_SYMBOLS) {
    const [base] = symbol.split('/');
    // Pass one: this symbol's spot legs, and only those. One per venue that
    // serves spot, resolved exactly as the type loop resolved it — the same
    // instrument, so no extra upstream work. They are awaited before any of
    // the symbol's derivative instruments are chosen, so the median below is a
    // real spot price for THIS symbol at the moment that choice is made, which
    // is what makes the near-the-money branch of defaultInstrument reachable.
    // The legs reject into `failed` jobs rather than propagating, so this
    // barrier cannot throw.
    const spotLegs: Promise<Job>[] = [];
    for (const [venue, client] of clients) {
      if (!venueServes(venue, 'spot')) continue;
      const markets = client.markets;
      if (!markets) continue;
      const instrument = defaultInstrument(instrumentsFor(markets, base, 'spot'), null);
      if (!instrument) continue; // this venue does not list spot
      spotLegs.push(quoteInstrument(symbol, 'spot', venue, client, instrument));
    }
    jobs.push(...spotLegs);
    const answered = await Promise.all(spotLegs);
    const spotPrices = answered.flatMap(r => (r.quote ? [r.quote.last] : []));
    // No spot venue answered for this symbol -> there is no reference price,
    // and none is invented. spotPrice stays null and defaultInstrument falls
    // back to the median strike at the nearest expiry, which is the honest
    // answer when nothing is known to be at the money.
    const spotPrice = medianPrice(spotPrices);
    // Pass two: the derivatives of the same symbol, now that spotPrice means
    // something.
    for (const type of TICKER_TYPES) {
      if (type === 'spot') continue; // already swept, and awaited, above
      for (const [venue, client] of clients) {
        if (!venueServes(venue, type)) continue;
        const markets = client.markets;
        if (!markets) continue;
        // Settlement is NOT pinned. A venue's USD-settled and USDT-settled
        // contracts for the same coin are different instruments with a real
        // basis between them, so each settlement is swept as its own row
        // below. Pinning to the row's quote currency here would silently drop
        // venues that settle in the other currency, and cross-checking across
        // them would report the basis as venue disagreement.
        const list = instrumentsFor(markets, base, type);
        const instrument = defaultInstrument(list, spotPrice);
        if (!instrument) continue; // this venue does not list the instrument
        jobs.push(quoteInstrument(symbol, type, venue, client, instrument));
      }
    }
  }
  const results = await Promise.all(jobs);
  const grouped = new Map<string, {
    quotes: VenueQuote[];
    failed: TickerExchange[];
    instrument: TickerRow['instrument'];
  }>();
  for (const r of results) {
    // Rows are keyed by (symbol, type, settlement): the same coin in two
    // market types is two rows, and so is the same coin settled in two
    // currencies. Neither is ever folded into one row, because their prices
    // are not comparable.
    const key = `${r.symbol}|${r.type}|${r.instrument.settle ?? ''}`;
    const entry = grouped.get(key) ?? { quotes: [], failed: [], instrument: r.instrument };
    if (r.quote) entry.quotes.push(r.quote);
    if (r.failed) entry.failed.push(r.failed);
    grouped.set(key, entry);
  }
  const rows: TickerRow[] = [];
  for (const [key, entry] of grouped) {
    if (entry.quotes.length === 0) continue;
    const [symbol, type] = key.split('|') as [string, TickerType];
    const prices = entry.quotes.map(q => q.last);
    // Dispersion is the honest cross-venue signal; the median is the displayed
    // figure. Venues that agree to 4 decimals produce a tight spread.
    const spread = prices.length < 2
      ? null
      : Math.max(...prices.map(p => spreadBetween(p, medianPrice(prices) as number) ?? 0));
    const highs = entry.quotes.map(q => q.high24h).filter((v): v is number => v !== null);
    const lows = entry.quotes.map(q => q.low24h).filter((v): v is number => v !== null);
    rows.push({
      symbol: symbol as TickerRow['symbol'],
      base: symbol.split('/')[0],
      quote: symbol.split('/')[1],
      type,
      instrument: entry.instrument,
      price: medianPrice(prices),
      // A 24h change is signed: a losing pair keeps its negative value.
      // medianPrice would discard every negative change and report "—".
      change24h: medianOf(
        entry.quotes.map(q => q.change24h).filter((v): v is number => v !== null),
        false,
      ),
      // max() over an empty set is -Infinity and min() is Infinity, either of
      // which the UI would print as a real number, so an absent high stays null.
      high24h: highs.length ? Math.max(...highs) : null,
      low24h: lows.length ? Math.min(...lows) : null,
      quoteVolume: medianPrice(entry.quotes.map(q => q.quoteVolume ?? 0).filter(v => v > 0)),
      venues: entry.quotes,
      spread,
      failed: entry.failed,
    });
  }
  // Stable order, so pagination cannot reshuffle rows between requests.
  return rows.sort((a, b) => a.type.localeCompare(b.type) || a.symbol.localeCompare(b.symbol));
}
