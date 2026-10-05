import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Trench — DEX pairs & live trench | FUDCOURT',
  description:
    'On-chain DEX section: per-pair liquidity, transactions and FDV, plus the live trench, from DexScreener.',
};

export default function MarketTrenchRoute() {
  return <StoreShell initialPage="market-trench" />;
}
