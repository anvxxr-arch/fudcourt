/**
 * The technicals board's shapers. Offline: every case below is a frozen payload,
 * so the rules are asserted against literals instead of against whatever the
 * screener happened to publish this minute.
 *
 * The numbers in the fixtures are real — they are the values the scanner
 * returned for CRYPTO:BTCUSD and BINANCE:BTCUSDT on 2026-10-10, including the
 * `Recommend.All = (MA + Other) / 2` identity that the whole board rests on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INSTRUMENTS, OSCILLATORS, MOVING_AVERAGES, SCAN_TF, TIMEFRAMES, UNRESOLVED, VALUE_FIELDS,
  aboveBelow, byClass, byId, classCounts, duplicateIds, recoverNet, scanBody, scanColumns,
  shapeBoard, shapeInstrument, summaryBand, type Instrument,
} from '@/features/technicals/model';

const inst: Instrument = { id: 'btcusdt', label: 'BTC/USDT', tv: 'BINANCE:BTCUSDT', cls: 'crypto' };

/** The 60m triple measured live: MA 0.214285714…, Other -0.36363636…, All -0.07467532… */
const cells = (over: Record<string, number | null> = {}) => ({
  'close|60': 83074,
  'RSI|60': 61.5795,
  'Recommend.MA|60': 0.21428571428571427,
  'Recommend.Other|60': -0.36363636363636365,
  'Recommend.All|60': -0.07467532467532469,
  ...over,
});

test('technicals: the score identity the board rests on holds on the measured triple', () => {
  const read = shapeInstrument(inst, cells(), ['1h']).reads[0];
  assert.equal(read.invariant, true, '0.214285… + -0.363636… / 2 === -0.074675… must verify');
  assert.equal(read.withheld, false);
});

test('technicals: a payload whose score disagrees with its own parts is flagged, never printed as fine', () => {
  // The invariant is the board's only defence against silently rendering a
  // number it can no longer explain, so it must FAIL on a broken triple.
  const read = shapeInstrument(inst, cells({ 'Recommend.All|60': 0.9 }), ['1h']).reads[0];
  assert.equal(read.invariant, false);
  assert.equal(read.all, 0.9, 'the value is still reported — it is flagged, not hidden');
});

test('technicals: a withheld timeframe is named, and never becomes a zero', () => {
  // Crypto `1d` measured null on the public screener (both global/ and crypto/
  // paths, CRYPTO:BTCUSD and BINANCE:BTCUSDT).
  const read = shapeInstrument(inst, {}, ['1d']).reads[0];
  assert.equal(read.withheld, true);
  assert.equal(read.all, null);
  assert.equal(read.ma, null);
  assert.equal(read.osc, null);
  assert.equal(read.values['close'], null, 'an unpublished value is null, never 0');
});

test('technicals: the recoverable integer is a NET, and it is the group mean times the group size', () => {
  // -4/11 and 3/14 are the fractions measured on the live BTC triple.
  assert.equal(recoverNet(-0.36363636363636365, 11), -4);
  assert.equal(recoverNet(0.21428571428571427, 14), 3);
  assert.equal(recoverNet(null, 11), null);
  const read = shapeInstrument(inst, cells(), ['1h']).reads[0];
  assert.equal(read.netOsc, -4);
  assert.equal(read.maPresent, 0, 'only fields the payload actually carried are counted');
});

test('technicals: the band mapping is total, ordered and states neutral in the middle', () => {
  assert.equal(summaryBand(1), 'STRONG BUY');
  assert.equal(summaryBand(0.5), 'STRONG BUY');
  assert.equal(summaryBand(0.1001), 'BUY');
  assert.equal(summaryBand(0.1), 'NEUTRAL');
  assert.equal(summaryBand(0), 'NEUTRAL');
  assert.equal(summaryBand(-0.1), 'NEUTRAL');
  assert.equal(summaryBand(-0.1001), 'SELL');
  assert.equal(summaryBand(-0.5), 'STRONG SELL');
  assert.equal(summaryBand(null), null);
  assert.equal(summaryBand(Number.NaN), null);
});

test('technicals: the request crosses every timeframe with every field', () => {
  const cols = scanColumns(['1h', '1d']);
  assert.equal(cols.length, 2 * VALUE_FIELDS.length);
  // The column carries the SUFFIX (`60`), never this board's label (`1h`).
  assert.ok(cols.includes('Recommend.All|60') && cols.includes('Recommend.All|1D'), 'the suffix map is applied');
  assert.ok(!cols.some((c) => c.endsWith('|1h')), 'no column may carry a board label');
  assert.equal(new Set(cols).size, cols.length, 'no column is requested twice');
  const body = scanBody([inst], ['1h']);
  assert.deepEqual(body.symbols.tickers, ['BINANCE:BTCUSDT']);
  assert.deepEqual(body.columns, cols.slice(0, VALUE_FIELDS.length));
});

test('technicals: every timeframe has a suffix, and the two group sizes are the measured ones', () => {
  assert.equal(OSCILLATORS.length, 11, 'measured: Recommend.Other is a mean over 11');
  assert.equal(MOVING_AVERAGES.length, 15, 'measured: Recommend.MA is a mean over 15');
  assert.ok((MOVING_AVERAGES as readonly string[]).includes('VWMA'));
  // BBPower, NOT Bull.Bear.Power: the latter returns null and skews the mean by 1.
  assert.ok((OSCILLATORS as readonly string[]).includes('BBPower'));
  assert.ok(!(OSCILLATORS as readonly string[]).includes('Bull.Bear.Power'));
  assert.ok((OSCILLATORS as readonly string[]).includes('MACD.macd'), 'MACD is one of the 11, as a histogram');
  for (const tf of TIMEFRAMES) assert.ok(SCAN_TF[tf], `${tf} must carry a screener suffix`);
  assert.equal(SCAN_TF['1d'], '1D', 'the daily suffix is uppercase — the lowercase form answers null');
});

test('technicals: the registry is unique on both keys, and a missing row is named not dropped', () => {
  assert.deepEqual(duplicateIds(), []);
  const tv = INSTRUMENTS.map((i) => i.tv);
  assert.equal(new Set(tv).size, tv.length, 'two instruments sharing a ticker would render one twice');
  assert.equal(byId('btcusdt')?.tv, 'BINANCE:BTCUSDT');
  assert.equal(byId('nope'), undefined);

  const board = shapeBoard(
    [{ symbol: 'BINANCE:BTCUSDT', cells: cells() }],
    [inst, { id: 'ethusdt', label: 'ETH/USDT', tv: 'BINANCE:ETHUSDT', cls: 'crypto' }],
    ['1h'],
    { fetchedAt: '2026-10-10T18:00:00.000Z', source: 'test' },
  );
  assert.equal(board.instruments.length, 1);
  assert.deepEqual(board.missing, ['ethusdt'], 'a symbol the upstream skipped is named in missing[]');
});

test('technicals: close-vs-level is arithmetic, and an unknown side is null rather than a default', () => {
  assert.equal(aboveBelow(100, 90), 'above');
  assert.equal(aboveBelow(90, 100), 'below');
  assert.equal(aboveBelow(100, 100), null);
  assert.equal(aboveBelow(null, 100), null);
  assert.equal(aboveBelow(100, null), null);
});


/* ---------------------------------------------------------------------------
 * The registry: every asset this app tracks, resolved by MEASUREMENT.
 *
 * The counts below are the app's own universes (`features/trade/model-instruments.ts`,
 * `features/market/stock-regions.ts`, `forex-pairs.ts`, `commodity-symbols.ts`) —
 * pinned as literals so a registry that quietly loses a class fails here rather
 * than shipping a board that claims to cover the market and does not.
 * ------------------------------------------------------------------------- */

test('registry: one row per app asset, and not one duplicate id or ticker', () => {
  assert.deepEqual(duplicateIds(), [], 'a duplicated id resolves to the wrong row');
  const tvs = INSTRUMENTS.map((i) => i.tv);
  assert.equal(new Set(tvs).size, tvs.length, 'two registry rows share one upstream ticker');
});

test('registry: the app universes are FULLY accounted for', () => {
  // 121 rows carry 30 crypto · 63 of the 65 stocks · 16 forex · 12 commodities.
  // The other two stocks are in UNRESOLVED, so nothing the app tracks is
  // missing without being named.
  assert.deepEqual(classCounts(), { crypto: 30, stock: 64, forex: 16, commodity: 11 });
  assert.equal(INSTRUMENTS.length, 121);
  assert.equal(classCounts().stock + UNRESOLVED.filter((u) => u.cls === 'stock').length, 65,
    'the app carries 65 stock symbols (16 US + 18 Asia + 31 Europe)');
  for (const cls of ['crypto', 'stock', 'forex', 'commodity'] as const) {
    assert.equal(byClass(cls).length, classCounts()[cls]);
  }
});

test('registry: the app assets the upstream cannot rate are STATED, never faked', () => {
  assert.deepEqual(UNRESOLVED.map((u) => u.id).sort(), ['axjo', 'coffee']);
  for (const u of UNRESOLVED) {
    assert.equal(byId(u.id), undefined, `${u.id} must not be a registry row`);
    assert.equal(INSTRUMENTS.some((i) => i.label === u.label), false, `${u.label} must not be silently dropped either`);
  }
});

test('registry: every id is URL-safe and every ticker is exchange-qualified', () => {
  for (const i of INSTRUMENTS) {
    assert.match(i.id, /^[a-z0-9.\-]+$/, `id ${i.id} is not URL-safe for ?symbols=`);
    assert.match(i.tv, /^[A-Z0-9_]+:[A-Za-z0-9._!+\-]+$/, `ticker ${i.tv} is not exchange-qualified`);
  }
});

test('registry: the resolved families are the measured ones', () => {
  const tvs = (c: string) => INSTRUMENTS.filter((i) => i.cls === c).map((i) => i.tv);
  assert.ok(tvs('crypto').every((t) => t.startsWith('BINANCE:') || t.startsWith('COINBASE:')),
    'crypto reads an exchange pair, never the synthetic index');
  assert.ok(tvs('forex').every((t) => t.startsWith('FX:') || t.startsWith('FX_IDC:')), 'forex reads the FX feeds');
  assert.ok(tvs('commodity').every((t) => /^(TVC|OANDA|FX):/.test(t)),
    'commodities read a rated spot/CFD series, never a front month (0/25 rated)');
  for (const ex of ['IDX:', 'LSE:', 'XETR:', 'NASDAQ:', 'NYSE:', 'TSE:', 'HKEX:', 'TWSE:']) {
    assert.ok(tvs('stock').some((t) => t.startsWith(ex)), `${ex} must be carried by the stock class`);
  }
});

test('registry: commodities read only a series the upstream itself calls one', () => {
  // The front months this app tracks carry NO aggregate (measured: 0 of 25
  // contracts rated in every symbol search), so each commodity reads the rated
  // series for the same underlying. Every other candidate was refused for a
  // reason: LSE:CRUD / AMEX:BNO / AMEX:SOYB are funds, SPARKS:COFFEE is an index
  // of coffee companies. This list is therefore a measurement, not a preference.
  const measured = new Set([
    'TVC:GOLD', 'TVC:SILVER', 'OANDA:XCUUSD', 'TVC:PLATINUM', 'FX:USOIL', 'FX:UKOIL',
    'OANDA:NATGASUSD', 'OANDA:CORNUSD', 'OANDA:WHEATUSD', 'OANDA:SOYBNUSD', 'OANDA:SUGARUSD',
  ]);
  const rows = byClass('commodity');
  assert.equal(rows.length, measured.size);
  for (const r of rows) assert.ok(measured.has(r.tv), `${r.label} reads ${r.tv}, never measured`);
  assert.equal(rows.some((r) => r.tv.includes('1!')), false, 'a front month cannot carry a rating (0/25)');
  assert.equal(byId('coffee'), undefined, 'coffee has no rated series and stays unresolved');
});

test('registry: the renames the measurement found are pinned', () => {
  // MATIC migrated to POL at the venue and TON is only rated on Coinbase;
  // both were measured, neither was guessed.
  assert.equal(byId('maticusdt')?.tv, 'BINANCE:POLUSDT');
  assert.equal(byId('tonusdt')?.tv, 'COINBASE:TONUSD');
  assert.equal(byId('usdidr')?.tv, 'FX_IDC:USDIDR');
  // The index sweep: ^TWII IS the TAIEX, and the upstream says so in its own words.
  assert.equal(byId('twii')?.tv, 'TWSE:IX0001');
  assert.equal(byId('axjo'), undefined, '^AXJO has no rated form and stays unresolved (ASX:XJO is absent)');
});

test('technicals: the indicator table is grouped by the two means, and those two groups partition the published fields', () => {
  // The two groups ARE Recommend.Other and Recommend.MA — the two means the
  // score is built from. The table must name them (not colour-code them), and
  // they must partition the published fields exactly, in the published order.
  const osc = new Set<string>(OSCILLATORS);
  const ma = new Set<string>(MOVING_AVERAGES);
  assert.equal(osc.size, 11, 'Recommend.Other is a mean over 11');
  assert.equal(ma.size, 15, 'Recommend.MA is a mean over 15');
  for (const f of ma) assert.equal(osc.has(f), false, `${f} cannot belong to both means`);
  assert.deepEqual(
    VALUE_FIELDS.slice(0, OSCILLATORS.length + MOVING_AVERAGES.length),
    [...OSCILLATORS, ...MOVING_AVERAGES],
    'the published order is the two groups back to back — that order is what the table renders',
  );
  const ui = readFileSync(new URL('../src/features/technicals/ui.tsx', import.meta.url), 'utf8');
  assert.match(ui, /'oscillators', OSCILLATORS/, 'the oscillator group is labelled');
  assert.match(ui, /'moving averages', MOVING_AVERAGES/, 'the moving-average group is labelled');
});

test('technicals: the page states the identity it rests on, and states it the same way the warning does', () => {
  // The board checks Recommend.All === (Recommend.MA + Recommend.Other) / 2 on
  // every read and warns when it fails. The page must therefore SAY what the
  // score is in the healthy case too, and say it in the same words, otherwise a
  // reader meets the formula for the first time only when it has already broken.
  const ui = readFileSync(new URL('../src/features/technicals/ui.tsx', import.meta.url), 'utf8');
  assert.match(ui, /the mean of the two means beside it, \(MA \+ oscillators\) \/ 2/, 'the source line states the identity');
  assert.match(ui, /not \(MA \+ oscillators\) \/ 2/, 'the warning states the same formula');
  assert.equal((ui.match(/\(MA \+ oscillators\) \/ 2/g) ?? []).length, 2, 'healthy case and warning agree on the formula');
});
