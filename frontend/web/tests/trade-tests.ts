/**
 * Trade domain tests (plan Phase 1–2): run OFFLINE, no network, no clock.
 *
 * Contract under test (`features/trade/{taxonomy,model,client}.ts`): the four
 * honesty rules the domain's file headers declare, plus the taxonomy invariants
 * that keep the URL space a market-type space.
 *
 *  1. NULL vs 0. A measurement nobody published is `null`, never `0`. The types
 *     say `number | null`; this suite pins the two places the rule can actually
 *     be broken — the client's mapping (a `null` price must survive, not become
 *     0) and the formatters (a real `0` must render as a value, not as the
 *     "unknown" em dash, and `null` must render as the em dash, not as 0).
 *  2. CAPABILITIES STATE WHAT IS FALSE. `VenueCapability.orderTypes` is a total
 *     record — every `OrderType` key present as `true`/`false`. An absent key is
 *     a bug, not a missing feature, so a partial record must not compile.
 *  3. THE INSTRUMENT ID IS CANONICAL. `btc-usdt` (lowercased `<base>-<quote>`)
 *     is the identity; the venue's own `BTCUSDT` is a FIELD the adapter
 *     resolves, never the id, and never built by a view.
 *  4. NO FIELD FOR A SECRET. The account shape carries `apiKeyMasked` and has no
 *     `apiKey` field at all, so a full key has nowhere to live.
 *
 * Plus the taxonomy invariants: the counts, the id uniqueness, the exhaustive
 * `VENUE_MARKET_TYPES` capability matrix, and the rule that a ROUTE is a market
 * type — no venue id is a market type, so `/trade/<venue>` cannot be a route.
 *
 * Usage: cd frontend/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXECUTION_STRATEGIES,
  MARGIN_MODES,
  MARKET_TYPES,
  MARKET_TYPE_BY_ID,
  ORDER_TYPES,
  VENUES,
  VENUE_BY_ID,
  VENUE_MARKET_TYPES,
  isMarketType,
} from '@/features/trade/taxonomy';
import type { MarketType, OrderType, VenueId } from '@/features/trade/taxonomy';
import type { Instrument, MarketRow, TradingAccount, VenueCapability } from '@/features/trade/model';
import {
  NO_VALUE,
  fetchExecutions,
  fetchMarketRows,
  fetchPortfolioSummary,
  formatChange,
  formatPrice,
  formatUsd,
  marketTypeHref,
  tickerTypeFor,
} from '@/features/trade/client';

// ---------------------------------------------------------------------------
// A fetch stub: the client is the only thing that touches the network, and it
// must be exercised against a fixed envelope rather than a live upstream.
// ---------------------------------------------------------------------------

type Stub = { status?: number; body: unknown };
const calls: string[] = [];

function stubFetch(handler: (url: string) => Stub): () => void {
  const original = globalThis.fetch;
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const { status = 200, body } = handler(url);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// ---------------------------------------------------------------------------
// Taxonomy shape — the counts and the lookup tables
// ---------------------------------------------------------------------------

test('trade: the taxonomy carries the canonical counts', () => {
  assert.equal(MARKET_TYPES.length, 6, 'six market types');
  assert.equal(VENUES.length, 7, 'seven tradable venues');
  assert.equal(EXECUTION_STRATEGIES.length, 7, 'seven execution strategies');
  assert.equal(ORDER_TYPES.length, 7, 'seven order types');
  assert.equal(MARGIN_MODES.length, 2, 'two margin modes');
});

test('trade: every taxonomy id is unique within its family', () => {
  for (const [name, ids] of [
    ['market types', MARKET_TYPES.map((m) => m.id)],
    ['venues', VENUES.map((v) => v.id)],
    ['strategies', EXECUTION_STRATEGIES.map((s) => s.id)],
    ['order types', ORDER_TYPES.map((o) => o.id)],
    ['margin modes', MARGIN_MODES.map((m) => m.id)],
  ] as Array<[string, string[]]>) {
    assert.equal(new Set(ids).size, ids.length, `${name} carry a duplicate id`);
  }
});

test('trade: the by-id lookups are total over their family', () => {
  assert.deepEqual(Object.keys(MARKET_TYPE_BY_ID).sort(), MARKET_TYPES.map((m) => m.id).sort());
  assert.deepEqual(Object.keys(VENUE_BY_ID).sort(), VENUES.map((v) => v.id).sort());
  for (const m of MARKET_TYPES) assert.equal(MARKET_TYPE_BY_ID[m.id].id, m.id);
  for (const v of VENUES) assert.equal(VENUE_BY_ID[v.id].id, v.id);
});

test('trade: isMarketType accepts exactly the taxonomy, case-sensitively', () => {
  for (const m of MARKET_TYPES) assert.equal(isMarketType(m.id), true, `${m.id} is a market type`);
  for (const bad of ['', 'Perpetual', 'PERPETUAL', 'perpetual2', 'binance', 'spot ']) {
    assert.equal(isMarketType(bad), false, `${JSON.stringify(bad)} is not a market type`);
  }
});

test('trade: a market type the ticker cannot quote is an explicit null, never a silent fall-through', () => {
  // `margin` is an account setting, not a quotable instrument. The taxonomy
  // states that with `tickerType: null`; a fall-through to `spot` would answer a
  // different question and render spot rows under a Margin heading.
  assert.equal(tickerTypeFor('margin'), null);
  assert.equal(tickerTypeFor('perpetual'), 'swap', 'a perpetual IS a swap in the venue vocabulary');
  assert.equal(tickerTypeFor('futures'), 'future');
  assert.equal(tickerTypeFor('options'), 'option');
  assert.equal(tickerTypeFor('spot'), 'spot');
  assert.equal(tickerTypeFor('swap'), 'swap');
});

// ---------------------------------------------------------------------------
// The capability matrix
// ---------------------------------------------------------------------------

test('trade: VENUE_MARKET_TYPES is exhaustive over the venues', () => {
  const keys = Object.keys(VENUE_MARKET_TYPES).sort();
  assert.deepEqual(keys, VENUES.map((v) => v.id).sort(), 'every venue states the market types it serves');
});

test('trade: every stated venue × market-type pairing is a real market type, with no repeats', () => {
  const known = new Set<string>(MARKET_TYPES.map((m) => m.id));
  for (const [venue, types] of Object.entries(VENUE_MARKET_TYPES)) {
    assert.ok(types.length > 0, `${venue} serves at least one market type`);
    assert.equal(new Set(types).size, types.length, `${venue} lists a market type twice`);
    for (const t of types) {
      assert.ok(known.has(t), `${venue} lists ${t}, which is not a market type`);
    }
  }
});

test('trade: no venue id is a market type, so a route can never be a venue', () => {
  // The URL space is `/trade/<market-type>`. If a venue id were also a market
  // type, `/trade/<venue>` would be ambiguous — the blow-up taxonomy.ts exists
  // to prevent. The invariant is that the two id sets are disjoint.
  for (const v of VENUES) {
    assert.equal(isMarketType(v.id), false, `${v.id} is a venue, not a market type`);
  }
  for (const m of MARKET_TYPES) {
    assert.equal(marketTypeHref(m.id), `/trade/${m.id}`);
  }
});

// ---------------------------------------------------------------------------
// Type-level honesty rules (checked by tsc, asserted here for the runtime half)
// ---------------------------------------------------------------------------

const exhaustiveCapability: VenueCapability = {
  venue: 'binance',
  instrumentId: 'btc-usdt',
  marketType: 'spot',
  orderTypes: Object.fromEntries(ORDER_TYPES.map((o) => [o.id, true])) as Record<OrderType, boolean>,
  nativeTwap: true,
  nativeVwap: true,
  nativeIceberg: true,
  leverage: false,
  marginModes: null,
  reduceOnly: false,
  postOnly: true,
};

// A capability that omits order types must not compile: an absent key is a bug,
// not a missing feature (the `orderTypes` record is total).
const _partialCapability: VenueCapability = {
  venue: 'binance',
  instrumentId: 'btc-usdt',
  marketType: 'spot',
  // @ts-expect-error — every OrderType must be present; a partial record is a type error
  orderTypes: { market: true },
  nativeTwap: false,
  nativeVwap: false,
  nativeIceberg: false,
  leverage: false,
  marginModes: null,
  reduceOnly: false,
  postOnly: false,
};

test('trade: every OrderType is a stated boolean capability, never an absent key', () => {
  assert.equal(Object.keys(exhaustiveCapability.orderTypes).length, ORDER_TYPES.length);
  for (const o of ORDER_TYPES) {
    assert.equal(
      typeof exhaustiveCapability.orderTypes[o.id],
      'boolean',
      `${o.id} must be stated as true or false, not omitted`,
    );
  }
});

const instrument: Instrument = {
  id: 'btc-usdt',
  base: 'BTC',
  quote: 'USDT',
  marketType: 'spot',
  venue: 'binance',
  venueSymbol: 'BTCUSDT',
  contractType: null,
  tickSize: null,
  lotSize: null,
  minOrder: null,
  maxLeverage: null,
  expiry: null,
};

test('trade: the canonical instrument id is the lowercased base-quote, and the venue symbol is a separate field', () => {
  assert.equal(instrument.id, `${instrument.base}-${instrument.quote}`.toLowerCase());
  assert.equal(instrument.id, 'btc-usdt');
  assert.match(instrument.id, /^[a-z0-9]+-[a-z0-9]+$/, 'the id is URL-safe and lowercased');
  assert.equal(instrument.venueSymbol, 'BTCUSDT');
  assert.notEqual(instrument.id, instrument.venueSymbol.toLowerCase(), 'the venue symbol is not the identity');
});

test('trade: an unpublished measurement is null, never 0', () => {
  for (const field of ['tickSize', 'lotSize', 'minOrder', 'maxLeverage', 'expiry', 'contractType'] as const) {
    assert.equal(instrument[field], null, `${field} is unknown here and must be null, not 0 or ''`);
  }
});

const account: TradingAccount = {
  id: 'acct-1',
  venue: 'binance',
  venueType: 'cex',
  label: 'Main',
  apiKeyMasked: 'abc...xyz',
  kind: 'api-key',
  canTrade: true,
  hasWithdrawPermission: false,
};

// TradingAccount has no `apiKey` field: a full secret has nowhere to live in the
// domain shape, so it cannot leak into a view.
const _leakyAccount: TradingAccount = {
  id: 'acct-2',
  venue: 'binance',
  venueType: 'cex',
  label: 'Leaky',
  apiKeyMasked: null,
  kind: 'api-key',
  canTrade: null,
  hasWithdrawPermission: null,
  // @ts-expect-error — there is no `apiKey` field; a secret is not part of the shape
  apiKey: 'sk-live-secret',
};

test('trade: the account shape carries only a masked key, never the secret', () => {
  assert.ok('apiKeyMasked' in account);
  assert.equal(account.apiKeyMasked, 'abc...xyz');
  assert.ok(!('apiKey' in account), 'there must be no field named apiKey');
  assert.ok(!Object.keys(account).some((k) => /secret|private|passphrase/i.test(k)));
});

// The `venue` field on a price source is `string`, NOT `VenueId`: a literal
// naming a source we cannot route to (`kraken`) must compile, or the type would
// silently drop every price source outside `VENUES`.
const marketRow: MarketRow = {
  instrumentId: 'btc-usdt',
  base: 'BTC',
  quote: 'USDT',
  marketType: 'spot',
  price: null,
  change24h: null,
  quoteVolume: null,
  venues: [{ venue: 'kraken', price: null }],
  spreadPct: null,
};

test('trade: a price source is a string, not a VenueId', () => {
  assert.equal(typeof marketRow.venues[0].venue, 'string');
  assert.ok(
    !VENUES.some((v) => v.id === marketRow.venues[0].venue),
    'kraken quotes a price but is not a routable venue — the type must still accept it',
  );
  assert.ok(!(VENUES.map((v) => v.id) as string[]).includes(marketRow.venues[0].venue));
});

// ---------------------------------------------------------------------------
// The client — null survives the mapping, and the composition is to the real
// endpoints (no private aggregate invented)
// ---------------------------------------------------------------------------

test('trade: the market board composes /api/ticker and canonicalises the instrument id', async () => {
  const restore = stubFetch(() => ({
    body: {
      rows: [
        {
          symbol: 'BTC/USDT',
          base: 'BTC',
          quote: 'USDT',
          type: 'spot',
          price: 64000,
          change24h: 0.0123,
          quoteVolume: 1_000_000_000,
          venues: [
            { exchange: 'binance', last: 64000 },
            { exchange: 'kraken', last: 63990 },
          ],
          spread: 0.02,
        },
      ],
      count: 1,
      total: 1,
      typeCounts: { spot: 1 },
    },
  }));
  try {
    const rows = await fetchMarketRows('spot');
    assert.ok(calls[0].startsWith('/api/ticker?'), 'the board reads the existing ticker endpoint');
    assert.ok(calls[0].includes('type=spot'), 'a specific market type asks the ticker for that type');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].instrumentId, 'btc-usdt', 'the venue symbol is canonicalised to the lowercased id');
    assert.deepEqual(rows[0].venues.map((v) => v.venue), ['binance', 'kraken'], 'every price source is kept');
    assert.equal(rows[0].marketType, 'spot');
  } finally {
    restore();
  }
});

test('trade: a market type the ticker cannot quote is an empty board, with no request made', async () => {
  const restore = stubFetch(() => ({ body: { rows: [], count: 0, total: 0, typeCounts: {} } }));
  try {
    const rows = await fetchMarketRows('margin');
    assert.deepEqual(rows, [], 'margin is account-level, so the board is honestly empty');
    assert.equal(calls.length, 0, 'no request is made for a market type the ticker has no vocabulary for');
  } finally {
    restore();
  }
});

test('trade: a null price from the ticker survives as null, never coerced to 0', async () => {
  const restore = stubFetch(() => ({
    body: {
      rows: [
        {
          symbol: 'XYZ/USDT',
          base: 'XYZ',
          quote: 'USDT',
          type: 'spot',
          price: null,
          change24h: null,
          quoteVolume: null,
          venues: [{ exchange: 'binance', last: null }],
          spread: null,
        },
      ],
      count: 1,
      total: 1,
      typeCounts: { spot: 1 },
    },
  }));
  try {
    const [row] = await fetchMarketRows('spot');
    assert.equal(row.price, null);
    assert.equal(row.change24h, null);
    assert.equal(row.quoteVolume, null);
    assert.equal(row.venues[0].price, null);
  } finally {
    restore();
  }
});

test('trade: an unconnected account is null, not a zero balance', async () => {
  const restore = stubFetch(() => ({ status: 401, body: {} }));
  try {
    const summary = await fetchPortfolioSummary();
    assert.deepEqual(summary, {
      equity: null,
      available: null,
      exposure: null,
      pnlToday: null,
      connected: false,
    });
    assert.notEqual(summary.equity, 0, 'a disconnected account is unknown, not empty');
  } finally {
    restore();
  }
});

test('trade: a connected account reports connected, and the unqueried figures stay null', async () => {
  const restore = stubFetch(() => ({ body: { accounts: [{ id: 'acct-1' }] } }));
  try {
    const summary = await fetchPortfolioSummary();
    assert.equal(summary.connected, true);
    assert.equal(summary.equity, null, 'a figure no venue answered is unknown, not 0');
  } finally {
    restore();
  }
});

test('trade: executions compose /api/executor/executions, and a 401 is an empty list, not an error', async () => {
  const restore = stubFetch(() => ({ status: 403, body: {} }));
  try {
    assert.deepEqual(await fetchExecutions(), []);
    assert.ok(calls[0].startsWith('/api/executor/executions'), 'the panel reads the executor it already has');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Formatters — the single spelling of "unknown"
// ---------------------------------------------------------------------------

test('trade: the formatters render null as the em dash and a real 0 as a value', () => {
  for (const fmt of [formatPrice, formatUsd, formatChange]) {
    assert.equal(fmt(null), NO_VALUE);
    assert.equal(fmt(undefined), NO_VALUE);
    assert.notEqual(fmt(0), NO_VALUE, 'a real zero is a value, not "unknown"');
  }
  assert.equal(formatUsd(0), '$0.00');
  // The 24h change is ALREADY IN PERCENT (ccxt's `percentage`), so there is no
  // x100 in the formatter: 1.39 is +1.39%, not +139%.
  assert.equal(formatChange(0), '0.00%');
  assert.equal(formatChange(1.39), '+1.39%');
  assert.equal(formatChange(-0.5), '-0.50%');
});

test('trade: the em dash is the one spelling of "no value"', () => {
  assert.equal(NO_VALUE, '—');
});

// Type-only references so the unused-locals pass does not elide the compile-time
// proofs above (the `@ts-expect-error` directives are the assertions).
export type _TradeTypeProofs = [Instrument, MarketRow, TradingAccount, VenueCapability, MarketType, VenueId];
