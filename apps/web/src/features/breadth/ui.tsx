'use client';

/**
 * The crypto-breadth boards (F-breadth) — `/breadth`: RWA, the primary-event
 * calendars, sector rotation and the venue ranking, on one surface.
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never print 0 where the upstream published nothing. Every absent
 *    metric renders `—`; a metric the upstream did not make is not a zero.
 *  - It must never let a slice read as the whole. The RWA index is page 1 of 210
 *    and the event lists ship one SSR page upstream will not paginate — the
 *    board states the slice it read, every time.
 *  - It must never show a change column the surface does not carry. The
 *    categories envelope reports `changeSource: 'unavailable'`; the board says
 *    so in the header and the cells rather than printing a flat 0.
 *  - It must never sum a partial. A "total raise" is stated only when EVERY row
 *    in view states a raise; otherwise the board says "n of m" and no total.
 *  - It must never render an empty-but-successful payload as an empty board. An
 *    upstream that answers 200 with no rows is reported as a failure.
 *
 * The reading itself lives in `./model.ts` and is pure, so every refusal above
 * is unit-tested offline against fixed rows.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, radius, space, letterSpacing } from '@/styles/tokens';
import { dash, fmtPct, fmtPrice } from '@/lib/format';
import { useT } from '@/lib/i18n/t';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import {
  fetchCategories,
  fetchExchanges,
  fetchLaunchpool,
  fetchNodesale,
  fetchRwa,
  fetchRwaAsset,
  type CategoriesEnvelope,
  type ExchangesEnvelope,
  type LaunchpoolEnvelope,
  type NodesaleEnvelope,
  type RwaAssetEnvelope,
  type RwaEnvelope,
  type Source,
} from './client';
import {
  BREADTH_CATEGORY_SLUGS,
  BREADTH_DEFAULT_CATEGORY,
  BREADTH_DEFAULT_EXCHANGE,
  BREADTH_DEFAULT_LP,
  BREADTH_DEFAULT_ND,
  BREADTH_EXCHANGE_LABELS,
  BREADTH_EXCHANGE_LISTS,
  BREADTH_LP_LISTS,
  BREADTH_ND_LISTS,
  readCategoryBoard,
  readEventList,
  readExchangeBoard,
  readRwaAsset,
  readRwaBoard,
  rwaChangePercent,
  type BreadthCategorySlug,
  type BreadthExchangeKey,
  type BreadthLpKey,
  type BreadthNdKey,
  type BreadthRwaRow,
  type EventStatus,
} from './model';

const STATUS_COLOR: Record<EventStatus, string> = {
  upcoming: themeColor.blue,
  active: themeColor.green,
  past: themeColor.labelTertiary,
  unknown: themeColor.orange,
};

/** A compact USD magnitude; null/undefined -> the em dash, never 0. */
function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return dash;
  const abs = Math.abs(v);
  if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/** A string field; absent or '' -> the em dash. */
function text(v: string | null | undefined): string {
  return v === null || v === undefined || v === '' ? dash : v;
}

/** A whole number, thousands-separated; null -> the em dash. */
function num(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? dash : v.toLocaleString('en-US');
}

/** The date part of an upstream ISO instant; null -> the em dash. */
function dateOf(iso: string | null): string {
  return iso ? iso.slice(0, 10) : dash;
}

/** A signed change colour: null and 0 are neutral, not up. */
function changeColor(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v === 0) return themeColor.labelTertiary;
  return v > 0 ? themeColor.green : themeColor.red;
}

/** A node tier price range, e.g. `$51.00` or `$40.00 – $120.00`; both null -> dash. */
function priceRange(lo: number | null, hi: number | null): string {
  if (lo === null && hi === null) return dash;
  if (lo !== null && hi !== null) return lo === hi ? `$${fmtPrice(lo)}` : `$${fmtPrice(lo)} – $${fmtPrice(hi)}`;
  if (lo !== null) return `from $${fmtPrice(lo)}`;
  return `up to $${fmtPrice(hi)}`;
}

/** A per-row share, without the change sign; null -> dash. */
function sharePct(v: number | null): string {
  return v === null || !Number.isFinite(v) ? dash : `${v.toFixed(2)}%`;
}

/** The dashed border-box the four selectors share. */
function selectorStyle(active: boolean): CSSProperties {
  return {
    background: active ? themeColor.blue : themeColor.bgTertiary,
    color: active ? themeColor.labelOnAccent : themeColor.labelSecondary,
    padding: `${space[8]}px ${space[16]}px`,
    border: `1px solid ${themeColor.separator}`,
    borderRadius: radius[8],
    cursor: 'pointer',
    fontSize: fontSize[12],
    fontFamily: 'inherit',
  };
}

/** The keyed RWA-asset `<select>` field (mirrors the directory's field style). */
const fieldStyle: CSSProperties = {
  background: themeColor.bgTertiary,
  color: themeColor.labelPrimary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: `${space[8]}px ${space[12]}px`,
  fontSize: fontSize[13],
  fontFamily: 'inherit',
  // A native <select>'s intrinsic width is its WIDEST <option>, so a long
  // option list ('Ticker · Name', 'Chain · Network') makes the control wider
  // than the card holding it — measured 522px in a 316px box. `maxWidth: 100%`
  // bounds it to its parent; `minWidth: 0` is what lets it actually shrink
  // there as a flex item, since the default `min-width: auto` refuses to go
  // below min-content.
  maxWidth: '100%',
  minWidth: 0,
};

/**
 * One read, keyed by a selector string. The loader closure is re-created each
 * render, but the effect depends on `key` — the SELECTION the read was made for —
 * so switching a selector refetches and an unrelated re-render does not.
 */
function useSource<T>(load: (signal: AbortSignal) => Promise<Source<T>>, key: string): Source<T> | null {
  const [state, setState] = useState<Source<T> | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    setState(null);
    load(ac.signal).then((s) => {
      if (!ac.signal.aborted) setState(s);
    });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/**
 * A row of selector buttons over one allowlist.
 *
 * `aria-pressed` is what carries the selection to assistive tech: the active
 * option was previously distinguishable ONLY by its `background` colour
 * (`selectorStyle`), which is a colour-only signal a screen reader cannot read
 * and a colour-blind reader can miss. The pattern is copied from
 * `features/economy/ui/compare.tsx` and `features/technicals/ui.tsx`, which
 * already do this correctly — it is the house convention, not a new one.
 *
 * Four boards consume this component, so the one attribute fixes all of them.
 */
function Selector<T extends string>({
  options,
  value,
  onChange,
  labelOf,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  labelOf?: (v: T) => string;
}) {
  return (
    <div style={{ display: 'flex', gap: space[8], flexWrap: 'nowrap', overflowX: 'auto', paddingBottom: space[4] }}>
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={o === value} onClick={() => onChange(o)} style={{ ...selectorStyle(o === value), flexShrink: 0 }}>
          {labelOf ? labelOf(o) : o}
        </button>
      ))}
    </div>
  );
}

/** The failure panel for a read that returned nothing — never an empty board. */
function ReadFailure({ title, error }: { title: string; error: string | null }) {
  const t = useT();
  return <ErrorState title={title} detail={error ?? t('crypto.common.upstreamNoRows')} />;
}

// ---------------------------------------------------------------------------
// (1) RWA board — mode=rwa (25 of 210)
// ---------------------------------------------------------------------------
function RwaSection() {
  const t = useT();
  const src = useSource<RwaEnvelope>((s) => fetchRwa(s), 'rwa');
  if (src === null) return <Loading what={t('crypto.breadth.rwaLoadingWhat')} />;
  if (src.data === null) return <ReadFailure title={t('crypto.breadth.rwaLoadFailTitle')} error={src.error} />;

  const board = readRwaBoard(src.data.rwaRows ?? [], src.data.upstreamTotal ?? null);
  if (board.rows.length === 0) {
    return (
      <ErrorState
        title={t('crypto.breadth.rwaEmptyTitle')}
        detail={t('crypto.breadth.rwaEmptyDetail')}
      />
    );
  }

  return (
    <Card
      title={t('crypto.breadth.rwaTitle')}
      subtitle={t('crypto.breadth.rwaSubtitle')}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
        <Stat
          label={t('crypto.breadth.statAssetsShown')}
          value={String(board.slice.shown)}
          hint={board.slice.upstreamTotal === null ? t('crypto.common.upstreamTotalNotStated') : t('crypto.common.ofUpstream', { n: board.slice.upstreamTotal })}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label={t('crypto.breadth.statLeveraged')}
          value={String(board.leveraged)}
          hint={t('crypto.breadth.hintRowsLeveraged')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label={t('crypto.breadth.statTypeMix')}
          value={board.typeMix.length === 0 ? dash : board.typeMix.map((t) => `${t.count} ${t.type}`).join(' · ')}
          hint={t('crypto.breadth.hintRowsByType')}
          valueSize={fontSize[13]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 200px' }}
        />
      </div>

      <DataTable
        head={[t('crypto.head.rank'), t('crypto.breadth.statTicker'), t('crypto.head.name'), t('crypto.breadth.statType'), t('crypto.head.priceUsd'), t('crypto.head.change24h'), t('crypto.head.marketCap'), t('crypto.head.volume24h')]}
        rows={board.rows.map((r: BreadthRwaRow) => {
          const chg = rwaChangePercent(r.change24h);
          return {
            cells: [
              <span key="rank" style={{ color: themeColor.labelTertiary }}>{num(r.rank)}</span>,
              <span key="ticker" style={{ fontWeight: fontWeight.semibold }}>{text(r.ticker)}</span>,
              <span key="name">
                {text(r.name)}
                {r.isLeveraged ? <span style={{ color: themeColor.orange, fontWeight: fontWeight.regular }}>{t('crypto.breadth.leveragedTag')}</span> : null}
              </span>,
              <span key="type" style={{ color: themeColor.labelTertiary }}>{text(r.type)}</span>,
              <span key="price">{fmtPrice(r.priceUsd)}</span>,
              <span key="chg" style={{ color: changeColor(chg) }}>{fmtPct(chg)}</span>,
              <span key="mcap">{usd(r.marketCapUsd)}</span>,
              <span key="vol">{usd(r.volume24hUsd)}</span>,
            ],
          };
        })}
      />
      <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {board.slice.note}. {t('crypto.breadth.rwaFootnote', { slice: text(src.data.slice) })}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (1b) RWA asset drill-down — mode=rwaasset&key=<detailKey> (keyed detail)
// ---------------------------------------------------------------------------

/** One keyed RWA-asset detail read — `mode=rwaasset&key=<detailKey>`. */
function RwaAssetDetailCard({ detailKey }: { detailKey: string }) {
  const t = useT();
  const src = useSource<RwaAssetEnvelope>((s) => fetchRwaAsset(detailKey, s), `rwaasset:${detailKey}`);

  if (src === null) return <Loading what={t('crypto.breadth.assetLoadingWhat', { key: detailKey })} />;
  if (src.data === null) {
    // A 400 (invalid key) or 404 (unknown resource) lands here as the error
    // side — never an empty panel.
    return (
      <ErrorState
        title={t('crypto.breadth.assetLoadFailTitle', { key: detailKey })}
        detail={src.error ?? t('crypto.breadth.assetLoadFailDetail')}
      />
    );
  }
  const asset = src.data.rwaAsset;
  if (!asset) {
    return (
      <ErrorState
        title={t('crypto.breadth.assetEmptyTitle', { key: detailKey })}
        detail={t('crypto.breadth.assetEmptyDetail')}
      />
    );
  }

  const read = readRwaAsset(asset);
  const chg = read.changePercent;
  const tone: 'neutral' | 'positive' | 'negative' =
    chg === null || !Number.isFinite(chg) || chg === 0 ? 'neutral' : chg > 0 ? 'positive' : 'negative';

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
        <Stat
          label={t('crypto.breadth.statTicker')}
          value={text(asset.ticker)}
          hint={text(asset.name)}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label={t('crypto.breadth.statType')}
          value={text(asset.type)}
          hint={t('crypto.breadth.hintKey', { key: detailKey })}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 130px' }}
        />
        <Stat
          label={t('crypto.breadth.statPriceUsd')}
          value={fmtPrice(asset.priceUsd)}
          hint={asset.currency ? t('crypto.breadth.hintQuotedIn', { currency: asset.currency }) : t('crypto.breadth.hintNoQuoteCurrency')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 150px' }}
        />
        <Stat
          label={t('crypto.breadth.stat24h')}
          value={fmtPct(chg)}
          tone={tone}
          hint={t('crypto.breadth.hintChangeFraction')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 150px' }}
        />
        <Stat
          label={t('crypto.breadth.stat24hAbs')}
          value={asset.change24hAbs === null ? dash : fmtPrice(asset.change24hAbs)}
          hint={t('crypto.breadth.hintAbsChange')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label={t('crypto.breadth.statMarketState')}
          value={text(asset.marketState)}
          hint={asset.marketState === null ? t('crypto.breadth.hintNoMarketState') : t('crypto.breadth.hintOwnLabel')}
          valueSize={fontSize[13]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 180px' }}
        />
        <Stat
          label={t('crypto.breadth.statQuoteUpdated')}
          value={text(asset.quoteUpdatedAt)}
          hint={t('crypto.breadth.hintQuoteInstant')}
          valueSize={fontSize[11]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 220px' }}
        />
        <Stat
          label={t('crypto.breadth.statLeveraged')}
          value={asset.isLeveraged ? t('crypto.breadth.yes') : t('crypto.breadth.no')}
          hint={t('crypto.breadth.hintRowLeveraged')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 120px' }}
        />
      </div>
      <p style={{ margin: 0, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {read.marketStateNote}. {t('crypto.breadth.assetFootnote', { slice: text(src.data.slice) })}
      </p>
    </>
  );
}

/** The RWA drill-down — a keyed selector over the `mode=rwa` rows. */
function RwaAssetSection() {
  const t = useT();
  const list = useSource<RwaEnvelope>((s) => fetchRwa(s), 'rwa:asset-list');
  const [selected, setSelected] = useState<string | null>(null);

  if (list === null) return <Loading what={t('crypto.breadth.assetListLoadingWhat')} />;
  if (list.data === null) return <ReadFailure title={t('crypto.breadth.assetListLoadFailTitle')} error={list.error} />;

  const rows = list.data.rwaRows ?? [];
  if (rows.length === 0) {
    return (
      <ErrorState
        title={t('crypto.breadth.assetListEmptyTitle')}
        detail={t('crypto.breadth.assetListEmptyDetail')}
      />
    );
  }

  // The default selection is DERIVED, never hard-coded: the first row's
  // detailKey, so the detail loads with the list instead of needing a click.
  const detailKey = selected ?? rows[0].detailKey;

  return (
    <Card
      title={t('crypto.breadth.assetDrillTitle')}
      subtitle={t('crypto.breadth.assetDrillSubtitle')}
      right={
        <label style={{ display: 'flex', alignItems: 'center', minWidth: 0, gap: space[4], fontSize: fontSize[11], color: themeColor.labelTertiary }}>
          {t('crypto.breadth.assetSelectLabel')}
          <select
            value={detailKey}
            onChange={(e) => setSelected(e.target.value)}
            aria-label={t('crypto.breadth.assetSelectAria')}
            style={fieldStyle}
          >
            {rows.map((r: BreadthRwaRow) => (
              <option key={r.detailKey} value={r.detailKey}>
                {text(r.ticker)} · {text(r.name)}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <RwaAssetDetailCard key={detailKey} detailKey={detailKey} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (2) Launch calendar — mode=launchpool + mode=nodesale, each with a window selector
// ---------------------------------------------------------------------------
function LaunchpoolCard() {
  const t = useT();
  const [variant, setVariant] = useState<BreadthLpKey>(BREADTH_DEFAULT_LP);
  const src = useSource<LaunchpoolEnvelope>((s) => fetchLaunchpool(variant, s), `launchpool:${variant}`);
  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <Card
      title={t('crypto.breadth.launchpoolTitle')}
      subtitle={t('crypto.breadth.launchpoolSubtitle')}
      right={<Selector<BreadthLpKey> options={BREADTH_LP_LISTS} value={variant} onChange={setVariant} />}
    >
      {src === null ? (
        <Loading what={t('crypto.breadth.launchpoolLoadingWhat')} />
      ) : src.data === null ? (
        <ReadFailure title={t('crypto.breadth.launchpoolLoadFailTitle')} error={src.error} />
      ) : (
        (() => {
          const read = readEventList(src.data.launchpoolRows ?? [], nowSec, (r) => r.totalRaiseUsd);
          if (read.shown === 0) {
            return (
              <ErrorState
                title={t('crypto.breadth.launchpoolEmptyTitle', { variant })}
                detail={t('crypto.breadth.launchpoolEmptyDetail')}
              />
            );
          }
          return (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
                <Stat
                  label={t('crypto.breadth.statEventsShown')}
                  value={String(read.shown)}
                  hint={src.data.upstreamTotal ? t('crypto.common.ofUpstream', { n: src.data.upstreamTotal }) : t('crypto.common.upstreamTotalNotStated')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label={t('crypto.breadth.statRaiseStated')}
                  value={`${read.raisedStated} / ${read.shown}`}
                  hint={t('crypto.breadth.hintRowsStateRaise')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label={t('crypto.breadth.statTotalRaise')}
                  value={usd(read.raisedTotalUsd)}
                  hint={read.raisedTotalUsd === null ? t('crypto.breadth.hintNotTotalled') : t('crypto.breadth.hintEveryRowRaise')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
                />
              </div>
              <DataTable
                head={[t('crypto.head.name'), t('crypto.coins.headSymbol'), t('crypto.head.category'), t('col.status'), t('crypto.breadth.headStarts'), t('crypto.breadth.headEnds'), t('crypto.breadth.headTotalRaise')]}
                rows={read.events.map((e) => ({
                  cells: [
                    <span key="n" style={{ fontWeight: fontWeight.semibold }}>{text(e.row.name)}</span>,
                    <span key="s" style={{ color: themeColor.labelTertiary }}>{text(e.row.symbol)}</span>,
                    <span key="c" style={{ color: themeColor.labelTertiary }}>{text(e.row.category)}</span>,
                    <span key="w" style={{ color: STATUS_COLOR[e.window.status] }}>{t(`crypto.breadth.status${e.window.status === 'upcoming' ? 'Upcoming' : e.window.status === 'active' ? 'Active' : e.window.status === 'past' ? 'Past' : 'Unknown'}` as 'crypto.breadth.statusUpcoming')}</span>,
                    <span key="a">{dateOf(e.row.when)}</span>,
                    <span key="b">{dateOf(e.row.till)}</span>,
                    <span key="r">{usd(e.row.totalRaiseUsd)}</span>,
                  ],
                }))}
              />
              <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
                {read.unannounced > 0 ? `${t('crypto.breadth.unannouncedNote', { n: read.unannounced, total: read.shown })} ` : ''}
                {t('crypto.breadth.launchpoolFootnote')}
              </p>
            </>
          );
        })()
      )}
    </Card>
  );
}

function NodesaleCard() {
  const t = useT();
  const [variant, setVariant] = useState<BreadthNdKey>(BREADTH_DEFAULT_ND);
  const src = useSource<NodesaleEnvelope>((s) => fetchNodesale(variant, s), `nodesale:${variant}`);
  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <Card
      title={t('crypto.breadth.nodesaleTitle')}
      subtitle={t('crypto.breadth.nodesaleSubtitle')}
      right={<Selector<BreadthNdKey> options={BREADTH_ND_LISTS} value={variant} onChange={setVariant} />}
    >
      {src === null ? (
        <Loading what={t('crypto.breadth.nodesaleLoadingWhat')} />
      ) : src.data === null ? (
        <ReadFailure title={t('crypto.breadth.nodesaleLoadFailTitle')} error={src.error} />
      ) : (
        (() => {
          const read = readEventList(src.data.nodesaleRows ?? [], nowSec, (r) => r.raiseUsd);
          if (read.shown === 0) {
            return (
              <ErrorState
                title={t('crypto.breadth.nodesaleEmptyTitle', { variant })}
                detail={t('crypto.breadth.nodesaleEmptyDetail')}
              />
            );
          }
          return (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
                <Stat
                  label={t('crypto.breadth.statEventsShown')}
                  value={String(read.shown)}
                  hint={src.data.upstreamTotal ? t('crypto.common.ofUpstream', { n: src.data.upstreamTotal }) : t('crypto.common.upstreamTotalNotStated')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label={t('crypto.breadth.statRaiseStated')}
                  value={`${read.raisedStated} / ${read.shown}`}
                  hint={t('crypto.breadth.hintRowsStateRaise')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label={t('crypto.breadth.statTotalRaise')}
                  value={usd(read.raisedTotalUsd)}
                  hint={read.raisedTotalUsd === null ? t('crypto.breadth.hintNotTotalled') : t('crypto.breadth.hintEveryRowRaise')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
                />
              </div>
              <DataTable
                head={[t('crypto.head.name'), t('crypto.coins.headSymbol'), t('crypto.head.category'), t('col.status'), t('crypto.breadth.headStarts'), t('crypto.breadth.headEnds'), t('crypto.breadth.headNodePrice'), t('crypto.breadth.headRaise')]}
                rows={read.events.map((e) => ({
                  cells: [
                    <span key="n" style={{ fontWeight: fontWeight.semibold }}>{text(e.row.name)}</span>,
                    <span key="s" style={{ color: themeColor.labelTertiary }}>{text(e.row.symbol)}</span>,
                    <span key="c" style={{ color: themeColor.labelTertiary }}>{text(e.row.category)}</span>,
                    <span key="w" style={{ color: STATUS_COLOR[e.window.status] }}>{t(`crypto.breadth.status${e.window.status === 'upcoming' ? 'Upcoming' : e.window.status === 'active' ? 'Active' : e.window.status === 'past' ? 'Past' : 'Unknown'}` as 'crypto.breadth.statusUpcoming')}</span>,
                    <span key="a">{dateOf(e.row.when)}</span>,
                    <span key="b">{dateOf(e.row.till)}</span>,
                    <span key="p">{priceRange(e.row.nodePriceFromUsd, e.row.nodePriceToUsd)}</span>,
                    <span key="r">{usd(e.row.raiseUsd)}</span>,
                  ],
                }))}
              />
              <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
                {read.unannounced > 0 ? `${t('crypto.breadth.unannouncedNote', { n: read.unannounced, total: read.shown })} ` : ''}
                {t('crypto.breadth.nodesaleFootnote')}
              </p>
            </>
          );
        })()
      )}
    </Card>
  );
}

function LaunchCalendarSection() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[12] }}>
      <LaunchpoolCard />
      <NodesaleCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// (3) Sector rotation — mode=categories (28-slug selector)
// ---------------------------------------------------------------------------
function SectorSection() {
  const t = useT();
  const [slug, setSlug] = useState<BreadthCategorySlug>(BREADTH_DEFAULT_CATEGORY);
  const src = useSource<CategoriesEnvelope>((s) => fetchCategories(slug, s), `categories:${slug}`);

  return (
    <Card
      title={t('crypto.breadth.sectorTitle')}
      subtitle={t('crypto.breadth.sectorSubtitle')}
      right={<Selector<BreadthCategorySlug> options={BREADTH_CATEGORY_SLUGS} value={slug} onChange={setSlug} />}
    >
      {src === null ? (
        <Loading what={t('crypto.breadth.sectorLoadingWhat')} />
      ) : src.data === null ? (
        <ReadFailure title={t('crypto.breadth.sectorLoadFailTitle')} error={src.error} />
      ) : (
        (() => {
          const board = readCategoryBoard(src.data.category ?? null, src.data.rows ?? [], src.data.changeSource);
          if (board.rows.length === 0) {
            return (
              <ErrorState
                title={t('crypto.breadth.sectorEmptyTitle', { slug })}
                detail={t('crypto.breadth.sectorEmptyDetail')}
              />
            );
          }
          return (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
                <Stat
                  label={t('crypto.breadth.statSector')}
                  value={text(board.info?.name ?? slug)}
                  hint={t('crypto.breadth.hintSlug', { slug })}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label={t('crypto.breadth.statGainers')}
                  value={num(board.breadth?.gainers ?? null)}
                  tone="positive"
                  hint={t('crypto.breadth.hintOwnCount')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 120px' }}
                />
                <Stat
                  label={t('crypto.breadth.statLosers')}
                  value={num(board.breadth?.losers ?? null)}
                  tone="negative"
                  hint={t('crypto.breadth.hintOwnCount')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 120px' }}
                />
                <Stat
                  label={t('crypto.breadth.statBreadth')}
                  value={num(board.breadth?.total ?? null)}
                  hint={board.breadth === null ? t('crypto.breadth.hintBreadthMissing') : t('crypto.breadth.hintBreadthSum')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 120px' }}
                />
              </div>

              {/* The refusal: no change column on this surface. Stated in the header
                  AND in the cells so it can never read as a flat market. */}
              {!board.change.available ? (
                <p
                  style={{
                    margin: `0 0 ${space[8]}px`,
                    fontSize: fontSize[12],
                    color: themeColor.orange,
                    lineHeight: lineHeight.normal,
                  }}
                >
                  {text(board.change.note)}. {t('crypto.breadth.sectorChangeNote')}
                </p>
              ) : board.change.note ? (
                <p style={{ margin: `0 0 ${space[8]}px`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
                  {board.change.note}.
                </p>
              ) : null}

              <DataTable
                head={[
                  t('crypto.head.rank'),
                  t('crypto.head.name'),
                  t('crypto.coins.headSymbol'),
                  t('crypto.head.priceUsd'),
                  board.change.available ? t('crypto.head.change24h') : t('crypto.sectors.headChangeUnavailable'),
                  t('crypto.head.marketCap'),
                  t('crypto.head.volume24h'),
                ]}
                rows={board.rows.map((r) => {
                  const changeCell: ReactNode = board.change.available ? (
                    <span style={{ color: changeColor(r.change24h) }}>{fmtPct(r.change24h)}</span>
                  ) : (
                    <span style={{ color: themeColor.labelTertiary }} title={t('crypto.sectors.changeUnavailableTitle')}>
                      {dash}
                    </span>
                  );
                  return {
                    cells: [
                      <span key="rank" style={{ color: themeColor.labelTertiary }}>{num(r.rank)}</span>,
                      <span key="name" style={{ fontWeight: fontWeight.semibold }}>{text(r.name)}</span>,
                      <span key="sym" style={{ color: themeColor.labelTertiary }}>{text(r.symbol)}</span>,
                      <span key="price">{fmtPrice(r.priceUsd)}</span>,
                      <span key="chg">{changeCell}</span>,
                      <span key="mcap">{usd(r.marketCap)}</span>,
                      <span key="vol">{usd(r.volume24hUsd)}</span>,
                    ],
                  };
                })}
              />
              <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
                {t('crypto.breadth.sectorFootnote', { count: src.data.count, slice: text(src.data.slice) })}
              </p>
            </>
          );
        })()
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (4) Exchange ranking — mode=exchanges (variant selector)
// ---------------------------------------------------------------------------
function ExchangeSection() {
  const t = useT();
  const [variant, setVariant] = useState<BreadthExchangeKey>(BREADTH_DEFAULT_EXCHANGE);
  const src = useSource<ExchangesEnvelope>((s) => fetchExchanges(variant, s), `exchanges:${variant}`);

  return (
    <Card
      title={t('crypto.breadth.exchangeTitle')}
      subtitle={t('crypto.breadth.exchangeSubtitle')}
      right={
        <Selector<BreadthExchangeKey>
          options={BREADTH_EXCHANGE_LISTS}
          value={variant}
          onChange={setVariant}
          labelOf={(v) => BREADTH_EXCHANGE_LABELS[v]}
        />
      }
    >
      {src === null ? (
        <Loading what={t('crypto.breadth.exchangeLoadingWhat')} />
      ) : src.data === null ? (
        <ReadFailure title={t('crypto.breadth.exchangeLoadFailTitle')} error={src.error} />
      ) : (
        (() => {
          const board = readExchangeBoard(src.data.rows ?? [], variant);
          if (board.rows.length === 0) {
            return (
              <ErrorState
                title={t('crypto.breadth.exchangeEmptyTitle')}
                detail={t('crypto.breadth.exchangeEmptyDetail')}
              />
            );
          }
          return (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
                <Stat
                  label={t('crypto.breadth.statVenuesShown')}
                  value={String(board.rows.length)}
                  hint={t('crypto.breadth.hintRowsOnSurface')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label={t('crypto.breadth.statVolumePage')}
                  value={board.volumeAvailable ? usd(board.dayVolumeShownUsd) : dash}
                  hint={board.volumeAvailable ? t('crypto.breadth.hintSumStated') : t('crypto.breadth.hintNoVolume')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 170px' }}
                />
                <Stat
                  label={t('crypto.breadth.statPairsStated')}
                  value={`${board.pairsStated} / ${board.rows.length}`}
                  hint={t('crypto.breadth.hintRowsStatePairs')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
              </div>

              <DataTable
                head={[t('crypto.head.rank'), t('crypto.head.name'), t('crypto.head.volume24h'), t('crypto.breadth.head7dVolume'), t('crypto.breadth.head30dVolume'), t('crypto.breadth.headShare'), t('crypto.breadth.headPairs')]}
                rows={board.rows.map((r) => ({
                  cells: [
                    <span key="rank" style={{ color: themeColor.labelTertiary }}>{num(r.rank)}</span>,
                    <span key="name" style={{ fontWeight: fontWeight.semibold }}>{text(r.name)}</span>,
                    <span key="d">{usd(r.dayVolUsd)}</span>,
                    <span key="w">{usd(r.weekVolUsd)}</span>,
                    <span key="m">{usd(r.monthVolUsd)}</span>,
                    <span key="s">{sharePct(r.percentVolume)}</span>,
                    <span key="p">{num(r.pairsCount)}</span>,
                  ],
                }))}
              />
              <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
                {t('crypto.breadth.exchangeFootnote', { slice: text(src.data.slice) })}
              </p>
            </>
          );
        })()
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The route surface — four independent boards, one failing read never blanks another.
// ---------------------------------------------------------------------------
export default function BreadthBoards() {
  const t = useT();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[16] }}>
      <RwaSection />
      <RwaAssetSection />
      <LaunchCalendarSection />
      <SectorSection />
      <ExchangeSection />
      <p style={{ margin: 0, fontSize: fontSize[11], color: themeColor.labelTertiary, letterSpacing: letterSpacing.xs, lineHeight: lineHeight.normal }}>
        {t('crypto.breadth.routeFootnote')}
      </p>
    </div>
  );
}
