'use client';

/**
 * The full price list (screener) — `/screener`: every coin CryptoRank's
 * converter page prices, price only. The widest dataset in the app (the
 * `/coins` board sees only the top 100).
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never print 0 where the upstream published no price. A null price
 *    is the em-dash `—`, and the headline counts those nulls rather than folding
 *    them into a low.
 *  - It must never render all 5413 rows at once (~946 KB). The board filters,
 *    sorts and paginates CLIENT-SIDE at 100/page and states the slice it shows
 *    (`page N of M — rows A–B of 5413`).
 *  - It must never show a change column the mode does not carry. This mode
 *    reports `changeSource: 'unavailable'` — it ships no 24h change at all — so
 *    there is no change cell and the footnote says so, rather than a 0 that
 *    would read as a flat market.
 *  - It must never blank the board because the read failed. A failed read
 *    renders an ErrorState; an empty-but-200 payload is its OWN distinct
 *    failure, not an empty table.
 *
 * The reading itself lives in `./model.ts` and is pure, so every rule above is
 * unit-tested offline against fixed rows.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, radius, space } from '@/styles/tokens';
import { fmtPrice } from '@/lib/format';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import { fetchConverter, type ConverterEnvelope, type Source } from './client';
import {
  SCREENER_PAGE_SIZE,
  filterScreenerRows,
  paginateScreenerRows,
  readScreenerBoard,
  sortScreenerRows,
  type ConverterRow,
  type ScreenerSortDir,
} from './model';

/** An integer count with thousands separators. */
function num(v: number): string {
  return v.toLocaleString('en-US');
}

/** A coin's `Name (SYMBOL)` label, tolerant of a blank symbol. */
function coinLabel(row: ConverterRow): string {
  return row.symbol ? `${row.name} (${row.symbol})` : row.name;
}

/** The dashed pager buttons share this shape. */
function controlStyle(disabled: boolean): CSSProperties {
  return {
    background: themeColor.bgTertiary,
    color: disabled ? themeColor.labelTertiary : themeColor.labelPrimary,
    border: `1px solid ${themeColor.separator}`,
    borderRadius: radius[8],
    padding: `${space[4]}px ${space[8]}px`,
    cursor: disabled ? 'default' : 'pointer',
    fontSize: fontSize[12],
    fontFamily: 'inherit',
    opacity: disabled ? 0.5 : 1,
  };
}

const footnote: CSSProperties = {
  margin: `${space[8]}px 0 0`,
  fontSize: fontSize[11],
  color: themeColor.labelTertiary,
  lineHeight: lineHeight.normal,
};

export default function ScreenerPage() {
  const [src, setSrc] = useState<Source<ConverterEnvelope> | null>(null);
  const [query, setQuery] = useState('');
  const [dir, setDir] = useState<ScreenerSortDir>('desc');
  const [pageNum, setPageNum] = useState(1);

  useEffect(() => {
    const ac = new AbortController();
    fetchConverter(ac.signal).then((s) => !ac.signal.aborted && setSrc(s));
    return () => ac.abort();
  }, []);

  const rows: ConverterRow[] = src?.data?.converterRows ?? [];
  const board = useMemo(
    () =>
      readScreenerBoard(rows, src?.data?.upstreamTotal ?? null, src?.data?.changeSource, Math.floor(Date.now() / 1000)),
    [rows, src?.data?.upstreamTotal, src?.data?.changeSource],
  );
  const filtered = useMemo(() => filterScreenerRows(board.rows, query), [board.rows, query]);
  const sorted = useMemo(() => sortScreenerRows(filtered.matched, dir), [filtered.matched, dir]);
  const page = useMemo(
    () => paginateScreenerRows(sorted, { page: pageNum, pageSize: SCREENER_PAGE_SIZE }),
    [sorted, pageNum],
  );

  if (src === null) return <Loading what="the full price list" />;

  if (src.data === null) {
    return (
      <ErrorState
        title="Could not load the full price list"
        detail={src.error ?? 'the upstream returned no rows and named no reason'}
      />
    );
  }

  if (board.shown === 0) {
    return (
      <ErrorState
        title="The full price list came back empty"
        detail="the upstream answered successfully with no rows — an empty board is not a valid read, so this is reported as a failure, not an empty table"
      />
    );
  }

  return (
    // `minmax(0, 1fr)`, not a bare `auto` track: a grid child defaults to
    // `min-width: auto`, so its MIN-CONTENT sets the track's floor. The stat
    // cluster below is a `flexWrap: 'wrap'` row whose four `flex: 1 1 160px`
    // tiles have a combined min-content of 647px, which made the track 647 wide
    // inside a 350px container and scrolled the whole page sideways on a phone
    // (measured: `scrollWidth` 667 against a 390 viewport). `minmax(0, 1fr)`
    // removes the automatic floor so the tiles wrap instead.
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[16] }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
        <Stat
          label="Coins with a price"
          value={num(board.priced)}
          hint={`of ${num(board.shown)} rows read`}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label="Highest priced"
          value={board.highest ? board.highest.name : '—'}
          hint={board.highest ? `${coinLabel(board.highest)} · ${fmtPrice(board.highest.priceUsd)}` : 'no row states a price'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 200px' }}
        />
        <Stat
          label="Lowest priced"
          value={board.lowest ? board.lowest.name : '—'}
          hint={board.lowest ? `${coinLabel(board.lowest)} · ${fmtPrice(board.lowest.priceUsd)}` : 'no row states a price'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 200px' }}
        />
        <Stat
          label="Rows with no price"
          value={num(board.nullPrice)}
          hint="rendered —, never 0"
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
      </div>

      <Card
        title="Full price list"
        subtitle="every coin CryptoRank's converter page prices — filter by name or symbol, sort by price, 100 rows per page"
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[8], marginBottom: space[8] }}>
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPageNum(1);
            }}
            placeholder="Filter by name or symbol…"
            aria-label="Filter coins by name or symbol"
            style={{
              background: themeColor.bgBase,
              color: themeColor.labelPrimary,
              border: `1px solid ${themeColor.separator}`,
              borderRadius: radius[8],
              padding: `${space[4]}px ${space[8]}px`,
              fontSize: fontSize[12],
              fontFamily: 'inherit',
              minWidth: `${space[40] * 5}px`,
            }}
          />
          <button
            type="button"
            onClick={() => {
              setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
              setPageNum(1);
            }}
            style={controlStyle(false)}
          >
            Price {dir === 'desc' ? '↓' : '↑'}
          </button>
          <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>
            {filtered.note} · sorted by price {dir === 'desc' ? 'descending' : 'ascending'}
          </span>
        </div>

        {page.totalRows === 0 ? (
          <ErrorState
            title="No coin matches the filter"
            detail={`no row matches “${query.trim()}” — clear the filter to see all ${num(board.shown)} coins`}
          />
        ) : (
          <DataTable
            head={['Rank', 'Name', 'Symbol', 'Price (USD)']}
            rows={page.pageRows.map((r, i) => ({
              cells: [
                <span key="rank" style={{ color: themeColor.labelTertiary }}>{num(page.firstIndex + i)}</span>,
                <span key="name" style={{ fontWeight: fontWeight.semibold }}>{r.name}</span>,
                <span key="sym" style={{ color: themeColor.labelTertiary }}>{r.symbol || '—'}</span>,
                <span key="price">{fmtPrice(r.priceUsd)}</span>,
              ],
            }))}
          />
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[8], marginTop: space[8] }}>
          <button
            type="button"
            disabled={page.page <= 1}
            onClick={() => setPageNum(page.page - 1)}
            style={controlStyle(page.page <= 1)}
          >
            ‹ prev
          </button>
          <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>{page.pageNote}</span>
          <button
            type="button"
            disabled={page.page >= page.totalPages}
            onClick={() => setPageNum(page.page + 1)}
            style={controlStyle(page.page >= page.totalPages)}
          >
            next ›
          </button>
        </div>

        <p style={footnote}>
          {board.slice.note}. The board filters, sorts and paginates client-side at {page.pageSize}/page and renders one
          page at a time — it never renders all {num(board.shown)} rows. Rank is this row&apos;s 1-based position in the
          current view (after the filter and sort), not an upstream ranking: the converter mode ships no rank. A price
          the upstream did not publish is a —, never 0.
        </p>
      </Card>

      <ErrorState
        title="No change column on this surface"
        detail={`${board.change.note}. This board therefore shows no 24h % cell at all — price only.`}
      />
    </div>
  );
}
