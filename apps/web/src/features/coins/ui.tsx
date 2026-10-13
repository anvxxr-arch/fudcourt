'use client';

/**
 * The coin directory (F-coins) — `/coins`: the all-coins list, the three
 * discovery widgets, and a per-coin drill down into CoinMarketCap's pairs and
 * CoinGlass's open interest.
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never print 0 where the upstream published nothing. `mode=coins`
 *    carries NO 24h change at all (`changeSource: 'unavailable'`), so every
 *    change cell is `—` and the board says so, rather than a flat 0 that would
 *    read as a market where nothing moved.
 *  - It must never sum a partial under a "total" label. The market-cap total is
 *    stated only when EVERY row in view states a cap; the count of stated caps
 *    accompanies it.
 *  - It must never present a page as the whole book. The pair table says "first
 *    page of N pairs"; the listings widgets name which anchor counts upstream
 *    shipped and whether the derived counts agree.
 *  - It must never blank three panels because one failed. The coin detail, the
 *    market pairs and the open interest each resolve to {data,error} on their
 *    own; a failing read renders its OWN error state.
 *
 * The reading itself lives in `./model.ts` and is pure, so every refusal above
 * is unit-tested offline against fixed rows.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, radius, space, letterSpacing } from '@/styles/tokens';
import { dash, fmtPct, fmtPrice } from '@/lib/format';
import { useT } from '@/lib/i18n/t';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import {
  fetchCoin,
  fetchCoins,
  fetchListings,
  fetchMarketPairs,
  fetchOpenInterest,
  type CoinEnvelope,
  type CoinsEnvelope,
  type ListingsEnvelope,
  type MarketPairsEnvelope,
  type OpenInterestEnvelope,
  type Source,
} from './client';
import {
  daysSince,
  filterAndSortCoins,
  readChangeColumn,
  readCoinsBoard,
  readListingsBoard,
  readMarketPairs,
  readOpenInterest,
  upstreamChangePercent,
  type CoinDetail,
  type CoinsRow,
  type ListingsRow,
  type ListingsWidgetKey,
  type MarketPairRow,
  type OpenInterestRow,
} from './model';

/** Display labels for the three discovery widgets (upstream's own names). */
const WIDGET_LABEL: Record<ListingsWidgetKey, string> = {
  recentlyAdded: 'crypto.coins.widgetRecentlyAdded',
  mostSearched: 'crypto.coins.widgetMostSearched',
  mostVisited: 'crypto.coins.widgetMostVisited',
};

/** The coin the detail panel is keyed to. */
type CoinPick = { key: string; symbol: string; name: string };

// ---------------------------------------------------------------------------
// Display helpers — every one is null-tolerant (`—`, never a fabricated 0).
// ---------------------------------------------------------------------------
function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return dash;
  const abs = Math.abs(v);
  if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

function text(v: string | null | undefined): string {
  return v === null || v === undefined || v === '' ? dash : v;
}

function num(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? dash : v.toLocaleString('en-US');
}

function dateOf(iso: string | null): string {
  return iso ? iso.slice(0, 10) : dash;
}

function changeColor(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v === 0) return themeColor.labelTertiary;
  return v > 0 ? themeColor.green : themeColor.red;
}

/** A change (already a PERCENT-scaled number) with its colour; null -> `—`. */
function ChangeCell({ value, available }: { value: number | null; available: boolean }): ReactNode {
  const t = useT();
  if (!available) {
    return (
      <span style={{ color: themeColor.labelTertiary }} title={t('crypto.coins.changeUnavailableTitle')}>
        {dash}
      </span>
    );
  }
  const p = upstreamChangePercent(value);
  return <span style={{ color: changeColor(p) }}>{fmtPct(p)}</span>;
}

const footnote: CSSProperties = {
  margin: `${space[8]}px 0 0`,
  fontSize: fontSize[11],
  color: themeColor.labelTertiary,
  lineHeight: lineHeight.normal,
};

const buttonStyle: CSSProperties = {
  background: themeColor.bgTertiary,
  color: themeColor.labelSecondary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[8]}px`,
  cursor: 'pointer',
  fontSize: fontSize[12],
  fontFamily: 'inherit',
};

// ---------------------------------------------------------------------------
// One read, keyed by a selector string (mirrors features/breadth + risk).
// ---------------------------------------------------------------------------
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

/** The failure panel for a read that returned nothing — never an empty board. */
function ReadFailure({ title, error }: { title: string; error: string | null }) {
  return <ErrorState title={title} detail={error ?? 'the upstream returned no rows and named no reason'} />;
}

// ---------------------------------------------------------------------------
// (1) + (2) The all-coins directory — headline stats, text filter, cap sort.
// ---------------------------------------------------------------------------
function DirectoryBoard({ selected, onSelect }: { selected: CoinPick | null; onSelect: (p: CoinPick) => void }) {
  const t = useT();
  const src = useSource<CoinsEnvelope>((s) => fetchCoins(s), 'coins');
  const [query, setQuery] = useState('');
  const [dir, setDir] = useState<'desc' | 'asc'>('desc');

  const rows: CoinsRow[] = src?.data?.rows ?? [];
  const board = useMemo(
    () => readCoinsBoard(rows, src?.data?.upstreamTotal ?? null, src?.data?.changeSource),
    [rows, src?.data?.upstreamTotal, src?.data?.changeSource],
  );
  const visible = useMemo(() => filterAndSortCoins(board.rows, query, dir), [board.rows, query, dir]);

  if (src === null) return <Loading what={t('crypto.coins.loadingWhat')} />;
  if (src.data === null) return <ReadFailure title={t('crypto.coins.loadFailTitle')} error={src.error} />;
  if (board.rows.length === 0) {
    return (
      <ErrorState
        title={t('crypto.coins.emptyTitle')}
        detail={t('crypto.common.emptyBoardFailure')}
      />
    );
  }

  const topCap = board.topByMarketCap ? board.topByMarketCap.marketCap : null;

  return (
    <Card
      title={t('crypto.coins.cardTitle')}
      subtitle={t('crypto.coins.cardSubtitle')}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
        <Stat
          label={t('crypto.coins.statListed')}
          value={num(board.listed)}
          hint={board.upstreamTotal === null ? t('crypto.common.upstreamTotalNotStated') : t('crypto.common.ofUpstream', { n: board.upstreamTotal })}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label={t('crypto.coins.statTotalCap')}
          value={usd(board.totalMarketCapUsd)}
          hint={
            board.totalMarketCapUsd === null
              ? t('crypto.coins.hintNotTotalled', { stated: board.marketCapStated, listed: board.listed })
              : t('crypto.coins.hintEveryRowCap', { stated: board.marketCapStated, listed: board.listed })
          }
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label={t('crypto.coins.statTopCap')}
          value={text(board.topByMarketCap?.name ?? null)}
          hint={board.topByMarketCap ? `${text(board.topByMarketCap.symbol)} · ${usd(topCap)}` : t('crypto.coins.hintNoRowCap')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label={t('crypto.coins.statWithChange')}
          value={board.change.available ? `${board.changeStated} / ${board.listed}` : dash}
          hint={board.change.available ? t('crypto.coins.hintRowsStateChange') : t('crypto.coins.hintNoChangeColumn')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[8], marginBottom: space[8] }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('crypto.coins.filterPlaceholder')}
          aria-label={t('crypto.coins.filterAria')}
          style={{
            background: themeColor.bgBase,
            color: themeColor.labelPrimary,
            border: `1px solid ${themeColor.separator}`,
            borderRadius: radius[8],
            padding: `${space[4]}px ${space[8]}px`,
            fontSize: fontSize[12],
            fontFamily: 'inherit',
            minWidth: '220px',
          }}
        />
        <button
          type="button"
          onClick={() => setDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
          style={buttonStyle}
        >
          {t('crypto.coins.sortMarketCap')} {dir === 'desc' ? '↓' : '↑'}
        </button>
        <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>
          {t('crypto.coins.showingCount', { n: visible.length, total: board.listed })}
        </span>
      </div>

      {visible.length === 0 ? (
        <ErrorState title={t('crypto.common.noCoinMatchTitle')} detail={t('crypto.coins.noMatchDetail', { query: query.trim(), total: board.listed })} />
      ) : (
        <DataTable
          head={[t('crypto.head.rank'), t('crypto.head.name'), t('crypto.coins.headSymbol'), t('crypto.head.priceUsd'), t('crypto.head.marketCap'), t('crypto.head.volume24h'), t('crypto.head.change24h'), t('crypto.head.category'), t('crypto.head.listed'), t('crypto.head.athUsd')]}
          rows={visible.map((r) => {
            const isSel = selected?.key === r.key;
            return {
              cells: [
                <span key="rank" style={{ color: themeColor.labelTertiary }}>{num(r.rank)}</span>,
                <button
                  key="name"
                  type="button"
                  onClick={() => onSelect({ key: r.key, symbol: r.symbol, name: r.name })}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    font: 'inherit',
                    color: isSel ? themeColor.blue : themeColor.labelPrimary,
                    fontWeight: isSel ? fontWeight.bold : fontWeight.semibold,
                    textAlign: 'left',
                  }}
                  title={t('crypto.coins.openDetailTitle')}
                >
                  {text(r.name)}
                  {isSel ? ' ●' : ''}
                </button>,
                <span key="sym" style={{ color: themeColor.labelTertiary }}>{text(r.symbol)}</span>,
                <span key="price">{fmtPrice(r.priceUsd)}</span>,
                <span key="mcap">{usd(r.marketCap)}</span>,
                <span key="vol">{usd(r.volume24hUsd)}</span>,
                <span key="c24"><ChangeCell value={r.change24h} available={board.change.available} /></span>,
                <span key="cat" style={{ color: themeColor.labelTertiary }}>{text(r.category)}</span>,
                <span key="listed" style={{ color: themeColor.labelTertiary }}>{dateOf(r.listingDate)}</span>,
                <span key="ath">{fmtPrice(r.athUsd)}</span>,
              ],
            };
          })}
        />
      )}

      <p style={footnote}>
        {t('crypto.coins.footnote')}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (3) The discovery widgets — recently added / most searched / most visited.
// ---------------------------------------------------------------------------
function ListingsSection() {
  const t = useT();
  const src = useSource<ListingsEnvelope>((s) => fetchListings(s), 'listings');
  const nowSec = Math.floor(Date.now() / 1000);
  const board = useMemo(
    () => readListingsBoard(src?.data?.listings ?? null, src?.data?.anchor24h ?? null, src?.data?.anchor7d ?? null),
    [src?.data?.listings, src?.data?.anchor24h, src?.data?.anchor7d],
  );
  const changeCol = readChangeColumn(src?.data?.changeSource);

  if (src === null) return <Loading what={t('crypto.coins.listingsLoadingWhat')} />;
  if (src.data === null) return <ReadFailure title={t('crypto.coins.listingsLoadFailTitle')} error={src.error} />;
  if (board.totalShown === 0) {
    return (
      <ErrorState
        title={t('crypto.coins.listingsEmptyTitle')}
        detail={t('crypto.common.emptyTableFailure')}
      />
    );
  }

  return (
    <Card
      title={t('crypto.coins.listingsCardTitle')}
      subtitle={t('crypto.coins.listingsCardSubtitle')}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[12] }}>
        {board.widgets.map((w) => {
          const newest = w.key === 'recentlyAdded' ? w.rows[0] : null;
          const newestDays = newest ? daysSince(newest.listingDate, nowSec) : null;
          return (
            <div key={w.key}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[8] }}>
                <Stat
                  label={t('crypto.coins.statRows')}
                  value={num(w.shown)}
                  hint={t('crypto.coins.hintAnchors', { h24: num(w.anchor24h), d7: num(w.anchor7d) })}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label={t('crypto.coins.stat24hStated')}
                  value={`${w.change24hStated} / ${w.shown}`}
                  hint={w.anchor24hMatch === null ? t('crypto.coins.hintNoAnchor') : w.anchor24hMatch ? t('crypto.coins.hintEqualsAnchor24h') : t('crypto.coins.hintDiffersAnchor24h')}
                  tone={w.anchor24hMatch === false ? 'negative' : 'neutral'}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
                />
                <Stat
                  label={t('crypto.coins.stat7dStated')}
                  value={`${w.change7dStated} / ${w.shown}`}
                  hint={w.anchor7dMatch === null ? t('crypto.coins.hintNoAnchor') : w.anchor7dMatch ? t('crypto.coins.hintEqualsAnchor7d') : t('crypto.coins.hintDiffersAnchor7d')}
                  tone={w.anchor7dMatch === false ? 'negative' : 'neutral'}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
                />
              </div>

              <DataTable
                head={[t('crypto.head.rank'), t('crypto.head.name'), t('crypto.coins.headSymbol'), t('crypto.head.priceUsd'), t('crypto.head.marketCap'), t('crypto.head.volume24h'), t('crypto.head.change24h'), t('crypto.head.change7d')]}
                rows={w.rows.map((r: ListingsRow) => ({
                  cells: [
                    <span key="rank" style={{ color: themeColor.labelTertiary }}>{num(r.rank)}</span>,
                    <span key="name" style={{ fontWeight: fontWeight.semibold }}>
                      {text(r.name)}
                      <span style={{ color: themeColor.labelTertiary, fontWeight: fontWeight.regular }}>
                        {' '}· {t(WIDGET_LABEL[w.key] as Parameters<typeof t>[0])}
                      </span>
                    </span>,
                    <span key="sym" style={{ color: themeColor.labelTertiary }}>{text(r.symbol)}</span>,
                    <span key="price">{fmtPrice(r.priceUsd)}</span>,
                    <span key="mcap">{usd(r.marketCap)}</span>,
                    <span key="vol">{usd(r.volume24hUsd)}</span>,
                    <span key="c24"><ChangeCell value={r.change24h} available={changeCol.available} /></span>,
                    <span key="c7"><ChangeCell value={r.change7d} available={changeCol.available} /></span>,
                  ],
                }))}
              />
              {w.key === 'recentlyAdded' && newest && newestDays !== null ? (
                <p style={footnote}>
                  {t('crypto.coins.newestAdd', {
                    name: text(newest.name),
                    symbol: text(newest.symbol),
                    date: dateOf(newest.listingDate),
                    age: newestDays < 1 ? t('crypto.coins.ageUnderDay') : t('crypto.coins.ageDays', { n: Math.floor(newestDays) }),
                  })}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <p style={footnote}>
        {changeCol.note ? `${changeCol.note}. ` : ''}
        {t('crypto.coins.listingsFootnote')}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (4) The keyed detail panel — three INDEPENDENT reads, one failing never
//     blanks the other two.
// ---------------------------------------------------------------------------
function CoinDetailPanel({ pick }: { pick: CoinPick }) {
  const t = useT();
  const src = useSource<CoinEnvelope>((s) => fetchCoin(pick.key, s), `coin:${pick.key}`);
  if (src === null) return <Loading what={t('crypto.coins.detailLoadingWhat')} />;
  if (src.data === null) return <ReadFailure title={t('crypto.coins.detailLoadFailTitle', { name: pick.name })} error={src.error} />;
  const d: CoinDetail | undefined = src.data.detail;
  if (!d) {
    return (
      <ErrorState
        title={t('crypto.coins.detailNoPayloadTitle', { name: pick.name })}
        detail={t('crypto.coins.detailNoPayloadDetail')}
      />
    );
  }
  const change = upstreamChangePercent(d.change24h);
  const rowsList: [string, ReactNode][] = [
    [t('crypto.coins.detailPriceUsd'), fmtPrice(d.priceUsd)],
    [t('crypto.coins.detailChange24h'), <span key="c" style={{ color: changeColor(change) }}>{fmtPct(change)}</span>],
    [t('crypto.coins.detailMarketCap'), usd(d.marketCap)],
    [t('crypto.coins.detailFdv'), usd(d.fullyDilutedMarketCap)],
    [t('crypto.coins.detailVolume24h'), usd(d.volume24h)],
    [t('crypto.coins.detailRank'), num(d.rank)],
    [t('crypto.coins.detailAvailableSupply'), num(d.availableSupply)],
    [t('crypto.coins.detailTotalSupply'), num(d.totalSupply)],
    [t('crypto.coins.detailMaxSupply'), num(d.maxSupply)],
    [t('crypto.coins.detailCirculating'), d.circulatingPct === null ? dash : `${d.circulatingPct.toFixed(2)}%`],
    [t('crypto.coins.detailAthUsd'), fmtPrice(d.athUsd)],
    [t('crypto.coins.detailAthDate'), text(d.athDate)],
    [t('crypto.coins.detailFromAth'), d.fromAthPct === null ? dash : `${d.fromAthPct.toFixed(2)}%`],
    [t('crypto.coins.detailAtlUsd'), fmtPrice(d.atlUsd)],
    [t('crypto.coins.detailAtlDate'), text(d.atlDate)],
    [t('crypto.coins.detailFromAtl'), d.fromAtlPct === null ? dash : `${d.fromAtlPct.toFixed(2)}%`],
    [t('crypto.coins.detailListed'), dateOf(d.listingDate)],
    [t('crypto.coins.detailLifeCycle'), text(d.lifeCycle)],
  ];
  return (
    <Card
      title={t('crypto.coins.detailCardTitle', { name: text(d.name), symbol: text(d.symbol) })}
      subtitle={t('crypto.coins.detailCardSubtitle', { key: pick.key })}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(160px, 100%), 1fr))', gap: `${space[8]}px ${space[16]}px` }}>
        {rowsList.map(([label, value]) => (
          <div key={label}>
            <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], letterSpacing: letterSpacing.xs }}>{label}</div>
            <div style={{ color: themeColor.labelPrimary, fontSize: fontSize[13] }}>{value}</div>
          </div>
        ))}
      </div>
      <p style={footnote}>
        {t('crypto.coins.detailFootnote')}
      </p>
    </Card>
  );
}

function MarketPairsPanel({ pick }: { pick: CoinPick }) {
  const t = useT();
  const src = useSource<MarketPairsEnvelope>((s) => fetchMarketPairs(pick.key, s), `pairs:${pick.key}`);
  if (src === null) return <Loading what={t('crypto.coins.pairsLoadingWhat')} />;
  if (src.data === null) return <ReadFailure title={t('crypto.coins.pairsLoadFailTitle', { name: pick.name })} error={src.error} />;
  const read = readMarketPairs(src.data.data ?? null, src.data.limit);
  if (read.shown === 0) {
    return (
      <ErrorState
        title={t('crypto.coins.pairsEmptyTitle', { name: pick.name })}
        detail={t('crypto.coins.pairsEmptyDetail')}
      />
    );
  }
  return (
    <Card title={t('crypto.coins.pairsCardTitle', { name: text(read.name), symbol: text(read.symbol) })} subtitle={t('crypto.coins.pairsCardSubtitle')}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[8] }}>
        <Stat
          label={t('crypto.coins.statPairsTotal')}
          value={num(read.numMarketPairs)}
          hint={t('crypto.coins.hintNumMarketPairs')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label={t('crypto.coins.statOnPage')}
          value={num(read.shown)}
          hint={`of ${num(read.numMarketPairs)}`}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
      </div>
      <DataTable
        head={[t('crypto.head.exchange'), t('crypto.head.priceUsd'), t('crypto.head.volumeUsd')]}
        rows={(src.data.data?.marketPairs ?? []).map((r: MarketPairRow) => ({
          cells: [
            <span key="ex" style={{ fontWeight: fontWeight.semibold }}>{text(r.exchangeName)}</span>,
            <span key="p">{fmtPrice(r.price)}</span>,
            <span key="v">{usd(r.volumeUsd)}</span>,
          ],
        }))}
      />
      <p style={footnote}>{t('crypto.coins.pairsFootnote')}</p>
    </Card>
  );
}

function OpenInterestPanel({ symbol }: { symbol: string }) {
  const t = useT();
  const upper = symbol.toUpperCase();
  const src = useSource<OpenInterestEnvelope>((s) => fetchOpenInterest(upper, s), `oi:${upper}`);
  if (src === null) return <Loading what={t('crypto.coins.oiLoadingWhat')} />;
  if (src.data === null) return <ReadFailure title={t('crypto.coins.oiLoadFailTitle', { symbol: upper })} error={src.error} />;
  const read = readOpenInterest(src.data.data ?? [], upper);
  if (read.shown === 0) {
    return (
      <ErrorState
        title={t('crypto.coins.oiEmptyTitle', { symbol: upper })}
        detail={t('crypto.common.emptyTableFailure')}
      />
    );
  }
  return (
    <Card title={t('crypto.coins.oiCardTitle', { symbol: upper })} subtitle={t('crypto.coins.oiCardSubtitle')}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[8] }}>
        <Stat
          label={t('crypto.coins.statExchangeRows')}
          value={num(read.shown)}
          hint={t('crypto.coins.hintCoinGlassSymbol', { symbol: upper })}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
      </div>
      <DataTable
        head={[t('crypto.head.exchange'), t('crypto.coins.headSymbol'), t('crypto.coins.headOpenInterestUsd'), t('crypto.coins.headOi4h'), t('crypto.coins.headVol1h')]}
        rows={read.rows.map((r: OpenInterestRow) => ({
          cells: [
            <span key="ex" style={{ fontWeight: fontWeight.semibold }}>{text(r.exchangeName)}</span>,
            <span key="sym" style={{ color: themeColor.labelTertiary }}>{text(r.symbol)}</span>,
            <span key="oi">{usd(r.openInterest)}</span>,
            <span key="h4" style={{ color: changeColor(r.h4OIChangePercent) }}>{fmtPct(r.h4OIChangePercent)}</span>,
            <span key="h1" style={{ color: changeColor(r.h1VolChangePercent) }}>{fmtPct(r.h1VolChangePercent)}</span>,
          ],
        }))}
      />
      <p style={footnote}>
        {t('crypto.coins.oiFootnote')}
      </p>
    </Card>
  );
}

function CoinDetailSection({ pick }: { pick: CoinPick }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[12] }}>
      <CoinDetailPanel pick={pick} />
      <div style={{ display: 'grid', gap: space[12], gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
        <MarketPairsPanel pick={pick} />
        <OpenInterestPanel symbol={pick.symbol} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The route surface — a directory board, three discovery widgets, and a keyed
// drill-down. Selecting a coin is the only state they share.
// ---------------------------------------------------------------------------
export default function CoinsDirectory() {
  const t = useT();
  const [selected, setSelected] = useState<CoinPick | null>(null);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[16] }}>
      <DirectoryBoard selected={selected} onSelect={setSelected} />
      <ListingsSection />
      {selected ? (
        <CoinDetailSection pick={selected} />
      ) : (
        <Card title={t('crypto.coins.detailPlaceholderTitle')} subtitle={t('crypto.coins.detailPlaceholderSubtitle')}>
          <p style={{ margin: 0, fontSize: fontSize[12], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
            {t('crypto.coins.detailPlaceholderBody')}
          </p>
        </Card>
      )}
      <p style={{ margin: 0, fontSize: fontSize[11], color: themeColor.labelTertiary, letterSpacing: letterSpacing.xs, lineHeight: lineHeight.normal }}>
        {t('crypto.coins.routeFootnote')}
      </p>
    </div>
  );
}
