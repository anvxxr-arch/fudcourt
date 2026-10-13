import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Stock — Equities | FUDCOURT',
  description: 'Stock section of the FUDCOURT market hub — US, Asia and Europe indices and blue chips from Yahoo Finance.',
};

export default function MarketStockRoute() {
  return <StoreShell initialPage="market-stock" />;
}
