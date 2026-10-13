import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Forex — Currency pairs | FUDCOURT',
  description: 'Forex section of the FUDCOURT market hub — curated major pairs from the exchangerate-api free feed.',
};

export default function MarketForexRoute() {
  return <StoreShell initialPage="market-forex" />;
}
