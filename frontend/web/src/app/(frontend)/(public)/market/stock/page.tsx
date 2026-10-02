import StoreShell from '@/components/layout/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Stock — Equities | FUDCOURT',
  description: 'Stock section of the FUDCOURT market hub. No equity source is connected yet.',
};

export default function MarketStockRoute() {
  return <StoreShell initialPage="market-stock" />;
}
