'use client';

import { useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { themeColor, fontFamily, fontSize, lineHeight, radius, space } from '@/styles/tokens';
import { useT } from '@/lib/i18n/t';
import type { DictKey } from '@/lib/i18n/en';
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

const SECTIONS: { key: MarketSection; labelKey: DictKey; href: string; blurbKey: DictKey }[] = [
  {
    key: 'crypto',
    labelKey: 'market.sectionCrypto',
    href: '/market/crypto',
    blurbKey: 'market.sectionCryptoBlurb',
  },
  {
    key: 'forex',
    labelKey: 'market.sectionForex',
    href: '/market/forex',
    blurbKey: 'market.sectionForexBlurb',
  },
  {
    key: 'commodity',
    labelKey: 'market.sectionCommodity',
    href: '/market/commodity',
    blurbKey: 'market.sectionCommodityBlurb',
  },
  {
    key: 'stock',
    labelKey: 'market.sectionStock',
    href: '/market/stock',
    blurbKey: 'market.sectionStockBlurb',
  },
  {
    key: 'trench',
    labelKey: 'market.sectionTrench',
    href: '/market/trench',
    blurbKey: 'market.sectionTrenchBlurb',
  },
];

const CRYPTO_TABS = [
  { key: 'instruments', labelKey: 'market.tabInstruments' },
  { key: 'prices', labelKey: 'market.tabPrices' },
  { key: 'defi', labelKey: 'market.tabDefi' },
] as const;

const TRENCH_TABS = [
  { key: 'pairs', labelKey: 'market.tabPairs' },
  { key: 'trench', labelKey: 'market.tabTrench' },
] as const;

const STOCK_TABS = [
  { key: 'us', labelKey: 'market.tabUs' },
  { key: 'asia', labelKey: 'market.tabAsia' },
  { key: 'europe', labelKey: 'market.tabEurope' },
] as const;

const tabStyle = (active: boolean): CSSProperties => ({
  background: active ? themeColor.blue : themeColor.bgTertiary,
  color: active ? themeColor.labelOnAccent : themeColor.labelSecondary,
  padding: `${space[8]}px ${space[16]}px`,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  cursor: 'pointer',
  fontSize: fontSize[12],
  textDecoration: 'none',
});

function Overview() {
  const t = useT();
  const cardStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    background: themeColor.bgSecondary,
    border: `1px solid ${themeColor.separator}`,
    borderRadius: radius[8],
    padding: space[12],
    textDecoration: 'none',
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[12] }}>
      {SECTIONS.map((s) => (
        <Link key={s.key} href={s.href} style={cardStyle}>
          <strong style={{ color: themeColor.blue }}>{t(s.labelKey)}</strong>
          {/* The blurb is prose, not data. It inherits the shell's mono stack, which reads as
              terminal noise at 12px — the sans stack is what the type scale is designed for
              at this size, and it keeps mono meaning "a figure" everywhere else on the board. */}
          <span style={{ color: themeColor.labelTertiary, fontFamily: fontFamily.sans, fontSize: fontSize[12], lineHeight: lineHeight.normal }}>{t(s.blurbKey)}</span>
        </Link>
      ))}
    </div>
  );
}

function CryptoSection() {
  const t = useT();
  const [tab, setTab] = useState<'instruments' | 'prices' | 'defi'>('instruments');
  return (
    <>
      <div style={{ display: 'flex', gap: space[8], marginBottom: space[12], flexWrap: 'wrap' }}>
        {CRYPTO_TABS.map((tb) => (
          <button key={tb.key} aria-pressed={tab === tb.key} onClick={() => setTab(tb.key)} style={tabStyle(tab === tb.key)}>
            {t(tb.labelKey)}
          </button>
        ))}
      </div>
      {tab === 'instruments' ? <TickerPage /> : tab === 'prices' ? <TrackerPage /> : <LlamaPage />}
    </>
  );
}

function TrenchSection() {
  const t = useT();
  const [tab, setTab] = useState<'pairs' | 'trench'>('pairs');
  return (
    <>
      <div style={{ display: 'flex', gap: space[8], marginBottom: space[12], flexWrap: 'wrap' }}>
        {TRENCH_TABS.map((tb) => (
          <button key={tb.key} aria-pressed={tab === tb.key} onClick={() => setTab(tb.key)} style={tabStyle(tab === tb.key)}>
            {t(tb.labelKey)}
          </button>
        ))}
      </div>
      {tab === 'pairs' ? <DexPage /> : <TrenchPage />}
    </>
  );
}

function StockSection() {
  const t = useT();
  const [tab, setTab] = useState<StockRegion>('us');
  return (
    <>
      <div style={{ display: 'flex', gap: space[8], marginBottom: space[12], flexWrap: 'wrap' }}>
        {STOCK_TABS.map((tb) => (
          <button key={tb.key} aria-pressed={tab === tb.key} onClick={() => setTab(tb.key)} style={tabStyle(tab === tb.key)}>
            {t(tb.labelKey)}
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
