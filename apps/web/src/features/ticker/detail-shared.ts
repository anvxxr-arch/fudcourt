export type TickerType = 'spot' | 'swap' | 'future' | 'option';

export type TypeSummary = {
  venues: string[];
  expiries: string[];
  /** Strikes keyed by expiry date; the ladder genuinely differs by date. */
  strikesByExpiry: Record<string, number[]>;
  default: { symbol: string; expiry: string | null; strike: number | null; optionKind: string | null } | null;
};

export type InstrumentsEnvelope = {
  symbol: string;
  types: Record<TickerType, TypeSummary>;
  venuesForType: Record<TickerType, string[]>;
  typeLabels: Record<TickerType, string>;
};

export type Instrument = {
  symbol: string;
  type: string;
  settle: string | null;
  expiry: number | null;
  strike: number | null;
  optionKind: 'call' | 'put' | null;
  contractSize: number | null;
};

export type Quote = {
  exchange: string;
  symbol: string;
  /**
   * What this venue's price is denominated in. Venues list the same contract
   * in different units — OKX quotes BTC options coin-margined, Bybit quotes
   * them USDT-settled — so the unit belongs to the quote, not to the coin.
   */
  settle: string | null;
  last: number | null;
  bid: number | null;
  ask: number | null;
  baseVolume: number | null;
  quoteVolume: number | null;
  high24h: number | null;
  low24h: number | null;
  change24h: number | null;
  openInterest: number | null;
  fundingRate: number | null;
  at: number | null;
  error: string | null;
};

export type QuoteEnvelope = {
  base: string;
  type: TickerType;
  instruments: Instrument[];
  settlements: string[];
  quotes: Quote[];
  price: number | null;
  notListed: string[];
  failed: string[];
};

export const TYPES: TickerType[] = ['spot', 'swap', 'future', 'option'];
