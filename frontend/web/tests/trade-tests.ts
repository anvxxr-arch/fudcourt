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
} from '@/features/trade/model';
import type { MarketType, OrderType, VenueId } from '@/features/trade/model';
import type { Instrument, MarketRow, TradingAccount, VenueCapability } from '@/features/trade/model';
import {
  NO_VALUE,
  createTradeExecution,
  executorMarketTypeFor,
  fetchExecutions,
  fetchMarketRows,
  fetchPortfolioSummary,
  fetchTradeAccounts,
  formatChange,
  formatPrice,
  formatUsd,
  marketTypeHref,
  previewTradeIntent,
  tickerTypeFor,
  venueOfExchange,
} from '@/features/trade/client';
import {
  CAPABILITY_COLUMNS,
  CAPABILITY_MATRIX,
  capabilityBoard,
  capabilityFor,
  capabilityOrderTypeSplit,
  capabilitiesForVenue,
} from '@/features/trade/model';
import { VENUE_BINDINGS, VENUE_BINDING_LIST, bindingFor } from '@/features/trade/adapters';
import { buildTradeRequest, missingRequired, type ComposerState } from '@/features/trade/model';
import { num } from '@/lib/num';
import {
  INSTRUMENTS,
  canonicalInstrumentId,
  instrumentById,
  instrumentHref,
  instrumentLabel,
  isInstrumentId,
} from '@/features/trade/model';

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

// ---------------------------------------------------------------------------
// Phase 3 — the capability matrix (the board offers only what the taxonomy serves)
// ---------------------------------------------------------------------------

test('trade: the capability matrix carries exactly one row per venue × market type', () => {
  const expected: string[] = [];
  for (const v of VENUES) for (const m of VENUE_MARKET_TYPES[v.id]) expected.push(`${v.id}:${m}`);
  const actual = CAPABILITY_MATRIX.map((c) => `${c.venue}:${c.marketType}`);
  assert.deepEqual(actual.slice().sort(), expected.slice().sort(), 'the board offers no pairing the taxonomy does not serve');
  assert.equal(new Set(actual).size, actual.length, 'a pairing is listed twice');
});

test('trade: every capability row states all seven order types as booleans', () => {
  for (const cap of CAPABILITY_MATRIX) {
    assert.deepEqual(
      Object.keys(cap.orderTypes).sort(),
      ORDER_TYPES.map((o) => o.id).sort(),
      `${cap.venue}:${cap.marketType} omits an order type`,
    );
    for (const o of ORDER_TYPES) {
      assert.equal(typeof cap.orderTypes[o.id], 'boolean', `${cap.venue}:${cap.marketType} ${o.id} must be a stated boolean`);
    }
  }
});

test('trade: the board columns are every order type, in taxonomy order, and rows are the matrix', () => {
  const { columns, rows } = capabilityBoard();
  assert.deepEqual(columns.map((c) => c.id), ORDER_TYPES.map((o) => o.id), 'a column per order type, none dropped');
  assert.equal(rows.length, CAPABILITY_MATRIX.length);
  assert.deepEqual(CAPABILITY_COLUMNS.map((c) => c.id), ORDER_TYPES.map((o) => o.id));
});

test('trade: a venue lookup returns only that venue, and the split is exhaustive', () => {
  for (const v of VENUES) {
    const rows = capabilitiesForVenue(v.id);
    assert.ok(rows.length > 0, `${v.id} has at least one capability row`);
    for (const row of rows) assert.equal(row.venue, v.id);
    const { supports, missing } = capabilityOrderTypeSplit(rows[0]);
    assert.equal(supports.length + missing.length, ORDER_TYPES.length, 'every order type is either supported or missing');
  }
  const binanceSpot = capabilityFor('binance', 'spot');
  assert.ok(binanceSpot !== undefined, 'binance serves spot');
  assert.equal(binanceSpot.venue, 'binance');
  assert.equal(binanceSpot.marketType, 'spot');
});

test('trade: a spot row has no margin mode, and a leverage row states its margin modes', () => {
  // The two invariants that make the matrix more than a grid of booleans: spot
  // has no margin setting, and leverage without a margin mode is meaningless.
  for (const cap of CAPABILITY_MATRIX) {
    if (cap.marketType === 'spot') assert.equal(cap.marginModes, null, `${cap.venue} spot has no margin mode`);
    if (cap.leverage) assert.notEqual(cap.marginModes, null, `${cap.venue}:${cap.marketType} has leverage but no margin mode`);
    if (cap.marketType === 'swap') {
      assert.equal(cap.orderTypes.limit, false, `${cap.venue} swap is an AMM route — market only`);
      assert.equal(cap.leverage, false, `${cap.venue} swap has no venue leverage`);
    }
  }
});

// ---------------------------------------------------------------------------
// Phase 5 — the per-venue adapter bindings
// ---------------------------------------------------------------------------

test('trade: every venue has a binding, and its market types mirror the taxonomy', () => {
  assert.deepEqual(Object.keys(VENUE_BINDINGS).sort(), VENUES.map((v) => v.id).sort(), 'the registry is total over the venues');
  assert.equal(VENUE_BINDING_LIST.length, VENUES.length);
  for (const v of VENUES) {
    const binding = bindingFor(v.id);
    assert.equal(binding.venue, v.id);
    assert.deepEqual([...binding.marketTypes], [...VENUE_MARKET_TYPES[v.id]], `${v.id} binding disagrees with the taxonomy`);
    assert.equal(binding.venueType, v.type);
  }
});

test('trade: the binding resolves the venue symbol, and a DEX that cannot derive it says so', () => {
  assert.equal(bindingFor('binance').venueSymbol('btc', 'usdt', 'spot'), 'BTCUSDT');
  assert.equal(bindingFor('bybit').venueSymbol('eth', 'usdt', 'perpetual'), 'ETHUSDT');
  assert.equal(bindingFor('mexc').venueSymbol('sol', 'usdt', 'spot'), 'SOLUSDT');
  assert.equal(bindingFor('okx').venueSymbol('btc', 'usdt', 'spot'), 'BTC-USDT', 'OKX separates base and quote');
  assert.equal(bindingFor('hyperliquid').venueSymbol('btc', 'usdc', 'perpetual'), 'BTC', 'a perp is addressed by the coin name');
  assert.equal(bindingFor('uniswap').venueSymbol('eth', 'usdc', 'swap'), null, 'an AMM pool needs contract addresses, not a ticker');
  assert.equal(bindingFor('jupiter').venueSymbol('sol', 'usdc', 'swap'), null);
  for (const v of VENUES) {
    assert.equal(bindingFor(v.id).kind, v.type === 'cex' ? 'api-key' : 'wallet', `${v.id} binds the wrong credential kind`);
  }
});

test('trade: the read channels name the executor account route and declare the unserved reads', () => {
  const binding = bindingFor('binance');
  assert.equal(binding.reads.account.path, '/api/executor/accounts');
  assert.equal(binding.reads.account.live, true, 'the account read is the executor route that exists');
  assert.equal(binding.reads.positions.live, false, 'a read with no route is declared, not faked');
  assert.equal(binding.reads.balances.live, false);
});

// ---------------------------------------------------------------------------
// Phase 4 — the composer's request builder (pure, no router, no DOM)
// ---------------------------------------------------------------------------

const baseIntent: ComposerState = {
  accountId: 'acct-1',
  venue: 'binance',
  base: 'btc',
  quote: 'usdt',
  side: 'buy',
  intent: 'open',
  entryType: 'market',
  entryPrice: '',
  postOnly: false,
  stopLoss: '98000',
  takeProfit: '',
  sizingMode: 'risk_percent',
  sizingValue: '1',
  basis: 'spot_equity',
  leverageMode: 'auto_safe',
  manualLeverage: '5',
  marginMode: '',
  mode: 'paper',
};

test('trade: a market type the executor cannot work yields no request, not a rejected one', () => {
  assert.equal(buildTradeRequest(baseIntent, 'options'), null);
  assert.equal(buildTradeRequest(baseIntent, 'swap'), null);
  assert.equal(missingRequired(baseIntent, 'options').length, 0, 'an unworkable type is not a "missing field"');
});

test('trade: the composer maps the trade market type to the executor vocabulary', () => {
  assert.equal(executorMarketTypeFor('spot'), 'spot');
  assert.equal(executorMarketTypeFor('margin'), 'spot');
  assert.equal(executorMarketTypeFor('perpetual'), 'linear_perp');
  assert.equal(executorMarketTypeFor('futures'), 'linear_perp');
  assert.equal(executorMarketTypeFor('options'), null);
  assert.equal(executorMarketTypeFor('swap'), null);
});

test('trade: the request carries the canonical symbol, the side and the intent', () => {
  const request = buildTradeRequest(baseIntent, 'spot');
  assert.ok(request !== null);
  assert.equal(request.symbol, 'BTC/USDT', 'the executor speaks a slash symbol, uppercased');
  assert.equal(request.marketType, 'spot');
  assert.equal(request.side, 'buy');
  assert.equal(request.intent, 'open');
  assert.equal(request.entry.type, 'market');
  assert.equal(request.mode, 'paper');
  assert.deepEqual(request.stopLoss, { price: 98000 });
  assert.equal(request.takeProfits, undefined, 'an empty TP is absent, never a fabricated price');
});

test('trade: a limit entry carries its price, and a market entry carries none', () => {
  const limit = buildTradeRequest({ ...baseIntent, entryType: 'limit', entryPrice: '100000' }, 'spot');
  assert.ok(limit !== null);
  assert.equal(limit.entry.type, 'limit');
  assert.equal(limit.entry.type === 'limit' ? limit.entry.price : null, 100000);
  assert.equal(limit.execution.type, 'limit', 'the execution method follows the entry for a direct order');
});

test('trade: leverage and margin mode are sent only for a linear perpetual', () => {
  const spot = buildTradeRequest({ ...baseIntent, leverageMode: 'manual', manualLeverage: '10', marginMode: 'isolated' }, 'spot');
  assert.ok(spot !== null);
  assert.equal(spot.leverage, undefined, 'a spot order carries no leverage');
  assert.equal(spot.marginMode, undefined);

  const perp = buildTradeRequest(
    { ...baseIntent, leverageMode: 'manual', manualLeverage: '10', marginMode: 'isolated', basis: 'futures_equity' },
    'perpetual',
  );
  assert.ok(perp !== null);
  assert.equal(perp.marketType, 'linear_perp');
  assert.deepEqual(perp.leverage, { mode: 'manual', leverage: 10 });
  assert.equal(perp.marginMode, 'isolated');
});

test('trade: an empty numeric field stays absent, never a silent zero', () => {
  assert.equal(num(''), undefined);
  assert.equal(num('   '), undefined);
  assert.equal(num('abc'), undefined);
  assert.equal(num('0'), 0, 'a real zero is a value');
  const request = buildTradeRequest({ ...baseIntent, stopLoss: '', takeProfit: '' }, 'spot');
  assert.ok(request !== null);
  assert.equal(request.stopLoss, undefined, 'no stop entered means no stop sent');
});

test('trade: the gate names what is missing before anything reaches the wire', () => {
  assert.ok(missingRequired({ ...baseIntent, accountId: '' }, 'spot').some((m) => m.startsWith('accountId')));
  assert.ok(missingRequired({ ...baseIntent, base: '  ' }, 'spot').some((m) => m.startsWith('symbol')));
  assert.ok(missingRequired({ ...baseIntent, sizingValue: '0' }, 'spot').some((m) => m.startsWith('sizing.value')));
  assert.ok(
    missingRequired({ ...baseIntent, sizingMode: 'risk_percent', stopLoss: '' }, 'spot').some((m) => m.startsWith('stopLoss')),
    'risk sizing without a stop is unbounded — the gate refuses it',
  );
  assert.ok(
    missingRequired({ ...baseIntent, entryType: 'limit', entryPrice: '' }, 'spot').some((m) => m.startsWith('entry.price')),
  );
  assert.equal(missingRequired({ ...baseIntent, entryType: 'limit', entryPrice: '100000' }, 'spot').length, 0, 'a complete intent passes');
});

// ---------------------------------------------------------------------------
// Phase 4/17 — the client composes the executor's real routes
// ---------------------------------------------------------------------------

type Captured = { url: string; method: string; body: unknown };
let captured: Captured[] = [];

function stubCapture(handler: (url: string, init?: RequestInit) => Stub): () => void {
  const original = globalThis.fetch;
  captured = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    captured.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const { status = 200, body } = handler(url, init);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('trade: the composer previews through /api/executor/preview, posting the request verbatim', async () => {
  const restore = stubCapture(() => ({ body: { preview: { plan: {}, conflicts: [], warnings: [] }, liveEnabled: false } }));
  try {
    const request = buildTradeRequest(baseIntent, 'spot');
    assert.ok(request !== null);
    await previewTradeIntent(request);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, '/api/executor/preview', 'the preview composes the executor route, not a private one');
    assert.equal(captured[0].method, 'POST');
    assert.deepEqual(captured[0].body, request, 'the body is the request, unchanged');
  } finally {
    restore();
  }
});

test('trade: placing composes /api/executor/executions', async () => {
  const restore = stubCapture(() => ({ body: { execution: { id: 'exec-1' }, plan: {} } }));
  try {
    const request = buildTradeRequest(baseIntent, 'spot');
    assert.ok(request !== null);
    const created = await createTradeExecution(request);
    assert.equal(captured[0].url, '/api/executor/executions');
    assert.equal(captured[0].method, 'POST');
    assert.equal(created.execution.id, 'exec-1');
  } finally {
    restore();
  }
});

test('trade: a failed preview surfaces the server error text, never a substituted one', async () => {
  const restore = stubCapture(() => ({ status: 422, body: { error: 'sizing rejected', errors: ['risk above policy'] } }));
  try {
    const request = buildTradeRequest(baseIntent, 'spot');
    assert.ok(request !== null);
    await assert.rejects(() => previewTradeIntent(request), /HTTP 422/);
  } finally {
    restore();
  }
});

test('trade: the accounts strip reads /api/executor/accounts, and 401 is empty, not an error', async () => {
  const restore = stubCapture(() => ({ status: 401, body: {} }));
  try {
    assert.deepEqual(await fetchTradeAccounts(), []);
    assert.equal(captured[0].url, '/api/executor/accounts');
  } finally {
    restore();
  }
});

test('trade: a connected account is returned with its masked key and permission flags', async () => {
  const account = {
    id: 'acct-1',
    exchange: 'binance',
    label: 'Main',
    apiKeyMasked: 'abc...xyz',
    health: 'healthy',
    revokedAt: null,
    permissions: { read: true, spotTrade: true, futuresTrade: false, withdraw: true },
  };
  const restore = stubCapture(() => ({ body: { accounts: [account] } }));
  try {
    const rows = await fetchTradeAccounts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].apiKeyMasked, 'abc...xyz', 'only the masked key is read');
    assert.equal(rows[0].permissions.withdraw, true, 'a withdrawal-capable key is reported, so the view can warn');
  } finally {
    restore();
  }
});

test('trade: a 500 on the accounts route is an error, not an empty list', async () => {
  const restore = stubCapture(() => ({ status: 500, body: { error: 'boom' } }));
  try {
    await assert.rejects(() => fetchTradeAccounts(), /HTTP 500/, 'a failed account read must never look like "no accounts"');
  } finally {
    restore();
  }
});

test('trade: an executor exchange maps to a venue only when it is one we route to', () => {
  assert.equal(venueOfExchange('binance'), 'binance');
  assert.equal(venueOfExchange('hyperliquid'), 'hyperliquid');
  assert.equal(venueOfExchange('kraken'), null, 'a venue we do not route to has no trade venue');
});

// ---------------------------------------------------------------------------
// The instrument registry (plan Phase 3) — the canonical id space a route
// resolves. The invariants here are what let `/trade/<marketType>/<instrument>`
// 404 an id it cannot address rather than serving an indexable empty page.
// ---------------------------------------------------------------------------

test('instrument: every registry id is canonical `<base>-<quote>`, lowercased', () => {
  assert.ok(INSTRUMENTS.length > 0, 'the registry is not empty');
  for (const i of INSTRUMENTS) {
    assert.equal(i.id, `${i.base.toLowerCase()}-${i.quote.toLowerCase()}`, `${i.id} is the canonical spelling`);
    assert.match(i.id, /^[a-z0-9]+-[a-z0-9]+$/, `${i.id} is well-formed`);
    assert.equal(i.base, i.base.toUpperCase(), `${i.id}: base is upper-cased`);
    assert.equal(i.quote, i.quote.toUpperCase(), `${i.id}: quote is upper-cased`);
  }
});

test('instrument: the id is DERIVED from base/quote, so the two cannot disagree', () => {
  for (const i of INSTRUMENTS) {
    assert.equal(i.id, canonicalInstrumentId(i.base, i.quote), `${i.base}/${i.quote} derives its own id`);
  }
});

test('instrument: ids are unique', () => {
  const ids = INSTRUMENTS.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate instrument id');
});

test('instrument: isInstrumentId accepts a registry id and rejects everything else', () => {
  const first = INSTRUMENTS[0].id;
  assert.equal(isInstrumentId(first), true, 'a registry id is addressable');
  assert.equal(isInstrumentId(first.toUpperCase()), false, 'the URL space is lowercase — BTC-USDT is not btc-usdt');
  assert.equal(isInstrumentId('foo-bar'), false, 'an id we do not quote is not addressable');
  assert.equal(isInstrumentId('btcusdt'), false, 'the venue spelling is not the canonical id');
  assert.equal(isInstrumentId('btc_usdt'), false, 'underscores are not the canonical separator');
  assert.equal(isInstrumentId(''), false, 'empty is not an instrument');
});

test('instrument: instrumentById resolves a registry id and yields undefined otherwise', () => {
  const entry = instrumentById('btc-usdt');
  assert.ok(entry, 'btc-usdt is in the registry');
  assert.equal(entry.base, 'BTC');
  assert.equal(entry.quote, 'USDT');
  assert.equal(instrumentById('foo-bar'), undefined, 'an unknown id resolves to nothing');
});

test('instrument: instrumentLabel renders the pair from the registry, not from the raw string', () => {
  assert.equal(instrumentLabel('btc-usdt'), 'BTC / USDT');
  assert.equal(instrumentLabel('eth-usdt'), 'ETH / USDT');
  assert.equal(instrumentLabel('zzz-usdt'), 'ZZZ-USDT', 'an unknown id falls back to its own upper-cased form');
});

test('instrument: instrumentHref is the plan route `/trade/<marketType>/<instrument>`', () => {
  assert.equal(instrumentHref('spot', 'btc-usdt'), '/trade/spot/btc-usdt');
  assert.equal(instrumentHref('perpetual', 'eth-usdt'), '/trade/perpetual/eth-usdt');
});

test('instrument: canonicalInstrumentId normalises case and surrounding space', () => {
  assert.equal(canonicalInstrumentId(' BTC ', 'usdt'), 'btc-usdt');
  assert.equal(canonicalInstrumentId('eth', 'USDT'), 'eth-usdt');
});

test('instrument: a market type with no tickerType (margin) has no instrument page', () => {
  // The route checks the market type too; a type the ticker cannot quote must not
  // grow a per-instrument page, and the sitemap must not enumerate one.
  assert.equal(MARKET_TYPE_BY_ID.margin.tickerType, null, 'margin has no quotable instrument');
  for (const market of MARKET_TYPES) {
    if (market.tickerType === null) assert.equal(market.id, 'margin', `${market.id} is the only quote-less type`);
  }
});

// Type-only references so the unused-locals pass does not elide the compile-time
// proofs above (the `@ts-expect-error` directives are the assertions).
export type _TradeTypeProofs = [Instrument, MarketRow, TradingAccount, VenueCapability, MarketType, VenueId];
