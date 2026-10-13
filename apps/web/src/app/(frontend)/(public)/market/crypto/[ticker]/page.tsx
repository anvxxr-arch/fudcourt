import TickerDetailPage from '@/features/market/ticker/detail';
import { notFound } from 'next/navigation';
import { TICKER_COIN } from '@/features/market/ticker/client';
import type { Metadata } from 'next';
/**
 * One coin's detail view, nested under the crypto board it belongs to.
 *
 * The route used to live at `/market/ticker/[ticker]`, a sibling namespace
 * that `/market/ticker` itself redirected away from — so reaching a coin cost
 * a redirect hop and the board and the detail page were in different parts of
 * the tree. It now sits directly under `/market/crypto`, which is where the
 * board's rows already linked to.
 */
export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }): Promise<Metadata> {
  const { ticker } = await params;
  const coin = (ticker ?? '').toUpperCase();
  return {
    title: `${coin || 'Coin'} — spot, perp, future & option | FUDCOURT`,
    description: `Cross-checked ${coin || 'coin'} prices across centralized exchanges for spot, perpetual, dated future and option instruments.`,
  };
}

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
export default async function TickerDetailRoute({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  // A coin we do not quote must be a real 404, not a 200 that renders an error
  // table. Without this, /market/crypto/FOO is an indexable page whose own
  // /api/ticker/instruments call rejects it with 404 unknown_symbol — the page
  // and its API disagreed about what exists.
  //
  // MEASURED 2026-10-06: `notFound()` DOES fire and the (frontend)/not-found
  // boundary renders ("NOT FOUND — this route does not exist"), but Next
  // 16.3.6 answers the request with HTTP 200, not 404. This is not specific to
  // this route: /blog/<unknown-slug>, /economy/nation/ZZ and /trade/notatype
  // all behave the same way, so it is an app-wide characteristic of this Next
  // version rather than a defect this route introduced. The body is a correct
  // 404 page; only the status line is wrong.
  if (!TICKER_COIN[(ticker ?? '').toUpperCase()]) notFound();
  return <TickerDetailPage />;
}
