import { NextResponse } from 'next/server';
import {
  TICKER_EXCHANGES,
  TICKER_SEARCH_MAX,
  TICKER_TYPE_LABELS,
  TICKER_TYPES,
  venuesForType,
  type TickerExchange,
  type TickerInstrument,
  type TickerType,
} from '@/features/ticker/client';
import {
  ensureMarkets,
  instrumentsFor,
  tickerClients,
} from '@/server/ticker';

import { num } from '../../_lib/num';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/** A venue's answer for one instrument. `last: null` with an `error` is a miss, never a price. */
type Quote = {
  exchange: TickerExchange;
  symbol: string;
  /** What this venue's number is denominated in, or null when it has no price. */
  settle: string | null;
  last: number | null;
  bid: number | null;
  ask: number | null;
  high24h: number | null;
  low24h: number | null;
  baseVolume: number | null;
  quoteVolume: number | null;
  change24h: number | null;
  openInterest: number | null;
  fundingRate: number | null;
  at: number | null;
  error: string | null;
};

/**
 * A venue that answered with no priceable instrument. `settle` is null because
 * there is no instrument to be settled in — the number is absent, not zero.
 */
function emptyQuote(venue: TickerExchange, symbol: string, error: string): Quote {
  return {
    exchange: venue, symbol, settle: null, last: null, bid: null, ask: null, high24h: null, low24h: null,
    baseVolume: null, quoteVolume: null, change24h: null, openInterest: null, fundingRate: null,
    at: null, error,
  };
}

/**
 * Prices for one *specific* instrument — the expiry, strike and call/put the
 * reader chose on the detail page — across every venue that lists it.
 *
 * The selection is resolved against each venue's own market list rather than
 * by string-building a ccxt symbol. The same option is spelled
 * `BTC/USD:BTC-260929-84250-C` on OKX and `BTC/USDT:USDT-260929-84250-C` on
 * Bybit, and a constructed symbol is rejected outright by the venue it was
 * wrong for. Matching on (expiry, strike, kind) finds each venue's own form.
 *
 * A venue that lists no such instrument is reported in `notListed` — a fact
 * about the market — while `failed` means the venue should have answered and
 * did not. The two are kept apart because they call for different reactions.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp = url.searchParams;

  const base = (sp.get('base') ?? '').trim().toUpperCase();
  const typeRaw = (sp.get('type') ?? 'spot').trim();

  if (!base) {
    return NextResponse.json({ error: 'missing_base', detail: 'pass ?base=BTC' }, { status: 400 });
  }
  if (base.length > TICKER_SEARCH_MAX) {
    return NextResponse.json(
      { error: 'base_too_long', detail: `max ${TICKER_SEARCH_MAX} characters` },
      { status: 400 }
    );
  }
  if (!(TICKER_TYPES as readonly string[]).includes(typeRaw)) {
    return NextResponse.json(
      { error: 'bad_type', detail: `type must be one of ${TICKER_TYPES.join(', ')}` },
      { status: 400 }
    );
  }
  const type = typeRaw as TickerType;

  // Expiry, strike and kind are optional: spot and perpetual have none, and
  // omitting them means "whatever that type defaults to".
  const expiryRaw = (sp.get('expiry') ?? '').trim();
  const strikeRaw = (sp.get('strike') ?? '').trim();
  const kindRaw = (sp.get('kind') ?? '').trim();

  if (strikeRaw && !Number.isFinite(Number(strikeRaw))) {
    return NextResponse.json({ error: 'bad_strike', detail: 'strike must be numeric' }, { status: 400 });
  }
  if (kindRaw && kindRaw !== 'call' && kindRaw !== 'put') {
    return NextResponse.json({ error: 'bad_kind', detail: "kind must be 'call' or 'put'" }, { status: 400 });
  }
  if (expiryRaw && Number.isNaN(Date.parse(expiryRaw))) {
    return NextResponse.json({ error: 'bad_expiry', detail: 'expiry must be an ISO date' }, { status: 400 });
  }

  const wantExpiry = expiryRaw ? new Date(expiryRaw).toISOString().slice(0, 10) : null;
  const wantStrike = strikeRaw ? Number(strikeRaw) : null;
  const wantKind = kindRaw === 'call' || kindRaw === 'put' ? kindRaw : null;
  const explicit = wantExpiry !== null || wantStrike !== null || wantKind !== null;

  const clients = tickerClients();
  const wanted = venuesForType(type);
  await Promise.all(
    TICKER_EXCHANGES.filter(v => wanted.includes(v)).map(v => ensureMarkets(v, c => c.loadMarkets()))
  );

  const quotes: Quote[] = [];
  const notListed: TickerExchange[] = [];
  const failed: TickerExchange[] = [];
  const resolved: TickerInstrument[] = [];

  for (const venue of wanted) {
    const client = clients.get(venue);
    const markets = client?.markets;
    if (!client || !markets) {
      notListed.push(venue);
      continue;
    }

    // Settlement is not pinned: each venue's own quote currency is the correct
    // one for it, and instrumentsFor already restricts the set to USD and
    // USD-pegged, so a coin-margined or fiat contract cannot be selected.
    const candidates = instrumentsFor(markets, base, type).filter((i) => {
      if (wantExpiry !== null) {
        if (i.expiry === null) return false;
        // Expiries are timestamps at market open, so compare calendar days.
        if (new Date(i.expiry).toISOString().slice(0, 10) !== wantExpiry) return false;
      }
      if (wantStrike !== null && i.strike !== wantStrike) return false;
      if (wantKind !== null && i.optionKind !== wantKind) return false;
      return true;
    });

    if (candidates.length === 0) {
      notListed.push(venue);
      continue;
    }

    /**
     * A venue can offer several contracts matching the same (expiry, strike,
     * kind) — OKX lists each option twice, once coin-margined and once
     * dollar-settled — and only one of the twins actually carries a price.
     * Committing to the first match would select a dead symbol and report "no
     * price", which is honest but useless. Candidates are tried in preference
     * order and the first that prices wins; a venue counts as failed only when
     * none of its candidates could be priced.
     */
    const ordered = explicit ? candidates : [...candidates].sort(byPreference);
    let picked: TickerInstrument | null = null;
    let quote: Quote | null = null;

    for (const candidate of ordered) {
      let fetched: Awaited<ReturnType<typeof client.fetchTicker>>;
      try {
        fetched = await client.fetchTicker(candidate.symbol);
      } catch {
        continue; // an unpriceable candidate is not yet a venue failure
      }
      // ccxt lists instruments it cannot price and returns last: undefined.
      // That is a silent miss and is never rendered as a price.
      const last = num(fetched?.last);
      if (last === null) continue;

      const raw = fetched as unknown as Record<string, unknown>;
      quote = {
        exchange: venue,
        symbol: candidate.symbol,
        // The unit this venue's number is in. Coin-margined and USD-settled
        // twins are different contracts, so each quote carries its own.
        settle: candidate.settle,
        last,
        bid: num(fetched.bid),
        ask: num(fetched.ask),
        high24h: num(fetched.high),
        low24h: num(fetched.low),
        baseVolume: num(fetched.baseVolume),
        quoteVolume: num(fetched.quoteVolume),
        change24h: num(fetched.percentage),
        openInterest: num(raw.openInterest),
        fundingRate: num(raw.fundingRate),
        at: num(fetched.timestamp),
        error: null,
      };
      picked = candidate;
      break;
    }

    if (!picked || !quote) {
      failed.push(venue);
      quotes.push(emptyQuote(venue, candidates[0].symbol, 'no price returned'));
      continue;
    }

    resolved.push(picked);

    // Funding is a perpetual concept; open interest exists on swaps, dated
    // futures and options. Both are best-effort: ccxt needs separate calls for
    // them, and an absent value stays null and is shown as "—".
    if (type === 'swap' && quote.fundingRate === null) {
      quote.fundingRate = await client.fetchFundingRate(picked.symbol).then(f => num(f?.fundingRate)).catch(() => null);
    }
    if (type !== 'spot' && quote.openInterest === null) {
      quote.openInterest = await client.fetchOpenInterest(picked.symbol)
        .then(oi => num(oi?.openInterestAmount ?? (oi as unknown as Record<string, unknown> | undefined)?.openInterest))
        .catch(() => null);
    }
    quotes.push(quote);
  }

  const priced = quotes.filter(q => q.last !== null);

  return NextResponse.json({
    base,
    type,
    typeLabel: TICKER_TYPE_LABELS[type],
    request: { expiry: wantExpiry, strike: wantStrike, kind: wantKind },
    instruments: resolved,
    // The settlements actually quoted. These are expected to differ between
    // venues, so their prices are comparable only up to the basis between them.
    settlements: [...new Set(resolved.map(i => i.settle).filter((s): s is string => typeof s === 'string'))],
    quotes,
    priced: priced.length,
    // Median of the venues that priced it; null when none did.
    price: priced.length ? median(priced.map(q => q.last as number)) : null,
    notListed,
    failed,
    timestamp: Date.now(),
  });
}

/**
 * Preference order when the reader has not pinned the instrument: nearest
 * expiry first, then calls before puts at the same strike, then a stable
 * settlement ordering so the same request always resolves the same contract.
 * The final tiebreak is the symbol itself rather than market-list order,
 * which ccxt does not guarantee and which would make the default drift.
 */
function byPreference(a: TickerInstrument, b: TickerInstrument): number {
  const ea = a.expiry ?? Number.MAX_SAFE_INTEGER;
  const eb = b.expiry ?? Number.MAX_SAFE_INTEGER;
  if (ea !== eb) return ea - eb;
  if ((a.strike ?? 0) !== (b.strike ?? 0)) return (a.strike ?? 0) - (b.strike ?? 0);
  const ka = a.optionKind === 'call' ? 0 : 1;
  const kb = b.optionKind === 'call' ? 0 : 1;
  if (ka !== kb) return ka - kb;
  return a.symbol.localeCompare(b.symbol);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
