'use client';
import QuoteBoard from '@/features/market/quote-board';
/**
 * Commodity board UI (client) — pure symbol data lives in
 * './commodity-symbols' (server-safe; the API route imports from there, never
 * from this module).
 */
export {
  COMMODITIES,
  COMMODITY_LABELS,
  COMMODITY_SYMBOLS,
  COMMODITY_TTL_MS,
} from './commodity-symbols';
export type { CommodityGroup, CommoditySpec } from './commodity-symbols';
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
