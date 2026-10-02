/**
 * Stock family (keyless, public) -- the contract behind the /market/stock
 * section.
 *
 * One Yahoo Finance chart call per symbol (the batch quote endpoint answers 401
 * without a crumb -- see features/market/quotes.ts). The symbol list is a fixed,
 * explicit allowlist -- indices first, then mega-caps -- never a crawl, so the
 * board is a bounded, known set rather than "whatever the provider felt like".
 */
import { QUOTE_TTL_MS } from '@/features/market/quotes';

export const STOCK_SYMBOLS = [
  '^GSPC', '^IXIC', '^DJI', '^RUT',
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO',
  'JPM', 'V', 'BRK-B', 'XOM',
] as const;

export type StockSymbol = (typeof STOCK_SYMBOLS)[number];

/** Shown when Yahoo returns only the raw symbol for a name. */
export const STOCK_LABELS: Readonly<Record<string, string>> = {
  '^GSPC': 'S&P 500',
  '^IXIC': 'Nasdaq Composite',
  '^DJI': 'Dow Jones Industrial Average',
  '^RUT': 'Russell 2000',
  AAPL: 'Apple',
  MSFT: 'Microsoft',
  NVDA: 'NVIDIA',
  GOOGL: 'Alphabet',
  AMZN: 'Amazon',
  META: 'Meta Platforms',
  TSLA: 'Tesla',
  AVGO: 'Broadcom',
  JPM: 'JPMorgan Chase',
  V: 'Visa',
  'BRK-B': 'Berkshire Hathaway',
  XOM: 'Exxon Mobil',
};

export const STOCK_TTL_MS = QUOTE_TTL_MS;
