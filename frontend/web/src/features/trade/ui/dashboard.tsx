'use client';

/**
 * The Trading Command Center (plan Phase 6) — `/trade` and `/trade/<marketType>`.
 *
 * WHAT IT IS. One board that joins what the site already serves: the market
 * board reads `/api/ticker` (the cross-venue price board), the account panels
 * read `/api/executor/*` (the CEX executor that already exists). It invents no
 * private aggregate, because a second endpoint for numbers another page already
 * publishes is a second source of truth that drifts the first time one moves.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never prints a figure it has not read.
 * Portfolio equity, margin usage and portfolio risk are `—` until a venue
 * actually answers: a connected-but-unqueried account is not a zero-balance
 * one, and a flat `$0.00` would be a lie a trader could act on. Risk is a
 * deterministic sum over live executions' committed notional, never estimated.
 *
 * Every panel is independent: one upstream failing empties its own panel with a
 * named error and leaves the rest of the page intact.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { alpha, color, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import {
  errorMessage,
  fetchExecutions,
  fetchMarketRows,
  fetchPortfolioSummary,
  formatChange,
  formatPrice,
  formatUsd,
  isLiveExecution,
  marketTypeHref,
  NO_VALUE,
  TRADE_NAV,
  type ExecutionLite,
} from '@/features/trade/client';
import type { MarketRow, PortfolioSummary } from '@/features/trade/model';
import {
  EXECUTION_STRATEGIES,
  MARKET_TYPES,
  MARKET_TYPE_BY_ID,
  VENUES,
  VENUE_MARKET_TYPES,
  type MarketType,
} from '@/features/trade/taxonomy';
import { Card, ChangeChip, DataTable, ErrorState, Loading, Notice, PageHeader, Value } from '@/features/trade/ui/parts';
import { CapabilityBoard } from '@/features/trade/ui/capability-board';
import { ConnectedAccountsStrip, TradeAccountsView } from '@/features/trade/ui/accounts';
import { TradeComposer } from '@/features/trade/ui/composer';

/** The pipeline the domain is built around (plan: market data → … → portfolio). */
const PIPELINE = [
  'Market data',
  'Trade intent',
  'Risk engine',
  'Execution engine',
  'Venue router',
  'CEX / DEX',
  'Order / Position',
  'Portfolio',
] as const;

type Panel<T> = { value: T; error: string | null; loading: boolean };

const idle = <T,>(value: T): Panel<T> => ({ value, error: null, loading: true });

export default function TradeDashboard({ marketType }: { marketType?: MarketType }) {
  const [rows, setRows] = useState<Panel<MarketRow[]>>(idle<MarketRow[]>([]));
  const [portfolio, setPortfolio] = useState<Panel<PortfolioSummary | null>>(idle<PortfolioSummary | null>(null));
  const [executions, setExecutions] = useState<Panel<ExecutionLite[]>>(idle<ExecutionLite[]>([]));

  useEffect(() => {
    const ac = new AbortController();
    setRows(idle<MarketRow[]>([]));
    setPortfolio(idle<PortfolioSummary | null>(null));
    setExecutions(idle<ExecutionLite[]>([]));

    fetchMarketRows(marketType ?? 'all', ac.signal)
      .then((v) => !ac.signal.aborted && setRows({ value: v, error: null, loading: false }))
      .catch((e) => !ac.signal.aborted && setRows({ value: [], error: errorMessage(e), loading: false }));

    fetchPortfolioSummary(ac.signal)
      .then((v) => !ac.signal.aborted && setPortfolio({ value: v, error: null, loading: false }))
      .catch((e) => !ac.signal.aborted && setPortfolio({ value: null, error: errorMessage(e), loading: false }));

    fetchExecutions(ac.signal)
      .then((v) => !ac.signal.aborted && setExecutions({ value: v, error: null, loading: false }))
      .catch((e) => !ac.signal.aborted && setExecutions({ value: [], error: errorMessage(e), loading: false }));

    return () => ac.abort();
  }, [marketType]);

  const liveExecutions = useMemo(() => executions.value.filter((e) => isLiveExecution(e.status)), [executions.value]);
  const committedNotional = useMemo(() => {
    const notional = liveExecutions.reduce((sum, e) => sum + (e.plannedNotional ?? 0), 0);
    return notional > 0 ? notional : null;
  }, [liveExecutions]);

  const entry = marketType ? MARKET_TYPE_BY_ID[marketType] : null;
  const connected = portfolio.value?.connected === true;
  const isMargin = marketType === 'margin';

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title={entry ? `${entry.label} — trading` : 'Trade — command center'}
        description={
          entry
            ? entry.note
            : 'One trading surface across every market type and venue. Market type is what you trade; the venue is only where it executes. Connect a venue to see balances, positions and risk.'
        }
        nav={TRADE_NAV}
      />

      {/* Market-type tabs — the canonical routes from the plan. */}
      <nav aria-label="Market types" style={{ display: 'flex', flexWrap: 'wrap', gap: space[6], marginBottom: space[16] }}>
        <TypeTab href="/trade" label="All" active={!marketType} />
        {MARKET_TYPES.map((m) => (
          <TypeTab key={m.id} href={marketTypeHref(m.id)} label={m.label} active={marketType === m.id} />
        ))}
      </nav>

      {/* Portfolio headline — honest when unconnected. */}
      <Card
        title="Portfolio"
        subtitle={connected ? 'connected venue account' : 'no venue account connected'}
        right={
          <Link href="/executor/accounts" style={{ fontSize: fontSize[11], color: color.accent, textDecoration: 'none' }}>
            {connected ? 'manage accounts →' : 'connect a venue →'}
          </Link>
        }
      >
        {portfolio.error ? (
          <ErrorState title="Portfolio unavailable" detail={portfolio.error} />
        ) : portfolio.loading ? (
          <Loading what="portfolio" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: space[14] }}>
            <Value label="Equity" value={formatUsd(portfolio.value?.equity)} tone={portfolio.value?.equity == null ? 'muted' : 'default'} hint="Total equity across connected venues. — until a venue answers; never a guessed zero." />
            <Value label="Available" value={formatUsd(portfolio.value?.available)} tone={portfolio.value?.available == null ? 'muted' : 'default'} />
            <Value label="Exposure" value={formatUsd(portfolio.value?.exposure)} tone={portfolio.value?.exposure == null ? 'muted' : 'default'} />
            <Value label="PnL today" value={formatUsd(portfolio.value?.pnlToday)} tone={portfolio.value?.pnlToday == null ? 'muted' : portfolio.value.pnlToday >= 0 ? 'positive' : 'negative'} />
            <Value label="Live orders" value={connected ? String(liveExecutions.length) : NO_VALUE} tone={connected ? 'default' : 'muted'} />
          </div>
        )}
      </Card>

      {/* Market board — live, from the ticker family. Margin is an account-level
          market with no quotable instrument of its own, so the margin route shows
          the account view below rather than a deliberately-empty board. */}
      {isMargin ? (
        <div style={{ marginTop: space[14] }}>
          <TradeAccountsView
            showPortfolio={false}
            note="Margin is an account-level market: it has no quotable instrument of its own, so there is no separate board. It trades the spot pairs on the spot board against borrowed collateral — this route shows the connected accounts and their margin-capable venues instead."
          />
        </div>
      ) : (
      <div style={{ marginTop: space[14] }}>
        <Card
          title={entry ? `${entry.label} markets` : 'Markets'}
          subtitle="cross-venue price, each venue's own quote and their divergence — read live"
          right={
            <Link href="/market/crypto" style={{ fontSize: fontSize[11], color: color.accent, textDecoration: 'none' }}>
              full board →
            </Link>
          }
        >
          {rows.error ? (
            <ErrorState title="Market board unavailable" detail={rows.error} />
          ) : rows.loading ? (
            <Loading what="markets" />
          ) : rows.value.length === 0 ? (
            <Notice>
              {entry && entry.tickerType === null
                ? `${entry.label} is an account-level market: there is no separate quotable instrument, so this board is intentionally empty. The instruments are the spot pairs on the spot board, traded against borrowed collateral.`
                : 'No venue returned a quote for this market type right now. An empty board is reported as empty, never padded with another type.'}
            </Notice>
          ) : (
            <DataTable
              head={['Instrument', 'Type', 'Price', '24h', 'Spread', 'Venues']}
              rows={rows.value.slice(0, 12).map((r) => ({
                cells: [
                  `${r.base} / ${r.quote}`,
                  MARKET_TYPE_BY_ID[r.marketType].label,
                  formatPrice(r.price),
                  <ChangeChip key={`c-${r.instrumentId}`} percent={r.change24h} />,
                  r.spreadPct === null ? NO_VALUE : `${r.spreadPct.toFixed(3)}%`,
                  r.venues.map((v) => v.venue).join(' · '),
                ],
              }))}
            />
          )}
        </Card>
      </div>
      )}

      {!isMargin && marketType !== undefined && (
        <div style={{ marginTop: space[14] }}>
          <TradeComposer marketType={marketType} />
        </div>
      )}

      {!isMargin && (
        <div style={{ marginTop: space[14] }}>
          <ConnectedAccountsStrip />
        </div>
      )}

      {!isMargin && (
        <div style={{ marginTop: space[14] }}>
          <CapabilityBoard marketType={marketType} />
        </div>
      )}

      {/* Account panels: positions, orders, risk — honest empty states. */}
      {!isMargin && (
      <div style={{ display: 'grid', gap: space[14], gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', marginTop: space[14] }}>
        <Card title="Open positions" subtitle="normalized across CEX and DEX">
          {executions.error ? (
            <ErrorState title="Positions unavailable" detail={executions.error} />
          ) : !connected ? (
            <Notice>Connect a venue account to see open positions. A DEX swap has no position until it settles on-chain.</Notice>
          ) : (
            <Notice>No open positions are recorded for the connected account. Position normalization (plan Phase 17) reads them per venue.</Notice>
          )}
        </Card>

        <Card title="Active orders" subtitle="live executions from the executor">
          {executions.error ? (
            <ErrorState title="Orders unavailable" detail={executions.error} />
          ) : executions.loading ? (
            <Loading what="orders" />
          ) : !connected ? (
            <Notice>Connect a venue account to place and track orders.</Notice>
          ) : liveExecutions.length === 0 ? (
            <Notice>No live orders. Working executions appear here with their fill progress.</Notice>
          ) : (
            <DataTable
              head={['Symbol', 'Type', 'Side', 'Status']}
              rows={liveExecutions.map((e) => ({
                href: `/executor/${e.id}`,
                cells: [e.symbol, e.marketType, e.side, e.status],
              }))}
            />
          )}
        </Card>

        <Card title="Risk" subtitle="deterministic, never model-estimated">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: space[12] }}>
            <Value label="Margin usage" value={NO_VALUE} tone="muted" hint="Requires a connected venue's margin snapshot." />
            <Value label="Committed risk" value={formatUsd(committedNotional)} tone={committedNotional === null ? 'muted' : 'default'} hint="Sum of planned notional over live executions. — when none are working." />
            <Value label="Portfolio risk" value={NO_VALUE} tone="muted" hint="Sum of committed risk over the whole portfolio; needs venue balances." />
          </div>
          <p style={{ margin: `${space[10]}px 0 0`, fontSize: fontSize[10], color: color.textMuted, lineHeight: lineHeight.normal }}>
            Risk is a deterministic calculation over entry, stop and size (plan Phase 13). It is never inferred from a model.
          </p>
        </Card>
      </div>
      )}

      {/* Venue + execution-strategy reference: the domain's vocabulary. */}
      <div style={{ display: 'grid', gap: space[14], gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', marginTop: space[14] }}>
        <Card title="Venues" subtitle="where an order can execute — CEX and DEX">
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
            {VENUES.map((v) => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: space[8] }}>
                <span style={{ fontSize: fontSize[12], color: color.text }}>
                  {v.label}{' '}
                  <span style={{ fontSize: fontSize[10], color: color.textMuted, letterSpacing: letterSpacing.sm, textTransform: 'uppercase' }}>{v.type}</span>
                </span>
                <span style={{ fontSize: fontSize[10], color: color.textMuted, textAlign: 'right' }}>
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
                <span style={{ fontSize: fontSize[12], color: color.text }}>{s.label}</span>
                <p style={{ margin: `${space[4]}px 0 0`, fontSize: fontSize[10], color: color.textMuted, lineHeight: lineHeight.normal }}>{s.note}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* The architecture the domain is built around. */}
      <div style={{ marginTop: space[14] }}>
        <Card title="How a trade flows" subtitle="market type and venue are orthogonal — this is the path from intent to position">
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[6] }}>
            {PIPELINE.map((step, i) => (
              <span key={step} style={{ display: 'inline-flex', alignItems: 'center', gap: space[6] }}>
                <span style={{ padding: `${space[4]}px ${space[10]}px`, border: `1px solid ${alpha(color.accent, 0.35)}`, borderRadius: radius[6], fontSize: fontSize[11], color: color.text }}>
                  {step}
                </span>
                {i < PIPELINE.length - 1 && <span aria-hidden="true" style={{ color: color.textMuted }}>→</span>}
              </span>
            ))}
          </div>
          <p style={{ margin: `${space[12]}px 0 0`, fontSize: fontSize[11], color: color.textMuted, lineHeight: lineHeight.normal }}>
            Spot, margin, perpetual, futures, options and swap are MARKET TYPES. Binance, Bybit, Hyperliquid and Uniswap are VENUES. TWAP, VWAP and iceberg are EXECUTION STRATEGIES. Keeping the three apart is what lets the engine grow without being rebuilt.
          </p>
        </Card>
      </div>
    </main>
  );
}

function TypeTab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      style={{
        padding: `${space[4]}px ${space[10]}px`,
        border: `1px solid ${active ? color.accent : color.border}`,
        borderRadius: radius[6],
        background: active ? alpha(color.accent, 0.12) : 'transparent',
        color: active ? color.text : color.textMuted,
        fontSize: fontSize[11],
        fontWeight: active ? fontWeight.semibold : fontWeight.regular,
        textDecoration: 'none',
      }}
    >
      {label}
    </Link>
  );
}
