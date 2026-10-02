'use client';

import QuoteBoard from '@/features/market/quote-board';
import type { StockRegion } from '@/features/market/stock/client';

const TITLE: Record<StockRegion, string> = {
  us: 'Stock — US indices & mega-caps',
  asia: 'Stock — Asia indices & blue chips',
};

/** Stock section: one Yahoo board per region (US / Asia). */
export default function StockBoard({ region }: { region: StockRegion }) {
  return (
    <QuoteBoard
      endpoint={`/api/market/stock?region=${region}`}
      title={TITLE[region]}
      unitHint="Yahoo Finance · one chart call per symbol"
    />
  );
}
