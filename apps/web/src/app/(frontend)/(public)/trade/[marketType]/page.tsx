import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import TradeDashboard from '@/features/trade/ui/dashboard';
import { MARKET_TYPE_BY_ID, isMarketType } from '@/features/trade/model';

/**
 * A market type is a route parameter, so the title is per-type. It is built from
 * the taxonomy and rendered as plain text, never interpreted. Existence is
 * decided by the allowlist check in the route below — a market type we do not
 * have must be a real 404, not a 200 that renders an empty board for an
 * indexable URL. This is the same rule the ticker detail route keeps.
 */
export async function generateMetadata({ params }: { params: Promise<{ marketType: string }> }): Promise<Metadata> {
  const { marketType } = await params;
  const raw = marketType ?? '';
  if (!isMarketType(raw)) return { title: 'Unknown market type | FUDCOURT' };
  return {
    title: `${MARKET_TYPE_BY_ID[raw].label} — trading | FUDCOURT`,
    description: MARKET_TYPE_BY_ID[raw].note,
  };
}

/**
 * `/trade/<marketType>` — one board per market type (plan Phase 1).
 *
 * The route segment IS the market type and never a venue: `/trade/perpetual`
 * is a page, `/trade/binance` is not. A venue is where an order executes, not
 * what is traded, and making it structural would force a second copy of every
 * market type under every venue.
 */

/**
 * ISR, not request-time: the param space is unbounded (every coin, every
 * market type/instrument, every country/bank/indicator the registry knows),
 * so this route cannot be pre-rendered to a fixed list. `dynamicParams = true`
 * lets Next render unknown slugs on demand while still caching the ones it has
 * already built, and `revalidate = 300` renews them. The shell is static — the
 * root layout no longer reads the cookie server-side, so the whole public tree
 * stays cacheable and only this param space is served on demand.
 */
export async function generateStaticParams() {
  return [];
}
export const dynamicParams = true;
export const revalidate = 300;
export default async function TradeMarketTypeRoute({ params }: { params: Promise<{ marketType: string }> }) {
  const { marketType } = await params;
  const raw = marketType ?? '';
  if (!isMarketType(raw)) notFound();
  return <TradeDashboard marketType={raw} />;
}
