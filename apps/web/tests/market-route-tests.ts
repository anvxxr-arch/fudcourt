/**
 * Market route failure + header contract: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test (app/(frontend)/api/market/{stock,commodity,macro,indonesia}/route.ts):
 *  - `region` is OUR parameter, and only the stock route reads one: a value
 *    outside STOCK_REGIONS is a strict 400 that names the allowed set, never a
 *    clamp to the default region. An EMPTY value is still a value -- `?region=`
 *    is a param the route must reject rather than treat as absent;
 *  - a symbol whose upstream call fails is REPORTED, not dropped: the board is
 *    still a 200, the symbol rides in `failed[]` with its reason, and it is
 *    absent from `quotes` -- so a partial board can never pass for a full one;
 *  - only a board where EVERY symbol failed is a loud 502, and it carries the
 *    whole `failed[]` array rather than a bare error string -- never a fake
 *    empty 200;
 *  - every 200 carries `X-Cache`, aggregated over the board's upstream calls:
 *    HIT only when EVERY upstream call was a HIT, COALESCED when at least one
 *    call shared an in-flight round-trip and none fell through to upstream,
 *    otherwise MISS. A 502 carries NO `X-Cache` -- an error is not a cache
 *    state, and stamping one would let a failure pass for a cached board.
 *
 * Every upstream call these routes make goes through `limitedFetch`, which
 * serialises them through one chain with a 200 ms floor, so a full-board test
 * costs roughly 200 ms per symbol (~3 s for the 16-symbol US board). That is
 * the price of driving the real seam instead of a private one, and it keeps the
 * suite honest about the concurrency the route actually runs at.
 *
 * Usage: cd frontend/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET as stockGET } from '@/app/(frontend)/api/market/stock/route';
import { GET as commodityGET } from '@/app/(frontend)/api/market/commodity/route';
import { GET as macroGET } from '@/app/(frontend)/api/market/macro/route';
import { GET as indonesiaGET } from '@/app/(frontend)/api/market/indonesia/route';
import { STOCK_REGIONS, STOCK_SYMBOLS } from '@/features/market/stock-regions';
import { COMMODITY_SYMBOLS } from '@/features/market/commodity-symbols';
import {
  ECONOMY_INDICATORS,
  INDICATORS,
  MACRO_SPREADS,
  MACRO_SYMBOLS,
  POLICY_RATES,
  POLICY_RATE_AREAS,
  WORLD_AGGREGATES,
  WORLD_CODES,
  WORLD_COUNTRIES,
  YAHOO_CHART,
} from '@/features/market/clients';
import {
  ID_APBN_IDS,
  ID_COUNTRY,
  IDR_QUOTE_SYMBOLS,
  IDR_QUOTES,
} from '@/features/market/clients';
import { IMF_DATAFLOW_CATALOGUE, IMF_SDMX } from '@/features/market/imf';
import { BIS_CBPOL, __resetMemo } from '@/features/market/bis';
import { FRED_CSV } from '@/features/market/fred';
import { WORLDBANK_API } from '@/features/market/worldbank';
import { __resetLimiter } from '@/lib/rate-limit';
// A fetch stub. Every upstream call these routes make goes through
// `limitedFetch`, which composes its own deadline around whatever
// `globalThis.fetch` answers -- so replacing the global reaches all four
// families (Yahoo, BIS, FRED, World Bank) without touching the limiter or the
// routes. The stub answers a real `Response` because `limitedFetch` reads the
// body ONCE and rebuilds an equivalent Response per caller from the text.
// ---------------------------------------------------------------------------
type Stub = { status?: number; body?: unknown };
/** Sentinel: the upstream REFUSES the connection rather than answering. That is
 *  a different failure from a non-200, and the routes report them differently
 *  (`fetch failed: …` versus `upstream <status>`), so both paths stay drivable. */
const REFUSED: unique symbol = Symbol('refused');
type Answer = Stub | typeof REFUSED;
const calls: string[] = [];
function stubFetch(handler: (url: string) => Answer): () => void {
  const original = globalThis.fetch;
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const answer = handler(url);
    if (answer === REFUSED) throw new Error('stubbed upstream: connection refused');
    const { status = 200, body } = answer;
    // A string body is CSV/text (BIS, FRED): it must reach the parser verbatim,
    // so it is written as-is rather than JSON-encoded into a quoted one-liner.
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    return new Response(text, {
      status,
      headers: { 'Content-Type': typeof body === 'string' ? 'text/csv' : 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
    __resetLimiter();
    __resetMemo();
  };
}
/** A minimal chart envelope `parseChart` accepts: a finite price is the one
 *  field it refuses to invent, so a stub that omits it would be testing the
 *  failure path rather than the success path. */
function chartBody(symbol: string, price: number): unknown {
  return {
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: price,
            chartPreviousClose: price - 1,
            symbol,
            longName: `${symbol} stub`,
            exchangeName: 'STUB',
            currency: 'USD',
          },
          indicators: { quote: [{ close: [price - 1, price] }] },
        },
      ],
    },
  };
}
/** The BIS CSV envelope `parseBisCsv` accepts: one row per requested area, each
 *  carrying a rate. The header names are the ones the parser indexes, so a stub
 *  that renamed them would be testing the failure path, not the success path. */
function bisBody(areas: readonly string[], rate = 4.25): string {
  const rows = areas.map((a) => `${a},2026-09-30,${rate}`).join('\n');
  return `REF_AREA,TIME_PERIOD,OBS_VALUE\n${rows}\n`;
}
/** The FRED CSV envelope `parseFred` accepts: a monthly series long enough for a
 *  12-month YoY, because the shapes with a lag refuse a shorter window. */
function fredBody(seriesId: string, months = 24): string {
  const rows: string[] = [];
  const start = new Date(Date.UTC(2024, 9, 1));
  for (let i = 0; i < months; i++) {
    const d = new Date(start);
    d.setUTCMonth(start.getUTCMonth() + i);
    rows.push(`${d.toISOString().slice(0, 7)}-01,${(100 + i * 0.5).toFixed(3)}`);
  }
  return `observation_date,${seriesId}\n${rows.join('\n')}\n`;
}
/** The World Bank envelope `parseWorldBankSeries` accepts: a two-element array
 *  whose second element is the row list. One row per requested country with a
 *  value in the window and a decade-earlier one, so `pickLatestAndPrior` can
 *  fill both the newest cell and its comparison. */
function worldBankBody(codes: readonly string[], value = 10.5): unknown {
  const rows = codes.flatMap((code) => [
    { countryiso3code: code, date: '2024', value },
    { countryiso3code: code, date: '2015', value: value - 1 },
  ]);
  return [null, rows];
}
/** `createFetchPool` logs every non-ok upstream, which is right in production
 *  and noise in a test whose whole point is that every call fails. */
function silenceConsoleError(): () => void {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}
const symbolsOf = (failed: { symbol: string }[]) => failed.map((f) => f.symbol);
// ---------------------------------------------------------------------------
// The region guard (stock only — the other two routes read no params)
// ---------------------------------------------------------------------------
test('market stock: a region outside STOCK_REGIONS is a 400 naming the allowed set, never a clamp', async () => {
  __resetLimiter();
  __resetMemo();
  const res = await stockGET(new Request('http://localhost/api/market/stock?region=bogus'));
  assert.equal(res.status, 400, 'a bogus region is a client error, not a defaulted board');
  const body = await res.json();
  assert.equal(body.error, 'invalid region');
  assert.ok(
    STOCK_REGIONS.every((r) => String(body.detail).includes(r)),
    'the detail must name every region the route will actually serve'
  );
  assert.equal(calls.length, 0, 'a rejected param must not reach the upstream at all');
});
test('market stock: an empty region param is a param, not an absent one', async () => {
  __resetLimiter();
  __resetMemo();
  const res = await stockGET(new Request('http://localhost/api/market/stock?region='));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid region');
  assert.equal(calls.length, 0);
});
// ---------------------------------------------------------------------------
// The all-fail 502 — the loud refusal, never a fake empty 200
// ---------------------------------------------------------------------------
test('market stock: every symbol failing is a 502 carrying the whole failed array', async () => {
  const restore = stubFetch(() => REFUSED);
  try {
    const res = await stockGET(new Request('http://localhost/api/market/stock?region=us'));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'no quotes returned');
    assert.equal(body.failed.length, STOCK_SYMBOLS.us.length, 'every symbol must be named, none dropped');
    assert.deepEqual(symbolsOf(body.failed), [...STOCK_SYMBOLS.us], 'input order, one entry per symbol');
    for (const f of body.failed) assert.match(f.reason, /^fetch failed: /, 'a refused connection is reported as a fetch failure');
    assert.equal(calls.length, STOCK_SYMBOLS.us.length, 'one upstream call per symbol, no batch endpoint');
  } finally {
    restore();
  }
});
test('market commodity: every symbol failing is a 502 carrying the whole failed array', async () => {
  const restore = stubFetch(() => REFUSED);
  try {
    const res = await commodityGET();
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'no quotes returned');
    assert.equal(body.failed.length, COMMODITY_SYMBOLS.length, 'every symbol must be named, none dropped');
    assert.deepEqual(symbolsOf(body.failed), [...COMMODITY_SYMBOLS], 'input order, one entry per symbol');
    for (const f of body.failed) assert.match(f.reason, /^fetch failed: /);
    assert.equal(calls.length, COMMODITY_SYMBOLS.length, 'one upstream call per symbol, no batch endpoint');
  } finally {
    restore();
  }
});
test('market macro: every quote failing is a 502, and the other families report their own failures', async () => {
  const restore = stubFetch(() => REFUSED);
  const quiet = silenceConsoleError();
  try {
    const res = await macroGET();
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'no quotes returned');
    assert.ok(
      String(body.detail).includes(`all ${MACRO_SYMBOLS.length} quote symbols failed`),
      'the detail counts the quote block, which is the board\'s spine'
    );
    const named = new Set(symbolsOf(body.failed));
    for (const s of MACRO_SYMBOLS) assert.ok(named.has(s), `${s} must be named in failed[]`);
    // The macro board is four upstreams, and a total quote failure does not
    // excuse the other three from reporting: the client is told which families
    // are dark, not just that the board is.
    assert.ok(named.has('BIS:WS_CBPOL'), 'the policy-rate family reports its own failure');
    assert.ok([...named].some((s) => s.startsWith('FRED:')), 'the FRED family reports its own failure');
    assert.ok([...named].some((s) => s.startsWith('WB:')), 'the World Bank family reports its own failure');
    assert.ok(body.failed.length > MACRO_SYMBOLS.length, 'a total quote failure still reports the other families');
  } finally {
    quiet();
    restore();
  }
});
// ---------------------------------------------------------------------------
// The partial board — a 200 that admits what it is missing
// ---------------------------------------------------------------------------
test('market stock: one symbol failing is a 200 with that symbol named in failed[]', async () => {
  const symbols = STOCK_SYMBOLS.us;
  const broken = symbols[0];
  const restore = stubFetch((url) => {
    const symbol = decodeURIComponent(url.slice(YAHOO_CHART.length + 1).split('?')[0]);
    if (symbol === broken) return REFUSED;
    return { body: chartBody(symbol, 100 + symbol.length) };
  });
  try {
    const res = await stockGET(new Request('http://localhost/api/market/stock'));
    assert.equal(res.status, 200, 'a partial board is a success that admits its gap, not an error');
    const body = await res.json();
    assert.equal(body.region, 'us', 'a bare request serves the default region');
    assert.equal(body.count, symbols.length - 1);
    assert.equal(body.quotes.length, symbols.length - 1);
    assert.equal(body.failed.length, 1, 'exactly the one symbol that failed');
    assert.equal(body.failed[0].symbol, broken);
    assert.match(body.failed[0].reason, /^fetch failed: /);
    assert.ok(
      !body.quotes.some((q: { symbol: string }) => q.symbol === broken),
      'a failed symbol must not also appear as a quote'
    );
    assert.equal(calls.length, symbols.length, 'one upstream call per symbol, no batch endpoint');
  } finally {
    restore();
  }
});
test('market commodity: one symbol failing is a 200 with that symbol named in failed[]', async () => {
  const broken = COMMODITY_SYMBOLS[0];
  const restore = stubFetch((url) => {
    const symbol = decodeURIComponent(url.slice(YAHOO_CHART.length + 1).split('?')[0]);
    if (symbol === broken) return { status: 503 };
    return { body: chartBody(symbol, 100 + symbol.length) };
  });
  try {
    const res = await commodityGET();
    assert.equal(res.status, 200, 'a partial board is a success that admits its gap, not an error');
    const body = await res.json();
    assert.equal(body.count, COMMODITY_SYMBOLS.length - 1);
    assert.equal(body.quotes.length, COMMODITY_SYMBOLS.length - 1);
    assert.equal(body.failed.length, 1, 'exactly the one symbol that failed');
    assert.equal(body.failed[0].symbol, broken);
    assert.equal(body.failed[0].reason, `upstream 503`, 'a non-200 is reported by status, not as a fetch failure');
    assert.ok(
      !body.quotes.some((q: { symbol: string }) => q.symbol === broken),
      'a failed symbol must not also appear as a quote'
    );
    // The curated label is what the board renders, so a surviving row must carry
    // it rather than Yahoo's contract-calendar name.
    const survivor = body.quotes.find((q: { symbol: string }) => q.symbol === COMMODITY_SYMBOLS[1]);
    assert.equal(survivor.name, 'Silver', 'a surviving row keeps the curated label');
    assert.match(String(body.derived), /1 of 12 failed/, 'the derived line counts the gap');
    assert.equal(calls.length, COMMODITY_SYMBOLS.length, 'one upstream call per symbol, no batch endpoint');
  } finally {
    restore();
  }
});
test('market macro: one quote symbol failing is a 200 with that symbol named in failed[]', async () => {
  const broken = MACRO_SYMBOLS[0];
  const restore = stubFetch((url) => {
    if (url.startsWith(YAHOO_CHART)) {
      const symbol = decodeURIComponent(url.slice(YAHOO_CHART.length + 1).split('?')[0]);
      if (symbol === broken) return REFUSED;
      return { body: chartBody(symbol, 4 + symbol.length) };
    }
    if (url.startsWith(BIS_CBPOL)) return { body: bisBody(POLICY_RATE_AREAS) };
    if (url.startsWith(FRED_CSV)) {
      return { body: fredBody(new URL(url).searchParams.get('id') ?? '') };
    }
    if (url.startsWith(WORLDBANK_API)) return { body: worldBankBody(WORLD_CODES) };
    return REFUSED;
  });
  try {
    const res = await macroGET();
    assert.equal(res.status, 200, 'a partial quote block is still a board, not an error');
    const body = await res.json();
    assert.equal(body.count, MACRO_SYMBOLS.length - 1);
    assert.equal(body.quotes.length, MACRO_SYMBOLS.length - 1);
    assert.equal(body.failed.length, 1, 'exactly the one quote symbol that failed');
    assert.equal(body.failed[0].symbol, broken);
    assert.match(body.failed[0].reason, /^fetch failed: /);
    assert.ok(
      !body.quotes.some((q: { symbol: string }) => q.symbol === broken),
      'a failed symbol must not also appear as a quote'
    );
    // The other three families still report: a partial quote block must not
    // excuse the policy-rate table, the indicator table or the worldwide board
    // from being served.
    assert.equal(body.policyRates.length, POLICY_RATES.length, 'every policy-rate row is still built');
    assert.ok(
      body.policyRates.every((r: { rate: number | null }) => r.rate !== null),
      'the BIS family answered, so no rate cell is withheld'
    );
    assert.equal(body.indicators.length, INDICATORS.length, 'every FRED indicator row is still built');
    assert.ok(
      body.indicators.every((r: { value: number | null }) => r.value !== null),
      'the FRED family answered, so no indicator value is withheld'
    );
    assert.equal(body.economies.length, WORLD_COUNTRIES.length, 'the worldwide board still lists every country');
    assert.equal(body.aggregates.length, WORLD_AGGREGATES.length, 'the worldwide board still lists every aggregate');
    // A spread over the broken leg is withheld, never computed from a zero.
    const brokenLeg = MACRO_SPREADS.find((s) => s.long === broken || s.short === broken);
    if (brokenLeg) {
      const spread = body.spreads.find((s: { label: string }) => s.label === brokenLeg.label);
      assert.equal(spread.bp, null, `the ${brokenLeg.label} spread has a missing leg and must stay null`);
    }
    // The quote symbols are the only family that failed, so the derived line's
    // failure count names exactly one item.
    assert.match(String(body.derived), /1 upstream item\(s\) failed/, 'the derived line counts the single gap');
  } finally {
    restore();
  }
});
// ---------------------------------------------------------------------------
// The X-Cache header policy — one mark per upstream call, aggregated per board.
// ---------------------------------------------------------------------------
/** A full-board Yahoo stub: every quote symbol answers a parseable envelope. */
function yahooOk(url: string, priceBase: number): Answer {
  const symbol = decodeURIComponent(url.slice(YAHOO_CHART.length + 1).split('?')[0]);
  return { body: chartBody(symbol, priceBase + symbol.length) };
}
/** The macro board's non-quote families, all answering. */
function macroFamiliesOk(url: string): Answer {
  if (url.startsWith(BIS_CBPOL)) return { body: bisBody(POLICY_RATE_AREAS) };
  if (url.startsWith(FRED_CSV)) {
    return { body: fredBody(new URL(url).searchParams.get('id') ?? '') };
  }
  if (url.startsWith(WORLDBANK_API)) return { body: worldBankBody(WORLD_CODES) };
  return REFUSED;
}
/** The IMF Fiscal Monitor envelope `parseImfFiscal` accepts: a dated vintage with
 *  one in-window actual per requested APBN indicator, so the board's finance
 *  block fills instead of reporting `IMF:*` failures. */
function imfBody(ids: readonly string[]): string {
  const series = ids
    .map(
      (id) =>
        `<Series COUNTRY="IDN" INDICATOR="${id}" FREQUENCY="A"><Obs TIME_PERIOD="2024" OBS_VALUE="14.5" DERIVATION_TYPE="M"/><Obs TIME_PERIOD="2030" OBS_VALUE="15.0" DERIVATION_TYPE="M"/></Series>`
    )
    .join('');
  return `<message:StructureSpecificData><message:Header><message:Structure structureID="IMF.FAD_FM_2025_OCT_VINTAGE_1_0_0"/></message:Header><message:DataSet PUBLICATION_DATE="2025-10-15T12:45:00Z">${series}</message:DataSet></message:StructureSpecificData>`;
}
const IMF_CATALOGUE = {
  data: {
    dataflows: [{ id: 'FM_2025_OCT_VINTAGE', version: '1.0.0' }],
  },
};
/** The indonesia board's non-quote families, all answering. */
function indonesiaFamiliesOk(url: string): Answer {
  if (url.startsWith(BIS_CBPOL)) return { body: bisBody(['ID']) };
  if (url.startsWith(WORLDBANK_API)) return { body: worldBankBody([ID_COUNTRY]) };
  if (url === IMF_DATAFLOW_CATALOGUE) return { body: IMF_CATALOGUE };
  if (url.startsWith(IMF_SDMX)) return { body: imfBody(ID_APBN_IDS), status: 200 };
  return REFUSED;
}
test('market stock: a fresh board is MISS; a repeated board is HIT', async () => {
  const restore = stubFetch((url) => yahooOk(url, 100));
  try {
    const first = await stockGET(new Request('http://localhost/api/market/stock?region=us'));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('X-Cache'), 'MISS', 'the first board pays every upstream call');
    await first.json();
    const second = await stockGET(new Request('http://localhost/api/market/stock?region=us'));
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('X-Cache'), 'HIT', 'every upstream call cached means the board is a HIT');
    await second.json();
    assert.equal(calls.length, STOCK_SYMBOLS.us.length, 'the repeat costs zero upstream calls');
  } finally {
    restore();
  }
});
test('market stock: one uncached symbol keeps the board at MISS', async () => {
  const restore = stubFetch((url) => yahooOk(url, 100));
  try {
    const warm = await stockGET(new Request('http://localhost/api/market/stock?region=us'));
    assert.equal(warm.status, 200);
    await warm.json();
    // A new region means new upstream URLs: none of them can be cached, so the
    // board is a MISS even though the limiter is warm from the first board.
    const other = await stockGET(new Request('http://localhost/api/market/stock?region=asia'));
    assert.equal(other.status, 200);
    assert.equal(other.headers.get('X-Cache'), 'MISS', 'any upstream round-trip makes the board a MISS');
    await other.json();
  } finally {
    restore();
  }
});
test('market commodity: a fresh board is MISS; a repeated board is HIT', async () => {
  const restore = stubFetch((url) => yahooOk(url, 50));
  try {
    const first = await commodityGET();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('X-Cache'), 'MISS');
    await first.json();
    const second = await commodityGET();
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('X-Cache'), 'HIT', 'every upstream call cached means the board is a HIT');
    await second.json();
    assert.equal(calls.length, COMMODITY_SYMBOLS.length, 'the repeat costs zero upstream calls');
  } finally {
    restore();
  }
});
test('market commodity: concurrent identical boards share one round-trip (COALESCED)', async () => {
  const restore = stubFetch((url) => yahooOk(url, 50));
  try {
    // No gate, no delay: the first board's workers register each symbol's
    // in-flight call synchronously before the second board's workers run, so
    // every second-board call coalesces. Microtask FIFO makes this
    // deterministic, not racy.
    const [a, b] = await Promise.all([commodityGET(), commodityGET()]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const marks = [a.headers.get('X-Cache'), b.headers.get('X-Cache')].sort();
    assert.deepEqual(marks, ['COALESCED', 'MISS'], 'one board pays, the other shares -- with no second MISS');
    await a.json();
    await b.json();
    assert.equal(calls.length, COMMODITY_SYMBOLS.length, 'the pair costs one round-trip per symbol, not two');
  } finally {
    restore();
  }
});
test('market macro: a fresh board is MISS; a repeated board is HIT', async () => {
  const restore = stubFetch((url) => {
    if (url.startsWith(YAHOO_CHART)) return yahooOk(url, 4);
    return macroFamiliesOk(url);
  });
  const quiet = silenceConsoleError();
  try {
    const first = await macroGET();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('X-Cache'), 'MISS', 'the first board pays every upstream call');
    await first.json();
    const second = await macroGET();
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('X-Cache'), 'HIT', 'every upstream call cached means the board is a HIT');
    await second.json();
  } finally {
    quiet();
    restore();
  }
});
test('market indonesia: a fresh board is MISS; a repeated board is HIT', async () => {
  const restore = stubFetch((url) => {
    if (url.startsWith(YAHOO_CHART)) return yahooOk(url, 16000);
    return indonesiaFamiliesOk(url);
  });
  const quiet = silenceConsoleError();
  try {
    const first = await indonesiaGET();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('X-Cache'), 'MISS', 'the first board pays every upstream call');
    const b1 = await first.json();
    assert.equal(b1.failed.length, 0, 'all families answered, so the board admits no gap');
    const second = await indonesiaGET();
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('X-Cache'), 'HIT', 'every upstream call cached means the board is a HIT');
    await second.json();
  } finally {
    quiet();
    restore();
  }
});
test('market 502s carry no X-Cache', async () => {
  // The memo store (`features/market/bis.ts`) has no cross-test visibility, so
  // a value memoised by an earlier board would leak into this all-fail run and
  // turn a 502 into a 200. Reset it up front: this test's contract is that
  // EVERY upstream call fails, and only a clean memo state can assert that.
  __resetMemo();
  const restore = stubFetch(() => REFUSED);
  const quiet = silenceConsoleError();
  try {
    const stock = await stockGET(new Request('http://localhost/api/market/stock?region=us'));
    assert.equal(stock.status, 502);
    assert.equal(stock.headers.get('X-Cache'), null, 'an error is not a cache state');
    await stock.json();
    const commodity = await commodityGET();
    assert.equal(commodity.status, 502);
    assert.equal(commodity.headers.get('X-Cache'), null, 'an error is not a cache state');
    await commodity.json();
    const macro = await macroGET();
    assert.equal(macro.status, 502);
    assert.equal(macro.headers.get('X-Cache'), null, 'an error is not a cache state');
    await macro.json();
    const indonesia = await indonesiaGET();
    assert.equal(indonesia.status, 502);
    assert.equal(indonesia.headers.get('X-Cache'), null, 'an error is not a cache state');
    await indonesia.json();
  } finally {
    quiet();
    restore();
  }
});
