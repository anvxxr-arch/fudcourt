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
  recentlyAdded: 'Recently added',
  mostSearched: 'Most searched',
  mostVisited: 'Most visited',
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
  if (!available) {
    return (
      <span style={{ color: themeColor.labelTertiary }} title="the upstream change column is unavailable on this surface">
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
  const src = useSource<CoinsEnvelope>((s) => fetchCoins(s), 'coins');
  const [query, setQuery] = useState('');
  const [dir, setDir] = useState<'desc' | 'asc'>('desc');

  const rows: CoinsRow[] = src?.data?.rows ?? [];
  const board = useMemo(
    () => readCoinsBoard(rows, src?.data?.upstreamTotal ?? null, src?.data?.changeSource),
    [rows, src?.data?.upstreamTotal, src?.data?.changeSource],
  );
  const visible = useMemo(() => filterAndSortCoins(board.rows, query, dir), [board.rows, query, dir]);

  if (src === null) return <Loading what="the coin directory" />;
  if (src.data === null) return <ReadFailure title="Could not load the coin directory" error={src.error} />;
  if (board.rows.length === 0) {
    return (
      <ErrorState
        title="The coin directory came back empty"
        detail="the upstream answered successfully with no rows — an empty board is not a valid read, so this is reported as a failure, not an empty table"
      />
    );
  }

  const topCap = board.topByMarketCap ? board.topByMarketCap.marketCap : null;

  return (
    <Card
      title="Coin directory"
      subtitle="the ranked all-coins list — filter by name, symbol or category; a metric upstream did not publish renders —"
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
        <Stat
          label="Coins listed"
          value={num(board.listed)}
          hint={board.upstreamTotal === null ? 'upstream total not stated' : `of ${board.upstreamTotal} upstream`}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label="Total market cap"
          value={usd(board.totalMarketCapUsd)}
          hint={
            board.totalMarketCapUsd === null
              ? `not totalled — ${board.marketCapStated} of ${board.listed} rows state a cap`
              : `every row states a cap (${board.marketCapStated}/${board.listed})`
          }
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label="Top by market cap"
          value={text(board.topByMarketCap?.name ?? null)}
          hint={board.topByMarketCap ? `${text(board.topByMarketCap.symbol)} · ${usd(topCap)}` : 'no row states a cap'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label="With a 24h change"
          value={board.change.available ? `${board.changeStated} / ${board.listed}` : dash}
          hint={board.change.available ? 'rows that state a 24h change' : 'this mode carries no change column'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[8], marginBottom: space[8] }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name, symbol or category…"
          aria-label="Filter coins"
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
          Market cap {dir === 'desc' ? '↓' : '↑'}
        </button>
        <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>
          showing {visible.length} of {board.listed}
        </span>
      </div>

      {visible.length === 0 ? (
        <ErrorState title="No coin matches the filter" detail={`no row matches “${query.trim()}” — clear the filter to see all ${board.listed} coins`} />
      ) : (
        <DataTable
          head={['Rank', 'Name', 'Symbol', 'Price (USD)', 'Market cap', '24h volume', '24h %', 'Category', 'Listed', 'ATH (USD)']}
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
                  title="Open this coin's detail"
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
        {board.slice.note}. The 24h % column is rendered — for every row: this mode reports{' '}
        <code>changeSource: unavailable</code>, so a 0 there would read as a flat market. A price or cap the upstream
        did not publish is a —, never 0. Click a name to open its detail below.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (3) The discovery widgets — recently added / most searched / most visited.
// ---------------------------------------------------------------------------
function ListingsSection() {
  const src = useSource<ListingsEnvelope>((s) => fetchListings(s), 'listings');
  const nowSec = Math.floor(Date.now() / 1000);
  const board = useMemo(
    () => readListingsBoard(src?.data?.listings ?? null, src?.data?.anchor24h ?? null, src?.data?.anchor7d ?? null),
    [src?.data?.listings, src?.data?.anchor24h, src?.data?.anchor7d],
  );
  const changeCol = readChangeColumn(src?.data?.changeSource);

  if (src === null) return <Loading what="the listings widgets" />;
  if (src.data === null) return <ReadFailure title="Could not load the listings widgets" error={src.error} />;
  if (board.totalShown === 0) {
    return (
      <ErrorState
        title="The listings widgets came back empty"
        detail="the upstream answered successfully with no rows — reported as a failure, not an empty board"
      />
    );
  }

  return (
    <Card
      title="Listings — new & trending"
      subtitle="three upstream discovery widgets; change is derived from histPrices anchors where the widget ships one, em-dash otherwise"
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[12] }}>
        {board.widgets.map((w) => {
          const newest = w.key === 'recentlyAdded' ? w.rows[0] : null;
          const newestDays = newest ? daysSince(newest.listingDate, nowSec) : null;
          return (
            <div key={w.key}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[8] }}>
                <Stat
                  label="Rows"
                  value={num(w.shown)}
                  hint={`upstream anchor24h ${num(w.anchor24h)} · anchor7d ${num(w.anchor7d)}`}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label="24h stated"
                  value={`${w.change24hStated} / ${w.shown}`}
                  hint={w.anchor24hMatch === null ? 'no anchor to check' : w.anchor24hMatch ? 'equals upstream anchor24h' : 'DIFFERS from upstream anchor24h'}
                  tone={w.anchor24hMatch === false ? 'negative' : 'neutral'}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
                />
                <Stat
                  label="7d stated"
                  value={`${w.change7dStated} / ${w.shown}`}
                  hint={w.anchor7dMatch === null ? 'no anchor to check' : w.anchor7dMatch ? 'equals upstream anchor7d' : 'DIFFERS from upstream anchor7d'}
                  tone={w.anchor7dMatch === false ? 'negative' : 'neutral'}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
                />
              </div>

              <DataTable
                head={['Rank', 'Name', 'Symbol', 'Price (USD)', 'Market cap', '24h volume', '24h %', '7d %']}
                rows={w.rows.map((r: ListingsRow) => ({
                  cells: [
                    <span key="rank" style={{ color: themeColor.labelTertiary }}>{num(r.rank)}</span>,
                    <span key="name" style={{ fontWeight: fontWeight.semibold }}>
                      {text(r.name)}
                      <span style={{ color: themeColor.labelTertiary, fontWeight: fontWeight.regular }}>
                        {' '}· {WIDGET_LABEL[w.key]}
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
                  Newest add: {text(newest.name)} ({text(newest.symbol)}), listed {dateOf(newest.listingDate)} —{' '}
                  {newestDays < 1 ? 'under a day' : `${Math.floor(newestDays)} day(s)`} ago.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <p style={footnote}>
        {changeCol.note ? `${changeCol.note}. ` : ''}
        The anchor24h/anchor7d figures are upstream&apos;s own stated row counts for each histPrices anchor; the board
        re-counts the non-null changes and flags any widget where the two disagree. A null change renders —, never 0.
        A rank upstream ships as null renders — too.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (4) The keyed detail panel — three INDEPENDENT reads, one failing never
//     blanks the other two.
// ---------------------------------------------------------------------------
function CoinDetailPanel({ pick }: { pick: CoinPick }) {
  const src = useSource<CoinEnvelope>((s) => fetchCoin(pick.key, s), `coin:${pick.key}`);
  if (src === null) return <Loading what="the coin detail" />;
  if (src.data === null) return <ReadFailure title={`Could not load the detail for ${pick.name}`} error={src.error} />;
  const d: CoinDetail | undefined = src.data.detail;
  if (!d) {
    return (
      <ErrorState
        title={`No detail payload for ${pick.name}`}
        detail="the upstream answered successfully without a detail object — reported as a failure, not an empty card"
      />
    );
  }
  const change = upstreamChangePercent(d.change24h);
  const rowsList: [string, ReactNode][] = [
    ['Price (USD)', fmtPrice(d.priceUsd)],
    ['24h change', <span key="c" style={{ color: changeColor(change) }}>{fmtPct(change)}</span>],
    ['Market cap', usd(d.marketCap)],
    ['Fully diluted cap', usd(d.fullyDilutedMarketCap)],
    ['24h volume', usd(d.volume24h)],
    ['Rank', num(d.rank)],
    ['Available supply', num(d.availableSupply)],
    ['Total supply', num(d.totalSupply)],
    ['Max supply', num(d.maxSupply)],
    ['Circulating', d.circulatingPct === null ? dash : `${d.circulatingPct.toFixed(2)}%`],
    ['ATH (USD)', fmtPrice(d.athUsd)],
    ['ATH date', text(d.athDate)],
    ['From ATH', d.fromAthPct === null ? dash : `${d.fromAthPct.toFixed(2)}%`],
    ['ATL (USD)', fmtPrice(d.atlUsd)],
    ['ATL date', text(d.atlDate)],
    ['From ATL', d.fromAtlPct === null ? dash : `${d.fromAtlPct.toFixed(2)}%`],
    ['Listed', dateOf(d.listingDate)],
    ['Life cycle', text(d.lifeCycle)],
  ];
  return (
    <Card
      title={`Detail — ${text(d.name)} (${text(d.symbol)})`}
      subtitle={`mode=coin&key=${pick.key}; change24h is a percent-scaled number upstream ships (see the model's scale note)`}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: `${space[8]}px ${space[16]}px` }}>
        {rowsList.map(([label, value]) => (
          <div key={label}>
            <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], letterSpacing: letterSpacing.xs }}>{label}</div>
            <div style={{ color: themeColor.labelPrimary, fontSize: fontSize[13] }}>{value}</div>
          </div>
        ))}
      </div>
      <p style={footnote}>
        Every field above is upstream&apos;s own; a null renders —, never 0. circulatingPct, fromAthPct and fromAtlPct
        are percents; change24h is a percent-scaled number (the number is the percent), not a raw ratio.
      </p>
    </Card>
  );
}

function MarketPairsPanel({ pick }: { pick: CoinPick }) {
  const src = useSource<MarketPairsEnvelope>((s) => fetchMarketPairs(pick.key, s), `pairs:${pick.key}`);
  if (src === null) return <Loading what="the market pairs" />;
  if (src.data === null) return <ReadFailure title={`Could not load the market pairs for ${pick.name}`} error={src.error} />;
  const read = readMarketPairs(src.data.data ?? null, src.data.limit);
  if (read.shown === 0) {
    return (
      <ErrorState
        title={`No market pairs for ${pick.name}`}
        detail="the upstream answered successfully with no pairs — reported as a failure, not an empty table (the slug may be unknown to CoinMarketCap)"
      />
    );
  }
  return (
    <Card title={`Market pairs — ${text(read.name)} (${text(read.symbol)})`} subtitle="CoinMarketCap's pair page for this slug; volumes are upstream's own">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[8] }}>
        <Stat
          label="Pairs (total)"
          value={num(read.numMarketPairs)}
          hint="numMarketPairs upstream"
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label="On this page"
          value={num(read.shown)}
          hint={`of ${num(read.numMarketPairs)}`}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
      </div>
      <DataTable
        head={['Exchange', 'Price (USD)', 'Volume (USD)']}
        rows={(src.data.data?.marketPairs ?? []).map((r: MarketPairRow) => ({
          cells: [
            <span key="ex" style={{ fontWeight: fontWeight.semibold }}>{text(r.exchangeName)}</span>,
            <span key="p">{fmtPrice(r.price)}</span>,
            <span key="v">{usd(r.volumeUsd)}</span>,
          ],
        }))}
      />
      <p style={footnote}>{read.note}. The table is that first page, not the whole book; a metric the upstream omitted renders —.</p>
    </Card>
  );
}

function OpenInterestPanel({ symbol }: { symbol: string }) {
  const upper = symbol.toUpperCase();
  const src = useSource<OpenInterestEnvelope>((s) => fetchOpenInterest(upper, s), `oi:${upper}`);
  if (src === null) return <Loading what="the open interest" />;
  if (src.data === null) return <ReadFailure title={`Could not load the open interest for ${upper}`} error={src.error} />;
  const read = readOpenInterest(src.data.data ?? [], upper);
  if (read.shown === 0) {
    return (
      <ErrorState
        title={`No open-interest rows for ${upper}`}
        detail="the upstream answered successfully with no rows — reported as a failure, not an empty table"
      />
    );
  }
  return (
    <Card title={`Open interest — ${upper}`} subtitle="CoinGlass per-exchange open interest for this coin's SYMBOL">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[8] }}>
        <Stat
          label="Exchange rows"
          value={num(read.shown)}
          hint={`CoinGlass symbol ${upper}`}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
      </div>
      <DataTable
        head={['Exchange', 'Symbol', 'Open interest (USD)', '4h OI %', '1h vol %']}
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
        {read.note}. A negative OI change is upstream&apos;s own percent, not our estimate; an absent metric renders —.
      </p>
    </Card>
  );
}

function CoinDetailSection({ pick }: { pick: CoinPick }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[12] }}>
      <CoinDetailPanel pick={pick} />
      <div style={{ display: 'grid', gap: space[12], gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
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
  const [selected, setSelected] = useState<CoinPick | null>(null);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[16] }}>
      <DirectoryBoard selected={selected} onSelect={setSelected} />
      <ListingsSection />
      {selected ? (
        <CoinDetailSection pick={selected} />
      ) : (
        <Card title="Coin detail" subtitle="select a coin above to load its detail, its CoinMarketCap pairs and its CoinGlass open interest">
          <p style={{ margin: 0, fontSize: fontSize[12], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
            No coin selected. The three reads that follow a selection are independent — if one fails it renders its own
            error and the other two stay up.
          </p>
        </Card>
      )}
      <p style={{ margin: 0, fontSize: fontSize[11], color: themeColor.labelTertiary, letterSpacing: letterSpacing.xs, lineHeight: lineHeight.normal }}>
        Three upstream families, one rule: a metric not published renders —, never 0. The directory mode carries no
        change column and says so; the pair table is a first page of the whole book; CoinGlass keys on the symbol, not
        the slug. Nothing here is a recommendation.
      </p>
    </div>
  );
}
