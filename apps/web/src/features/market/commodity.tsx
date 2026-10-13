'use client';
import QuoteBoard from '@/features/market/quote-board';
import { useT } from '@/lib/i18n/t';
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
  const t = useT();
  return (
    <QuoteBoard
      endpoint="/api/market/commodity"
      title={t('market.commodityTitle')}
      unitHint={t('market.commodityHint')}
    />
  );
}
