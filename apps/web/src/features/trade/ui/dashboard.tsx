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
 *
 * Entry shell: data fetching + composition. Data panels live in
 * `./dashboard-panels`, static reference sections in `./dashboard-reference`.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import {
  errorMessage,
  fetchExecutions,
  fetchMarketRows,
  fetchPortfolioSummary,
  isLiveExecution,
  TRADE_NAV,
  type ExecutionLite,
} from '@/features/trade/client';
import type { MarketRow, PortfolioSummary } from '@/features/trade/model';
import { MARKET_TYPE_BY_ID, type MarketType } from '@/features/trade/model';
import { PageHeader } from '@/ui/page-header';
import { CapabilityBoard } from '@/features/trade/ui/capability-board';
import { ConnectedAccountsStrip } from '@/features/trade/ui/accounts';
import { TradeComposer } from '@/features/trade/ui/composer';
import { AccountPanelsGrid, idle, MarketBoardCard, PortfolioCard, type Panel } from '@/features/trade/ui/dashboard-panels';
import { MarketTypeTabs, ReferenceGrid, TradeFlowCard } from '@/features/trade/ui/dashboard-reference';

// Single-sourced shared constants stay reachable from the historic entry path.
export { idle, type Panel } from '@/features/trade/ui/dashboard-panels';
export { PIPELINE } from '@/features/trade/ui/dashboard-reference';

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
        title={entry ? `${entry.label} — trading` : 'Trade every market from one surface'}
        description={
          entry
            ? entry.note
            : 'Spot, margin, perps, futures, options and swap — one surface. Market type is what you trade; the venue is only where it executes.'
        }
        nav={TRADE_NAV}
      />

      {/* Primary action — one CTA; the market-type tabs below stay as secondary nav. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[8], marginBottom: space[16] }}>
        <Link
          href="/executor/accounts"
          style={{ background: themeColor.blue, color: themeColor.labelOnAccent, padding: `${space[8]}px ${space[16]}px`, borderRadius: radius[8], fontSize: fontSize[12], fontWeight: fontWeight.bold, textDecoration: 'none' }}
        >
          {connected ? 'Manage connected venues →' : 'Connect a venue →'}
        </Link>
        <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>
          Your exchange keys, never ours — the masked key is the only key the API returns.
        </span>
      </div>

      {/* Market-type tabs — the canonical routes from the plan. */}
      <MarketTypeTabs marketType={marketType} />

      {/* Portfolio headline — honest when unconnected. */}
      <PortfolioCard portfolio={portfolio} connected={connected} liveOrderCount={liveExecutions.length} />

      {/* Market board — live, from the ticker family. */}
      <MarketBoardCard rows={rows} entry={entry} isMargin={isMargin} />

      {!isMargin && marketType !== undefined && (
        <div style={{ marginTop: space[12] }}>
          <TradeComposer marketType={marketType} />
        </div>
      )}

      {!isMargin && (
        <div style={{ marginTop: space[12] }}>
          <ConnectedAccountsStrip />
        </div>
      )}

      {!isMargin && (
        <div style={{ marginTop: space[12] }}>
          <CapabilityBoard marketType={marketType} />
        </div>
      )}

      {/* Account panels: positions, orders, risk — honest empty states. */}
      {!isMargin && (
        <AccountPanelsGrid
          executions={executions}
          connected={connected}
          liveExecutions={liveExecutions}
          committedNotional={committedNotional}
        />
      )}

      {/* Venue + execution-strategy reference: the domain's vocabulary. */}
      <ReferenceGrid />

      {/* The architecture the domain is built around. */}
      <TradeFlowCard />
    </main>
  );
}
