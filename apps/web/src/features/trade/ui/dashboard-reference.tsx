'use client';

/**
 * dashboard-reference.tsx — the static reference sections of the Trading
 * Command Center: market-type tabs, the venues/strategies vocabulary cards,
 * and the trade-flow architecture card. `PIPELINE` lives here as the single
 * source; dashboard.tsx imports it.
 */
import Link from 'next/link';
import { alpha, themeColor, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import { marketTypeHref } from '@/features/trade/client';
import {
  EXECUTION_STRATEGIES,
  MARKET_TYPES,
  MARKET_TYPE_BY_ID,
  VENUES,
  VENUE_MARKET_TYPES,
  type MarketType,
} from '@/features/trade/model';
import { Card } from '@/ui/card';

/** The pipeline the domain is built around (plan: market data → … → portfolio). */
export const PIPELINE = [
  'Market data',
  'Trade intent',
  'Risk engine',
  'Execution engine',
  'Venue router',
  'CEX / DEX',
  'Order / Position',
  'Portfolio',
] as const;

export function TypeTab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      style={{
        padding: `${space[4]}px ${space[8]}px`,
        border: `1px solid ${active ? themeColor.blue : themeColor.separator}`,
        borderRadius: radius[8],
        background: active ? alpha(themeColor.blue, 0.12) : 'transparent',
        color: active ? themeColor.labelPrimary : themeColor.labelTertiary,
        fontSize: fontSize[11],
        fontWeight: active ? fontWeight.semibold : fontWeight.regular,
        textDecoration: 'none',
      }}
    >
      {label}
    </Link>
  );
}

export function MarketTypeTabs({ marketType }: { marketType?: MarketType }) {
  return (
    <nav aria-label="Market types" style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[16] }}>
      <TypeTab href="/trade" label="All" active={!marketType} />
      {MARKET_TYPES.map((m) => (
        <TypeTab key={m.id} href={marketTypeHref(m.id)} label={m.label} active={marketType === m.id} />
      ))}
    </nav>
  );
}

export function ReferenceGrid() {
  return (
    <div style={{ display: 'grid', gap: space[12], gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', marginTop: space[12] }}>
      <Card title="Venues" subtitle="where an order can execute — CEX and DEX">
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
          {VENUES.map((v) => (
            <div key={v.id} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: space[8] }}>
              <span style={{ fontSize: fontSize[12], color: themeColor.labelPrimary }}>
                {v.label}{' '}
                <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, letterSpacing: letterSpacing.sm, textTransform: 'uppercase' }}>{v.type}</span>
              </span>
              <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, textAlign: 'right' }}>
                {VENUE_MARKET_TYPES[v.id].map((m) => MARKET_TYPE_BY_ID[m].label).join(' · ')}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Execution strategies" subtitle="how an order is worked — venue-independent">
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
          {EXECUTION_STRATEGIES.map((s) => (
            <div key={s.id}>
              <span style={{ fontSize: fontSize[12], color: themeColor.labelPrimary }}>{s.label}</span>
              <p style={{ margin: `${space[4]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>{s.note}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function TradeFlowCard() {
  return (
    <div style={{ marginTop: space[12] }}>
      <Card title="How a trade flows" subtitle="market type and venue are orthogonal — this is the path from intent to position">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[8] }}>
          {PIPELINE.map((step, i) => (
            <span key={step} style={{ display: 'inline-flex', alignItems: 'center', gap: space[8] }}>
              <span style={{ padding: `${space[4]}px ${space[8]}px`, border: `1px solid ${alpha(themeColor.blue, 0.35)}`, borderRadius: radius[8], fontSize: fontSize[11], color: themeColor.labelPrimary }}>
                {step}
              </span>
              {i < PIPELINE.length - 1 && <span aria-hidden="true" style={{ color: themeColor.labelTertiary }}>→</span>}
            </span>
          ))}
        </div>
        <p style={{ margin: `${space[12]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
          Spot, margin, perpetual, futures, options and swap are MARKET TYPES. Binance, Bybit, Hyperliquid and Uniswap are VENUES. TWAP, VWAP and iceberg are EXECUTION STRATEGIES. Keeping the three apart is what lets the engine grow without being rebuilt.
        </p>
      </Card>
    </div>
  );
}
