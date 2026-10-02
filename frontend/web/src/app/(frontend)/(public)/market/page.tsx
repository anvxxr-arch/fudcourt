import StoreShell from '@/components/layout/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Market — Crypto, forex, commodity, stock & DEX | FUDCOURT',
  description:
    'The FUDCOURT market hub: cross-checked centralized-exchange instruments, on-chain DEX pairs, and per-asset-class sections for crypto, forex, commodity and stock.',
};

export default function MarketRoute() {
  return <StoreShell initialPage="market" />;
}
