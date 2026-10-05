import IndicatorExplorer from '@/features/economy/ui/indicator';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Indicators — Canonical economic series | FUDCOURT',
  description:
    'Browse every canonical economic series by category, country, frequency and source. Each row is one upstream binding behind a stable slug.',
};

/** The indicator explorer (plan Phase 6). */
export default function EconomyIndicatorIndexRoute() {
  return <IndicatorExplorer />;
}
