'use client';

import { useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { color, fontSize, radius, space } from '@/styles/tokens';
import dynamic from 'next/dynamic';
const TickerPage = dynamic(() => import('@/features/market/ticker/ui'), { ssr: false });
const TrackerPage = dynamic(() => import('@/features/overview/tracker'), { ssr: false });
const DexPage = dynamic(() => import('@/features/market/dex/ui'), { ssr: false });
const TrenchPage = dynamic(() => import('@/features/market/dex/trench'), { ssr: false });
const ForexBoard = dynamic(() => import('@/features/market/forex'), { ssr: false });
const CommodityBoard = dynamic(() => import('@/features/market/commodity'), { ssr: false });
const StockBoard = dynamic(() => import('@/features/market/stock'), { ssr: false });
const LlamaPage = dynamic(() => import('@/features/market/defi-tvl'), { ssr: false });
import type { StockRegion } from '@/features/market/stock';

// The Market hub — one surface over the market sections, keyed by asset class:
//   crypto    → CEX instruments (TickerPage, cross-venue) + top-250 prices (CoinGecko)
//               + DeFi TVL (DeFiLlama)
//   trench    → on-chain DEX pairs + the live trench (DexScreener)
//   forex     → curated major pairs (exchangerate-api free feed, keyless)
//   commodity → front-month futures (Yahoo Finance, keyless)
//   stock     → US, Asia and Europe indices + blue chips (Yahoo Finance, keyless)
// Each section is its own route (/market/<section>); this component only adds the
// section chrome, so the providers' envelopes are untouched.
export type MarketSection = 'crypto' | 'forex' | 'commodity' | 'stock' | 'trench';

const SECTIONS: { key: MarketSection; label: string; href: string; blurb: string }[] = [
  {
    key: 'crypto',
    label: 'Crypto',
    href: '/market/crypto',
    blurb:
      'Centralized-exchange instruments (spot, perpetual, dated future, option) cross-checked across venues, a top-250 market-cap board, and the DeFi TVL board (DeFiLlama).',
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
    blurb: 'US, Asia and Europe indices and blue chips from Yahoo Finance.',
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
  { key: 'defi', label: 'DeFi TVL' },
] as const;

const TRENCH_TABS = [
  { key: 'pairs', label: 'Pairs' },
  { key: 'trench', label: 'Trench' },
] as const;

const STOCK_TABS = [
  { key: 'us', label: 'US' },
  { key: 'asia', label: 'Asia' },
  { key: 'europe', label: 'Europe' },
] as const;

const tabStyle = (active: boolean): CSSProperties => ({
  background: active ? color.blue : color.bgTertiary,
  color: active ? color.labelOnAccent : color.labelSecondary,
  padding: `${space[8]}px ${space[16]}px`,
  border: `1px solid ${color.separator}`,
  borderRadius: radius[8],
  cursor: 'pointer',
  fontSize: fontSize[12],
  textDecoration: 'none',
});

function Overview() {
  const cardStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    background: color.bgSecondary,
    border: `1px solid ${color.separator}`,
    borderRadius: radius[8],
    padding: space[12],
    textDecoration: 'none',
  };
  return (
    <div style={{ display: 'grid', gap: space[12] }}>
      {SECTIONS.map((s) => (
        <Link key={s.key} href={s.href} style={cardStyle}>
          <strong style={{ color: color.blue }}>{s.label}</strong>
          <span style={{ color: color.labelTertiary, fontSize: fontSize[12] }}>{s.blurb}</span>
        </Link>
      ))}
    </div>
  );
}

function CryptoSection() {
  const [tab, setTab] = useState<'instruments' | 'prices' | 'defi'>('instruments');
  return (
    <>
      <div style={{ display: 'flex', gap: space[8], marginBottom: space[12], flexWrap: 'wrap' }}>
        {CRYPTO_TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={tabStyle(tab === t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'instruments' ? <TickerPage /> : tab === 'prices' ? <TrackerPage /> : <LlamaPage />}
    </>
  );
}

function TrenchSection() {
  const [tab, setTab] = useState<'pairs' | 'trench'>('pairs');
  return (
    <>
      <div style={{ display: 'flex', gap: space[8], marginBottom: space[12], flexWrap: 'wrap' }}>
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

function StockSection() {
  const [tab, setTab] = useState<StockRegion>('us');
  return (
    <>
      <div style={{ display: 'flex', gap: space[8], marginBottom: space[12], flexWrap: 'wrap' }}>
        {STOCK_TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={tabStyle(tab === t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <StockBoard region={tab} />
    </>
  );
}

export default function MarketHub({ section }: { section?: MarketSection }) {
  return (
    <div>
      {!section && <Overview />}
      {section === 'crypto' && <CryptoSection />}
      {section === 'trench' && <TrenchSection />}
      {section === 'forex' && <ForexBoard />}
      {section === 'commodity' && <CommodityBoard />}
      {section === 'stock' && <StockSection />}
    </div>
  );
}
