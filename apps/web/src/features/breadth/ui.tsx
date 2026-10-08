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

/** How the board reads a status for the eye. */
const STATUS_LABEL: Record<EventStatus, string> = {
  upcoming: 'upcoming',
  active: 'live',
  past: 'closed',
  unknown: 'no window',
};
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

/** A row of selector buttons over one allowlist. */
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
        <button key={o} type="button" onClick={() => onChange(o)} style={{ ...selectorStyle(o === value), flexShrink: 0 }}>
          {labelOf ? labelOf(o) : o}
        </button>
      ))}
    </div>
  );
}

/** The failure panel for a read that returned nothing — never an empty board. */
function ReadFailure({ title, error }: { title: string; error: string | null }) {
  return <ErrorState title={title} detail={error ?? 'the upstream returned no rows and named no reason'} />;
}

// ---------------------------------------------------------------------------
// (1) RWA board — mode=rwa (25 of 210)
// ---------------------------------------------------------------------------
function RwaSection() {
  const src = useSource<RwaEnvelope>((s) => fetchRwa(s), 'rwa');
  if (src === null) return <Loading what="the RWA board" />;
  if (src.data === null) return <ReadFailure title="Could not load the RWA board" error={src.error} />;

  const board = readRwaBoard(src.data.rwaRows ?? [], src.data.upstreamTotal ?? null);
  if (board.rows.length === 0) {
    return (
      <ErrorState
        title="The RWA index came back empty"
        detail="the upstream answered successfully with no rows — an empty board is not a valid read, so this is reported as a failure, not an empty table"
      />
    );
  }

  return (
    <Card
      title="RWA board"
      subtitle="tokenized real-world assets — rank, price and cap as CryptoRank ships them; a metric it did not publish renders —"
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
        <Stat
          label="Assets shown"
          value={String(board.slice.shown)}
          hint={board.slice.upstreamTotal === null ? 'upstream total not stated' : `of ${board.slice.upstreamTotal} upstream`}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label="Leveraged"
          value={String(board.leveraged)}
          hint="rows CryptoRank flags leveraged"
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label="Type mix"
          value={board.typeMix.length === 0 ? dash : board.typeMix.map((t) => `${t.count} ${t.type}`).join(' · ')}
          hint="rows on this page by upstream type"
          valueSize={fontSize[13]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 200px' }}
        />
      </div>

      <DataTable
        head={['Rank', 'Ticker', 'Name', 'Type', 'Price (USD)', '24h %', 'Market cap', '24h volume']}
        rows={board.rows.map((r: BreadthRwaRow) => {
          const chg = rwaChangePercent(r.change24h);
          return {
            cells: [
              <span key="rank" style={{ color: themeColor.labelTertiary }}>{num(r.rank)}</span>,
              <span key="ticker" style={{ fontWeight: fontWeight.semibold }}>{text(r.ticker)}</span>,
              <span key="name">
                {text(r.name)}
                {r.isLeveraged ? <span style={{ color: themeColor.orange, fontWeight: fontWeight.regular }}> · leveraged</span> : null}
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
        {board.slice.note}. The 24h % column is upstream&apos;s own change (a fraction upstream, shown as a percent); a blank
        price or cap is a metric upstream did not publish, shown as — rather than 0. CryptoRank&apos;s own slice: {text(src.data.slice)}.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (1b) RWA asset drill-down — mode=rwaasset&key=<detailKey> (keyed detail)
// ---------------------------------------------------------------------------

/** One keyed RWA-asset detail read — `mode=rwaasset&key=<detailKey>`. */
function RwaAssetDetailCard({ detailKey }: { detailKey: string }) {
  const src = useSource<RwaAssetEnvelope>((s) => fetchRwaAsset(detailKey, s), `rwaasset:${detailKey}`);

  if (src === null) return <Loading what={`the ${detailKey} RWA asset`} />;
  if (src.data === null) {
    // A 400 (invalid key) or 404 (unknown resource) lands here as the error
    // side — never an empty panel.
    return (
      <ErrorState
        title={`Could not load the '${detailKey}' RWA asset`}
        detail={src.error ?? 'the upstream returned no asset and named no reason — an invalid key or an unknown resource is reported here, never as an empty panel'}
      />
    );
  }
  const asset = src.data.rwaAsset;
  if (!asset) {
    return (
      <ErrorState
        title={`The '${detailKey}' RWA asset came back empty`}
        detail="the upstream answered successfully with no asset — an empty detail is not a valid read, so this is reported as a failure, not an empty panel"
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
          label="Ticker"
          value={text(asset.ticker)}
          hint={text(asset.name)}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label="Type"
          value={text(asset.type)}
          hint={`key ${detailKey}`}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 130px' }}
        />
        <Stat
          label="Price (USD)"
          value={fmtPrice(asset.priceUsd)}
          hint={asset.currency ? `quoted in ${asset.currency}` : 'upstream stated no quote currency'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 150px' }}
        />
        <Stat
          label="24h %"
          value={fmtPct(chg)}
          tone={tone}
          hint="change24h is a fraction upstream, shown ×100 as a percent"
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 150px' }}
        />
        <Stat
          label="24h change (abs)"
          value={asset.change24hAbs === null ? dash : fmtPrice(asset.change24hAbs)}
          hint="upstream's absolute price change"
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label="Market state"
          value={text(asset.marketState)}
          hint={asset.marketState === null ? 'no marketState upstream — last session close' : "upstream's own label"}
          valueSize={fontSize[13]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 180px' }}
        />
        <Stat
          label="Quote updated"
          value={text(asset.quoteUpdatedAt)}
          hint="upstream's own quote instant"
          valueSize={fontSize[11]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 220px' }}
        />
        <Stat
          label="Leveraged"
          value={asset.isLeveraged ? 'yes' : 'no'}
          hint="row CryptoRank flags leveraged"
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 120px' }}
        />
      </div>
      <p style={{ margin: 0, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {read.marketStateNote}. A blank price, change, market state or quote instant is a metric upstream did not publish,
        shown as — rather than 0. CryptoRank&apos;s own slice: {text(src.data.slice)}.
      </p>
    </>
  );
}

/** The RWA drill-down — a keyed selector over the `mode=rwa` rows. */
function RwaAssetSection() {
  const list = useSource<RwaEnvelope>((s) => fetchRwa(s), 'rwa:asset-list');
  const [selected, setSelected] = useState<string | null>(null);

  if (list === null) return <Loading what="the RWA asset list" />;
  if (list.data === null) return <ReadFailure title="Could not load the RWA asset list" error={list.error} />;

  const rows = list.data.rwaRows ?? [];
  if (rows.length === 0) {
    return (
      <ErrorState
        title="The RWA index came back empty"
        detail="the upstream answered successfully with no rows — an empty selector is not a valid read, so this is reported as a failure, not an empty panel"
      />
    );
  }

  // The default selection is DERIVED, never hard-coded: the first row's
  // detailKey, so the detail loads with the list instead of needing a click.
  const detailKey = selected ?? rows[0].detailKey;

  return (
    <Card
      title="RWA asset drill-down"
      subtitle="one tokenized asset at a time — the key is the row's detailKey; an invalid key or an unknown resource is reported as an error, never an empty panel"
      right={
        <label style={{ display: 'flex', alignItems: 'center', minWidth: 0, gap: space[4], fontSize: fontSize[11], color: themeColor.labelTertiary }}>
          asset
          <select
            value={detailKey}
            onChange={(e) => setSelected(e.target.value)}
            aria-label="Select an RWA asset to load its detail"
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
  const [variant, setVariant] = useState<BreadthLpKey>(BREADTH_DEFAULT_LP);
  const src = useSource<LaunchpoolEnvelope>((s) => fetchLaunchpool(variant, s), `launchpool:${variant}`);
  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <Card
      title="Launchpool events"
      subtitle="primary-launch raises — windows are upstream ISO dates; an unannounced window is named, never guessed"
      right={<Selector<BreadthLpKey> options={BREADTH_LP_LISTS} value={variant} onChange={setVariant} />}
    >
      {src === null ? (
        <Loading what="the launchpool list" />
      ) : src.data === null ? (
        <ReadFailure title="Could not load the launchpool list" error={src.error} />
      ) : (
        (() => {
          const read = readEventList(src.data.launchpoolRows ?? [], nowSec, (r) => r.totalRaiseUsd);
          if (read.shown === 0) {
            return (
              <ErrorState
                title={`No ${variant} launchpool events came back`}
                detail="the upstream answered successfully with no rows — reported as a failure, not an empty calendar"
              />
            );
          }
          return (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
                <Stat
                  label="Events shown"
                  value={String(read.shown)}
                  hint={src.data.upstreamTotal ? `of ${src.data.upstreamTotal} upstream` : 'upstream total not stated'}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label="Raise stated"
                  value={`${read.raisedStated} / ${read.shown}`}
                  hint="rows that state a raise"
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label="Total raise"
                  value={usd(read.raisedTotalUsd)}
                  hint={read.raisedTotalUsd === null ? 'not totalled — some rows state no raise' : 'every row states a raise'}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
                />
              </div>
              <DataTable
                head={['Name', 'Symbol', 'Category', 'Status', 'Starts', 'Ends', 'Total raise']}
                rows={read.events.map((e) => ({
                  cells: [
                    <span key="n" style={{ fontWeight: fontWeight.semibold }}>{text(e.row.name)}</span>,
                    <span key="s" style={{ color: themeColor.labelTertiary }}>{text(e.row.symbol)}</span>,
                    <span key="c" style={{ color: themeColor.labelTertiary }}>{text(e.row.category)}</span>,
                    <span key="w" style={{ color: STATUS_COLOR[e.window.status] }}>{STATUS_LABEL[e.window.status]}</span>,
                    <span key="a">{dateOf(e.row.when)}</span>,
                    <span key="b">{dateOf(e.row.till)}</span>,
                    <span key="r">{usd(e.row.totalRaiseUsd)}</span>,
                  ],
                }))}
              />
              <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
                {read.unannounced > 0 ? `${read.unannounced} of ${read.shown} events have no announced window and are marked “no window”. ` : ''}
                A total is shown only when every row on the page states a raise — otherwise it says “n of m”, because a partial sum
                under a “total” label would understate by the rows it skipped. Upstream ships one SSR page and ignores ?page=.
              </p>
            </>
          );
        })()
      )}
    </Card>
  );
}

function NodesaleCard() {
  const [variant, setVariant] = useState<BreadthNdKey>(BREADTH_DEFAULT_ND);
  const src = useSource<NodesaleEnvelope>((s) => fetchNodesale(variant, s), `nodesale:${variant}`);
  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <Card
      title="Node sales"
      subtitle="node tier sales — nodePriceFrom–To is the upstream tier range (never a market price); raise is upstream's own figure"
      right={<Selector<BreadthNdKey> options={BREADTH_ND_LISTS} value={variant} onChange={setVariant} />}
    >
      {src === null ? (
        <Loading what="the node-sale list" />
      ) : src.data === null ? (
        <ReadFailure title="Could not load the node-sale list" error={src.error} />
      ) : (
        (() => {
          const read = readEventList(src.data.nodesaleRows ?? [], nowSec, (r) => r.raiseUsd);
          if (read.shown === 0) {
            return (
              <ErrorState
                title={`No ${variant} node sales came back`}
                detail="the upstream answered successfully with no rows — reported as a failure, not an empty calendar"
              />
            );
          }
          return (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
                <Stat
                  label="Events shown"
                  value={String(read.shown)}
                  hint={src.data.upstreamTotal ? `of ${src.data.upstreamTotal} upstream` : 'upstream total not stated'}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label="Raise stated"
                  value={`${read.raisedStated} / ${read.shown}`}
                  hint="rows that state a raise"
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label="Total raise"
                  value={usd(read.raisedTotalUsd)}
                  hint={read.raisedTotalUsd === null ? 'not totalled — some rows state no raise' : 'every row states a raise'}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
                />
              </div>
              <DataTable
                head={['Name', 'Symbol', 'Category', 'Status', 'Starts', 'Ends', 'Node price', 'Raise']}
                rows={read.events.map((e) => ({
                  cells: [
                    <span key="n" style={{ fontWeight: fontWeight.semibold }}>{text(e.row.name)}</span>,
                    <span key="s" style={{ color: themeColor.labelTertiary }}>{text(e.row.symbol)}</span>,
                    <span key="c" style={{ color: themeColor.labelTertiary }}>{text(e.row.category)}</span>,
                    <span key="w" style={{ color: STATUS_COLOR[e.window.status] }}>{STATUS_LABEL[e.window.status]}</span>,
                    <span key="a">{dateOf(e.row.when)}</span>,
                    <span key="b">{dateOf(e.row.till)}</span>,
                    <span key="p">{priceRange(e.row.nodePriceFromUsd, e.row.nodePriceToUsd)}</span>,
                    <span key="r">{usd(e.row.raiseUsd)}</span>,
                  ],
                }))}
              />
              <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
                {read.unannounced > 0 ? `${read.unannounced} of ${read.shown} events have no announced window and are marked “no window”. ` : ''}
                Node prices are the upstream tier range in USD, not a market price; a raise is stated only when every row on the
                page states one. Upstream ships one SSR page and ignores ?page=.
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
  const [slug, setSlug] = useState<BreadthCategorySlug>(BREADTH_DEFAULT_CATEGORY);
  const src = useSource<CategoriesEnvelope>((s) => fetchCategories(slug, s), `categories:${slug}`);

  return (
    <Card
      title="Sector rotation"
      subtitle="one sector at a time — the header is CryptoRank's own gainers/losers count; where the change column is absent the board says so"
      right={<Selector<BreadthCategorySlug> options={BREADTH_CATEGORY_SLUGS} value={slug} onChange={setSlug} />}
    >
      {src === null ? (
        <Loading what="the sector board" />
      ) : src.data === null ? (
        <ReadFailure title="Could not load the sector board" error={src.error} />
      ) : (
        (() => {
          const board = readCategoryBoard(src.data.category ?? null, src.data.rows ?? [], src.data.changeSource);
          if (board.rows.length === 0) {
            return (
              <ErrorState
                title={`The ${slug} sector came back empty`}
                detail="the upstream answered successfully with no rows — reported as a failure, not an empty board"
              />
            );
          }
          return (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
                <Stat
                  label="Sector"
                  value={text(board.info?.name ?? slug)}
                  hint={`slug ${slug}`}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label="Gainers"
                  value={num(board.breadth?.gainers ?? null)}
                  tone="positive"
                  hint="CryptoRank's own count"
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 120px' }}
                />
                <Stat
                  label="Losers"
                  value={num(board.breadth?.losers ?? null)}
                  tone="negative"
                  hint="CryptoRank's own count"
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 120px' }}
                />
                <Stat
                  label="Breadth"
                  value={num(board.breadth?.total ?? null)}
                  hint={board.breadth === null ? 'gainers/losers not both stated' : 'gainers + losers'}
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
                  {text(board.change.note)}. The 24h % column below is therefore shown as — for every row, not as 0.
                </p>
              ) : board.change.note ? (
                <p style={{ margin: `0 0 ${space[8]}px`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
                  {board.change.note}.
                </p>
              ) : null}

              <DataTable
                head={[
                  'Rank',
                  'Name',
                  'Symbol',
                  'Price (USD)',
                  board.change.available ? '24h %' : '24h % (unavailable)',
                  'Market cap',
                  '24h volume',
                ]}
                rows={board.rows.map((r) => {
                  const changeCell: ReactNode = board.change.available ? (
                    <span style={{ color: changeColor(r.change24h) }}>{fmtPct(r.change24h)}</span>
                  ) : (
                    <span style={{ color: themeColor.labelTertiary }} title="the upstream change column is unavailable on this surface">
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
                {src.data.count} rows on CryptoRank&apos;s own category page. CryptoRank&apos;s own slice: {text(src.data.slice)}.
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
  const [variant, setVariant] = useState<BreadthExchangeKey>(BREADTH_DEFAULT_EXCHANGE);
  const src = useSource<ExchangesEnvelope>((s) => fetchExchanges(variant, s), `exchanges:${variant}`);

  return (
    <Card
      title="Exchange ranking"
      subtitle="venues by CryptoRank's own reported volume — the reserve-transparency variant carries no volume, so those columns render —"
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
        <Loading what="the exchange ranking" />
      ) : src.data === null ? (
        <ReadFailure title="Could not load the exchange ranking" error={src.error} />
      ) : (
        (() => {
          const board = readExchangeBoard(src.data.rows ?? [], variant);
          if (board.rows.length === 0) {
            return (
              <ErrorState
                title="The exchange ranking came back empty"
                detail="the upstream answered successfully with no rows — reported as a failure, not an empty board"
              />
            );
          }
          return (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
                <Stat
                  label="Venues shown"
                  value={String(board.rows.length)}
                  hint="rows on this surface"
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label="24h volume (page)"
                  value={board.volumeAvailable ? usd(board.dayVolumeShownUsd) : dash}
                  hint={board.volumeAvailable ? 'sum over the rows that state it' : 'this variant publishes no volume'}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 170px' }}
                />
                <Stat
                  label="Pairs stated"
                  value={`${board.pairsStated} / ${board.rows.length}`}
                  hint="rows that state a pair count"
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
              </div>

              <DataTable
                head={['Rank', 'Name', '24h volume', '7d volume', '30d volume', 'Share', 'Pairs']}
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
                {board.note}. A volume the surface did not publish renders — rather than 0. CryptoRank&apos;s own slice: {text(src.data.slice)}.
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
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[16] }}>
      <RwaSection />
      <RwaAssetSection />
      <LaunchCalendarSection />
      <SectorSection />
      <ExchangeSection />
      <p style={{ margin: 0, fontSize: fontSize[11], color: themeColor.labelTertiary, letterSpacing: letterSpacing.xs, lineHeight: lineHeight.normal }}>
        Four upstream tables, one rule: a metric CryptoRank did not publish renders —, never 0. RWA and the event lists are
        page-1 slices and say so; the sector board names the change column it does not carry; nothing here is a recommendation.
      </p>
    </div>
  );
}
