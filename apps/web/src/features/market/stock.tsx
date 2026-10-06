'use client';
import { Banner } from '@/ui/banner';
import QuoteBoard from '@/features/market/quote-board';
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

const TITLE: Record<StockRegion, string> = {
  us: 'Stock — US indices & mega-caps',
  asia: 'Stock — Asia indices & blue chips',
  europe: 'Stock — Europe indices & blue chips',
};
/**
 * Stock section: one Yahoo board per region (US / Asia / Europe).
 *
 * `region` is prop-typed `StockRegion`, but the section tables that feed it are
 * `string`-valued, so an index miss at runtime is possible. The house `Banner` is the
 * loud fallback — an honest error chrome beats rendering `title` undefined. The previous
 * shape dereferenced the record and would have thrown mid-render instead.
 */
export default function StockBoard({ region }: { region: StockRegion }) {
  const title = TITLE[region];
  if (!title) {
    return <Banner variant="error">{`market hub: unknown stock region '${region}'`}</Banner>;
  }
  return (
    <QuoteBoard
      endpoint={`/api/market/stock?region=${region}`}
      title={title}
      unitHint="Yahoo Finance · one chart call per symbol"
    />
  );
}
