import type { Metadata } from 'next';
import '@/app/(frontend)/globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://fc.dwirijal.my.id'),
  title: 'FUDCOURT',
  description: 'Community, terminal, and management — verified crypto market intelligence and cross-chain treasury accounting.',
  openGraph: {
    title: 'FUDCOURT',
    description: 'Community, terminal, and management — verified crypto market intelligence and cross-chain treasury accounting.',
    url: '/',
    siteName: 'FUDCOURT',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FUDCOURT',
    description: 'Community, terminal, and management — verified crypto market intelligence and cross-chain treasury accounting.',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}