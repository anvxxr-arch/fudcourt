'use client';

/**
 * dashboard-panels.tsx — the data panels of the Trading Command Center.
 *
 * Portfolio headline, market board (with the margin account-level branch),
 * and the positions/orders/risk grid. Each panel is independent: one upstream
 * failing empties its own panel with a named error and leaves the rest intact.
 * `Panel`/`idle` live here as the single source; dashboard.tsx imports them.
 */
import { Card } from '@/ui/card';
import { ChangeChip } from '@/ui/change-chip';
import { DataTable } from '@/ui/data-table';
import { ErrorState } from '@/ui/feedback';
import { Loading } from '@/ui/feedback';
import { Notice } from '@/ui/notice';
import { Value } from '@/ui/value';
import { themeColor, fontSize, lineHeight, space } from '@/styles/tokens';
import {
  formatPrice,
  formatUsd,
  NO_VALUE,
  type ExecutionLite,
} from '@/features/trade/client';
import type { MarketRow, PortfolioSummary } from '@/features/trade/model';
import { instrumentHref, isInstrumentId } from '@/features/trade/model';
import { MARKET_TYPE_BY_ID } from '@/features/trade/model';
import Link from 'next/link';
import { TradeAccountsView } from '@/features/trade/ui/accounts';

export type Panel<T> = { value: T; error: string | null; loading: boolean };

export const idle = <T,>(value: T): Panel<T> => ({ value, error: null, loading: true });

export function PortfolioCard({
  portfolio,
  connected,
  liveOrderCount,
}: {
  portfolio: Panel<PortfolioSummary | null>;
  connected: boolean;
  liveOrderCount: number;
}) {
  return (
    <Card
      title="Portfolio"
      subtitle={connected ? 'connected venue account' : 'no venue account connected'}
      right={
        <Link href="/executor/accounts" style={{ fontSize: fontSize[11], color: themeColor.blue, textDecoration: 'none' }}>
          {connected ? 'manage accounts →' : 'connect a venue →'}
        </Link>
      }
    >
      {portfolio.error ? (
        <ErrorState title="Portfolio unavailable" detail={portfolio.error} />
      ) : portfolio.loading ? (
        <Loading what="portfolio" />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: space[12] }}>
          <Value label="Equity" value={formatUsd(portfolio.value?.equity)} tone={portfolio.value?.equity == null ? 'muted' : 'default'} hint="Total equity across connected venues. — until a venue answers; never a guessed zero." />
          <Value label="Available" value={formatUsd(portfolio.value?.available)} tone={portfolio.value?.available == null ? 'muted' : 'default'} />
          <Value label="Exposure" value={formatUsd(portfolio.value?.exposure)} tone={portfolio.value?.exposure == null ? 'muted' : 'default'} />
          <Value label="PnL today" value={formatUsd(portfolio.value?.pnlToday)} tone={portfolio.value?.pnlToday == null ? 'muted' : portfolio.value.pnlToday >= 0 ? 'positive' : 'negative'} />
          <Value label="Live orders" value={connected ? String(liveOrderCount) : NO_VALUE} tone={connected ? 'default' : 'muted'} />
        </div>
      )}
    </Card>
  );
}

export function MarketBoardCard({
  rows,
  entry,
  isMargin,
}: {
  rows: Panel<MarketRow[]>;
  entry: { label: string; tickerType: string | null } | null;
  isMargin: boolean;
}) {
  // Margin is an account-level market with no quotable instrument of its own,
  // so the margin route shows the account view rather than a deliberately-empty board.
  if (isMargin) {
    return (
      <div style={{ marginTop: space[12] }}>
        <TradeAccountsView
          showPortfolio={false}
          note="Margin is an account-level market: it has no quotable instrument of its own, so there is no separate board. It trades the spot pairs on the spot board against borrowed collateral — this route shows the connected accounts and their margin-capable venues instead."
        />
      </div>
    );
  }
  return (
    <div style={{ marginTop: space[12] }}>
      <Card
        title={entry ? `${entry.label} markets` : 'Markets'}
        subtitle="cross-venue price, each venue's own quote and their divergence — read live"
        right={
          <Link href="/market/crypto" style={{ fontSize: fontSize[11], color: themeColor.blue, textDecoration: 'none' }}>
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
              // A row links to its canonical instrument page only when the id is
              // in the registry, so a drift between the board's source and the
              // registry yields a non-link, never a broken link.
              href: isInstrumentId(r.instrumentId) ? instrumentHref(r.marketType, r.instrumentId) : undefined,
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
  );
}

export function AccountPanelsGrid({
  executions,
  connected,
  liveExecutions,
  committedNotional,
}: {
  executions: Panel<ExecutionLite[]>;
  connected: boolean;
  liveExecutions: ExecutionLite[];
  committedNotional: number | null;
}) {
  return (
    <div style={{ display: 'grid', gap: space[12], gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', marginTop: space[12] }}>
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
        <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
          Risk is a deterministic calculation over entry, stop and size (plan Phase 13). It is never inferred from a model.
        </p>
      </Card>
    </div>
  );
}
