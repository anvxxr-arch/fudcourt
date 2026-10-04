import type { Metadata } from 'next';
import EconomyDashboard from '@/features/economy/ui/dashboard';

export const metadata: Metadata = {
  title: 'Economy — Global macro dashboard | FUDCOURT',
  description:
    'Global macro dashboard: growth, inflation, labour, money and policy across the major economies, read from FRED, the World Bank and BIS and normalised to one canonical model.',
};

/** The macro module's front door (plan Phase 4). */
export default function EconomyPage() {
  return <EconomyDashboard />;
}
