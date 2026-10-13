import type { Metadata } from 'next';
import { TradeAccountsPage } from '@/features/trade/ui/accounts';

export const metadata: Metadata = {
  title: 'Trade accounts — Connected venues | FUDCOURT',
  description:
    'Every venue your trading connects to: the masked API key, the permission the venue reports, and the order types each venue supports — with a withdrawal-capable key warned, never hidden.',
};

// Request-time on purpose: this is the connected-venue surface. Its data is the
// per-account masked API key and the permissions each venue reports, so there is
// no shared snapshot a cache could hold — it is request-time by construction.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The connected-account surface (plan Phase 17). */
export default function TradeAccountsRoute() {
  return <TradeAccountsPage />;
}
