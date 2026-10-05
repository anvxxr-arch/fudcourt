import { CentralBankDetail } from '@/features/economy/ui/central-bank';
import { CENTRAL_BANK_BY_SLUG } from '@/features/economy/model';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

/**
 * A bank slug is a route parameter, so the title is per-bank. Existence is
 * decided by the registry lookup below — an unknown slug must be a real 404.
 */
export async function generateMetadata({ params }: { params: Promise<{ bank: string }> }): Promise<Metadata> {
  const { bank } = await params;
  const meta = CENTRAL_BANK_BY_SLUG[(bank ?? '').toLowerCase()];
  if (!meta) return { title: 'Unknown central bank | FUDCOURT' };
  return {
    title: `${meta.name} — policy rate & decisions | FUDCOURT`,
    description: `${meta.name} (${meta.short}): policy rate, rate history and each level change, from BIS WS_CBPOL.`,
  };
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function EconomyCentralBankRoute({ params }: { params: Promise<{ bank: string }> }) {
  const { bank } = await params;
  if (!CENTRAL_BANK_BY_SLUG[(bank ?? '').toLowerCase()]) notFound();
  return <CentralBankDetail bank={(bank ?? '').toLowerCase()} />;
}
