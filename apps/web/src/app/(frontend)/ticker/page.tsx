import StoreShell from '@/shell/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Ticker — CEX spot, perpetual, future & option prices | FUDCOURT',
  description:
    'Cross-checked prices for centralized-exchange instruments: spot, perpetual, dated future and option, each relayed directly from the venues rather than from an aggregator.',
};

export default function TickerRoute() {
  return <StoreShell initialPage="ticker" />;
}
