import type { Metadata } from 'next';
import EconomyDashboard from '@/features/economy/ui/dashboard';
import { loadEconomyBoards } from '@/features/economy/server-boards';
// This was the FIRST page to leave request-time rendering and it is the template
// the rest of the public boards were converted to. It no longer ships an empty
// client shell: the boards are read at build (`loadEconomyBoards`) so the served
// HTML carries the figures and the cards never grow under the reader. The
// `revalidate` window is what keeps those figures fresh — a build-time read, not
// a request-time one, because the upstreams are slow (see server-boards.ts). The
// export is spelled out rather than left to the default so the intent is legible
// here; `/sitemap.xml` keeps its own, longer 3600s window because posts change
// rarely.
export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Global Macro Dashboard: Growth, Inflation, Money & Policy',
  description:
    'FudCourt macro dashboard: growth, inflation, labour, money and policy across major economies, read from FRED, the World Bank and BIS into one canonical model.',
  alternates: { canonical: '/economy' },
  openGraph: {
    title: 'Global Macro Dashboard: Growth, Inflation, Money & Policy',
    description: 'Growth, inflation, labour, money and policy across major economies — one canonical macro model from FRED, World Bank and BIS.',
    url: '/economy',
    siteName: 'FUDCOURT',
    type: 'website',
    images: ['/og-cover.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Global Macro Dashboard: Growth, Inflation, Money & Policy',
    description: 'Growth, inflation, labour, money and policy across major economies — one canonical macro model from FRED, World Bank and BIS.',
    images: ['/og-cover.png'],
  },
};

/** The macro module's front door (plan Phase 4). */
export default async function EconomyPage() {
  // Read the five boards at BUILD (and on each background revalidation), so the
  // served HTML already carries the figures and the prerendered shell is no
  // longer a set of `Loading` placeholders that grow when the client data lands.
  // See `server-boards.ts` for why this runs at build rather than per request
  // (a single FRED series takes ~4s here; request-time reads would push TTFB
  // past 10s). A board that cannot be read comes back null and is fetched on the
  // client instead, so the page degrades to its old behaviour rather than
  // baking an error state.
  const boards = await loadEconomyBoards();
  return <EconomyDashboard initial={boards} />;
}
