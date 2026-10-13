import CompareBoard from '@/features/economy/ui/compare';
import type { Metadata } from 'next';

export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Compare — Countries & series | FUDCOURT',
  description:
    'Compare any countries on any measures over one period. The query lives in the URL, so a comparison is shareable without a page per combination.',
};

/** The comparison board (plan Phase 10). */
export default function EconomyCompareRoute() {
  return <CompareBoard />;
}
