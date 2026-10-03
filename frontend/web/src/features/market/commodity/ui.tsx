'use client';

import QuoteBoard from '@/features/market/quote-board';

/** Commodity section: front-month futures (metals, energy, agriculture). */
export default function CommodityBoard() {
  return (
    <QuoteBoard
      endpoint="/api/market/commodity"
      title="Commodity — futures"
      unitHint="front-month · Yahoo Finance"
    />
  );
}
