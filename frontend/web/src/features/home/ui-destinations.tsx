'use client';
import Link from 'next/link';
import { color, fontSize, fontWeight, lineHeight, space } from '@/styles/tokens';
import { cardStyle, h2Style } from './ui-shared';

export type Destination = { href: string; label: string; blurb: string };

export const DESTINATIONS: Destination[] = [
  {
    href: '/market',
    label: 'Market',
    blurb: 'Cross-checked CEX instruments, on-chain DEX pairs, and per-asset-class sections: crypto, forex, commodity and stock.',
  },
  {
    href: '/signals',
    label: 'Signals',
    blurb: 'Read-only screening output over a 168h window. Not trading signals, not financial advice.',
  },
  {
    href: '/scoreboard',
    label: 'Scoreboard',
    blurb: 'Tracked traders and wallets ranked by realized performance.',
  },
  {
    href: '/news',
    label: 'News',
    blurb: 'Crypto market news aggregated for treasury and trading decisions.',
  },
  {
    href: '/blog',
    label: 'Blog',
    blurb: 'Research, playbooks and insights, published through the Payload CMS.',
  },
];

export function DestinationsSection() {
  return (
    <section>
      <h2 style={h2Style}>Boards</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: space[12] }}>
        {DESTINATIONS.map(d => (
          <Link key={d.href} href={d.href} style={{ ...cardStyle, textDecoration: 'none', display: 'block' }}>
            <div style={{ color: color.labelPrimary, fontSize: fontSize[13], fontWeight: fontWeight.bold }}>{d.label} →</div>
            <div style={{ color: color.labelTertiary, fontSize: fontSize[11], marginTop: space[8], lineHeight: lineHeight.normal }}>{d.blurb}</div>
          </Link>
        ))}
      </div>
    </section>
  );
}
