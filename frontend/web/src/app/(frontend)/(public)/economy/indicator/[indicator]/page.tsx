import IndicatorDetail from '@/features/economy/ui/indicator';
import { INDICATOR_BY_SLUG } from '@/features/economy/registry';
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

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function EconomyIndicatorRoute({ params }: { params: Promise<{ indicator: string }> }) {
  const { indicator } = await params;
  if (!INDICATOR_BY_SLUG[(indicator ?? '').toLowerCase()]) notFound();
  return <IndicatorDetail slug={(indicator ?? '').toLowerCase()} />;
}
