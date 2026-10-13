import { IndicatorDetail } from '@/features/economy/ui/indicator';
import { INDICATOR_BY_SLUG } from '@/features/economy/model';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

/**
 * A slug is a route parameter, so the title is per-series. Existence is decided
 * by the registry lookup below — an unknown slug must be a real 404, not a 200
 * that renders an empty chart for an indexable URL.
 */
export async function generateMetadata({ params }: { params: Promise<{ indicator: string }> }): Promise<Metadata> {
  const { indicator } = await params;
  const meta = INDICATOR_BY_SLUG[(indicator ?? '').toLowerCase()];
  if (!meta) return { title: 'Unknown indicator | FUDCOURT' };
  return {
    title: `${meta.name} — ${meta.frequency} series | FUDCOURT`,
    description: `${meta.name} (${meta.slug}): ${meta.category}/${meta.subcategory}, ${meta.frequency}, source ${meta.source}. History, latest value and release detail.`,
  };
}


/**
 * ISR, not request-time: the param space is unbounded (every coin, every
 * market type/instrument, every country/bank/indicator the registry knows),
 * so this route cannot be pre-rendered to a fixed list. `dynamicParams = true`
 * lets Next render unknown slugs on demand while still caching the ones it has
 * already built, and `revalidate = 300` renews them. The shell is static — the
 * root layout no longer reads the cookie server-side, so the whole public tree
 * stays cacheable and only this param space is served on demand.
 */
export async function generateStaticParams() {
  return [];
}
export const dynamicParams = true;
export const revalidate = 300;
export default async function EconomyIndicatorRoute({ params }: { params: Promise<{ indicator: string }> }) {
  const { indicator } = await params;
  if (!INDICATOR_BY_SLUG[(indicator ?? '').toLowerCase()]) notFound();
  return <IndicatorDetail slug={(indicator ?? '').toLowerCase()} />;
}
