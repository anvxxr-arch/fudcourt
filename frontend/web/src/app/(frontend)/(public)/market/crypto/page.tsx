import StoreShell from '@/components/layout/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Crypto — CEX instruments & prices | FUDCOURT',
  description:
    'Crypto market section: spot, perpetual, dated future and option instruments cross-checked across centralized exchanges, plus a top-250 market-cap board.',
};

export default function MarketCryptoRoute() {
  return <StoreShell initialPage="market-crypto" />;
}
