'use client';

import { useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { color, fontSize, radius, space } from '@/styles/tokens';
import TickerPage from '@/features/ticker/ui';
import TrackerPage from '@/features/tracker/ui';
import DexPage from '@/features/dex/ui';
import TrenchPage from '@/features/dex/trench';
import ForexBoard from '@/features/market/forex/ui';
import CommodityBoard from '@/features/market/commodity/ui';
import StockBoard from '@/features/market/stock/ui';

// The Market hub — one surface over the market sections, keyed by asset class:
//   crypto    → CEX instruments (TickerPage, cross-venue) + top-250 prices (CoinGecko)
//   trench    → on-chain DEX pairs + the live trench (DexScreener)
//   forex     → curated major pairs (exchangerate-api free feed, keyless)
//   commodity → front-month futures (Yahoo Finance, keyless)
//   stock     → indices + mega-caps (Yahoo Finance, keyless)
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
    blurb: 'Currency pairs — curated majors + Asia from the exchangerate-api free feed (ECB-fed, republished daily).',
  },
  {
    key: 'commodity',
    label: 'Commodity',
    href: '/market/commodity',
    blurb: 'Metals, energy and agriculture — front-month futures from Yahoo Finance.',
  },
  {
    key: 'stock',
    label: 'Stock',
    href: '/market/stock',
    blurb: 'Indices and mega-cap equities from Yahoo Finance.',
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
      {section === 'forex' && <ForexBoard />}
      {section === 'commodity' && <CommodityBoard />}
      {section === 'stock' && <StockBoard />}
    </div>
  );
}
