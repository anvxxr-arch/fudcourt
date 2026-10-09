'use client';

/**
 * The funding desk — `/funding`: the per-symbol funding-rate matrix read
 * verbatim from CoinAnk's `mode=fundingRate` (885 symbols, each carrying a
 * per-venue funding map across ~11 USDT-margined and ~6 COIN-margined venues).
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never print a missing value as 0. A venue the upstream does not
 *    carry is absent from the map; a rate it ships as `null` renders `—`, never
 *    `0`. A real 0 rate still renders as its own figure, because a zero and an
 *    absence are different claims.
 *  - It must never print a fraction as if it were a percent. The upstream
 *    `fundingRate` is a FRACTION (e.g. 1.049e-05 = 0.001049%); every rate on
 *    this board goes through `fractionToPercent` (×100), and the board states it.
 *  - It must never let a page read as the market. The upstream ships 885
 *    symbols; the board filters, sorts and pages them client-side and STATES the
 *    slice.
 *  - It must never let a failed read read as an empty board. The single source
 *    carries its own error and renders it; an empty-but-200 payload is its own
 *    distinct failure.
 *
 * The reading itself lives in `./model.ts` and is pure, so every rule above is
 * unit-tested offline against fixed rows. The keyed detail reads the SAME
 * already-fetched data — selecting a symbol never refetches.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, radius, space } from '@/styles/tokens';
import { dash, fmtTime } from '@/lib/format';
import { setBoardStale } from '@/lib/stale-board';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { EmptyState, ErrorState, Loading, StaleNotice } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import { fetchFundingRates, type FundingRead } from './client';
import {
  DEFAULT_SORT_DIR,
  SYMBOLS_PAGE_SIZE,
  distinctVenues,
  extremeSymbols,
  filterSymbols,
  nextFundingIn,
  paginate,
  sortSymbols,
  symbolFundings,
  venueRows,
  type FundingSymbolRow,
  type SortDir,
  type SymbolFunding,
  type VenueSide,
} from './model';

/** A percent at 4dp; a missing number is `—`, never `0`. */
function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return dash;
  return `${v.toFixed(4)}%`;
}

/** A plain count, thousands-separated; a missing number is `—`. */
function count(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return dash;
  return v.toLocaleString('en-US');
}

/** The colour a signed value carries; a missing value is muted, never coloured. */
function signColor(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return themeColor.labelTertiary;
  return v >= 0 ? themeColor.green : themeColor.red;
}

/** The `Stat` tone a signed value carries; a missing value reads neutral. */
function signTone(v: number | null | undefined): 'positive' | 'negative' | 'neutral' {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'neutral';
  return v >= 0 ? 'positive' : 'negative';
}

/** A seconds-remaining countdown; a missing/elapsed time is `—`. */
function countdown(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return dash;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** The footnote treatment: muted, small, wrapped. */
const FOOTNOTE: CSSProperties = {
  margin: `${space[8]}px 0 0`,
  fontSize: fontSize[11],
  color: themeColor.labelTertiary,
  lineHeight: lineHeight.normal,
};

/** A chip (side toggle / sort toggle / pager button); the active one is filled blue. */
function chipStyle(active: boolean): CSSProperties {
  return {
    background: active ? themeColor.blue : themeColor.bgSecondary,
    color: active ? themeColor.labelOnAccent : themeColor.labelPrimary,
    border: `1px solid ${themeColor.separator}`,
    borderRadius: radius[8],
    padding: `${space[4]}px ${space[8]}px`,
    cursor: 'pointer',
    fontSize: fontSize[11],
    fontWeight: fontWeight.medium,
  };
}

/** A pager button dimmed when it cannot move. */
function pagerStyle(disabled: boolean): CSSProperties {
  return { ...chipStyle(false), opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' };
}

/** The text filter over the symbol column. */
const INPUT_STYLE: CSSProperties = {
  background: themeColor.bgBase,
  color: themeColor.labelPrimary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[8]}px`,
  fontSize: fontSize[12],
  minWidth: 160,
};

/** A symbol cell that selects the symbol for the keyed detail table. */
const LINK_BUTTON: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  color: themeColor.blue,
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: fontWeight.semibold,
};

/** The per-venue detail table for the selected symbol and side. */
function VenueDetail({ row, side, nowSec }: { row: FundingSymbolRow; side: VenueSide; nowSec: number }) {
  const rows = venueRows(row, side);
  if (rows.length === 0) {
    return (
      <EmptyState>
        {row.symbol} carries no {side === 'umap' ? 'USDT-margined' : 'COIN-margined'} venues in this read.
      </EmptyState>
    );
  }
  return (
    <DataTable
      head={['Venue', 'Type', 'Symbol', 'Funding rate', 'Est. rate', 'Next funding']}
      rows={rows.map((r) => ({
        cells: [
          <span key="v" style={{ fontWeight: fontWeight.semibold }}>{r.venue}</span>,
          <span key="t" style={{ color: themeColor.labelSecondary }}>{r.exchangeType ?? dash}</span>,
          <span key="s" style={{ color: themeColor.labelSecondary }}>{r.symbol ?? dash}</span>,
          <span key="f" style={{ color: signColor(r.fundingRatePct), fontWeight: fontWeight.semibold }}>{pct(r.fundingRatePct)}</span>,
          <span key="e" style={{ color: signColor(r.estimatedRatePct) }}>{pct(r.estimatedRatePct)}</span>,
          <span key="n" style={{ color: themeColor.labelSecondary }}>
            {r.nextFundingTime === null ? dash : `${fmtTime(r.nextFundingTime / 1000)} · ${countdown(nextFundingIn(r.nextFundingTime, nowSec))}`}
          </span>,
        ],
      }))}
    />
  );
}

export default function FundingPage() {
  const [read, setRead] = useState<FundingRead | null>(null);
  const [query, setQuery] = useState('');
  const [dir, setDir] = useState<SortDir>(DEFAULT_SORT_DIR);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [side, setSide] = useState<VenueSide>('umap');
  const [nowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const ac = new AbortController();
    fetchFundingRates(ac.signal).then((r) => !ac.signal.aborted && setRead(r));
    return () => ac.abort();
  }, []);
  // Publish this board's staleness to the shell subtitle; cleared on unmount.
  const staleEnvelope = read?.data?.stale ? read.data : null;
  useEffect(() => {
    setBoardStale(staleEnvelope ? { source: 'CoinAnk', fetchedAt: staleEnvelope.fetchedAt, ageSec: staleEnvelope.staleAgeSec ?? 0 } : null);
    return () => setBoardStale(null);
  }, [staleEnvelope]);

  const rows = read?.data?.data ?? null;

  const summaries = useMemo<SymbolFunding[]>(() => (rows ? symbolFundings(rows, 'umap') : []), [rows]);
  const sorted = useMemo(() => sortSymbols(summaries, dir), [summaries, dir]);
  const filtered = useMemo(() => filterSymbols(sorted, query), [sorted, query]);
  const paged = useMemo(() => paginate(filtered, page, SYMBOLS_PAGE_SIZE), [filtered, page]);

  // The detail reads the SAME already-fetched data — no refetch on selection.
  const selectedRow = useMemo(
    () => (rows && selected !== null ? rows.find((r) => r.symbol === selected) ?? null : null),
    [rows, selected],
  );

  if (read === null) return <Loading what="the funding-rate matrix" />;

  if (read.error) {
    return <ErrorState title="Could not read the funding-rate matrix" detail={read.error} />;
  }

  if (rows === null || rows.length === 0) {
    return (
      <ErrorState
        title="The funding-rate matrix returned no symbols"
        detail="An empty payload that claims success is reported as a failure, not rendered as an empty board."
      />
    );
  }

  const venues = distinctVenues(rows, 'umap');
  const extremes = extremeSymbols(rows, 'umap');
  const activeSymbol = selectedRow ?? (sorted.length > 0 ? rows.find((r) => r.symbol === sorted[0].symbol) ?? null : null);

  return (
    <>
      {read.data?.stale ? (
        <StaleNotice source="CoinAnk" fetchedAt={read.data.fetchedAt} ageSec={read.data.staleAgeSec ?? 0} />
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
        <Stat
          label="Symbols tracked"
          value={count(rows.length)}
          hint="symbols carrying a funding map in this read"
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label="Venues (USDT-margined)"
          value={count(venues.length)}
          hint={venues.join(' · ')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 220px' }}
        />
        <Stat
          label="Highest max funding"
          value={extremes.highestMax ? extremes.highestMax.symbol : dash}
          tone={signTone(extremes.highestMax?.percent ?? null)}
          hint={extremes.highestMax ? `${pct(extremes.highestMax.percent)} — its highest cross-venue USDT rate` : 'no finite rate in this read'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 200px' }}
        />
        <Stat
          label="Lowest min funding"
          value={extremes.lowestMin ? extremes.lowestMin.symbol : dash}
          tone={signTone(extremes.lowestMin?.percent ?? null)}
          hint={extremes.lowestMin ? `${pct(extremes.lowestMin.percent)} — its lowest cross-venue USDT rate` : 'no finite rate in this read'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 200px' }}
        />
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card
          title="Funding-rate matrix"
          subtitle="per symbol, across the USDT-margined venues — filter by symbol, sort by cross-venue mean, paged client-side"
          right={
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[4], alignItems: 'center' }}>
              <input
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="Filter symbol…"
                style={INPUT_STYLE}
              />
              <button type="button" onClick={() => { setDir((d) => (d === 'asc' ? 'desc' : 'asc')); setPage(1); }} style={chipStyle(true)}>
                mean USDT rate {dir === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          }
        >
          {paged.total === 0 ? (
            <EmptyState>No symbol matches “{query}”.</EmptyState>
          ) : (
            <>
              <DataTable
                head={['Symbol', '# venues', 'Min USDT', 'Max USDT', 'Mean USDT']}
                rows={paged.rows.map((r) => ({
                  cells: [
                    <button key="s" type="button" onClick={() => setSelected(r.symbol)} style={LINK_BUTTON}>{r.symbol}</button>,
                    <span key="v" style={{ color: themeColor.labelSecondary }}>{count(r.venueCount)}</span>,
                    <span key="min" style={{ color: signColor(r.min) }}>{pct(r.min)}</span>,
                    <span key="max" style={{ color: signColor(r.max) }}>{pct(r.max)}</span>,
                    <span key="mean" style={{ color: signColor(r.mean), fontWeight: fontWeight.semibold }}>{pct(r.mean)}</span>,
                  ],
                }))}
              />
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: space[8], marginTop: space[8] }}>
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={paged.page <= 1} style={pagerStyle(paged.page <= 1)}>
                  ‹ Prev
                </button>
                <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>
                  page {paged.page} / {paged.pages} · rows {paged.from}–{paged.to} of {paged.total}
                </span>
                <button type="button" onClick={() => setPage((p) => Math.min(paged.pages, p + 1))} disabled={paged.page >= paged.pages} style={pagerStyle(paged.page >= paged.pages)}>
                  Next ›
                </button>
              </div>
            </>
          )}
          <p style={FOOTNOTE}>
            {count(rows.length)} symbols tracked
            {read.data?.upstreamCount !== undefined && read.data.upstreamCount !== rows.length
              ? ` (upstream reports ${count(read.data.upstreamCount)})`
              : ''}
            {query.trim() !== '' ? `, ${count(filtered.length)} matching “${query.trim()}”` : ''}
            {' '}— sorted by cross-venue mean USDT rate, paged at {SYMBOLS_PAGE_SIZE} per page; the slice in view is stated
            above. Every rate is a FRACTION upstream rendered ×100; a missing rate is a dash, never a zero.
          </p>
        </Card>
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card
          title="Venue detail"
          subtitle="one symbol's rates, per venue — read from the same already-fetched data, never refetched"
          right={
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[4] }}>
              <button type="button" onClick={() => setSide('umap')} style={chipStyle(side === 'umap')}>USDT-margined</button>
              <button type="button" onClick={() => setSide('cmap')} style={chipStyle(side === 'cmap')}>COIN-margined</button>
            </div>
          }
        >
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: space[8], marginBottom: space[8] }}>
            <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>Symbol</span>
            <select value={activeSymbol?.symbol ?? ''} onChange={(e) => setSelected(e.target.value)} style={INPUT_STYLE}>
              {sorted.map((s) => (
                <option key={s.symbol} value={s.symbol}>{s.symbol}</option>
              ))}
            </select>
          </div>
          {activeSymbol === null ? (
            <EmptyState>Select a symbol to read its per-venue rates.</EmptyState>
          ) : (
            <VenueDetail row={activeSymbol} side={side} nowSec={nowSec} />
          )}
          <p style={FOOTNOTE}>
            {activeSymbol === null
              ? 'No symbol selected.'
              : `${activeSymbol.symbol}: ${count(venueRows(activeSymbol, side).length)} ${side === 'umap' ? 'USDT-margined' : 'COIN-margined'} venues in this read.`}{' '}
            fundingRate and estimatedRate are FRACTIONS upstream, rendered ×100 as percents; a venue the upstream does not
            carry is simply absent, and a null rate is a dash, never a zero.
          </p>
        </Card>
      </div>

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        Every figure is read verbatim from CoinAnk&apos;s funding-rate feed — the per-symbol matrix of USDT-margined
        (umap) and COIN-margined (cmap) venue rates. The board derives only the cross-venue min/max/mean, the distinct
        venue count, the extremes, the filter/sort and the page slice; it estimates nothing about the market. A missing
        value renders as a dash, never a zero, and a failed read renders as an error, never an empty board.
      </p>
    </>
  );
}
