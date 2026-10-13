import NationExplorer from '@/features/economy/ui/nation';
import type { Metadata } from 'next';

export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Nations — Country economy explorer | FUDCOURT',
  description:
    'Explore every economy FUDCOURT covers: growth, inflation, labour, money, fiscal and trade series per country, grouped by region and ranked by depth of coverage.',
};

/** The country explorer (plan Phase 5). */
export default function EconomyNationIndexRoute() {
  return <NationExplorer />;
}
