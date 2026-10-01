import TickerDetailPage from '@/features/ticker/detail';
import { notFound } from 'next/navigation';
import { TICKER_COIN } from '@/features/ticker/client';
import type { Metadata } from 'next';

/**
 * The coin is a route parameter, so the title is per-coin. It is built from the
 * URL and rendered as plain text, never interpreted. Existence is decided by the
 * allowlist check in the route handler below, not here.
 */
export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }): Promise<Metadata> {
  const { ticker } = await params;
  const coin = (ticker ?? '').toUpperCase();
  return {
    title: `${coin || 'Coin'} — spot, perp, future & option | FUDCOURT`,
    description: `Cross-checked ${coin || 'coin'} prices across centralized exchanges for spot, perpetual, dated future and option instruments.`,
  };
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function TickerDetailRoute({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  // A coin we do not quote must be a real 404, not a 200 that renders an error
  // table. Without this, /ticker/FOO is an indexable page whose own
  // /api/ticker/instruments call rejects it with 404 unknown_symbol — the page
  // and its API disagreed about what exists.
  if (!TICKER_COIN[(ticker ?? '').toUpperCase()]) notFound();
  return <TickerDetailPage />;
}
