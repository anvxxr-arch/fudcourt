/**
 * The technicals board's model: its own instrument registry, the upstream's
 * field ids, and the pure shapers that turn one scanner response into the rows
 * the board renders.
 *
 * WHY THE REGISTRY LIVES HERE (and not in a sibling's): the structure gate's
 * fifth rule forbids `features/<a>` reading `features/<b>`'s internals, so a new
 * family declares its OWN identity space rather than reaching into the ticker or
 * trade registries. The ids below are this board's; `tv` is the only field the
 * upstream ever sees.
 *
 * WHERE THE NUMBERS COME FROM — measured, not assumed (2026-10-10):
 *  * `Recommend.All === (Recommend.MA + Recommend.Other) / 2` held on 90 of 90
 *    samples (10 symbols x 9 timeframes), so the score is a mean of two means.
 *  * `Recommend.Other` covers 11 oscillators and `Recommend.MA` covers 15 moving
 *    averages — both id lists lifted from TradingView's own technical-analysis
 *    widget bundle, which is why `BBPower` (not `Bull.Bear.Power`) is here.
 *  * Each aggregate is a mean of -1/0/+1 ratings, so `count * aggregate` is an
 *    integer. That integer is the NET (buy - sell); it does NOT recover how many
 *    indicators were neutral, which is why the board prints a net and never a
 *    fabricated Sell/Neutral/Buy split.
 *  * The per-indicator rating RULES are evaluated upstream and are not in any
 *    public bundle, so this board reports their aggregates verbatim and only
 *    ever derives a comparison it can prove arithmetically (close vs a moving
 *    average). It does not claim to reimplement their scoring.
 */
export type AssetClass = 'crypto' | 'stock' | 'forex' | 'commodity';

export interface AssetClassSpec {
  id: AssetClass;
  label: string;
  /** What the upstream screener path is called, quoted in the UI's source line. */
  venue: string;
}

export const ASSET_CLASSES: AssetClassSpec[] = [
  { id: 'crypto', label: 'Crypto', venue: 'TradingView crypto screener' },
  { id: 'stock', label: 'Stocks', venue: 'TradingView US screener' },
  { id: 'forex', label: 'Forex', venue: 'TradingView FX screener' },
  { id: 'commodity', label: 'Commodities', venue: 'TradingView CFD screener' },
];

export interface Instrument {
  /** This board's id (registry-local, stable, what the URL carries). */
  id: string;
  label: string;
  /** The exchange-qualified ticker the upstream resolves. */
  tv: string;
  cls: AssetClass;
}

/**
 * The curated universe. Deliberately small and hand-picked: a board that claims
 * "the market" while showing 20 rows would be lying, so the board says what it
 * covers and each row links to the upstream it came from.
 *
 * Crypto uses exchange-qualified pairs (`BINANCE:BTCUSDT`) rather than the
 * `CRYPTO:BTCUSD` synthetic index: the synthetic symbols are absent from the
 * public screener's ticker list (measured), and the exchange pair is the one a
 * trader can actually act on.
 */
export const INSTRUMENTS: Instrument[] = [
  { id: 'btcusdt', label: 'BTC/USDT', tv: 'BINANCE:BTCUSDT', cls: 'crypto' },
  { id: 'ethusdt', label: 'ETH/USDT', tv: 'BINANCE:ETHUSDT', cls: 'crypto' },
  { id: 'solusdt', label: 'SOL/USDT', tv: 'BINANCE:SOLUSDT', cls: 'crypto' },
  { id: 'bnbusdt', label: 'BNB/USDT', tv: 'BINANCE:BNBUSDT', cls: 'crypto' },
  { id: 'xrpusdt', label: 'XRP/USDT', tv: 'BINANCE:XRPUSDT', cls: 'crypto' },
  { id: 'dogeusdt', label: 'DOGE/USDT', tv: 'BINANCE:DOGEUSDT', cls: 'crypto' },
  { id: 'adausdt', label: 'ADA/USDT', tv: 'BINANCE:ADAUSDT', cls: 'crypto' },
  { id: 'linkusdt', label: 'LINK/USDT', tv: 'BINANCE:LINKUSDT', cls: 'crypto' },
  { id: 'avaxusdt', label: 'AVAX/USDT', tv: 'BINANCE:AVAXUSDT', cls: 'crypto' },
  { id: 'aapl', label: 'AAPL', tv: 'NASDAQ:AAPL', cls: 'stock' },
  { id: 'msft', label: 'MSFT', tv: 'NASDAQ:MSFT', cls: 'stock' },
  { id: 'nvda', label: 'NVDA', tv: 'NASDAQ:NVDA', cls: 'stock' },
  { id: 'tsla', label: 'TSLA', tv: 'NASDAQ:TSLA', cls: 'stock' },
  { id: 'spy', label: 'SPY', tv: 'AMEX:SPY', cls: 'stock' },
  { id: 'eurusd', label: 'EUR/USD', tv: 'FX:EURUSD', cls: 'forex' },
  { id: 'gbpusd', label: 'GBP/USD', tv: 'FX:GBPUSD', cls: 'forex' },
  { id: 'usdjpy', label: 'USD/JPY', tv: 'FX:USDJPY', cls: 'forex' },
  { id: 'audusd', label: 'AUD/USD', tv: 'FX:AUDUSD', cls: 'forex' },
  { id: 'gold', label: 'Gold', tv: 'TVC:GOLD', cls: 'commodity' },
  { id: 'silver', label: 'Silver', tv: 'TVC:SILVER', cls: 'commodity' },
  { id: 'wti', label: 'Crude WTI', tv: 'TVC:USOIL', cls: 'commodity' },
  { id: 'copper', label: 'Copper', tv: 'TVC:COPPER', cls: 'commodity' },
];

export const byId = (id: string): Instrument | undefined => INSTRUMENTS.find((i) => i.id === id);

/** Every id in the registry, unique — a duplicated id would resolve to the wrong row. */
export function duplicateIds(): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const i of INSTRUMENTS) {
    if (seen.has(i.id)) dupes.push(i.id);
    seen.add(i.id);
  }
  return dupes;
}

export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1M'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** This board's timeframe label → the upstream's column suffix. */
export const SCAN_TF: Record<Timeframe, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '2h': '120',
  '4h': '240',
  '1d': '1D',
  '1w': '1W',
  '1M': '1M',
};

/** The 11 oscillator ids the upstream's own widget asks for, in its order. */
export const OSCILLATORS = [
  'RSI', 'Stoch.K', 'CCI20', 'ADX', 'AO', 'Mom', 'MACD.macd', 'Stoch.RSI.K', 'W.R', 'BBPower', 'UO',
] as const;

/** The 15 moving-average ids, same source. */
export const MOVING_AVERAGES = [
  'EMA10', 'SMA10', 'EMA20', 'SMA20', 'EMA30', 'SMA30', 'EMA50', 'SMA50',
  'EMA100', 'SMA100', 'EMA200', 'SMA200', 'Ichimoku.BLine', 'VWMA', 'HullMA9',
] as const;

export const AGGREGATE_FIELDS = ['Recommend.All', 'Recommend.MA', 'Recommend.Other'] as const;
/** Extra raw fields the board shows beside the indicators (never scored here). */
export const CONTEXT_FIELDS = ['close', 'change', 'ADX+DI', 'ADX-DI', 'MACD.signal'] as const;

export const VALUE_FIELDS = [
  ...OSCILLATORS, ...MOVING_AVERAGES, ...CONTEXT_FIELDS, ...AGGREGATE_FIELDS,
];

/**
 * The column order the request and the response are BOTH built from.
 *
 * The screener answers a positional array (`data[].d`), so the order is the
 * contract: if the request and the parse ever disagree, every value shifts one
 * column sideways and the board renders perfectly plausible wrong numbers. One
 * function, called from both sides, is the only shape that cannot drift.
 */
export function scanColumns(tfs: Timeframe[]): string[] {
  return tfs.flatMap((tf) => VALUE_FIELDS.map((field) => `${field}|${SCAN_TF[tf]}`));
}

/** The request body the screener expects, for one board read. */
export function scanBody(instruments: Instrument[], tfs: Timeframe[]) {
  return {
    symbols: { tickers: instruments.map((i) => i.tv), query: { types: [] } },
    columns: scanColumns(tfs),
  };
}

export type Rating = 'STRONG SELL' | 'SELL' | 'NEUTRAL' | 'BUY' | 'STRONG BUY';

/**
 * The upstream publishes a score, not a word (the word is composed on their
 * server). This maps a score onto a word with the bands the widget's own gauge
 * uses and the board STATES the bands rather than presenting the word as
 * upstream output.
 */
export function summaryBand(score: number | null): Rating | null {
  if (score === null || !Number.isFinite(score)) return null;
  if (score >= 0.5) return 'STRONG BUY';
  if (score > 0.1) return 'BUY';
  if (score <= -0.5) return 'STRONG SELL';
  if (score < -0.1) return 'SELL';
  return 'NEUTRAL';
}

export interface TfRead {
  tf: Timeframe;
  /** Verbatim upstream score — the summary number the technicals page prints. */
  all: number | null;
  /** Mean of the 15 moving-average ratings (nulls drop out of the denominator). */
  ma: number | null;
  /** Mean of the 11 oscillator ratings. */
  osc: number | null;
  /** `null` when the upstream withheld the whole timeframe (crypto `1d` does). */
  withheld: boolean;
  /** mean * size — the integer net (buy − sell) over the group, when recoverable. */
  netMa: number | null;
  netOsc: number | null;
  /** How many of the 15 MAs the upstream actually returned (nulls drop out). */
  maPresent: number;
  /** `false` when the published score disagrees with (MA + Other) / 2. */
  invariant: boolean;
  values: Record<string, number | null>;
}

export interface InstrumentRead {
  instrument: Instrument;
  reads: TfRead[];
}

export interface BoardPayload {
  /** ISO timestamp of the upstream read. */
  fetchedAt: string;
  /** The upstream this payload came from, named for the reader. */
  source: string;
  instruments: InstrumentRead[];
  /** Requested ids the upstream returned no row for — named, never silently dropped. */
  missing: string[];
}

const WIN = 1e-9;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Mean of a group, times its size — an integer whenever the upstream is consistent. */
export function recoverNet(aggregate: number | null, size: number): number | null {
  if (aggregate === null) return null;
  const net = aggregate * size;
  return Math.abs(net - Math.round(net)) < 1e-6 ? Math.round(net) : null;
}

/**
 * Shape ONE symbol's per-timeframe cells. Pure: the scanner's response is already
 * parsed by the time it gets here, so every rule below is testable offline
 * against a frozen payload instead of whatever the market was doing that minute.
 */
export function shapeInstrument(
  instrument: Instrument,
  cells: Record<string, number | null>,
  tfs: Timeframe[],
): InstrumentRead {
  const reads = tfs.map((tf): TfRead => {
    const suffix = SCAN_TF[tf];
    const at = (field: string): number | null => num(cells[`${field}|${suffix}`]);
    const all = at('Recommend.All');
    const ma = at('Recommend.MA');
    const osc = at('Recommend.Other');
    const values: Record<string, number | null> = {};
    for (const f of VALUE_FIELDS) values[f] = at(f);
    const maPresent = MOVING_AVERAGES.filter((f) => at(f) !== null).length;
    // The published score must equal the mean of the two group means; a payload
    // that violates it means the upstream changed shape and the board says so
    // instead of printing a number it can no longer explain.
    const invariant =
      all !== null && ma !== null && osc !== null && Math.abs(all - (ma + osc) / 2) < WIN;
    return {
      tf,
      all,
      ma,
      osc,
      withheld: all === null && ma === null && osc === null,
      netMa: recoverNet(ma, maPresent || MOVING_AVERAGES.length),
      netOsc: recoverNet(osc, OSCILLATORS.length),
      maPresent,
      invariant,
      values,
    };
  });
  return { instrument, reads };
}

/** Shape a whole scanner response: rows keyed by the ticker the upstream echoed. */
export function shapeBoard(
  rows: { symbol: string; cells: Record<string, number | null> }[],
  instruments: Instrument[],
  tfs: Timeframe[],
  meta: { fetchedAt: string; source: string },
): BoardPayload {
  const byTv = new Map(rows.map((r) => [r.symbol, r.cells]));
  const present: InstrumentRead[] = [];
  const missing: string[] = [];
  for (const inst of instruments) {
    const cells = byTv.get(inst.tv);
    if (!cells) {
      missing.push(inst.id);
      continue;
    }
    present.push(shapeInstrument(inst, cells, tfs));
  }
  return { fetchedAt: meta.fetchedAt, source: meta.source, instruments: present, missing };
}

/** The fields a value cell is allowed to be flagged against — arithmetic only. */
export function aboveBelow(close: number | null, level: number | null): 'above' | 'below' | null {
  if (close === null || level === null) return null;
  if (close > level) return 'above';
  if (close < level) return 'below';
  return null;
}
