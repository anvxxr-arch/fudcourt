'use client';

/**
 * The sector / tag taxonomy board (F-sectors) — `/sectors`: CryptoRank's topic
 * taxonomy as a ranked index, plus a KEYED detail that loads one tag's page.
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never print 0 where the upstream published nothing. A tag with a
 *    null change (2 of the 183) or a null cap renders `—`, never 0 — a metric
 *    the upstream did not make is not a zero.
 *  - It must never show the detail change column as if it were real. The tag
 *    envelope reports `changeSource: 'unavailable'`; the board says so and
 *    renders `—` in every row rather than a flat 0.
 *  - It must never let a count read as an unqualified total. The gainers/losers
 *    figures are sums OVER THE TAGS THAT STATE THEM, and the board names how
 *    many did (`n of 183`).
 *  - It must never let a slice read as the whole. The taxonomy is 183 rows and a
 *    tag page is paginated client-side 50 at a time; the board states the window
 *    it is showing every time.
 *  - It must never render an upstream 404 (an unknown slug) or an empty-but-
 *    successful payload as an empty table. Both are reported as failures.
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
import { EmptyState, ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import { fetchTag, fetchTags, type Source, type TagEnvelope, type TagsEnvelope } from './client';
import {
  filterAndSortTags,
  pageSlice,
  readTagBoard,
  readTagDetail,
  type TagCoinRow,
  type TagRow,
  type TagSortKey,
} from './model';

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

/** A percent without a sign; null -> the em dash. */
function pct(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? dash : `${v.toFixed(2)}%`;
}

/** A signed change colour: null and 0 are neutral, not up. */
function changeColor(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v === 0) return themeColor.labelTertiary;
  return v > 0 ? themeColor.green : themeColor.red;
}

/** A tag's top coins as a comma list of names; none -> the em dash. */
function coinNames(row: TagRow): string {
  return row.rankedCoins.length === 0 ? dash : row.rankedCoins.map((c) => c.name).join(', ');
}

/** The dashed border-box the field controls share. */
const FIELD_STYLE: CSSProperties = {
  background: themeColor.bgTertiary,
  color: themeColor.labelPrimary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[8]}px`,
  fontSize: fontSize[12],
  fontFamily: 'inherit',
  // A native <select>'s intrinsic width is its WIDEST <option> — the tag list
  // reaches '(P2E)MarketplaceLaunchpadRestakingDePINExchange'. `maxWidth: 100%`
  // bounds it to the card; `minWidth: 0` is what lets it shrink there, since a
  // flex item's default `min-width: auto` refuses to go below min-content.
  maxWidth: '100%',
  minWidth: 0,
};

/** A disabled-aware pagination / sort button. */
function buttonStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    background: active ? themeColor.blue : themeColor.bgTertiary,
    color: disabled ? themeColor.labelTertiary : active ? themeColor.labelOnAccent : themeColor.labelSecondary,
    border: `1px solid ${themeColor.separator}`,
    borderRadius: radius[8],
    padding: `${space[4]}px ${space[8]}px`,
    fontSize: fontSize[12],
    fontFamily: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}

/** A tag name as a link-like button that selects the slug for the detail board. */
const NAME_BUTTON_STYLE: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  margin: 0,
  color: themeColor.blue,
  fontFamily: 'inherit',
  fontSize: fontSize[12],
  fontWeight: fontWeight.semibold,
  cursor: 'pointer',
  textAlign: 'left',
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

const SORT_OPTIONS: { key: TagSortKey; label: 'crypto.sectors.sortMarketCap' | 'crypto.sectors.sortChange24h' | 'crypto.sectors.sortDominance' }[] = [
  { key: 'marketCap', label: 'crypto.sectors.sortMarketCap' },
  { key: 'change24h', label: 'crypto.sectors.sortChange24h' },
  { key: 'dominance', label: 'crypto.sectors.sortDominance' },
];

// ---------------------------------------------------------------------------
// (3) The KEYED detail — mode=tag&key=<slug>
// ---------------------------------------------------------------------------
function TagDetailCard({ slug, tags, onSelect }: { slug: string; tags: TagRow[]; onSelect: (s: string) => void }) {
  const t = useT();
  const nowSec = Math.floor(Date.now() / 1000);
  const src = useSource<TagEnvelope>((s) => fetchTag(slug, s), `tag:${slug}`);
  const [page, setPage] = useState(1);

  const selector = (
    <select value={slug} onChange={(e) => onSelect(e.target.value)} style={FIELD_STYLE} aria-label={t('crypto.sectors.selectAria')}>
      {tags.map((t) => (
        <option key={t.slug} value={t.slug}>
          {t.name}
        </option>
      ))}
    </select>
  );

  const wrap = (children: ReactNode) => (
    <Card
      title={t('crypto.sectors.detailTitle')}
      subtitle={t('crypto.sectors.detailSubtitle')}
      right={selector}
    >
      {children}
    </Card>
  );

  if (src === null) return wrap(<Loading what={t('crypto.sectors.loadingWhat')} />);
  if (src.data === null) {
    return wrap(
      <ErrorState
        title={t('crypto.sectors.loadFailTitle', { slug })}
        detail={t('crypto.sectors.loadFailDetail', { error: src.error ?? t('crypto.common.upstreamNoRows') })}
      />,
    );
  }

  const envelope = src.data;
  const detail = readTagDetail(envelope.tag ?? null, envelope.rows ?? [], envelope.changeSource, nowSec);
  if (detail.rows.length === 0) {
    return wrap(
      <ErrorState
        title={t('crypto.sectors.emptyTitle', { slug })}
        detail={t('crypto.sectors.emptyDetail')}
      />,
    );
  }

  const slice = pageSlice(detail.rows.length, page, 50);
  const visible = detail.rows.slice(slice.start - 1, slice.end);

  return wrap(
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
        <Stat
          label={t('crypto.sectors.statSlug')}
          value={text(detail.info?.slug ?? slug)}
          hint={t('crypto.sectors.hintModeTagKey')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label={t('crypto.sectors.statName')}
          value={text(detail.info?.name)}
          hint={t('crypto.sectors.hintCoinsInTag', { n: detail.rows.length })}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label={t('crypto.sectors.statSubtitle')}
          value={text(detail.info?.subtitle)}
          hint={t('crypto.sectors.hintOwnDescription')}
          valueSize={fontSize[13]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 260px' }}
        />
      </div>

      {/* The refusal: no change column on this surface. Stated in the header AND in
          the cells so it can never read as a flat market. */}
      {!detail.change.available ? (
        <p style={{ margin: `0 0 ${space[8]}px`, fontSize: fontSize[12], color: themeColor.orange, lineHeight: lineHeight.normal }}>
          {t('crypto.sectors.changeUnavailableNote')}
          {detail.change.note ? ` (${detail.change.note})` : ''}.
        </p>
      ) : detail.change.note ? (
        <p style={{ margin: `0 0 ${space[8]}px`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
          {detail.change.note}.
        </p>
      ) : null}

      <DataTable
        head={[t('crypto.head.rank'), t('crypto.head.name'), t('crypto.coins.headSymbol'), t('crypto.head.priceUsd'), t('crypto.head.marketCap'), t('crypto.head.volume24h'), t('crypto.head.category'), t('crypto.head.athUsd'), detail.change.available ? t('crypto.head.change24h') : t('crypto.sectors.headChangeUnavailable')]}
        rows={visible.map((r: TagCoinRow) => {
          const changeCell = detail.change.available ? (
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
              <span key="mcap">{usd(r.marketCap)}</span>,
              <span key="vol">{usd(r.volume24hUsd)}</span>,
              <span key="cat" style={{ color: themeColor.labelTertiary }}>{text(r.category)}</span>,
              <span key="ath">{fmtPrice(r.athUsd)}</span>,
              <span key="chg">{changeCell}</span>,
            ],
          };
        })}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: space[8], marginTop: space[8], flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setPage(slice.page - 1)} disabled={slice.page <= 1} style={buttonStyle(false, slice.page <= 1)}>
          {t('crypto.common.prevCap')}
        </button>
        <span style={{ fontSize: fontSize[12], color: themeColor.labelSecondary }}>
          {t('crypto.sectors.showingTags', { n: slice.note, total: detail.rows.length })} · {t('crypto.sectors.hintPageOf', { page: slice.page, pages: slice.pages })}
        </span>
        <button type="button" onClick={() => setPage(slice.page + 1)} disabled={slice.page >= slice.pages} style={buttonStyle(false, slice.page >= slice.pages)}>
          {t('crypto.common.nextCap')}
        </button>
      </div>

      <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {t('crypto.sectors.detailFootnote', { count: envelope.count, slice: text(envelope.slice) })}
      </p>
    </>,
  );
}

// ---------------------------------------------------------------------------
// The route surface — the taxonomy index, its filter/sort, and the keyed detail.
// ---------------------------------------------------------------------------
export default function SectorsBoard() {
  const t = useT();
  const tags = useSource<TagsEnvelope>((s) => fetchTags(s), 'tags');
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<TagSortKey>('marketCap');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const nowSec = Math.floor(Date.now() / 1000);

  if (tags === null) return <Loading what={t('crypto.sectors.taxonomyLoadingWhat')} />;
  if (tags.data === null) {
    return (
      <ErrorState
        title={t('crypto.sectors.taxonomyLoadFailTitle')}
        detail={t('crypto.sectors.taxonomyLoadFailDetail', { error: tags.error ?? t('crypto.common.upstreamNoRows') })}
      />
    );
  }

  const envelope = tags.data;
  const board = readTagBoard(envelope.tagRows ?? [], envelope.upstreamTotal ?? null, nowSec);
  if (board.rows.length === 0) {
    return (
      <ErrorState
        title={t('crypto.sectors.taxonomyEmptyTitle')}
        detail={t('crypto.common.emptyBoardFailure')}
      />
    );
  }

  const view = filterAndSortTags(board.rows, { query, sortBy });
  const activeSlug = selectedSlug ?? board.topDominance?.slug ?? board.rows[0]?.slug ?? null;
  const sortLabel = t(SORT_OPTIONS.find((o) => o.key === sortBy)?.label ?? 'crypto.sectors.sortMarketCap');

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[16] }}>
      {/* (1) Headline row of Stat cards from mode=tags. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
        <Stat
          label={t('crypto.sectors.statTags')}
          value={String(board.tagCount)}
          hint={board.upstreamTotal === null ? t('crypto.common.upstreamTotalNotStated') : t('crypto.common.ofUpstream', { n: board.upstreamTotal })}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label={t('crypto.sectors.statTopDominance')}
          value={pct(board.topDominance?.dominance ?? null)}
          hint={board.topDominance ? `${board.topDominance.name} · ${board.topDominance.slug}` : t('crypto.sectors.hintNoTagDominance')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 200px' }}
        />
        <Stat
          label={t('crypto.sectors.statGainers')}
          value={board.gainers.stated === 0 ? dash : num(board.gainers.total)}
          tone="positive"
          hint={t('crypto.sectors.hintSumOverTags', { stated: board.gainers.stated, of: board.gainers.of })}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 180px' }}
        />
        <Stat
          label={t('crypto.sectors.statLosers')}
          value={board.losers.stated === 0 ? dash : num(board.losers.total)}
          tone="negative"
          hint={t('crypto.sectors.hintSumOverTags', { stated: board.losers.stated, of: board.losers.of })}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 180px' }}
        />
      </div>

      {/* (2) The taxonomy table — filter over name/description, sort by a metric. */}
      <Card
        title={t('crypto.sectors.cardTitle')}
        subtitle={t('crypto.sectors.cardSubtitle')}
        right={
          <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('crypto.sectors.filterPlaceholder')}
              style={FIELD_STYLE}
              aria-label={t('crypto.sectors.filterAria')}
            />
            {SORT_OPTIONS.map((o) => (
              <button key={o.key} type="button" onClick={() => setSortBy(o.key)} style={buttonStyle(o.key === sortBy, false)}>
                {t(o.label as Parameters<typeof t>[0])}
              </button>
            ))}
          </div>
        }
      >
        <p style={{ margin: `0 0 ${space[8]}px`, fontSize: fontSize[12], color: themeColor.labelSecondary, lineHeight: lineHeight.normal }}>
          {t('crypto.sectors.showingTags', { n: view.length, total: board.rows.length })}
          {query.trim() === '' ? '' : t('crypto.sectors.filteredBy', { query: query.trim() })}
          {t('crypto.sectors.sortedBy', { label: sortLabel, total: text(envelope.upstreamTotal === null ? null : String(envelope.upstreamTotal)) })}
        </p>

        {view.length === 0 ? (
          <EmptyState>{t('crypto.sectors.noMatch', { query: query.trim() })}</EmptyState>
        ) : (
          <DataTable
            head={[t('crypto.head.name'), t('crypto.head.marketCap'), t('crypto.head.volume24h'), t('crypto.sectors.headDominance'), t('crypto.head.change24h'), t('crypto.sectors.headGainers'), t('crypto.sectors.headLosers'), t('crypto.sectors.headTopCoins')]}
            rows={view.map((r) => ({
              cells: [
                <button key="name" type="button" className="fc-hit-24" onClick={() => setSelectedSlug(r.slug)} style={NAME_BUTTON_STYLE} title={t('crypto.sectors.loadTitle', { slug: r.slug })}>
                  {text(r.name)}
                </button>,
                <span key="mcap">{usd(r.marketCap)}</span>,
                <span key="vol">{usd(r.volume24h)}</span>,
                <span key="dom">{pct(r.dominance)}</span>,
                <span key="chg" style={{ color: changeColor(r.change24h) }}>{fmtPct(r.change24h)}</span>,
                <span key="g" style={{ color: themeColor.green }}>{num(r.gainers)}</span>,
                <span key="l" style={{ color: themeColor.red }}>{num(r.losers)}</span>,
                <span key="coins" style={{ color: themeColor.labelTertiary, whiteSpace: 'normal' }}>{coinNames(r)}</span>,
              ],
            }))}
          />
        )}

        <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
          {t('crypto.sectors.taxonomyFootnote', { slice: text(envelope.slice) })}
        </p>
      </Card>

      {/* (3) The KEYED detail for the selected slug. */}
      {activeSlug === null ? (
        <Card title={t('crypto.sectors.detailPlaceholderTitle')} subtitle={t('crypto.sectors.detailPlaceholderSubtitle')}>
          <EmptyState>{t('crypto.sectors.noTagSelected')}</EmptyState>
        </Card>
      ) : (
        <TagDetailCard key={activeSlug} slug={activeSlug} tags={board.rows} onSelect={setSelectedSlug} />
      )}

      <p style={{ margin: 0, fontSize: fontSize[11], color: themeColor.labelTertiary, letterSpacing: letterSpacing.xs, lineHeight: lineHeight.normal }}>
        {t('crypto.sectors.routeFootnote', { count: board.tagCount })}
      </p>
    </div>
  );
}
