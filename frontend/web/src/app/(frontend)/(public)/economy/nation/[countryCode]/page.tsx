import NationBoard from '@/features/market/nation/ui';
import { nationByCode } from '@/features/market/nation/client';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

/**
 * A country code is a route parameter, so the title is per-country. It is built
 * from the URL and rendered as plain text, never interpreted. Existence is
 * decided by the allowlist check below, not here — a code we do not cover must
 * be a real 404, not a 200 that renders an error table for an indexable URL.
 */
export async function generateMetadata({ params }: { params: Promise<{ countryCode: string }> }): Promise<Metadata> {
  const { countryCode } = await params;
  const nation = nationByCode(countryCode ?? '');
  if (!nation) return { title: 'Unknown country | FUDCOURT' };
  return {
    title: `${nation.name} — economy, government finance & policy rate | FUDCOURT`,
    description: `${nation.name} (${nation.code}) economy profile: World Bank structural indicators, IMF Fiscal Monitor government finance, the policy rate, and the ${nation.currency} against the dollar.`,
  };
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function EconomyNationRoute({ params }: { params: Promise<{ countryCode: string }> }) {
  const { countryCode } = await params;
  const nation = nationByCode(countryCode ?? '');
  if (!nation) notFound();
  // The canonical slug is the lowercase alpha-2 code; the board reads the API by
  // the ISO3 the upstreams are keyed on, so both spellings of the URL reach the
  // same profile and the payload is fetched under one name.
  return <NationBoard code={nation.code} />;
}
