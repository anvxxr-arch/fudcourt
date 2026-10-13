'use client';
import { Banner } from '@/ui/banner';
import QuoteBoard from '@/features/market/quote-board';
import { useT } from '@/lib/i18n/t';
import type { StockRegion } from './stock-regions';

/**
 * Stock board UI (client) — pure region data lives in './stock-regions'
 * (server-safe; the API route imports from there, never from this module).
 */
export {
  DEFAULT_STOCK_REGION,
  STOCK_LABELS,
  STOCK_REGIONS,
  STOCK_SYMBOLS,
  STOCK_TTL_MS,
  isStockRegion,
} from './stock-regions';
export type { StockRegion } from './stock-regions';

const TITLE_KEYS = {
  us: 'market.stockTitleUs',
  asia: 'market.stockTitleAsia',
  europe: 'market.stockTitleEurope',
} as const;
/**
 * Stock section: one Yahoo board per region (US / Asia / Europe).
 *
 * `region` is prop-typed `StockRegion`, but the section tables that feed it are
 * `string`-valued, so an index miss at runtime is possible. The house `Banner` is the
 * loud fallback — an honest error chrome beats rendering `title` undefined. The previous
 * shape dereferenced the record and would have thrown mid-render instead.
 */
export default function StockBoard({ region }: { region: StockRegion }) {
  const t = useT();
  const titleKey = TITLE_KEYS[region];
  if (!titleKey) {
    return <Banner variant="error">{t('market.unknownRegion', { region })}</Banner>;
  }
  return (
    <QuoteBoard
      endpoint={`/api/market/stock?region=${region}`}
      title={t(titleKey)}
      unitHint={t('market.stockHint')}
    />
  );
}
