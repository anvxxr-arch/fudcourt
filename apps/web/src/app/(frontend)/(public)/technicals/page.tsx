import type { Metadata } from 'next';
import StoreShell from '@/features/overview/store-shell';

// The house contract for a public board: time-revalidated, never request-time
// (`tests/server-cache-tests.ts` asserts this exact value on every board page).
export const revalidate = 300;

const TITLE = 'Technicals — the summary, per timeframe | FUDCOURT';
const DESCRIPTION =
  'TradingView-style technical summaries read from the screener its own technicals page uses: the score per timeframe, the oscillator and moving-average means behind it, and every indicator value verbatim. A score that disagrees with its own parts is flagged, and the upstream withholding a timeframe is stated rather than filled in with zeros.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/technicals' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/technicals', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};

export default function TechnicalsRoute() {
  return <StoreShell initialPage="technicals" />;
}
