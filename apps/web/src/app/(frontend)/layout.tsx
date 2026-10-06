import type { Metadata } from 'next';
import '@/app/(frontend)/globals.css';
import { Navbar } from '@/ui/navbar';
import { Breadcrumb } from '@/ui/breadcrumb';

/**
 * The canonical origin, written down ONCE. `metadataBase` and the breadcrumb's
 * `BreadcrumbList` both need it, and two spellings of the same domain is how a
 * structured-data URL drifts from the canonical one.
 */
const ORIGIN = 'https://fc.dwirijal.my.id';

export const metadata: Metadata = {
  metadataBase: new URL(ORIGIN),
  title: 'FUDCOURT',
  description: 'Community, terminal, and management — verified crypto market intelligence and cross-chain treasury accounting.',
  openGraph: {
    title: 'FUDCOURT',
    description: 'Community, terminal, and management — verified crypto market intelligence and cross-chain treasury accounting.',
    url: '/',
    siteName: 'FUDCOURT',
    type: 'website',
    images: ['/og-cover.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FUDCOURT',
    description: 'Community, terminal, and management — verified crypto market intelligence and cross-chain treasury accounting.',
    images: ['/og-cover.png'],
  },
  robots: { index: true, follow: true },
  manifest: '/manifest.json',
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){var t=localStorage.getItem('theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.classList.toggle('dark',t==='dark');})();",
          }}
        />
      </head>
      <body>
        {/* The site chrome: one primary nav, one breadcrumb, on every page.
            Both are client components that read the pathname and are rendered
            into the initial HTML, so the bar and the trail are in the markup a
            crawler receives. */}
        <Navbar />
        <Breadcrumb origin={ORIGIN} />
        <div className="fc-fade-in">{children}</div>
      </body>
    </html>
  );
}