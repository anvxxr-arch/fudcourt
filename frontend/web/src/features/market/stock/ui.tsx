'use client';

import QuoteBoard from '@/features/market/quote-board';

/** Stock section: Yahoo indices + mega-cap equities. */
export default function StockBoard() {
  return (
    <QuoteBoard
      endpoint="/api/market/stock"
      title="Stock — indices & mega-caps"
      unitHint="Yahoo Finance · one chart call per symbol"
    />
  );
}
