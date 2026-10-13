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
import { useT } from '@/lib/i18n/t';
import { setBoardStale } from '@/lib/stale-board';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { EmptyState, ErrorState, Loading, StaleNotice } from '@/ui/feedback';
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
  const t = useT();
  if (rows.length === 0) return <EmptyState>{t('crypto.derivatives.noFundingRows')}</EmptyState>;
  return (
    <DataTable
      head={[t('crypto.global.headExchange'), t('col.symbol'), t('crypto.derivatives.headFundingRate'), t('crypto.derivatives.headOriginalSymbol')]}
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
  const t = useT();
  if (rows.length === 0) return <EmptyState>{t('crypto.derivatives.noVenueRows')}</EmptyState>;
  return (
    <DataTable
      head={[t('crypto.global.headExchange'), t('crypto.derivatives.headTotalTurnover'), t('crypto.derivatives.headLongTurnover'), t('crypto.derivatives.headShortTurnover'), t('crypto.derivatives.headLongRatio'), t('crypto.derivatives.headShortRatio')]}
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
  const t = useT();
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
  // Publish this board's staleness to the shell subtitle; cleared on unmount.
  // Stale if EITHER coinank envelope is a labelled last-good serve — the
  // liquidation read is preferred for its fetchedAt/age when both are.
  const staleEnvelope = liq?.data?.stale ? liq.data : sources?.longShort?.stale ? sources.longShort : null;
  useEffect(() => {
    setBoardStale(staleEnvelope ? { source: 'CoinAnk', fetchedAt: staleEnvelope.fetchedAt, ageSec: staleEnvelope.staleAgeSec ?? 0 } : null);
    return () => setBoardStale(null);
  }, [staleEnvelope]);

  const longShortRows = sources?.longShort?.data ?? null;
  const longShortPage = useMemo(
    () => (longShortRows ? paginate(longShortRows, page, LONGSHORT_PAGE_SIZE) : null),
    [longShortRows, page]
  );
  const funding = sources?.funding?.data ?? null;
  const fundingMin = useMemo(() => (funding ? orderFunding(funding.min, 'min') : []), [funding]);
  const fundingMax = useMemo(() => (funding ? orderFunding(funding.max, 'max') : []), [funding]);

  if (sources === null) return <Loading what={t('crypto.derivatives.loadingWhat')} />;

  const statistics = sources.statistics?.data ?? null;
  const marketRows = sources.markets?.data ?? null;
  const liqRows = liq?.data?.data ?? null;

  return (
    <>
      {liq?.data?.stale ? (
        <StaleNotice
          source={t('crypto.derivatives.staleLiq', { interval })}
          fetchedAt={liq.data.fetchedAt}
          ageSec={liq.data.staleAgeSec ?? 0}
        />
      ) : null}
      {sources.longShort?.stale ? (
        <StaleNotice
          source={t('crypto.derivatives.staleLongShort')}
          fetchedAt={sources.longShort.fetchedAt}
          ageSec={sources.longShort.staleAgeSec ?? 0}
        />
      ) : null}
      {statistics === null ? (
        <ErrorState
          title={t('crypto.derivatives.statsFailTitle')}
          detail={sources.statisticsError ?? t('crypto.derivatives.statsFailDetail')}
        />
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
          <Stat
            label={t('crypto.derivatives.statVolume24h')}
            value={usd(statistics.volUsd)}
            tone={signTone(statistics.volH24Chain)}
            hint={t('crypto.derivatives.hintVsPrior24h', { pct: fmtPct(statistics.volH24Chain) })}
            valueSize={fontSize[17]}
            style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
          />
          <Stat
            label={t('crypto.derivatives.statOpenInterest')}
            value={usd(statistics.openInterest)}
            tone={signTone(statistics.oiH24Chain)}
            hint={t('crypto.derivatives.hintOver24h', { pct: fmtPct(statistics.oiH24Chain) })}
            valueSize={fontSize[17]}
            style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
          />
          <Stat
            label={t('crypto.derivatives.statLiquidations24h')}
            value={usd(statistics.liquidationH24VolUsd)}
            tone={signTone(statistics.lqH24Chain)}
            hint={t('crypto.derivatives.hintLiqEvents', { count: count(statistics.liquidationH24Num), pct: fmtPct(statistics.lqH24Chain) })}
            valueSize={fontSize[17]}
            style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
          />
          <Stat
            label={t('crypto.derivatives.statLongShortSplit')}
            value={`${sharePct(statistics.longRate)} / ${sharePct(statistics.shortRate)}`}
            hint={t('crypto.derivatives.hintLongShortShare')}
            valueSize={fontSize[17]}
            style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
          />
        </div>
      )}

      <div style={{ marginTop: space[12] }}>
        <Card title={t('crypto.derivatives.marketsTitle')} subtitle={t('crypto.derivatives.marketsSubtitle')}>
          {marketRows === null || marketRows.length === 0 ? (
            <ErrorState
              title={t('crypto.derivatives.marketsFailTitle')}
              detail={sources.marketsError ?? t('crypto.derivatives.marketsFailDetail')}
            />
          ) : (
            <DataTable
              head={[t('col.symbol'), t('col.price'), t('crypto.head.change24h'), t('crypto.derivatives.headOpenInterest'), t('crypto.derivatives.headOi24h'), t('crypto.head.volume24h'), t('crypto.derivatives.headAvgFunding'), t('crypto.derivatives.headLiq24h')]}
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
              ? t('crypto.derivatives.marketsServed', { n: sources.markets.upstreamCount })
              : ''}{' '}
            {t('crypto.derivatives.missingFieldNote')}
          </p>
        </Card>
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card
          title={t('crypto.derivatives.liqTitle')}
          subtitle={t('crypto.derivatives.liqSubtitle')}
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
            <Loading what={t('crypto.derivatives.liqLoadingWhat', { interval })} />
          ) : liq.error ? (
            <ErrorState title={t('crypto.derivatives.liqFailTitle', { interval })} detail={liq.error} />
          ) : liqRows === null || liqRows.length === 0 ? (
            <ErrorState
              title={t('crypto.derivatives.liqEmptyTitle', { interval })}
              detail={t('crypto.derivatives.liqEmptyDetail')}
            />
          ) : (
            <LiquidationTable rows={liqRows} />
          )}
          <p style={FOOTNOTE}>
            {t('crypto.derivatives.liqFootnote', { intervals: LIQ_INTERVALS.join(', ') })}
          </p>
        </Card>
      </div>

      <div style={{ marginTop: space[12] }}>
        {funding === null ? (
          <ErrorState
            title={t('crypto.derivatives.fundingFailTitle')}
            detail={sources.fundingError ?? t('crypto.derivatives.fundingFailDetail')}
          />
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[12] }}>
            <div style={{ flex: '1 1 340px', minWidth: 0 }}>
              <Card title={t('crypto.derivatives.fundingNegTitle')} subtitle={t('crypto.derivatives.fundingNegSubtitle')}>
                <FundingTable rows={fundingMin} />
              </Card>
            </div>
            <div style={{ flex: '1 1 340px', minWidth: 0 }}>
              <Card title={t('crypto.derivatives.fundingPosTitle')} subtitle={t('crypto.derivatives.fundingPosSubtitle')}>
                <FundingTable rows={fundingMax} />
              </Card>
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card
          title={t('crypto.derivatives.longShortTitle')}
          subtitle={t('crypto.derivatives.longShortSubtitle')}
        >
          {sources.longShort === null ? (
            <ErrorState
              title={t('crypto.derivatives.longShortFailTitle')}
              detail={sources.longShortError ?? t('crypto.derivatives.longShortFailDetail')}
            />
          ) : longShortPage === null || longShortPage.total === 0 ? (
            <ErrorState
              title={t('crypto.derivatives.longShortEmptyTitle')}
              detail={t('crypto.derivatives.longShortEmptyDetail')}
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
                  {t('crypto.common.prev')}
                </button>
                <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>
                  {t('crypto.derivatives.pageNote', { page: longShortPage.page, pages: longShortPage.pages, from: longShortPage.from, to: longShortPage.to, total: longShortPage.total })}
                </span>
                <button type="button" onClick={() => setPage((p) => Math.min(longShortPage.pages, p + 1))} disabled={longShortPage.page >= longShortPage.pages} style={pagerStyle(longShortPage.page >= longShortPage.pages)}>
                  {t('crypto.common.next')}
                </button>
              </div>
            </>
          )}
          <p style={FOOTNOTE}>
            {t('crypto.derivatives.longShortFootnote', {
              total: longShortPage ? longShortPage.total : dash,
              upstream:
                sources.longShort.upstreamCount !== undefined && sources.longShort.upstreamCount !== longShortPage?.total
                  ? t('crypto.derivatives.longShortUpstreamNote', { n: sources.longShort.upstreamCount })
                  : '',
              pageSize: LONGSHORT_PAGE_SIZE,
            })}
          </p>
        </Card>
      </div>

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {t('crypto.derivatives.routeFootnote')}
      </p>
    </>
  );
}
