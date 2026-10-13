import type { Metadata } from 'next';
import '@/app/(frontend)/globals.css';
import { Navbar } from '@/ui/navbar';
import { Breadcrumb } from '@/ui/breadcrumb';
import { LocaleProvider } from '@/lib/i18n/t';
import { DEFAULT_LOCALE } from '@/lib/i18n/index';
import { megaMenu } from './mega-menu';

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

/**
 * The root layout is SYNCHRONOUS on purpose. The locale is client state, not a
 * server read: reading `cookies()` here would mark the whole tree dynamic and
 * 500 every page that still declares ISR (measured 2026-10-13 — /market/crypto/BTC,
 * /trade/spot/btc-usdt, /economy/nation/USA returned DYNAMIC_SERVER_USAGE).
 *
 * The server therefore renders `lang="en"` + a `<LocaleProvider>` seeded with the
 * default; on mount the provider reads the `fc-locale` cookie and switches, and
 * the switcher in the navbar writes the cookie + updates the SAME state. The
 * first paint is always en — the same trade the theme toggle already makes (its
 * inline script mutates the DOM before hydration and React never sees a
 * conflicting render), and the tree stays static/ISR so the public HTML keeps
 * its `s-maxage=300` cacheability.
 *
 * `lang` is rewritten from the cookie by the inline script below, before React
 * hydrates — the same pre-hydration pattern the theme toggle uses — so the
 * served attribute and the visible chrome agree for a returning visitor.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={DEFAULT_LOCALE}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){var t=localStorage.getItem('theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.classList.toggle('dark',t==='dark');})();",
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var m=(document.cookie.match(/(?:^|;)\\s*fc-locale=([^;]+)/)||[])[1];if(m&&['en','id','zh'].indexOf(m)>=0){document.documentElement.lang=m;}}catch(e){}})();",
          }}
        />
      </head>
      <body>
        <LocaleProvider>
          <Navbar mega={megaMenu()} />
          <Breadcrumb origin={ORIGIN} />
          <div id="main-content" tabIndex={-1} className="fc-route-enter">{children}</div>
        </LocaleProvider>
      </body>
    </html>
  );
}