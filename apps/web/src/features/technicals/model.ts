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
  { id: 'crypto', label: 'Crypto', venue: 'TradingView crypto screener (exchange-qualified pairs)' },
  { id: 'stock', label: 'Stocks', venue: 'TradingView global stock screener (US, Asia, Europe)' },
  { id: 'forex', label: 'Forex', venue: 'TradingView forex screener (FX and FX_IDC feeds)' },
  { id: 'commodity', label: 'Commodities', venue: 'TradingView commodity series (TVC, OANDA, FX spot/CFD)' },
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
 * The curated universe: EVERY asset this app tracks — the 30 crypto pairs of
 * `features/trade/model-instruments.ts`, the 65 stocks and indices of
 * `features/market/stock-regions.ts` (US, Asia and Europe), the 12 futures of
 * `features/market/commodity-symbols.ts` and the 16 pairs of
 * `features/market/forex-pairs.ts`.
 *
 * Every `tv` below was RESOLVED BY MEASUREMENT, never by guesswork: each
 * candidate was POSTed to the public screener and kept only when it answered
 * with a numeric `Recommend.All`. The app symbols it could not rate are in
 * `UNRESOLVED` below, with the reason — a symbol the upstream cannot rate is
 * stated, never faked, and never dropped quietly.
 *
 * Crypto uses the exchange-qualified pair rather than the `CRYPTO:BTCUSD`
 * synthetic (the synthetics answer without an aggregate — measured), and where
 * the app's symbol no longer matches the live venue the resolution says so:
 * `MATIC` resolves to `BINANCE:POLUSDT` (the migration), `TON` to
 * `COINBASE:TONUSD`.
 *
 * Commodities were the hard half, and the reason they read CFD/spot series
 * rather than the front months this app tracks: NOT ONE futures contract in the
 * screener carries a technicals aggregate (measured — 0 of 25 rated in every
 * symbol search, including `CBOT:ZC` and `ICEUS:KC`). Each commodity therefore
 * reads the rated series for the SAME underlying, accepted only where the
 * upstream itself calls it one (`type=commodity`: "WTI Oil Future", "Copper",
 * "Soybeans"). A rated but DIFFERENT instrument is refused — `LSE:CRUD` and
 * `AMEX:BNO` are oil ETCs, `AMEX:SOYB` a soybean ETF, `SPARKS:COFFEE` an index
 * of coffee stocks. Coffee has no such series anywhere, so it is `UNRESOLVED`.
 *
 * Ids are registry-local, stable and URL-safe (what `?symbols=` carries) — the
 * upstream ticker is a FIELD, never the identity.
 */
export const INSTRUMENTS: Instrument[] = [
  // --- crypto: 30 ---
  { id: 'btcusdt', label: 'BTC/USDT', tv: 'BINANCE:BTCUSDT', cls: 'crypto' },
  { id: 'ethusdt', label: 'ETH/USDT', tv: 'BINANCE:ETHUSDT', cls: 'crypto' },
  { id: 'solusdt', label: 'SOL/USDT', tv: 'BINANCE:SOLUSDT', cls: 'crypto' },
  { id: 'bnbusdt', label: 'BNB/USDT', tv: 'BINANCE:BNBUSDT', cls: 'crypto' },
  { id: 'xrpusdt', label: 'XRP/USDT', tv: 'BINANCE:XRPUSDT', cls: 'crypto' },
  { id: 'dogeusdt', label: 'DOGE/USDT', tv: 'BINANCE:DOGEUSDT', cls: 'crypto' },
  { id: 'adausdt', label: 'ADA/USDT', tv: 'BINANCE:ADAUSDT', cls: 'crypto' },
  { id: 'avaxusdt', label: 'AVAX/USDT', tv: 'BINANCE:AVAXUSDT', cls: 'crypto' },
  { id: 'linkusdt', label: 'LINK/USDT', tv: 'BINANCE:LINKUSDT', cls: 'crypto' },
  { id: 'dotusdt', label: 'DOT/USDT', tv: 'BINANCE:DOTUSDT', cls: 'crypto' },
  { id: 'maticusdt', label: 'MATIC/USDT', tv: 'BINANCE:POLUSDT', cls: 'crypto' },
  { id: 'ltcusdt', label: 'LTC/USDT', tv: 'BINANCE:LTCUSDT', cls: 'crypto' },
  { id: 'trxusdt', label: 'TRX/USDT', tv: 'BINANCE:TRXUSDT', cls: 'crypto' },
  { id: 'tonusdt', label: 'TON/USDT', tv: 'COINBASE:TONUSD', cls: 'crypto' },
  { id: 'arbusdt', label: 'ARB/USDT', tv: 'BINANCE:ARBUSDT', cls: 'crypto' },
  { id: 'opusdt', label: 'OP/USDT', tv: 'BINANCE:OPUSDT', cls: 'crypto' },
  { id: 'atomusdt', label: 'ATOM/USDT', tv: 'BINANCE:ATOMUSDT', cls: 'crypto' },
  { id: 'nearusdt', label: 'NEAR/USDT', tv: 'BINANCE:NEARUSDT', cls: 'crypto' },
  { id: 'aptusdt', label: 'APT/USDT', tv: 'BINANCE:APTUSDT', cls: 'crypto' },
  { id: 'suiusdt', label: 'SUI/USDT', tv: 'BINANCE:SUIUSDT', cls: 'crypto' },
  { id: 'pepeusdt', label: 'PEPE/USDT', tv: 'BINANCE:PEPEUSDT', cls: 'crypto' },
  { id: 'shibusdt', label: 'SHIB/USDT', tv: 'BINANCE:SHIBUSDT', cls: 'crypto' },
  { id: 'injusdt', label: 'INJ/USDT', tv: 'BINANCE:INJUSDT', cls: 'crypto' },
  { id: 'seiusdt', label: 'SEI/USDT', tv: 'BINANCE:SEIUSDT', cls: 'crypto' },
  { id: 'tiausdt', label: 'TIA/USDT', tv: 'BINANCE:TIAUSDT', cls: 'crypto' },
  { id: 'runeusdt', label: 'RUNE/USDT', tv: 'BINANCE:RUNEUSDT', cls: 'crypto' },
  { id: 'wifusdt', label: 'WIF/USDT', tv: 'BINANCE:WIFUSDT', cls: 'crypto' },
  { id: 'aaveusdt', label: 'AAVE/USDT', tv: 'BINANCE:AAVEUSDT', cls: 'crypto' },
  { id: 'uniusdt', label: 'UNI/USDT', tv: 'BINANCE:UNIUSDT', cls: 'crypto' },
  { id: 'crvusdt', label: 'CRV/USDT', tv: 'BINANCE:CRVUSDT', cls: 'crypto' },
  // --- stock: 65 ---
  { id: 'gspc', label: 'S&P 500', tv: 'SP:SPX', cls: 'stock' },
  { id: 'ixic', label: 'Nasdaq Composite', tv: 'NASDAQ:IXIC', cls: 'stock' },
  { id: 'dji', label: 'Dow Jones Industrial Average', tv: 'DJ:DJI', cls: 'stock' },
  { id: 'rut', label: 'Russell 2000', tv: 'TVC:RUT', cls: 'stock' },
  { id: 'aapl', label: 'Apple', tv: 'NASDAQ:AAPL', cls: 'stock' },
  { id: 'msft', label: 'Microsoft', tv: 'NASDAQ:MSFT', cls: 'stock' },
  { id: 'nvda', label: 'NVIDIA', tv: 'NASDAQ:NVDA', cls: 'stock' },
  { id: 'googl', label: 'Alphabet', tv: 'NASDAQ:GOOGL', cls: 'stock' },
  { id: 'amzn', label: 'Amazon', tv: 'NASDAQ:AMZN', cls: 'stock' },
  { id: 'meta', label: 'Meta Platforms', tv: 'NASDAQ:META', cls: 'stock' },
  { id: 'tsla', label: 'Tesla', tv: 'NASDAQ:TSLA', cls: 'stock' },
  { id: 'avgo', label: 'Broadcom', tv: 'NASDAQ:AVGO', cls: 'stock' },
  { id: 'jpm', label: 'JPMorgan Chase', tv: 'NYSE:JPM', cls: 'stock' },
  { id: 'v', label: 'Visa', tv: 'NYSE:V', cls: 'stock' },
  { id: 'brk-b', label: 'Berkshire Hathaway', tv: 'NYSE:BRK.B', cls: 'stock' },
  { id: 'xom', label: 'Exxon Mobil', tv: 'NYSE:XOM', cls: 'stock' },
  { id: 'jkse', label: 'IDX Composite (IHSG)', tv: 'IDX:COMPOSITE', cls: 'stock' },
  { id: 'n225', label: 'Nikkei 225', tv: 'TVC:NI225', cls: 'stock' },
  { id: 'hsi', label: 'Hang Seng', tv: 'TVC:HSI', cls: 'stock' },
  { id: 'ks11', label: 'KOSPI', tv: 'KRX:KOSPI', cls: 'stock' },
  { id: 'sti', label: 'Straits Times', tv: 'TVC:STI', cls: 'stock' },
  { id: 'bbca.jk', label: 'Bank Central Asia', tv: 'IDX:BBCA', cls: 'stock' },
  { id: 'bbri.jk', label: 'Bank Rakyat Indonesia', tv: 'IDX:BBRI', cls: 'stock' },
  { id: 'bmri.jk', label: 'Bank Mandiri', tv: 'IDX:BMRI', cls: 'stock' },
  { id: 'tlkm.jk', label: 'Telkom Indonesia', tv: 'IDX:TLKM', cls: 'stock' },
  { id: 'asii.jk', label: 'Astra International', tv: 'IDX:ASII', cls: 'stock' },
  { id: 'icbp.jk', label: 'Indofood CBP', tv: 'IDX:ICBP', cls: 'stock' },
  { id: '7203.t', label: 'Toyota Motor', tv: 'TSE:7203', cls: 'stock' },
  { id: '0700.hk', label: 'Tencent Holdings', tv: 'HKEX:700', cls: 'stock' },
  { id: '005930.ks', label: 'Samsung Electronics', tv: 'KRX:005930', cls: 'stock' },
  { id: '2330.tw', label: 'TSMC', tv: 'TWSE:2330', cls: 'stock' },
  { id: '600519.ss', label: 'Kweichow Moutai', tv: 'SSE:600519', cls: 'stock' },
  { id: 'ftse', label: 'FTSE 100', tv: 'TVC:UKX', cls: 'stock' },
  { id: 'gdaxi', label: 'DAX', tv: 'XETR:DAX', cls: 'stock' },
  { id: 'fchi', label: 'CAC 40', tv: 'TVC:CAC40', cls: 'stock' },
  { id: 'stoxx50e', label: 'EURO STOXX 50', tv: 'TVC:SX5E', cls: 'stock' },
  { id: 'ibex', label: 'IBEX 35', tv: 'BME:IBC', cls: 'stock' },
  { id: 'aex', label: 'AEX', tv: 'EURONEXT:AEX', cls: 'stock' },
  { id: 'ssmi', label: 'SMI', tv: 'SIX:SMI', cls: 'stock' },
  { id: 'bfx', label: 'BEL 20', tv: 'EURONEXT:BEL20', cls: 'stock' },
  { id: 'omx', label: 'OMX Stockholm 30', tv: 'OMXSTO:OMXS30', cls: 'stock' },
  { id: 'shel.l', label: 'Shell', tv: 'LSE:SHEL', cls: 'stock' },
  { id: 'azn.l', label: 'AstraZeneca', tv: 'LSE:AZN', cls: 'stock' },
  { id: 'hsba.l', label: 'HSBC Holdings', tv: 'LSE:HSBA', cls: 'stock' },
  { id: 'ulvr.l', label: 'Unilever', tv: 'LSE:ULVR', cls: 'stock' },
  { id: 'mc.pa', label: 'LVMH', tv: 'EURONEXT:MC', cls: 'stock' },
  { id: 'or.pa', label: "L'Oréal", tv: 'EURONEXT:OR', cls: 'stock' },
  { id: 'tte.pa', label: 'TotalEnergies', tv: 'EURONEXT:TTE', cls: 'stock' },
  { id: 'sap.de', label: 'SAP', tv: 'XETR:SAP', cls: 'stock' },
  { id: 'sie.de', label: 'Siemens', tv: 'XETR:SIE', cls: 'stock' },
  { id: 'alv.de', label: 'Allianz', tv: 'XETR:ALV', cls: 'stock' },
  { id: 'asml.as', label: 'ASML Holding', tv: 'EURONEXT:ASML', cls: 'stock' },
  { id: 'adyen.as', label: 'Adyen', tv: 'EURONEXT:ADYEN', cls: 'stock' },
  { id: 'san.mc', label: 'Banco Santander', tv: 'BME:SAN', cls: 'stock' },
  { id: 'itx.mc', label: 'Inditex', tv: 'BME:ITX', cls: 'stock' },
  { id: 'eni.mi', label: 'Eni', tv: 'MIL:ENI', cls: 'stock' },
  { id: 'galp.ls', label: 'Galp Energia', tv: 'EURONEXT:GALP', cls: 'stock' },
  { id: 'nesn.sw', label: 'Nestlé', tv: 'SIX:NESN', cls: 'stock' },
  { id: 'novn.sw', label: 'Novartis', tv: 'SIX:NOVN', cls: 'stock' },
  { id: 'ubsg.sw', label: 'UBS Group', tv: 'SIX:UBSG', cls: 'stock' },
  { id: 'novo-b.co', label: 'Novo Nordisk', tv: 'OMXCOP:NOVO_B', cls: 'stock' },
  { id: 'eric-b.st', label: 'Ericsson', tv: 'OMXSTO:ERIC_B', cls: 'stock' },
  { id: 'nokia.he', label: 'Nokia', tv: 'OMXHEX:NOKIA', cls: 'stock' },
  // --- forex: 16 ---
  { id: 'eurusd', label: 'EUR/USD', tv: 'FX:EURUSD', cls: 'forex' },
  { id: 'gbpusd', label: 'GBP/USD', tv: 'FX:GBPUSD', cls: 'forex' },
  { id: 'audusd', label: 'AUD/USD', tv: 'FX:AUDUSD', cls: 'forex' },
  { id: 'nzdusd', label: 'NZD/USD', tv: 'FX:NZDUSD', cls: 'forex' },
  { id: 'usdjpy', label: 'USD/JPY', tv: 'FX:USDJPY', cls: 'forex' },
  { id: 'usdchf', label: 'USD/CHF', tv: 'FX:USDCHF', cls: 'forex' },
  { id: 'usdcad', label: 'USD/CAD', tv: 'FX:USDCAD', cls: 'forex' },
  { id: 'usdcny', label: 'USD/CNY', tv: 'FX_IDC:USDCNY', cls: 'forex' },
  { id: 'usdsgd', label: 'USD/SGD', tv: 'FX_IDC:USDSGD', cls: 'forex' },
  { id: 'usdhkd', label: 'USD/HKD', tv: 'FX:USDHKD', cls: 'forex' },
  { id: 'usdidr', label: 'USD/IDR', tv: 'FX_IDC:USDIDR', cls: 'forex' },
  { id: 'usdmyr', label: 'USD/MYR', tv: 'FX_IDC:USDMYR', cls: 'forex' },
  { id: 'usdthb', label: 'USD/THB', tv: 'FX_IDC:USDTHB', cls: 'forex' },
  { id: 'usdphp', label: 'USD/PHP', tv: 'FX_IDC:USDPHP', cls: 'forex' },
  { id: 'usdinr', label: 'USD/INR', tv: 'FX:USDINR', cls: 'forex' },
  { id: 'usdkrw', label: 'USD/KRW', tv: 'FX:USDKRW', cls: 'forex' },
  // --- commodity: 11 --- rated series only; the front months carry no
  // aggregate at all (measured 0/25), so each row reads the rated series
  // for the same underlying. Coffee is in UNRESOLVED: nothing rates it.
  { id: 'gold', label: 'Gold', tv: 'TVC:GOLD', cls: 'commodity' },
  { id: 'silver', label: 'Silver', tv: 'TVC:SILVER', cls: 'commodity' },
  { id: 'copper', label: 'Copper', tv: 'OANDA:XCUUSD', cls: 'commodity' },
  { id: 'platinum', label: 'Platinum', tv: 'TVC:PLATINUM', cls: 'commodity' },
  { id: 'crudewti', label: 'Crude WTI', tv: 'FX:USOIL', cls: 'commodity' },
  { id: 'brent', label: 'Brent', tv: 'FX:UKOIL', cls: 'commodity' },
  { id: 'naturalgas', label: 'Natural Gas', tv: 'OANDA:NATGASUSD', cls: 'commodity' },
  { id: 'corn', label: 'Corn', tv: 'OANDA:CORNUSD', cls: 'commodity' },
  { id: 'wheat', label: 'Wheat', tv: 'OANDA:WHEATUSD', cls: 'commodity' },
  { id: 'soybeans', label: 'Soybeans', tv: 'OANDA:SOYBNUSD', cls: 'commodity' },
  { id: 'sugar11', label: 'Sugar #11', tv: 'OANDA:SUGARUSD', cls: 'commodity' },
];

/**
 * The app assets the public screener could not rate. Measured, not assumed:
 * these are the ONLY two of the 65 stocks whose every candidate ticker answered
 * without a `Recommend.All`, so the board states them instead of rendering a row
 * of dashes or dropping them silently.
 */
export const UNRESOLVED: readonly { id: string; label: string; cls: AssetClass }[] = [
  { id: 'twii', label: 'Taiwan Weighted', cls: 'stock' },
  { id: 'axjo', label: 'S&P/ASX 200', cls: 'stock' },
  // Coffee: ICEUS:KC1! is unrated like every other front month, and no rated
  // series for the same underlying exists — the only "coffee" the screener rates
  // is SPARKS:COFFEE, an INDEX of coffee companies, which is a different asset.
  { id: 'coffee', label: 'Coffee', cls: 'commodity' },
];

/** The instruments of one asset class, in registry order. */
export function byClass(cls: AssetClass): Instrument[] {
  return INSTRUMENTS.filter((i) => i.cls === cls);
}

/** Per-class counts, so the switcher states its own size instead of implying it. */
export function classCounts(): Record<AssetClass, number> {
  const out = {} as Record<AssetClass, number>;
  for (const cls of ASSET_CLASSES) out[cls.id] = 0;
  for (const i of INSTRUMENTS) out[i.cls] += 1;
  return out;
}
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
