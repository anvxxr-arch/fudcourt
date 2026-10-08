'use client';

/**
 * The chain & ecosystem directory (F-chains) — `/chains`: the chain index, the
 * ecosystem index, and a KEYED detail for the selected chain.
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never print 0 where the upstream published nothing. Every absent
 *    metric renders `—`; a chain whose market cap upstream states as null is a
 *    null, not a zero.
 *  - It must never sum a partial. The directory's "total market cap" is stated
 *    ONLY when every row in view states one; otherwise the board says "n of m"
 *    and no total.
 *  - It must never let a slice read as the whole. The ecosystem index is page 1
 *    of 106 and the detail ships thousands of tokens — the board states the
 *    slice it read, every time.
 *  - It must never show a change column the surface does not carry. The
 *    chain-detail mode reports `changeSource: 'unavailable'`; the board says so
 *    and renders `—` in the change cell rather than a flat 0.
 *  - It must never render an empty-but-successful payload as an empty board. An
 *    upstream that answers 200 with no rows is reported as a failure.
 *
 * The reading itself lives in `./model.ts` and is pure, so every refusal above
 * is unit-tested offline against fixed rows.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, radius, space, letterSpacing } from '@/styles/tokens';
import { dash, fmtPct, fmtPrice, fmtTime } from '@/lib/format';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import {
  fetchBlockchains,
  fetchChain,
  fetchEcosystems,
  type BlockchainsEnvelope,
  type ChainEnvelope,
  type EcosystemsEnvelope,
  type Source,
} from './client';
import {
  CHAINS_DETAIL_PAGE_SIZE,
  capCoverageNote,
  filterChains,
  readChainDetail,
  readChainDirectory,
  readEcosystemBoard,
  type ChainDirectoryBoard,
  type ChainRow,
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

/** A whole number, thousands-separated; null -> the em dash. */
function num(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? dash : v.toLocaleString('en-US');
}

/** A string field; absent or '' -> the em dash. */
function text(v: string | null | undefined): string {
  return v === null || v === undefined || v === '' ? dash : v;
}

/** A signed change colour: null and 0 are neutral, not up. */
function changeColor(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v === 0) return themeColor.labelTertiary;
  return v > 0 ? themeColor.green : themeColor.red;
}

/** A tag list as one line; empty -> the em dash (an absent taxonomy, not a blank). */
function tagsLine(tags: readonly string[] | null | undefined): string {
  return tags && tags.length > 0 ? tags.join(' · ') : dash;
}

/** The dashed control buttons (filter/pager) share this shape. */
function controlStyle(disabled: boolean): CSSProperties {
  return {
    background: themeColor.bgTertiary,
    color: disabled ? themeColor.labelTertiary : themeColor.labelSecondary,
    padding: `${space[4]}px ${space[12]}px`,
    border: `1px solid ${themeColor.separator}`,
    borderRadius: radius[8],
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: fontSize[12],
    fontFamily: 'inherit',
  };
}

/** The free-text filter and the chain <select> share this shape. */
const fieldStyle: CSSProperties = {
  background: themeColor.bgTertiary,
  color: themeColor.labelPrimary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: `${space[8]}px ${space[12]}px`,
  fontSize: fontSize[13],
  fontFamily: 'inherit',
};

/** A chain name drawn as the row's selection control (loads its detail). */
function nameButtonStyle(active: boolean): CSSProperties {
  return {
    background: 'transparent',
    border: 'none',
    padding: 0,
    margin: 0,
    cursor: 'pointer',
    color: active ? themeColor.orange : themeColor.blue,
    fontWeight: fontWeight.semibold,
    fontFamily: 'inherit',
    fontSize: fontSize[12],
    textAlign: 'left',
  };
}

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

// ---------------------------------------------------------------------------
// (1)+(2) The chain directory — mode=blockchains (277 rows) + a text filter
// ---------------------------------------------------------------------------
function DirectoryCard({
  src,
  board,
  selected,
  onSelect,
}: {
  src: Source<BlockchainsEnvelope> | null;
  board: ChainDirectoryBoard | null;
  selected: string | null;
  onSelect: (slug: string) => void;
}) {
  const [query, setQuery] = useState('');

  if (src === null) {
    return (
      <Card title="Chain directory">
        <Loading what="the chain directory" />
      </Card>
    );
  }
  if (src.data === null) {
    return (
      <ErrorState
        title="Could not load the chain directory"
        detail={src.error ?? 'the upstream returned no rows and named no reason'}
      />
    );
  }

  const listed = board ?? readChainDirectory([], null, 0);
  if (listed.rows.length === 0) {
    return (
      <ErrorState
        title="The chain directory came back empty"
        detail="the upstream answered successfully with no rows — an empty directory is not a valid read, so this is reported as a failure, not an empty table"
      />
    );
  }

  const { matched, note } = filterChains(listed.rows, query);

  return (
    <Card
      title="Chain directory"
      subtitle="every chain CryptoRank indexes — a market cap it did not state renders —; click a chain (or pick one) to load its ecosystem"
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
        <Stat
          label="Chains with stated cap"
          value={`${listed.statedCap} / ${listed.shown}`}
          hint="rows that state a market cap"
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label="Top by market cap"
          value={listed.topByMarketCap ? text(listed.topByMarketCap.name) : dash}
          hint={listed.topByMarketCap ? usd(listed.topByMarketCap.marketCap) : 'no chain states a market cap'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 180px' }}
        />
        <Stat
          label="Total market cap"
          value={listed.totalMarketCapUsd === null ? dash : usd(listed.totalMarketCapUsd)}
          hint={
            listed.totalMarketCapUsd === null
              ? `${listed.statedCap} of ${listed.shown} state a cap — not totalled`
              : 'every row states a cap'
          }
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 180px' }}
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], alignItems: 'center', marginBottom: space[8] }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter by name or network…"
          aria-label="Filter chains by name or network"
          style={{ ...fieldStyle, flex: '1 1 220px' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: space[4], fontSize: fontSize[11], color: themeColor.labelTertiary }}>
          select
          <select
            value={selected ?? ''}
            onChange={(e) => onSelect(e.target.value)}
            aria-label="Select a chain to load its detail"
            style={fieldStyle}
          >
            {listed.rows.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
                {c.network ? ` · ${c.network}` : ''}
              </option>
            ))}
          </select>
        </label>
        <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>{note}</span>
      </div>

      <DataTable
        head={['Name', 'Network', 'Market cap', 'Explorer']}
        rows={matched.map((r: ChainRow) => ({
          cells: [
            <button key="n" type="button" onClick={() => onSelect(r.slug)} style={nameButtonStyle(r.slug === selected)}>
              {text(r.name)}
              {r.slug === selected ? <span style={{ color: themeColor.labelTertiary }}> · shown below</span> : null}
            </button>,
            <span key="net" style={{ color: themeColor.labelTertiary }}>{text(r.network)}</span>,
            <span key="mcap">{usd(r.marketCap)}</span>,
            r.explorerUrl ? (
              <a key="ex" href={r.explorerUrl} target="_blank" rel="noreferrer" style={{ color: themeColor.blue }}>
                explorer ↗
              </a>
            ) : (
              <span key="ex" style={{ color: themeColor.labelTertiary }}>{dash}</span>
            ),
          ],
        }))}
      />
      <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {note}; {listed.upstreamTotal === null ? 'upstream stated no fuller total — the feed is the whole index' : `upstream states ${listed.upstreamTotal} in all`}.{' '}
        {capCoverageNote(listed)}. A blank market cap is a metric upstream did not publish, shown as — rather than 0.
        Directory read {fmtTime(listed.asOf)} (this browser).
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (4) The keyed chain detail — mode=chain&key=<slug>, paginated 50/page
// ---------------------------------------------------------------------------
function DetailSection({ slug }: { slug: string }) {
  const src = useSource<ChainEnvelope>((s) => fetchChain(slug, s), `chain:${slug}`);
  const [page, setPage] = useState(1);

  return (
    <Card
      title="Chain detail"
      subtitle={`mode=chain&key=${slug} — the keyed read; this mode ships no change column, so the 24h % cell is — on every row`}
    >
      {src === null ? (
        <Loading what={`the ${slug} chain`} />
      ) : src.data === null ? (
        <ErrorState
          title={`Could not load the '${slug}' chain`}
          detail={src.error ?? 'the upstream returned no header and named no reason'}
        />
      ) : (
        (() => {
          const board = readChainDetail(src.data.chain ?? null, src.data.rows ?? [], src.data.changeSource, {
            page,
            pageSize: CHAINS_DETAIL_PAGE_SIZE,
          });
          if (board.totalRows === 0) {
            return (
              <ErrorState
                title={`The '${slug}' chain came back with no tokens`}
                detail="the upstream answered successfully with an empty token array — reported as a failure, not an empty table"
              />
            );
          }
          const chain = board.chain;
          return (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
                <Stat
                  label="Chain"
                  value={chain ? text(chain.name) : text(slug)}
                  hint={chain ? `network ${text(chain.network)}` : 'header not stated upstream'}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
                />
                <Stat
                  label="Market cap"
                  value={chain ? usd(chain.marketCap) : dash}
                  hint="CryptoRank's own figure for the chain"
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
                />
                <Stat
                  label="Tokens"
                  value={num(board.totalRows)}
                  hint={`page ${board.page} of ${board.totalPages}`}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label="Explorer"
                  value={
                    chain && chain.explorerUrl ? (
                      <a href={chain.explorerUrl} target="_blank" rel="noreferrer" style={{ color: themeColor.blue, fontSize: fontSize[13] }}>
                        open ↗
                      </a>
                    ) : (
                      dash
                    )
                  }
                  hint={chain && chain.explorerUrl ? chain.explorerUrl : 'upstream stated no explorer'}
                  valueSize={fontSize[13]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 200px' }}
                />
              </div>

              {!board.change.available ? (
                <p style={{ margin: `0 0 ${space[8]}px`, fontSize: fontSize[12], color: themeColor.orange, lineHeight: lineHeight.normal }}>
                  {text(board.change.note)}.
                </p>
              ) : board.change.note ? (
                <p style={{ margin: `0 0 ${space[8]}px`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
                  {board.change.note}.
                </p>
              ) : null}

              <DataTable
                head={['Rank', 'Name', 'Symbol', 'Price (USD)', 'Market cap', '24h volume', 'Category', 'ATH (USD)', '24h %']}
                rows={board.pageRows.map((r) => ({
                  cells: [
                    <span key="rank" style={{ color: themeColor.labelTertiary }}>{num(r.rank)}</span>,
                    <span key="name" style={{ fontWeight: fontWeight.semibold }}>{text(r.name)}</span>,
                    <span key="sym" style={{ color: themeColor.labelTertiary }}>{text(r.symbol)}</span>,
                    <span key="price">{fmtPrice(r.priceUsd)}</span>,
                    <span key="mcap">{usd(r.marketCap)}</span>,
                    <span key="vol">{usd(r.volume24hUsd)}</span>,
                    <span key="cat" style={{ color: themeColor.labelTertiary }}>{text(r.category)}</span>,
                    <span key="ath">{fmtPrice(r.athUsd)}</span>,
                    board.change.available ? (
                      <span key="chg" style={{ color: changeColor(r.change24h) }}>{fmtPct(r.change24h)}</span>
                    ) : (
                      <span key="chg" style={{ color: themeColor.labelTertiary }} title="this mode reports no change column">
                        {dash}
                      </span>
                    ),
                  ],
                }))}
              />

              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[8], marginTop: space[8] }}>
                <button type="button" disabled={board.page <= 1} onClick={() => setPage(board.page - 1)} style={controlStyle(board.page <= 1)}>
                  ‹ prev
                </button>
                <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>{board.pageNote}</span>
                <button
                  type="button"
                  disabled={board.page >= board.totalPages}
                  onClick={() => setPage(board.page + 1)}
                  style={controlStyle(board.page >= board.totalPages)}
                >
                  next ›
                </button>
              </div>

              <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
                The detail ships the whole ecosystem token array in one read; the board paginates it client-side at{' '}
                {board.pageSize}/page and states the slice ({board.pageNote}). 24h % is — because this mode reports
                changeSource:&apos;unavailable&apos; — an absent column, not a flat market. A blank price, cap or ATH is a metric upstream
                did not publish, shown as — rather than 0. CryptoRank&apos;s own slice: {text(src.data.slice)}.
              </p>
            </>
          );
        })()
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (3) The ecosystem index — mode=ecosystems (20 of 106)
// ---------------------------------------------------------------------------
function EcosystemSection() {
  const src = useSource<EcosystemsEnvelope>((s) => fetchEcosystems(s), 'ecosystems');

  if (src === null) {
    return (
      <Card title="Ecosystem index">
        <Loading what="the ecosystem index" />
      </Card>
    );
  }
  if (src.data === null) {
    return (
      <Card title="Ecosystem index">
        <ErrorState
          title="Could not load the ecosystem index"
          detail={src.error ?? 'the upstream returned no rows and named no reason'}
        />
      </Card>
    );
  }

  const board = readEcosystemBoard(src.data.ecosystemRows ?? [], src.data.upstreamTotal ?? null);
  if (board.rows.length === 0) {
    return (
      <Card title="Ecosystem index">
        <ErrorState
          title="The ecosystem index came back empty"
          detail="the upstream answered successfully with no rows — reported as a failure, not an empty table"
        />
      </Card>
    );
  }

  return (
    <Card
      title="Ecosystem index"
      subtitle="CryptoRank's own ecosystem aggregates — a metric it did not publish renders —; the % columns are upstream's percent figures"
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
        <Stat
          label="Ecosystems shown"
          value={String(board.shown)}
          hint={board.upstreamTotal === null ? 'upstream total not stated' : `of ${board.upstreamTotal} upstream`}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label="Slice"
          value={board.note}
          hint="SSR ships page 1 only"
          valueSize={fontSize[13]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 220px' }}
        />
      </div>

      <DataTable
        head={['Ecosystem', 'Projects', 'Δ Projects 3m', 'Market cap', 'Mcap 24h %', 'TVL', 'TVL 24h %', 'Tags']}
        rows={board.rows.map((r) => ({
          cells: [
            <span key="n" style={{ fontWeight: fontWeight.semibold }}>{text(r.name)}</span>,
            <span key="p">{num(r.projects)}</span>,
            <span key="pc">{num(r.projectsChange3m)}</span>,
            <span key="mc">{usd(r.marketCapUsd)}</span>,
            <span key="mcc" style={{ color: changeColor(r.marketCapChange24hPct) }}>{fmtPct(r.marketCapChange24hPct)}</span>,
            <span key="tv">{usd(r.tvlUsd)}</span>,
            <span key="tvc" style={{ color: changeColor(r.tvlChange24hPct) }}>{fmtPct(r.tvlChange24hPct)}</span>,
            <span key="tags" style={{ color: themeColor.labelTertiary }}>{tagsLine(r.tags)}</span>,
          ],
        }))}
      />
      <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {board.note} — SSR ships page 1 only, so this board reads those {board.shown} and no more. Market cap, TVL and their 24h %
        columns are CryptoRank&apos;s OWN ecosystem aggregates (their methodology), not an independent measure. Δ Projects 3m and the
        % columns are shipped by upstream: the two 24h values are percent figures, and projectsChange3m carries no unit upstream so
        it is shown exactly as shipped. A blank figure is a metric upstream did not publish, shown as — rather than 0.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The route surface — the directory owns the selection; a failed read never blanks another section.
// ---------------------------------------------------------------------------
export default function ChainsDirectory() {
  const src = useSource<BlockchainsEnvelope>((s) => fetchBlockchains(s), 'blockchains');
  const [selected, setSelected] = useState<string | null>(null);
  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), []);

  const board = useMemo(
    () => (src?.data ? readChainDirectory(src.data.chainRows ?? [], src.data.upstreamTotal ?? null, nowSec) : null),
    [src, nowSec],
  );

  // The default selection is DERIVED, never a hard-coded slug: the top chain by
  // stated market cap, falling back to the first row, so the detail loads with
  // the directory instead of needing a click first.
  const slug = selected ?? board?.topByMarketCap?.slug ?? board?.rows[0]?.slug ?? null;

  return (
    <div style={{ display: 'grid', gap: space[16] }}>
      <DirectoryCard src={src} board={board} selected={slug} onSelect={setSelected} />
      {slug ? <DetailSection key={slug} slug={slug} /> : null}
      <EcosystemSection />
      <p style={{ margin: 0, fontSize: fontSize[11], color: themeColor.labelTertiary, letterSpacing: letterSpacing.xs, lineHeight: lineHeight.normal }}>
        One chain directory, its ecosystem index and a keyed per-chain detail. Every board states its slice; a metric CryptoRank did
        not publish renders —, never 0; the detail&apos;s change column is named as unavailable rather than printed as a flat 0; and a
        successful-but-empty read is reported as a failure, never shown as an empty table. Nothing here is a recommendation.
      </p>
    </div>
  );
}
