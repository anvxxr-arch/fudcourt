'use client';

import { useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { color, fontSize, radius, space } from '@/styles/tokens';
import TickerPage from '@/features/ticker/ui';
import TrackerPage from '@/features/tracker/ui';
import DexPage from '@/features/dex/ui';
import TrenchPage from '@/features/dex/trench';

// The Market hub — one surface over the market sections, keyed by asset class:
//   crypto    → CEX instruments (TickerPage, cross-venue) + top-250 prices (CoinGecko)
//   trench    → on-chain DEX pairs + the live trench (DexScreener)
//   forex     → no source connected (placeholder, never a mock)
//   commodity → no source connected
//   stock     → no source connected
// Each section is its own route (/market/<section>); this component only adds the
// section chrome, so the providers' envelopes are untouched.
export type MarketSection = 'crypto' | 'forex' | 'commodity' | 'stock' | 'trench';

const SECTIONS: { key: MarketSection; label: string; href: string; blurb: string }[] = [
  {
    key: 'crypto',
    label: 'Crypto',
    href: '/market/crypto',
    blurb:
      'Centralized-exchange instruments (spot, perpetual, dated future, option) cross-checked across venues, plus a top-250 market-cap board.',
  },
  {
    key: 'forex',
    label: 'Forex',
    href: '/market/forex',
    blurb: 'Currency pairs — no source connected yet.',
  },
  {
    key: 'commodity',
    label: 'Commodity',
    href: '/market/commodity',
    blurb: 'Metals, energy and agriculture — no source connected yet.',
  },
  {
    key: 'stock',
    label: 'Stock',
    href: '/market/stock',
    blurb: 'Equities — no source connected yet.',
  },
  {
    key: 'trench',
    label: 'Trench',
    href: '/market/trench',
    blurb: 'On-chain DEX pairs and the live trench, from DexScreener.',
  },
];

const CRYPTO_TABS = [
  { key: 'instruments', label: 'Instruments' },
  { key: 'prices', label: 'Prices' },
] as const;

const TRENCH_TABS = [
  { key: 'pairs', label: 'Pairs' },
  { key: 'trench', label: 'Trench' },
] as const;

const tabStyle = (active: boolean): CSSProperties => ({
  background: active ? color.accent : color.surface,
  color: active ? color.textOnAccent : color.text,
  padding: `${space[8]}px ${space[16]}px`,
  border: `1px solid ${color.border}`,
  borderRadius: radius[8],
  cursor: 'pointer',
  fontSize: fontSize[12],
  textDecoration: 'none',
});

function SectionNav({ active }: { active?: MarketSection }) {
  return (
    <nav style={{ display: 'flex', gap: space[10], marginBottom: space[18], flexWrap: 'wrap' }}>
      {SECTIONS.map((s) => (
        <Link key={s.key} href={s.href} style={tabStyle(active === s.key)}>
          {s.label}
        </Link>
      ))}
    </nav>
  );
}

function NoSource({ label }: { label: string }) {
  return (
    <div
      style={{
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius[8],
        padding: space[18],
      }}>
      <h3 style={{ margin: 0, color: color.text }}>{label} — no source connected</h3>
      <p style={{ margin: `${space[8]}px 0 0`, color: color.textMuted, fontSize: fontSize[12] }}>
        This section is part of the market hub, but no {label.toLowerCase()} data source is wired
        into FUDCOURT yet. Nothing is shown rather than a mock — connect a provider and it fills in.
      </p>
    </div>
  );
}

function Overview() {
  const cardStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    background: color.surface,
    border: `1px solid ${color.border}`,
    borderRadius: radius[8],
    padding: space[14],
    textDecoration: 'none',
  };
  return (
    <div style={{ display: 'grid', gap: space[12] }}>
      {SECTIONS.map((s) => (
        <Link key={s.key} href={s.href} style={cardStyle}>
          <strong style={{ color: color.accent }}>{s.label}</strong>
          <span style={{ color: color.textMuted, fontSize: fontSize[12] }}>{s.blurb}</span>
        </Link>
      ))}
    </div>
  );
}

function CryptoSection() {
  const [tab, setTab] = useState<'instruments' | 'prices'>('instruments');
  return (
    <>
      <div style={{ display: 'flex', gap: space[10], marginBottom: space[14], flexWrap: 'wrap' }}>
        {CRYPTO_TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={tabStyle(tab === t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'instruments' ? <TickerPage /> : <TrackerPage />}
    </>
  );
}

function TrenchSection() {
  const [tab, setTab] = useState<'pairs' | 'trench'>('pairs');
  return (
    <>
      <div style={{ display: 'flex', gap: space[10], marginBottom: space[14], flexWrap: 'wrap' }}>
        {TRENCH_TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={tabStyle(tab === t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'pairs' ? <DexPage /> : <TrenchPage />}
    </>
  );
}

export default function MarketHub({ section }: { section?: MarketSection }) {
  return (
    <div>
      <SectionNav active={section} />
      {!section && <Overview />}
      {section === 'crypto' && <CryptoSection />}
      {section === 'trench' && <TrenchSection />}
      {section === 'forex' && <NoSource label="Forex" />}
      {section === 'commodity' && <NoSource label="Commodity" />}
      {section === 'stock' && <NoSource label="Stock" />}
    </div>
  );
}
