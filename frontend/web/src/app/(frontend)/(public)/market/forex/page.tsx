import StoreShell from '@/components/layout/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Forex — Currency pairs | FUDCOURT',
  description: 'Forex section of the FUDCOURT market hub. No currency-pair source is connected yet.',
};

export default function MarketForexRoute() {
  return <StoreShell initialPage="market-forex" />;
}
