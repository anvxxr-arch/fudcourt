import NationProfile from '@/features/economy/ui/nation';
import { countryByAnyCode } from '@/features/economy/registry';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

/**
 * A country code is a route parameter, so the title is per-country. It is built
 * from the registry and rendered as plain text, never interpreted. Existence is
 * decided by the allowlist check below — a code we do not cover must be a real
 * 404, not a 200 that renders an error table for an indexable URL.
 */
export async function generateMetadata({ params }: { params: Promise<{ countryCode: string }> }): Promise<Metadata> {
  const { countryCode } = await params;
  const country = countryByAnyCode(countryCode ?? '');
  if (!country) return { title: 'Unknown country | FUDCOURT' };
  return {
    title: `${country.name} — economy, policy rate & government finance | FUDCOURT`,
    description: `${country.name} (${country.iso3}) economy profile: growth, inflation, labour, money, fiscal and trade series, plus the policy rate, normalised to one canonical model.`,
  };
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function EconomyNationRoute({ params }: { params: Promise<{ countryCode: string }> }) {
  const { countryCode } = await params;
  const country = countryByAnyCode(countryCode ?? '');
  if (!country) notFound();
  // The canonical slug is the lowercase alpha-2 code; the profile reads the API by
  // the ISO3 the upstreams are keyed on, so both spellings of the URL reach the
  // same profile and the payload is fetched under one name.
  return <NationProfile code={country.iso3} />;
}
