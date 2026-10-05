import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TradeInstrument } from '@/features/trade/ui/instrument';
import { isInstrumentId, instrumentLabel } from '@/features/trade/instrument';
import { MARKET_TYPE_BY_ID, isMarketType } from '@/features/trade/taxonomy';

/**
 * An instrument is a route parameter, so the title is per-instrument. It is
 * built from the registry and rendered as plain text, never interpreted.
 * Existence is decided by the two allowlist checks in the route below.
 */
export async function generateMetadata({ params }: { params: Promise<{ marketType: string; instrument: string }> }): Promise<Metadata> {
  const { marketType, instrument } = await params;
  const rawType = marketType ?? '';
  const rawInstrument = instrument ?? '';
  if (!isMarketType(rawType) || !isInstrumentId(rawInstrument)) {
    return { title: 'Unknown instrument | FUDCOURT' };
  }
  const label = instrumentLabel(rawInstrument);
  return {
    title: `${label} — ${MARKET_TYPE_BY_ID[rawType].label} trading | FUDCOURT`,
    description: `Cross-venue quotes for ${label} on ${MARKET_TYPE_BY_ID[rawType].label}, with the FUDCourt composer to preview and place the trade.`,
  };
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * `/trade/<marketType>/<instrument>` — the canonical instrument page (plan
 * Phase 1). The market type is the route segment and the instrument its child:
 * `/trade/spot/btc-usdt`, never `/trade/binance/btc-usdt` (a venue is not a
 * route segment). Both segments are checked against a bounded allowlist — the
 * taxonomy for the market type, the instrument registry for the id — so a market
 * type or instrument we cannot address is a REAL 404, not a 200 that renders an
 * empty page for an indexable URL. This is the same rule the ticker detail route
 * keeps.
 */
export default async function TradeInstrumentRoute({ params }: { params: Promise<{ marketType: string; instrument: string }> }) {
  const { marketType, instrument } = await params;
  const rawType = marketType ?? '';
  const rawInstrument = instrument ?? '';
  if (!isMarketType(rawType) || !isInstrumentId(rawInstrument)) notFound();
  return <TradeInstrument marketType={rawType} instrumentId={rawInstrument} />;
}
