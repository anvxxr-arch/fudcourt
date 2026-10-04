import NationIndex from '@/features/market/nation/index-list';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Economy by nation — 125 economies | FUDCOURT',
  description:
    'Per-country economy profiles: World Bank structural indicators, IMF Fiscal Monitor government finance, the central-bank policy rate and the currency against the dollar.',
};

export default function EconomyNationIndexRoute() {
  return <NationIndex />;
}
