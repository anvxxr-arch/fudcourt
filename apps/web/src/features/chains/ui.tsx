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
import { useT } from '@/lib/i18n/t';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import {
  fetchBlockchains,
  fetchChain,
  fetchEcosystem,
  fetchEcosystems,
  type BlockchainsEnvelope,
  type ChainEnvelope,
  type EcosystemEnvelope,
  type EcosystemsEnvelope,
  type Source,
} from './client';
import {
  CHAINS_DETAIL_PAGE_SIZE,
  capCoverageNote,
  filterChains,
  nativeCoinNote,
  readChainDetail,
  readChainDirectory,
  readEcosystemBoard,
  readEcosystemDetail,
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
  // A native <select>'s intrinsic width is its WIDEST <option>, so a long
  // option list ('Ticker · Name', 'Chain · Network') makes the control wider
  // than the card holding it — measured 522px in a 316px box. `maxWidth: 100%`
  // bounds it to its parent; `minWidth: 0` is what lets it actually shrink
  // there as a flex item, since the default `min-width: auto` refuses to go
  // below min-content.
  maxWidth: '100%',
  minWidth: 0,
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
  const t = useT();
  const [query, setQuery] = useState('');

  if (src === null) {
    return (
      <Card title={t('crypto.chains.cardTitle')}>
        <Loading what={t('crypto.chains.loadingWhat')} />
      </Card>
    );
  }
  if (src.data === null) {
    return (
      <ErrorState
        title={t('crypto.chains.loadFailTitle')}
        detail={src.error ?? t('crypto.common.upstreamNoRows')}
      />
    );
  }

  const listed = board ?? readChainDirectory([], null, 0);
  if (listed.rows.length === 0) {
    return (
      <ErrorState
        title={t('crypto.chains.emptyTitle')}
        detail={t('crypto.chains.emptyDetail')}
      />
    );
  }

  const { matched, note } = filterChains(listed.rows, query);

  return (
    <Card
      title={t('crypto.chains.cardTitle')}
      subtitle={t('crypto.chains.cardSubtitle')}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
        <Stat
          label={t('crypto.chains.statStatedCap')}
          value={`${listed.statedCap} / ${listed.shown}`}
          hint={t('crypto.chains.hintRowsStateCap')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label={t('crypto.chains.statTopCap')}
          value={listed.topByMarketCap ? text(listed.topByMarketCap.name) : dash}
          hint={listed.topByMarketCap ? usd(listed.topByMarketCap.marketCap) : t('crypto.chains.hintNoChainCap')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 180px' }}
        />
        <Stat
          label={t('crypto.chains.statTotalCap')}
          value={listed.totalMarketCapUsd === null ? dash : usd(listed.totalMarketCapUsd)}
          hint={
            listed.totalMarketCapUsd === null
              ? t('crypto.chains.hintCapNotTotalled', { stated: listed.statedCap, shown: listed.shown })
              : t('crypto.chains.hintEveryRowCap')
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
          placeholder={t('crypto.chains.filterPlaceholder')}
          aria-label={t('crypto.chains.filterAria')}
          style={{ ...fieldStyle, flex: '1 1 220px' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', minWidth: 0, gap: space[4], fontSize: fontSize[11], color: themeColor.labelTertiary }}>
          {t('crypto.chains.selectLabel')}
          <select
            value={selected ?? ''}
            onChange={(e) => onSelect(e.target.value)}
            aria-label={t('crypto.chains.selectAria')}
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
        head={[t('crypto.head.name'), t('crypto.chains.headNetwork'), t('crypto.head.marketCap'), t('crypto.chains.headExplorer')]}
        rows={matched.map((r: ChainRow) => ({
          cells: [
            <button key="n" type="button" onClick={() => onSelect(r.slug)} style={nameButtonStyle(r.slug === selected)}>
              {text(r.name)}
              {r.slug === selected ? <span style={{ color: themeColor.labelTertiary }}>{t('crypto.chains.shownBelow')}</span> : null}
            </button>,
            <span key="net" style={{ color: themeColor.labelTertiary }}>{text(r.network)}</span>,
            <span key="mcap">{usd(r.marketCap)}</span>,
            r.explorerUrl ? (
              <a key="ex" href={r.explorerUrl} target="_blank" rel="noreferrer" style={{ color: themeColor.blue }}>
                {t('crypto.chains.explorerLink')}
              </a>
            ) : (
              <span key="ex" style={{ color: themeColor.labelTertiary }}>{dash}</span>
            ),
          ],
        }))}
      />
      <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {note}; {listed.upstreamTotal === null ? t('crypto.chains.footnoteNoTotal') : t('crypto.chains.footnoteTotal', { n: listed.upstreamTotal })}.{' '}
        {capCoverageNote(listed)}. {t('crypto.chains.footnoteBlankCap')}
        {t('crypto.chains.footnoteRead', { time: fmtTime(listed.asOf) })}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (4) The keyed chain detail — mode=chain&key=<slug>, paginated 50/page
// ---------------------------------------------------------------------------
function DetailSection({ slug }: { slug: string }) {
  const t = useT();
  const src = useSource<ChainEnvelope>((s) => fetchChain(slug, s), `chain:${slug}`);
  const [page, setPage] = useState(1);

  return (
    <Card
      title={t('crypto.chains.detailTitle')}
      subtitle={t('crypto.chains.detailSubtitle', { slug })}
    >
      {src === null ? (
        <Loading what={t('crypto.chains.detailLoadingWhat', { slug })} />
      ) : src.data === null ? (
        <ErrorState
          title={t('crypto.chains.detailLoadFailTitle', { slug })}
          detail={src.error ?? t('crypto.chains.detailNoHeaderDetail')}
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
                title={t('crypto.chains.detailEmptyTitle', { slug })}
                detail={t('crypto.chains.detailEmptyDetail')}
              />
            );
          }
          const chain = board.chain;
          return (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
                <Stat
                  label={t('crypto.chains.statChain')}
                  value={chain ? text(chain.name) : text(slug)}
                  hint={chain ? t('crypto.chains.hintNetwork', { network: text(chain.network) }) : t('crypto.chains.hintNoHeader')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
                />
                <Stat
                  label={t('crypto.chains.statMarketCap')}
                  value={chain ? usd(chain.marketCap) : dash}
                  hint={t('crypto.chains.hintChainCap')}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
                />
                <Stat
                  label={t('crypto.chains.statTokens')}
                  value={num(board.totalRows)}
                  hint={t('crypto.chains.hintPageOf', { page: board.page, pages: board.totalPages })}
                  valueSize={fontSize[17]}
                  style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
                />
                <Stat
                  label={t('crypto.chains.statExplorer')}
                  value={
                    chain && chain.explorerUrl ? (
                      <a href={chain.explorerUrl} target="_blank" rel="noreferrer" style={{ color: themeColor.blue, fontSize: fontSize[13] }}>
                        {t('crypto.chains.openLink')}
                      </a>
                    ) : (
                      dash
                    )
                  }
                  hint={chain && chain.explorerUrl ? chain.explorerUrl : t('crypto.chains.hintNoExplorer')}
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
                head={[t('crypto.head.rank'), t('crypto.head.name'), t('crypto.coins.headSymbol'), t('crypto.head.priceUsd'), t('crypto.head.marketCap'), t('crypto.head.volume24h'), t('crypto.head.category'), t('crypto.head.athUsd'), t('crypto.head.change24h')]}
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
                      <span key="chg" style={{ color: themeColor.labelTertiary }} title={t('crypto.chains.noChangeTitle')}>
                        {dash}
                      </span>
                    ),
                  ],
                }))}
              />

              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[8], marginTop: space[8] }}>
                <button type="button" disabled={board.page <= 1} onClick={() => setPage(board.page - 1)} style={controlStyle(board.page <= 1)}>
                  {t('crypto.common.prev')}
                </button>
                <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>{board.pageNote}</span>
                <button
                  type="button"
                  disabled={board.page >= board.totalPages}
                  onClick={() => setPage(board.page + 1)}
                  style={controlStyle(board.page >= board.totalPages)}
                >
                  {t('crypto.common.next')}
                </button>
              </div>

              <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
                {t('crypto.chains.detailFootnote', { pageSize: board.pageSize, note: board.pageNote, slice: text(src.data.slice) })}
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
  const t = useT();
  const src = useSource<EcosystemsEnvelope>((s) => fetchEcosystems(s), 'ecosystems');

  if (src === null) {
    return (
      <Card title={t('crypto.chains.ecoIndexTitle')}>
        <Loading what={t('crypto.chains.ecoIndexLoadingWhat')} />
      </Card>
    );
  }
  if (src.data === null) {
    return (
      <Card title={t('crypto.chains.ecoIndexTitle')}>
        <ErrorState
          title={t('crypto.chains.ecoIndexLoadFailTitle')}
          detail={src.error ?? t('crypto.common.upstreamNoRows')}
        />
      </Card>
    );
  }

  const board = readEcosystemBoard(src.data.ecosystemRows ?? [], src.data.upstreamTotal ?? null);
  if (board.rows.length === 0) {
    return (
      <Card title={t('crypto.chains.ecoIndexTitle')}>
        <ErrorState
          title={t('crypto.chains.ecoIndexEmptyTitle')}
          detail={t('crypto.chains.ecoIndexEmptyDetail')}
        />
      </Card>
    );
  }

  return (
    <Card
      title={t('crypto.chains.ecoIndexTitle')}
      subtitle={t('crypto.chains.ecoIndexSubtitle')}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
        <Stat
          label={t('crypto.chains.statEcoShown')}
          value={String(board.shown)}
          hint={board.upstreamTotal === null ? t('crypto.common.upstreamTotalNotStated') : t('crypto.common.ofUpstream', { n: board.upstreamTotal })}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label={t('crypto.chains.statSlice')}
          value={board.note}
          hint={t('crypto.chains.hintSsrPage1')}
          valueSize={fontSize[13]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 220px' }}
        />
      </div>

      <DataTable
        head={[t('crypto.chains.headEcosystem'), t('crypto.chains.headProjects'), t('crypto.chains.headProjects3m'), t('crypto.head.marketCap'), t('crypto.chains.headMcap24h'), t('crypto.chains.headTvl'), t('crypto.chains.headTvl24h'), t('crypto.chains.headTags')]}
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
        {t('crypto.chains.ecoFootnote', { note: board.note, shown: board.shown })}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (5) The keyed ecosystem drill-down — mode=ecosystem&key=<slug>
// ---------------------------------------------------------------------------
function EcosystemDetailRead({ slug }: { slug: string }) {
  const t = useT();
  const src = useSource<EcosystemEnvelope>((s) => fetchEcosystem(slug, s), `ecosystem:${slug}`);

  if (src === null) {
    return <Loading what={t('crypto.chains.ecoDetailLoadingWhat', { slug })} />;
  }
  if (src.data === null) {
    return (
      <ErrorState
        title={t('crypto.chains.ecoDetailLoadFailTitle', { slug })}
        detail={src.error ?? t('crypto.chains.detailNoHeaderDetail')}
      />
    );
  }

  const board = readEcosystemDetail(
    src.data.ecosystem ?? null,
    src.data.rows ?? [],
    src.data.upstreamTotal ?? null,
    src.data.changeSource,
  );
  if (board.ecosystem === null || board.rows.length === 0) {
    return (
      <ErrorState
        title={t('crypto.chains.ecoDetailEmptyTitle', { slug })}
        detail={t('crypto.chains.ecoDetailEmptyDetail')}
      />
    );
  }

  const eco = board.ecosystem;
  const coin = eco.coin;
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
        <Stat
          label={t('crypto.chains.statEcosystem')}
          value={text(eco.name)}
          hint={eco.blockchain ? t('crypto.chains.hintBlockchain', { name: text(eco.blockchain.name) }) : t('crypto.chains.hintNoBlockchain')}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 180px' }}
        />
        <Stat
          label={t('crypto.chains.statNativeCoin')}
          value={coin ? `${text(coin.symbol)} ${fmtPrice(coin.priceUsd)}` : dash}
          hint={coin ? t('crypto.chains.hintNativeCoin24h', { pct: fmtPct(coin.change24h) }) : nativeCoinNote(coin)}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 220px' }}
        />
        <Stat
          label={t('crypto.chains.statCoins')}
          value={num(board.shown)}
          hint={board.sliceNote}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
      </div>

      {board.descriptionText ? (
        <p style={{ margin: `0 0 ${space[12]}px`, fontSize: fontSize[12], color: themeColor.labelSecondary, lineHeight: lineHeight.normal }}>
          <span style={{ color: themeColor.labelTertiary }}>{t('crypto.chains.descOwnWords')}</span>
          {board.descriptionText}
        </p>
      ) : (
        <p style={{ margin: `0 0 ${space[12]}px`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
          {t('crypto.chains.descNone')}
        </p>
      )}

      {!board.change.available ? (
        <p style={{ margin: `0 0 ${space[8]}px`, fontSize: fontSize[12], color: themeColor.orange, lineHeight: lineHeight.normal }}>
          {text(board.change.note)}.
        </p>
      ) : null}

      <DataTable
        head={[t('crypto.head.rank'), t('crypto.head.name'), t('crypto.coins.headSymbol'), t('crypto.head.priceUsd'), t('crypto.head.marketCap'), t('crypto.head.volume24h'), t('crypto.head.category'), t('crypto.head.change24h')]}
        rows={board.rows.map((r) => ({
          cells: [
            <span key="rank" style={{ color: themeColor.labelTertiary }}>{num(r.rank)}</span>,
            <span key="name" style={{ fontWeight: fontWeight.semibold }}>{text(r.name)}</span>,
            <span key="sym" style={{ color: themeColor.labelTertiary }}>{text(r.symbol)}</span>,
            <span key="price">{fmtPrice(r.priceUsd)}</span>,
            <span key="mcap">{usd(r.marketCap)}</span>,
            <span key="vol">{usd(r.volume24hUsd)}</span>,
            <span key="cat" style={{ color: themeColor.labelTertiary }}>{text(r.category)}</span>,
            board.change.available ? (
              <span key="chg" style={{ color: changeColor(r.change24h) }}>{fmtPct(r.change24h)}</span>
            ) : (
              <span key="chg" style={{ color: themeColor.labelTertiary }} title={t('crypto.chains.noChangeTitle')}>
                {dash}
              </span>
            ),
          ],
        }))}
      />

      <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {t('crypto.chains.ecoDetailFootnote', { note: board.sliceNote, shown: board.shown, slice: text(src.data.slice) })}
      </p>
    </>
  );
}

function EcosystemDetailSection() {
  const t = useT();
  const indexSrc = useSource<EcosystemsEnvelope>((s) => fetchEcosystems(s), 'ecosystems');
  const [selected, setSelected] = useState<string | null>(null);

  const indexBoard = indexSrc?.data
    ? readEcosystemBoard(indexSrc.data.ecosystemRows ?? [], indexSrc.data.upstreamTotal ?? null)
    : null;

  // The default selection is DERIVED, never a hard-coded slug: the first ecosystem
  // the index shipped, so the drill-down loads with the selector instead of
  // needing a click first.
  const slug = selected ?? indexBoard?.rows[0]?.key ?? null;

  return (
    <Card
      title={t('crypto.chains.ecoDetailTitle')}
      subtitle={t('crypto.chains.ecoDetailSubtitle')}
    >
      {indexSrc === null ? (
        <Loading what={t('crypto.chains.ecoIndexLoadingWhat')} />
      ) : indexSrc.data === null ? (
        <ErrorState
          title={t('crypto.chains.ecoIndexLoadFailTitle')}
          detail={indexSrc.error ?? t('crypto.common.upstreamNoRows')}
        />
      ) : indexBoard && indexBoard.rows.length > 0 ? (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], alignItems: 'center', marginBottom: space[12] }}>
            <label style={{ display: 'flex', alignItems: 'center', minWidth: 0, gap: space[4], fontSize: fontSize[11], color: themeColor.labelTertiary }}>
              {t('crypto.chains.selectLabel')}
              <select
                value={slug ?? ''}
                onChange={(e) => setSelected(e.target.value)}
                aria-label={t('crypto.chains.ecoSelectAria')}
                style={fieldStyle}
              >
                {indexBoard.rows.map((e) => (
                  <option key={e.key} value={e.key}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>{indexBoard.note}</span>
          </div>
          {slug ? <EcosystemDetailRead key={slug} slug={slug} /> : null}
        </>
      ) : (
        <ErrorState
          title={t('crypto.chains.ecoIndexEmptyTitle')}
          detail={t('crypto.chains.ecoIndexEmptyDetail')}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The route surface — the directory owns the selection; a failed read never blanks another section.
// ---------------------------------------------------------------------------
export default function ChainsDirectory() {
  const t = useT();
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
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[16] }}>
      <DirectoryCard src={src} board={board} selected={slug} onSelect={setSelected} />
      {slug ? <DetailSection key={slug} slug={slug} /> : null}
      <EcosystemSection />
      <EcosystemDetailSection />
      <p style={{ margin: 0, fontSize: fontSize[11], color: themeColor.labelTertiary, letterSpacing: letterSpacing.xs, lineHeight: lineHeight.normal }}>
        {t('crypto.chains.routeFootnote')}
      </p>
    </div>
  );
}
