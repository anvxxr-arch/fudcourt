import type { Metadata } from 'next';
import { TradeAccountsPage } from '@/features/trade/ui/accounts';

export const metadata: Metadata = {
  title: 'Trade accounts — Connected venues | FUDCOURT',
  description:
    'Every venue your trading connects to: the masked API key, the permission the venue reports, and the order types each venue supports — with a withdrawal-capable key warned, never hidden.',
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The connected-account surface (plan Phase 17). */
export default function TradeAccountsRoute() {
  return <TradeAccountsPage />;
}
