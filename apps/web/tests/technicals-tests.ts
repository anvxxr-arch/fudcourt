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
import {
  INSTRUMENTS, OSCILLATORS, MOVING_AVERAGES, SCAN_TF, TIMEFRAMES, VALUE_FIELDS,
  aboveBelow, byId, duplicateIds, recoverNet, scanBody, scanColumns, shapeBoard,
  shapeInstrument, summaryBand, type Instrument,
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
