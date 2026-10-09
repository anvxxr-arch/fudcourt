'use client';

/**
 * The spot-ETF flow desk — `/etf`: where the spot-ETF money went, day by day.
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never fabricate an issuer. Older rows ship `ticker: null` upstream;
 *    those rows are grouped under an explicit "unlabelled (upstream)" bucket and
 *    the bucket is styled apart from a real ticker. A made-up name would be the
 *    same lie as a made-up number.
 *  - It must never print a missing number as 0. A field the payload does not
 *    carry renders `—`, never `0` — a zero flow and an absent figure are
 *    different claims.
 *  - It must never let a slice read as the whole window. The recent-days table is
 *    cut at 30 by default and SAYS SO; the per-issuer table states the window it
 *    totals over.
 *  - A failed read is not an empty read; an empty-but-successful payload is a
 *    failure to report, never a blank board.
 *
 * The reading itself lives in `./model.ts` and is pure, so every rule above
 * unit-tests offline against fixed rows.
 */
import { useEffect, useMemo, useState } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, space } from '@/styles/tokens';
import { setBoardStale } from '@/lib/stale-board';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ErrorState, Loading, StaleNotice } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import { fetchEtfSource, type EtfSources } from './client';
import { buildEtfBoard, dayLabel, topIssuers, type EtfBoard } from './model';

/** The recent-days window the board shows by default. */
const RECENT_DAYS = 30;

/** A signed USD magnitude, compacted; a missing number is `—`, never `0`. */
function signedUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const mag =
    abs >= 1e9 ? `$${(abs / 1e9).toFixed(2)}B` : abs >= 1e6 ? `$${(abs / 1e6).toFixed(2)}M` : abs >= 1e3 ? `$${(abs / 1e3).toFixed(1)}K` : `$${abs.toFixed(0)}`;
  return `${v < 0 ? '-' : '+'}${mag}`;
}

/** A signed BTC magnitude, compacted; a missing number is `—`, never `0`. */
function signedBtc(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const mag = abs >= 1000 ? `${(abs / 1000).toFixed(2)}K` : abs >= 1 ? abs.toFixed(2) : abs.toFixed(3);
  return `${v < 0 ? '-' : '+'}${mag} BTC`;
}

/** The tone a signed value carries: any non-negative flow is positive, a missing flow is neutral. */
function tone(v: number | null | undefined): 'positive' | 'negative' | 'neutral' {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'neutral';
  return v >= 0 ? 'positive' : 'negative';
}

/** The colour a signed cell carries. */
function signColor(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return themeColor.labelTertiary;
  return v >= 0 ? themeColor.green : themeColor.red;
}

/** The top-3 issuers of a day, as one compact line. */
function topIssuersText(day: Parameters<typeof topIssuers>[0]): string {
  const top = topIssuers(day);
  if (top.length === 0) return '—';
  return top.map((i) => `${i.ticker} ${signedUsd(i.changeUsd)}`).join(' · ');
}

export default function EtfFlowsPage() {
  const [sources, setSources] = useState<EtfSources | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchEtfSource(ac.signal).then((s) => !ac.signal.aborted && setSources(s));
    return () => ac.abort();
  }, []);
  // Publish this board's staleness to the shell subtitle; cleared on unmount.
  const staleEnvelope = sources?.data?.stale ? sources.data : null;
  useEffect(() => {
    setBoardStale(staleEnvelope ? { source: 'CoinAnk', fetchedAt: staleEnvelope.fetchedAt, ageSec: staleEnvelope.staleAgeSec ?? 0 } : null);
    return () => setBoardStale(null);
  }, [staleEnvelope]);

  const board: EtfBoard | null = useMemo(() => {
    const rows = sources?.data?.data;
    if (!rows || rows.length === 0) return null;
    return buildEtfBoard(rows, { recentDays: RECENT_DAYS });
  }, [sources]);

  if (sources === null) return <Loading what="the ETF flow feed" />;

  if (sources.error) {
    return <ErrorState title="Could not load the ETF flow feed" detail={sources.error} />;
  }

  if (!board) {
    return (
      <ErrorState
        title="The ETF flow feed returned no rows"
        detail="An empty payload that claims success is reported as a failure, not rendered as an empty board."
      />
    );
  }

  const latest = board.latest;

  return (
    <>
      {sources.data?.stale ? (
        <StaleNotice source="CoinAnk" fetchedAt={sources.data.fetchedAt} ageSec={sources.data.staleAgeSec ?? 0} />
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
        <Stat
          label="Latest net flow"
          value={signedUsd(latest?.changeUsd)}
          tone={tone(latest?.changeUsd)}
          hint={latest ? dayLabel(latest.date) : 'no day in the payload'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label="Latest net BTC"
          value={signedBtc(latest?.change)}
          tone={tone(latest?.change)}
          hint={latest ? `${topIssuers(latest).length} issuer(s) listed` : 'no day in the payload'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label="Cumulative net flow"
          value={signedUsd(board.cumulativeChangeUsd)}
          tone={tone(board.cumulativeChangeUsd)}
          hint={`over ${board.dayCount} day(s)`}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label="Days covered"
          value={String(board.dayCount)}
          hint={`${board.windowStart ?? '—'} → ${board.windowEnd ?? '—'}`}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card title="Recent daily flows" subtitle={`the ${board.recentDays}-day recent window — net creations/redemptions and the largest issuers each day`}>
          <DataTable
            head={['Date', 'Net flow (USD)', 'Net BTC', 'Top issuers by |flow|']}
            rows={board.recent.map((day) => ({
              cells: [
                <span key="d" style={{ fontWeight: fontWeight.semibold }}>{dayLabel(day.date)}</span>,
                <span key="u" style={{ color: signColor(day.changeUsd), fontWeight: fontWeight.semibold }}>{signedUsd(day.changeUsd)}</span>,
                <span key="b" style={{ color: signColor(day.change) }}>{signedBtc(day.change)}</span>,
                <span key="t" style={{ color: themeColor.labelSecondary }}>{topIssuersText(day)}</span>,
              ],
            }))}
          />
          <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
            {board.sliceNote}. The latest row is the newest day upstream has published and may be an incomplete session.
          </p>
        </Card>
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card title="Per-issuer totals" subtitle={`summed across all ${board.dayCount} day(s) the payload covers, ranked by absolute flow`}>
          <DataTable
            head={['Issuer', 'Net flow (USD)', 'Net BTC', 'Days present']}
            rows={board.tickerTotals.map((t) => ({
              cells: [
                <span key="k" style={{ fontWeight: fontWeight.semibold, color: t.unlabelled ? themeColor.labelTertiary : themeColor.labelPrimary }}>{t.ticker}</span>,
                <span key="u" style={{ color: signColor(t.totalChangeUsd), fontWeight: fontWeight.semibold }}>{signedUsd(t.totalChangeUsd)}</span>,
                <span key="b" style={{ color: signColor(t.totalChange) }}>{signedBtc(t.totalChange)}</span>,
                <span key="d" style={{ color: themeColor.labelSecondary }}>{t.daysPresent}</span>,
              ],
            }))}
          />
          <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
            Rows the upstream ships without a ticker are grouped as &ldquo;unlabelled (upstream)&rdquo; — a real
            absence, never a fabricated name and never a zero.
          </p>
        </Card>
      </div>

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {board.derived}
      </p>
    </>
  );
}
