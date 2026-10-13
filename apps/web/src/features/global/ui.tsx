'use client';

/**
 * The global market pulse — `/global`: the whole-market read on one board.
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never print a 0 for a figure the upstream did not state. Total
 *    market cap and 24h volume live at `data.quotes[0]` — an array of ONE — and
 *    an empty quote block is a REAL absence: the stats render `—` and a note
 *    says the quote was absent, rather than a $0 market.
 *  - It must never let the upstream's STRING `totalCount` read as `NaN` or a
 *    silent 0. It is parsed once in the model and stated as a slice.
 *  - It must never imply it sees the whole market. The listing and venue tables
 *    are a 25-row window of the upstream's ranked pages; the slice says so.
 *  - A failed read is not an empty read: each of the three reads resolves to
 *    its own error and is rendered as that error, not as an empty table.
 *
 * The reading itself lives in `./model.ts` and is pure, so every guard above is
 * unit-testable offline against fixed payloads.
 */
import { useEffect, useMemo, useState } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, space } from '@/styles/tokens';
import { dash, fmtPct, fmtPrice, fmtVolume } from '@/lib/format';
import { useT } from '@/lib/i18n/t';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { EmptyState, ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import { CMC_START, fetchGlobalSources, type GlobalSources } from './client';
import { buildGlobalBoard, type GlobalBoard, type Reading } from './model';

/** A statistic table's KPI tile: the shared shape at the repeated-tile size. */
const TILE = { padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' } as const;

/** The tone a signed change paints its tile with; an absent change is neutral. */
function toneOf(v: Reading): 'positive' | 'negative' | 'neutral' {
  if (v === null) return 'neutral';
  return v >= 0 ? 'positive' : 'negative';
}

/** A percentage LEVEL (no sign — dominance is a share, not a move), or `—`. */
function level(v: Reading): string {
  return v === null ? dash : `${v.toFixed(2)}%`;
}

/** A count with thousands separators, or `—`. */
function count(v: Reading): string {
  if (v === null) return dash;
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2);
}

/** A fee the upstream reports as a percent, or `—`. */
function fee(v: Reading): string {
  return v === null ? dash : `${v}%`;
}

/** A gas price in gwei, or `—`. */
function gwei(v: Reading): string {
  return v === null ? dash : `${v.toFixed(1)} gwei`;
}

/** A gas confirmation time in seconds, or `—`. */
function secs(v: Reading): string {
  return v === null ? dash : `~${Math.round(v)}s`;
}

/** One gas tier: its name, its price and how long it is expected to take. */
function GasTier({ label, gweiValue, seconds }: { label: string; gweiValue: Reading; seconds: Reading }) {
  return (
    <div style={{ flex: '1 1 120px' }}>
      <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>{label}</div>
      <div style={{ color: themeColor.labelPrimary, fontSize: fontSize[13], fontWeight: fontWeight.semibold }}>{gwei(gweiValue)}</div>
      <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>{secs(seconds)}</div>
    </div>
  );
}

export default function GlobalPulsePage() {
  const t = useT();
  const [sources, setSources] = useState<GlobalSources | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchGlobalSources(ac.signal).then((s) => !ac.signal.aborted && setSources(s));
    return () => ac.abort();
  }, []);

  const board: GlobalBoard | null = useMemo(() => {
    if (!sources?.global) return null;
    return buildGlobalBoard({
      global: sources.global.data,
      listing: sources.listing?.data ?? null,
      exchanges: sources.exchanges?.data ?? null,
      listingStart: sources.listing?.start ?? CMC_START,
      nowSec: Math.floor(Date.now() / 1000),
    });
  }, [sources]);

  if (sources === null) return <Loading what={t('crypto.global.loadingWhat')} />;

  if (!board) {
    return (
      <ErrorState
        title={t('crypto.global.loadFailTitle')}
        detail={sources.globalError ?? t('crypto.common.upstreamNoRows')}
      />
    );
  }

  const g = board.global;

  return (
    <>
      {/* ---- 1. whole-market stats ---------------------------------------- */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
        <Stat
          label={t('crypto.global.statTotalCap')}
          value={fmtVolume(g.totalMarketCap)}
          hint={g.quoteMissing ? t('crypto.global.hintQuoteMissing') : t('crypto.global.hint24h', { pct: fmtPct(g.marketCap24hChangePct) })}
          tone={toneOf(g.marketCap24hChangePct)}
          valueSize={fontSize[17]}
          style={TILE}
        />
        <Stat
          label={t('crypto.global.statVolume24h')}
          value={fmtVolume(g.totalVolume24h)}
          hint={g.quoteMissing ? t('crypto.global.hintQuoteMissing') : t('crypto.global.hintActivePairs', { n: count(g.activeMarketPairs) })}
          valueSize={fontSize[17]}
          style={TILE}
        />
        <Stat
          label={t('crypto.global.statBtcDominance')}
          value={level(g.btcDominance)}
          hint={t('crypto.global.hintOver24h', { pct: fmtPct(g.btcDominanceChange24h) })}
          tone={toneOf(g.btcDominanceChange24h)}
          valueSize={fontSize[17]}
          style={TILE}
        />
        <Stat
          label={t('crypto.global.statEthDominance')}
          value={level(g.ethDominance)}
          hint={t('crypto.global.hintOver24h', { pct: fmtPct(g.ethDominanceChange24h) })}
          tone={toneOf(g.ethDominanceChange24h)}
          valueSize={fontSize[17]}
          style={TILE}
        />
        <Stat
          label={t('crypto.global.statActiveExchanges')}
          value={count(g.activeExchanges)}
          hint={t('crypto.global.hintOfTracked', { n: count(g.totalExchanges) })}
          valueSize={fontSize[17]}
          style={TILE}
        />
        <Stat
          label={t('crypto.global.statActiveCurrencies')}
          value={count(g.activeCurrencies)}
          hint={t('crypto.global.hintOfTracked', { n: count(g.totalCurrencies) })}
          valueSize={fontSize[17]}
          style={TILE}
        />
      </div>

      {g.quoteMissing && (
        <div style={{ marginTop: space[8] }}>
          <ErrorState
            title={t('crypto.global.noQuoteTitle')}
            detail={t('crypto.global.noQuoteDetail')}
          />
        </div>
      )}

      {/* ---- 2. segment volumes + the gas oracle --------------------------- */}
      <div style={{ marginTop: space[12] }}>
        <Card title={t('crypto.global.segmentsTitle')} subtitle={t('crypto.global.segmentsSubtitle')}>
          <DataTable
            head={[t('crypto.global.headSegment'), t('crypto.head.volume24h'), t('crypto.global.headChange24h'), t('crypto.head.marketCap')]}
            rows={board.segments.map((s) => ({
              cells: [
                <span key="s" style={{ fontWeight: fontWeight.semibold }}>{s.label}</span>,
                <span key="v">{fmtVolume(s.volume24h)}</span>,
                <span key="c" style={{ color: s.changePct24h === null ? themeColor.labelTertiary : (s.changePct24h >= 0 ? themeColor.green : themeColor.red) }}>
                  {fmtPct(s.changePct24h)}
                </span>,
                <span key="m" style={{ color: themeColor.labelTertiary }}>{fmtVolume(s.marketCap)}</span>,
              ],
            }))}
          />

          <div style={{ marginTop: space[12], paddingTop: space[8], borderTop: `1px solid ${themeColor.separator}` }}>
            <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginBottom: space[4] }}>
              {t('crypto.global.gasOracle', { n: count(board.gas.block) })}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
              <GasTier label={t('crypto.global.gasSlow')} gweiValue={board.gas.slowGwei} seconds={board.gas.slowSeconds} />
              <GasTier label={t('crypto.global.gasStandard')} gweiValue={board.gas.standardGwei} seconds={board.gas.standardSeconds} />
              <GasTier label={t('crypto.global.gasFast')} gweiValue={board.gas.fastGwei} seconds={board.gas.fastSeconds} />
            </div>
          </div>
        </Card>
      </div>

      {/* ---- 3. the coin ranking ------------------------------------------ */}
      <div style={{ marginTop: space[12] }}>
        <Card
          title={t('crypto.global.coinsTitle')}
          subtitle={t('crypto.global.coinsSubtitle', { n: board.slice.listingShown })}
        >
          {sources.listingError ? (
            <ErrorState title={t('crypto.global.listingFailTitle')} detail={sources.listingError} />
          ) : board.listing.length === 0 ? (
            <EmptyState>{t('crypto.global.listingEmpty')}</EmptyState>
          ) : (
            <DataTable
              head={[t('crypto.head.rank'), t('col.coin'), t('col.price'), t('crypto.head.change24h'), t('crypto.head.marketCap'), t('crypto.head.volume24h'), t('crypto.global.headDominance')]}
              rows={board.listing.map((c) => ({
                cells: [
                  <span key="r" style={{ color: themeColor.labelTertiary }}>{c.rank}</span>,
                  <span key="n" style={{ fontWeight: fontWeight.semibold }}>
                    {c.name}
                    {c.symbol ? <span style={{ color: themeColor.labelTertiary, fontWeight: fontWeight.regular }}> {c.symbol}</span> : null}
                  </span>,
                  <span key="p">{fmtPrice(c.price)}</span>,
                  <span key="c" style={{ color: c.percentChange24h === null ? themeColor.labelTertiary : (c.percentChange24h >= 0 ? themeColor.green : themeColor.red) }}>
                    {fmtPct(c.percentChange24h)}
                  </span>,
                  <span key="m">{fmtVolume(c.marketCap)}</span>,
                  <span key="v">{fmtVolume(c.volume24h)}</span>,
                  <span key="d" style={{ color: themeColor.labelTertiary }}>{level(c.dominance)}</span>,
                ],
              }))}
            />
          )}
        </Card>
      </div>

      {/* ---- 4. the venue ranking ----------------------------------------- */}
      <div style={{ marginTop: space[12] }}>
        <Card
          title={t('crypto.global.exchangesTitle')}
          subtitle={t('crypto.global.exchangesSubtitle', { n: board.slice.exchangesShown })}
        >
          {sources.exchangesError ? (
            <ErrorState title={t('crypto.global.exchangesFailTitle')} detail={sources.exchangesError} />
          ) : board.exchanges.length === 0 ? (
            <EmptyState>{t('crypto.global.exchangesEmpty')}</EmptyState>
          ) : (
            <DataTable
              head={[t('crypto.global.headExchange'), t('crypto.head.volume24h'), t('crypto.global.headMarketShare'), t('crypto.global.headMarkets'), t('crypto.global.headScore'), t('crypto.global.headMakerTaker')]}
              rows={board.exchanges.map((x) => ({
                cells: [
                  <span key="n" style={{ fontWeight: fontWeight.semibold }}>{x.name}</span>,
                  <span key="v">{fmtVolume(x.totalVol24h)}</span>,
                  <span key="s">{level(x.marketSharePct)}</span>,
                  <span key="m" style={{ color: themeColor.labelTertiary }}>{count(x.numMarkets)}</span>,
                  <span key="sc" style={{ color: themeColor.labelTertiary }}>{count(x.score)}</span>,
                  <span key="f" style={{ color: themeColor.labelTertiary }}>{fee(x.makerFee)} / {fee(x.takerFee)}</span>,
                ],
              }))}
            />
          )}
        </Card>
      </div>

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {board.slice.note}. {board.derived}.
      </p>
    </>
  );
}
