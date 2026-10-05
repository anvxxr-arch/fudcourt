import CentralBankIndex from '@/features/economy/ui/central-bank';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Central banks — Policy rates | FUDCOURT',
  description:
    'Policy rates for the major central banks, from BIS WS_CBPOL: level, last move and history, grouped by region.',
};

/** The central-bank index (plan Phase 7). */
export default function EconomyCentralBankIndexRoute() {
  return <CentralBankIndex />;
}
