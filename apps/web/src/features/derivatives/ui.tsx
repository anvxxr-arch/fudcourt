'use client';

/**
 * The derivatives desk (F12) — `/derivatives`: the futures tape read verbatim
 * from CoinGlass and CoinAnk — open interest, funding extremes, per-venue
 * liquidations and the long/short ratio.
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never print a missing value as 0. In the long/short table a `null`
 *    cell is a REAL absence — that exchange does not list that coin — and it
 *    renders `—`; every other absent figure does the same. A real 0 (a coin with
 *    no liquidations this interval) still renders as its own figure, because a
 *    zero and an absence are different claims.
 *  - It must never ask for an interval the upstream does not serve. An
 *    unsupported liquidation interval answers HTTP 200 with a wall of zeros; the
 *    board offers only the six the sidecar accepts, so a zero never stands in
 *    for "not measured".
 *  - It must never let a page read as the market. CoinAnk serves 726 long/short
 *    rows at a time; the board pages through them and STATES the slice.
 *  - It must never let a failed read read as an empty board. Each source carries
 *    its own error and renders it on its own side.
 *
 * The reading itself lives in `./model.ts` and is pure, so every rule above is
 * unit-tested offline against fixed rows.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, radius, space } from '@/styles/tokens';
import { dash, fmtPrice, fmtPct } from '@/lib/format';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { EmptyState, ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import { fetchDerivativeSources, fetchLiquidation, type DerivativeSources, type LiquidationRead } from './client';
import {
  LIQ_DEFAULT_INTERVAL,
  LIQ_INTERVALS,
  LONGSHORT_PAGE_SIZE,
  LONG_SHORT_RATIO_COLUMNS,
  orderFunding,
  paginate,
  ratioOf,
  type FundingRow,
  type LiqInterval,
  type LiquidationRow,
  type LongShortRow,
} from './model';

/** Compact USD; a missing number is `—`, never `0`. A real 0 renders as `$0.00`. */
function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return dash;
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

/** A funding rate as a percentage at 4dp; a missing number is `—`. */
function fundingPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return dash;
  return `${v.toFixed(4)}%`;
}

/** A share of 100 as a percentage; a missing number is `—`. */
function sharePct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return dash;
  return `${v.toFixed(2)}%`;
}

/** A long/short ratio; a missing/non-finite cell is `—`, never `0`. */
function ratio3(v: number | null): string {
  return v === null ? dash : v.toFixed(3);
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

/** The footnote treatment: muted, small, wrapped. */
const FOOTNOTE: CSSProperties = {
  margin: `${space[8]}px 0 0`,
  fontSize: fontSize[11],
  color: themeColor.labelTertiary,
  lineHeight: lineHeight.normal,
};

/** A chip (interval selector / pager button); the active one is filled blue. */
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
  return {
    ...chipStyle(false),
    opacity: disabled ? 0.4 : 1,
    cursor: disabled ? 'default' : 'pointer',
  };
}

/** The funding rows of one extreme, as a small table. */
function FundingTable({ rows }: { rows: readonly FundingRow[] }) {
  if (rows.length === 0) return <EmptyState>The upstream served no funding rows for this side.</EmptyState>;
  return (
    <DataTable
      head={['Exchange', 'Symbol', 'Funding rate', 'Original symbol']}
      rows={rows.map((r) => ({
        cells: [
          <span key="e" style={{ fontWeight: fontWeight.semibold }}>{r.exchangeName}</span>,
          <span key="s" style={{ color: themeColor.labelSecondary }}>{r.symbol}</span>,
          <span key="f" style={{ color: signColor(r.fundingRate), fontWeight: fontWeight.semibold }}>{fundingPct(r.fundingRate)}</span>,
          <span key="o" style={{ color: themeColor.labelTertiary }}>{r.originalSymbol}</span>,
        ],
      }))}
    />
  );
}

/** The per-venue liquidation table for the selected interval. */
function LiquidationTable({ rows }: { rows: readonly LiquidationRow[] }) {
  if (rows.length === 0) return <EmptyState>The upstream served no venue rows for this interval.</EmptyState>;
  return (
    <DataTable
      head={['Exchange', 'Total turnover', 'Long turnover', 'Short turnover', 'Long ratio', 'Short ratio']}
      rows={rows.map((r) => ({
        cells: [
          <span key="e" style={{ fontWeight: fontWeight.semibold }}>{r.exchangeName}</span>,
          <span key="t">{usd(r.totalTurnover)}</span>,
          <span key="l" style={{ color: themeColor.green }}>{usd(r.longTurnover)}</span>,
          <span key="s" style={{ color: themeColor.red }}>{usd(r.shortTurnover)}</span>,
          <span key="lr" style={{ color: themeColor.labelSecondary }}>{ratio3(r.longRatio)}</span>,
          <span key="sr" style={{ color: themeColor.labelSecondary }}>{ratio3(r.shortRatio)}</span>,
        ],
      }))}
    />
  );
}

export default function DerivativesPage() {
  const [sources, setSources] = useState<DerivativeSources | null>(null);
  const [interval, setInterval] = useState<LiqInterval>(LIQ_DEFAULT_INTERVAL);
  const [liq, setLiq] = useState<LiquidationRead | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const ac = new AbortController();
    fetchDerivativeSources(ac.signal).then((s) => !ac.signal.aborted && setSources(s));
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    setLiq(null);
    fetchLiquidation(interval, ac.signal).then((r) => !ac.signal.aborted && setLiq(r));
    return () => ac.abort();
  }, [interval]);

  const longShortRows = sources?.longShort?.data ?? null;
  const longShortPage = useMemo(
    () => (longShortRows ? paginate(longShortRows, page, LONGSHORT_PAGE_SIZE) : null),
    [longShortRows, page]
  );
  const funding = sources?.funding?.data ?? null;
  const fundingMin = useMemo(() => (funding ? orderFunding(funding.min, 'min') : []), [funding]);
  const fundingMax = useMemo(() => (funding ? orderFunding(funding.max, 'max') : []), [funding]);

  if (sources === null) return <Loading what="the derivatives tape" />;

  const statistics = sources.statistics?.data ?? null;
  const marketRows = sources.markets?.data ?? null;
  const liqRows = liq?.data?.data ?? null;

  return (
    <>
      {statistics === null ? (
        <ErrorState
          title="Could not read the market statistics"
          detail={sources.statisticsError ?? 'the upstream returned an empty payload and named no reason'}
        />
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
          <Stat
            label="24h volume"
            value={usd(statistics.volUsd)}
            tone={signTone(statistics.volH24Chain)}
            hint={`${fmtPct(statistics.volH24Chain)} vs prior 24h`}
            valueSize={fontSize[17]}
            style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
          />
          <Stat
            label="Open interest"
            value={usd(statistics.openInterest)}
            tone={signTone(statistics.oiH24Chain)}
            hint={`${fmtPct(statistics.oiH24Chain)} over 24h`}
            valueSize={fontSize[17]}
            style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
          />
          <Stat
            label="24h liquidations"
            value={usd(statistics.liquidationH24VolUsd)}
            tone={signTone(statistics.lqH24Chain)}
            hint={`${count(statistics.liquidationH24Num)} events · ${fmtPct(statistics.lqH24Chain)} vs prior`}
            valueSize={fontSize[17]}
            style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
          />
          <Stat
            label="Long / short split"
            value={`${sharePct(statistics.longRate)} / ${sharePct(statistics.shortRate)}`}
            hint="long share / short share of the book (they sum to 100)"
            valueSize={fontSize[17]}
            style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
          />
        </div>
      )}

      <div style={{ marginTop: space[12] }}>
        <Card title="Perpetual markets" subtitle="the market tape CoinGlass serves — price, open interest, volume, funding and 24h liquidations">
          {marketRows === null || marketRows.length === 0 ? (
            <ErrorState
              title="Could not read the market tape"
              detail={sources.marketsError ?? 'the upstream returned no rows and named no reason'}
            />
          ) : (
            <DataTable
              head={['Symbol', 'Price', '24h %', 'Open interest', 'OI 24h %', '24h volume', 'Avg funding', 'Liq 24h']}
              rows={marketRows.map((m) => ({
                cells: [
                  <span key="s" style={{ fontWeight: fontWeight.semibold }}>{m.symbol}</span>,
                  <span key="p">{fmtPrice(m.price)}</span>,
                  <span key="c" style={{ color: signColor(m.priceChangePercent) }}>{fmtPct(m.priceChangePercent)}</span>,
                  <span key="o">{usd(m.openInterest)}</span>,
                  <span key="oi" style={{ color: signColor(m.oichangePercent) }}>{fmtPct(m.oichangePercent)}</span>,
                  <span key="v">{usd(m.volUsd)}</span>,
                  <span key="f" style={{ color: signColor(m.avgFundingRate) }}>{fundingPct(m.avgFundingRate)}</span>,
                  <span key="l" style={{ color: themeColor.labelSecondary }}>{usd(m.liqInfo?.totalVolUsd)}</span>,
                ],
              }))}
            />
          )}
          <p style={FOOTNOTE}>
            {sources.markets?.upstreamCount !== undefined
              ? `CoinGlass served ${sources.markets.upstreamCount} rows. `
              : ''}
            A missing field renders as a dash, never a zero.
          </p>
        </Card>
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card
          title="Liquidations by venue"
          subtitle="total / long / short turnover per exchange for the selected window"
          right={
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[4] }}>
              {LIQ_INTERVALS.map((iv) => (
                <button key={iv} type="button" onClick={() => setInterval(iv)} style={chipStyle(iv === interval)}>
                  {iv}
                </button>
              ))}
            </div>
          }
        >
          {liq === null ? (
            <Loading what={`the ${interval} liquidations`} />
          ) : liq.error ? (
            <ErrorState title={`Could not read the ${interval} liquidations`} detail={liq.error} />
          ) : liqRows === null || liqRows.length === 0 ? (
            <ErrorState
              title={`The ${interval} liquidations returned no rows`}
              detail="An empty payload that claims success is reported as a failure, not rendered as an empty board."
            />
          ) : (
            <LiquidationTable rows={liqRows} />
          )}
          <p style={FOOTNOTE}>
            The interval is one of {LIQ_INTERVALS.join(', ')} — the six windows the upstream answers. Any other
            interval answers a wall of zeros, so the board never asks for one and a zero here is a measurement.
          </p>
        </Card>
      </div>

      <div style={{ marginTop: space[12] }}>
        {funding === null ? (
          <ErrorState
            title="Could not read the funding-rate extremes"
            detail={sources.fundingError ?? 'the upstream returned an empty payload and named no reason'}
          />
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[12] }}>
            <div style={{ flex: '1 1 340px', minWidth: 0 }}>
              <Card title="Funding — most negative" subtitle="the 50 most negative rates upstream serves, most negative first">
                <FundingTable rows={fundingMin} />
              </Card>
            </div>
            <div style={{ flex: '1 1 340px', minWidth: 0 }}>
              <Card title="Funding — most positive" subtitle="the 50 most positive rates upstream serves, most positive first">
                <FundingTable rows={fundingMax} />
              </Card>
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card
          title="Long / short ratio"
          subtitle="the book's split per exchange — the columns are the upstream's own ratio families (a*, b*) verbatim"
        >
          {sources.longShort === null ? (
            <ErrorState
              title="Could not read the long/short feed"
              detail={sources.longShortError ?? 'the upstream returned an empty payload and named no reason'}
            />
          ) : longShortPage === null || longShortPage.total === 0 ? (
            <ErrorState
              title="The long/short feed returned no rows"
              detail="An empty payload that claims success is reported as a failure, not rendered as an empty board."
            />
          ) : (
            <>
              <DataTable
                head={['Coin', ...LONG_SHORT_RATIO_COLUMNS]}
                rows={longShortPage.rows.map((r: LongShortRow) => ({
                  cells: [
                    <span key="c" style={{ fontWeight: fontWeight.semibold }}>{r.coinName}</span>,
                    ...LONG_SHORT_RATIO_COLUMNS.map((k) => (
                      <span key={k} style={{ color: ratioOf(r, k) === null ? themeColor.labelTertiary : themeColor.labelSecondary }}>
                        {ratio3(ratioOf(r, k))}
                      </span>
                    )),
                  ],
                }))}
              />
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: space[8], marginTop: space[8] }}>
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={longShortPage.page <= 1} style={pagerStyle(longShortPage.page <= 1)}>
                  ‹ Prev
                </button>
                <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>
                  page {longShortPage.page} / {longShortPage.pages} · rows {longShortPage.from}–{longShortPage.to} of {longShortPage.total}
                </span>
                <button type="button" onClick={() => setPage((p) => Math.min(longShortPage.pages, p + 1))} disabled={longShortPage.page >= longShortPage.pages} style={pagerStyle(longShortPage.page >= longShortPage.pages)}>
                  Next ›
                </button>
              </div>
            </>
          )}
          <p style={FOOTNOTE}>
            The long/short feed is served {longShortPage ? longShortPage.total : dash} rows
            {sources.longShort.upstreamCount !== undefined && sources.longShort.upstreamCount !== longShortPage?.total
              ? ` (upstream reports ${sources.longShort.upstreamCount})`
              : ''}{' '}
            and paged client-side at {LONGSHORT_PAGE_SIZE} per page; the slice in view is stated above. A dash is a
            real absence — that exchange does not list that coin — never a zero.
          </p>
        </Card>
      </div>

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        Every figure is read verbatim from the venue aggregates — CoinGlass for the market tape and the funding
        extremes, CoinAnk for the per-venue liquidations and the long/short ratio. The board derives only the ORDER
        of the funding arrays and the long/short page slice; it estimates nothing about the market. A missing value
        renders as a dash, never a zero, and a failed source renders as an error on its own side, never as an empty
        table.
      </p>
    </>
  );
}
