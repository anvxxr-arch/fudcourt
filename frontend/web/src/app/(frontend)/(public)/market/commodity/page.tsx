import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Commodity — Metals, energy & agriculture | FUDCOURT',
  description: 'Commodity section of the FUDCOURT market hub — front-month metals, energy and agriculture futures from Yahoo Finance.',
};

export default function MarketCommodityRoute() {
  return <StoreShell initialPage="market-commodity" />;
}
