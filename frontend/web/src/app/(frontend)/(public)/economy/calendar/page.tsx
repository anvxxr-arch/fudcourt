import EconomyCalendar from '@/features/economy/ui/calendar';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Economic calendar — Release log | FUDCOURT',
  description:
    'A release log of market-moving economic series by reference period, filterable by country, category and date.',
};

/** The release log (plan Phase 8). */
export default function EconomyCalendarRoute() {
  return <EconomyCalendar />;
}
