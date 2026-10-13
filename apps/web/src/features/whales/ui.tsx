'use client';

/**
 * The whale watcher (F12) — `/whales`: the largest open positions on Hyperliquid,
 * read from coinank's `whales` mode.
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never imply it sees the whole book. Upstream ranks the positions and
 *    serves page 1 of its own `pagination.total` (1,484 at last read) — the board
 *    prints "50 of 1,484" and sums only the rows it can see.
 *  - It must never print a missing metric as 0. A `liquidationPx` upstream did not
 *    state renders `—`, and a position with no liquidation price states no
 *    distance rather than "0% from liquidation".
 *  - It must never invent a side. `side` is the upstream's own label; the signed
 *    size (negative = Short) is the documented cross-check, and a row carrying
 *    neither renders `—`.
 *
 * The reading itself lives in `./model.ts` and is pure, so every refusal above is
 * unit-tested offline against fixed rows.
 */
import { useEffect, useMemo, useState } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, radius, space, letterSpacing } from '@/styles/tokens';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { EmptyState, ErrorState, Loading, StaleNotice } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import { fmtPrice } from '@/lib/format';
import { useT } from '@/lib/i18n/t';
import { setBoardStale } from '@/lib/stale-board';
import { fetchWhaleSource, type WhaleSources } from './client';
import { buildWhaleBoard, type WhaleBoard, type WhalePosition, type WhaleSide } from './model';

const SIDE_COLOR: Record<WhaleSide, string> = {
  Long: themeColor.green,
  Short: themeColor.red,
};

/** A USD magnitude, compacted; null/non-finite -> `—`. */
function usd(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** A signed USD amount: `+$1.23M` / `-$24.42M`; null -> `—`. */
function usdSigned(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  if (v === 0) return '$0';
  return (v > 0 ? '+' : '') + usd(v);
}

/** A fraction rendered as a percentage, or `—`. */
function pct(v: number | null): string {
  return v === null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`;
}

/** A 0x address, truncated for the column; empty -> `—`. */
function shortAddr(a: string): string {
  if (!a) return '—';
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Green/red by the sign of a signed value; null -> muted. */
function pnlColor(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v === 0) return themeColor.labelSecondary;
  return v > 0 ? themeColor.green : themeColor.red;
}

/** One of the two headline blocks: the largest position / the largest loss. */
function LargestBlock({ title, pos, mode }: { title: string; pos: WhalePosition | null; mode: 'notional' | 'pnl' }) {
  const t = useT();
  return (
    <div style={{ flex: '1 1 220px', border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: space[12] }}>
      <div style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, letterSpacing: letterSpacing.wide, textTransform: 'uppercase' }}>{title}</div>
      {pos === null ? (
        <EmptyState>{t('crypto.whales.noPositionMetric')}</EmptyState>
      ) : (
        <>
          <div style={{ fontSize: fontSize[20], fontWeight: fontWeight.bold, marginTop: space[4], color: mode === 'pnl' ? pnlColor(pos.unrealizedPnl) : themeColor.labelPrimary }}>
            {mode === 'notional' ? usd(pos.positionValue) : usdSigned(pos.unrealizedPnl)}
          </div>
          <div style={{ fontSize: fontSize[12], color: themeColor.labelSecondary, marginTop: space[4] }}>
            <span style={{ color: pos.side ? SIDE_COLOR[pos.side] : themeColor.labelTertiary, fontWeight: fontWeight.semibold }}>{pos.side ?? '—'}</span>
            {' '}
            {pos.baseCoin} · {pos.leverage === null ? '—' : `${pos.leverage}x`} leverage
          </div>
          <div style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, marginTop: space[4], lineHeight: lineHeight.normal }}>
            {shortAddr(pos.address)} · entry {fmtPrice(pos.entryPx)} · liq {fmtPrice(pos.liquidationPx)} · {pct(pos.liquidationDistance)} to liq
          </div>
        </>
      )}
    </div>
  );
}

export default function WhalesPage() {
  const t = useT();
  const [sources, setSources] = useState<WhaleSources | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchWhaleSource(ac.signal).then((s) => !ac.signal.aborted && setSources(s));
    return () => ac.abort();
  }, []);
  // Publish this board's staleness to the shell subtitle; cleared on unmount.
  const staleEnvelope = sources?.data?.stale ? sources.data : null;
  useEffect(() => {
    setBoardStale(staleEnvelope ? { source: 'CoinAnk', fetchedAt: staleEnvelope.fetchedAt, ageSec: staleEnvelope.staleAgeSec ?? 0 } : null);
    return () => setBoardStale(null);
  }, [staleEnvelope]);

  const board: WhaleBoard | null = useMemo(() => {
    if (!sources?.data) return null;
    return buildWhaleBoard(
      sources.data.data?.list ?? [],
      sources.data.data?.pagination ?? null,
      Math.floor(Date.now() / 1000),
    );
  }, [sources]);

  if (sources === null) return <Loading what={t('crypto.whales.loadingWhat')} />;

  if (!board) {
    return (
      <ErrorState
        title={t('crypto.whales.loadFailTitle')}
        detail={sources.error ?? t('crypto.common.upstreamNoRows')}
      />
    );
  }

  // An empty payload that claims success is a FAILURE to report, not an empty
  // board: "no positions" from a ranking that always returns some is a broken read.
  if (board.positions.length === 0) {
    return (
      <ErrorState
        title={t('crypto.whales.emptyTitle')}
        detail={t('crypto.whales.emptyDetail', { total: board.slice.total.toLocaleString('en-US') })}
      />
    );
  }

  const totals = board.totals;
  const pages = board.slice.pageSize > 0 ? Math.ceil(board.slice.total / board.slice.pageSize) : null;

  return (
    <>
      {sources.data?.stale ? (
        <StaleNotice source="CoinAnk" fetchedAt={sources.data.fetchedAt} ageSec={sources.data.staleAgeSec ?? 0} />
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
        <Stat
          label={t('crypto.whales.statSeen')}
          value={String(totals.seen)}
          hint={t('crypto.whales.hintOfUpstream', { n: totals.upstreamTotal.toLocaleString('en-US') })}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label={t('crypto.whales.statUpstreamTotal')}
          value={totals.upstreamTotal.toLocaleString('en-US')}
          hint={t('crypto.whales.hintPagination', { page: board.slice.current, pages: pages ?? '—' })}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label={t('crypto.whales.statTotalNotional')}
          value={usd(totals.totalNotional)}
          hint={totals.notionalMissing > 0 ? t('crypto.whales.hintNotionalMissing', { n: totals.notionalMissing }) : t('crypto.whales.hintNotionalSum', { n: totals.seen })}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label={t('crypto.whales.statNetPnl')}
          value={usdSigned(totals.netUnrealizedPnl)}
          tone={totals.netUnrealizedPnl >= 0 ? 'positive' : 'negative'}
          hint={totals.pnlMissing > 0 ? t('crypto.whales.hintPnlMissing', { n: totals.pnlMissing }) : t('crypto.whales.hintPnlSum')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label={t('crypto.whales.statLongShort')}
          value={`${usd(totals.split.long)} / ${usd(totals.split.short)}`}
          hint={totals.split.longShare === null ? t('crypto.whales.hintNoNotional') : t('crypto.whales.hintLongShortShare', { long: (totals.split.longShare * 100).toFixed(1), short: ((1 - totals.split.longShare) * 100).toFixed(1) })}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
      </div>

      <p style={{ margin: `${space[12]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {board.slice.note}.
      </p>

      <div style={{ marginTop: space[12] }}>
        <Card title={t('crypto.whales.positionsTitle', { n: board.positions.length })} subtitle={t('crypto.whales.positionsSubtitle')}>
          <DataTable
            head={[t('crypto.whales.headAddress'), t('col.coin'), t('col.side'), t('crypto.whales.headLeverage'), t('crypto.whales.headNotional'), t('crypto.whales.headUnrealizedPnl'), t('crypto.whales.headEntry'), t('crypto.whales.headLiquidation'), t('crypto.whales.headToLiq')]}
            rows={board.positions.map((p) => ({
              cells: [
                <span key="a" style={{ color: themeColor.labelSecondary }}>{shortAddr(p.address)}</span>,
                <span key="c" style={{ fontWeight: fontWeight.semibold }}>{p.baseCoin || '—'}</span>,
                <span key="s" style={{ color: p.side ? SIDE_COLOR[p.side] : themeColor.labelTertiary, fontWeight: fontWeight.semibold }}>{p.side ?? '—'}</span>,
                <span key="l" style={{ color: themeColor.labelSecondary }}>{p.leverage === null ? '—' : `${p.leverage}x`}</span>,
                <span key="v">{usd(p.positionValue)}</span>,
                <span key="u" style={{ color: pnlColor(p.unrealizedPnl), fontWeight: fontWeight.semibold }}>{usdSigned(p.unrealizedPnl)}</span>,
                <span key="e" style={{ color: themeColor.labelSecondary }}>{fmtPrice(p.entryPx)}</span>,
                <span key="q" style={{ color: themeColor.labelSecondary }}>{fmtPrice(p.liquidationPx)}</span>,
                <span key="d" style={{ color: p.liquidationDistance === null ? themeColor.labelTertiary : themeColor.labelPrimary }}>{pct(p.liquidationDistance)}</span>,
              ],
            }))}
          />
        </Card>
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card title={t('crypto.whales.byCoinTitle')} subtitle={t('crypto.whales.byCoinSubtitle')}>
          {board.coinGroups.length === 0 ? (
            <EmptyState>{t('crypto.whales.noCoinPosition')}</EmptyState>
          ) : (
            <DataTable
              head={[t('col.coin'), t('crypto.whales.headPositions'), t('crypto.whales.headNotional'), t('crypto.whales.headNetSide'), t('crypto.whales.headNetNotional'), t('crypto.whales.headUnrealizedPnl')]}
              rows={board.coinGroups.map((g) => ({
                cells: [
                  <span key="c" style={{ fontWeight: fontWeight.semibold }}>{g.baseCoin}</span>,
                  <span key="n" style={{ color: themeColor.labelSecondary }}>{String(g.count)}</span>,
                  <span key="v">{usd(g.notional)}</span>,
                  <span key="s" style={{ color: g.netSide === 'Long' ? themeColor.green : g.netSide === 'Short' ? themeColor.red : themeColor.labelTertiary, fontWeight: fontWeight.semibold }}>{g.netSide}</span>,
                  <span key="nn" style={{ color: pnlColor(g.netNotional) }}>{usdSigned(g.netNotional)}</span>,
                  <span key="p" style={{ color: pnlColor(g.unrealizedPnl), fontWeight: fontWeight.semibold }}>{usdSigned(g.unrealizedPnl)}</span>,
                ],
              }))}
            />
          )}
        </Card>
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card title={t('crypto.whales.extremesTitle')} subtitle={t('crypto.whales.extremesSubtitle')}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[12] }}>
            <LargestBlock title={t('crypto.whales.largestPosition')} pos={board.largest} mode="notional" />
            <LargestBlock title={t('crypto.whales.largestLoss')} pos={board.largestLoss} mode="pnl" />
          </div>
        </Card>
      </div>

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {board.derived}.
      </p>
    </>
  );
}
