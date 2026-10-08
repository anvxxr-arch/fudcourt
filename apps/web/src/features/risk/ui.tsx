'use client';

/**
 * The risk feed (F10) — `/risk`: prediction-market pricing joined with the
 * headlines being reported.
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never print a probability the book cannot support. A crossed,
 *    one-sided or non-positive book has NO priced view, and the row says so
 *    instead of showing 0% or a fabricated 50% — "the market is undecided" and
 *    "there is no market here" are different claims and only one is true.
 *  - It must never let a thin book read as a liquid one. A book wider than 10%
 *    of its mid is marked WIDE, because its mid is arithmetic, not consensus.
 *  - It must never imply it sees the whole market. CryptoRank serves page 1 —
 *    the payload states how many rows of how many, and the board prints it.
 *  - It must never assert a causal link between a headline and a price. The join
 *    is LEXICAL (a shared 5+ character non-stopword token) and is labelled as
 *    such, in the column header and the footnote.
 *
 * The reading itself lives in `./model.ts` and is pure, so every refusal above
 * is unit-tested offline against fixed rows.
 */
import { useEffect, useMemo, useState } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, radius, space } from '@/styles/tokens';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { EmptyState, ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import { fetchRiskSources, type RiskSources } from './client';
import { buildRiskFeed, mostDecidedMarket, type BookQuality, type RiskFeed } from './model';

const QUALITY_COLOR: Record<BookQuality, string> = {
  tight: themeColor.green,
  wide: themeColor.orange,
  unknown: themeColor.labelTertiary,
};

const QUALITY_LABEL: Record<BookQuality, string> = {
  tight: 'tight book',
  wide: 'wide book',
  unknown: 'no book',
};

/** A probability as a percentage, or the em dash when none is stated. */
function pct(p: number | null): string {
  return p === null ? '—' : `${(p * 100).toFixed(1)}%`;
}

/** An age in hours, as a compact human string. */
function age(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** A USD magnitude, compacted so a 3.4M volume does not break the column. */
function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export default function RiskFeedPage() {
  const [sources, setSources] = useState<RiskSources | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchRiskSources(ac.signal).then((s) => !ac.signal.aborted && setSources(s));
    return () => ac.abort();
  }, []);

  const feed: RiskFeed | null = useMemo(() => {
    if (!sources?.prediction) return null;
    return buildRiskFeed(sources.prediction.predictionRows ?? [], sources.news?.items ?? [], {
      aggregate: sources.prediction.prediction ?? null,
      upstreamTotal: sources.prediction.upstreamTotal,
      nowSec: Math.floor(Date.now() / 1000),
    });
  }, [sources]);

  if (sources === null) return <Loading what="the risk feed" />;

  if (!feed) {
    return (
      <ErrorState
        title="Could not load the prediction-market read"
        detail={sources.predictionError ?? 'the upstream returned no rows and named no reason'}
      />
    );
  }

  // The most DECIDED market — the one furthest from a coin flip — and its
  // PRICED probability, never `0.5 + conviction`. Printing 98.5% beside a market
  // the book prices at 1.5% would invert what the market says: the conviction is
  // how far the price sits from even odds, and only the price is the market's view.
  const mostDecided = mostDecidedMarket(feed.markets);

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
        <Stat
          label="Markets priced"
          value={String(feed.markets.length)}
          hint={`of ${feed.slice.shown} rows read`}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label="24h volume"
          value={usd(feed.aggregate?.totalVolumeUsd)}
          tone={feed.aggregate == null ? 'neutral' : feed.aggregate.volumeChangePct >= 0 ? 'positive' : 'negative'}
          hint={feed.aggregate ? `${feed.aggregate.volumeChangePct >= 0 ? '+' : ''}${feed.aggregate.volumeChangePct.toFixed(2)}% vs prior` : 'not reported'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label="Open interest"
          value={usd(feed.aggregate?.openInterestUsd)}
          hint={feed.aggregate ? `${feed.aggregate.marketsCount.toLocaleString('en-US')} markets tracked` : 'not reported'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label="Most decided"
          value={pct(mostDecided?.probability ?? null)}
          hint={
            mostDecided
              ? `${mostDecided.title} · ±${((mostDecided.conviction ?? 0) * 100).toFixed(1)} from a coin flip`
              : 'no priced market'
          }
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card title="Priced events" subtitle="ranked by 24h volume — the mid of the book is the market's own priced odds">
          {feed.markets.length === 0 ? (
            <EmptyState>No market on this page carries a usable book.</EmptyState>
          ) : (
            <DataTable
              head={['Event', 'Platform', 'Implied probability', 'Spread', 'Book', '24h volume', 'Resolves']}
              rows={feed.markets.map((m) => ({
                href: m.externalUrl,
                cells: [
                  <span key="t" style={{ fontWeight: fontWeight.semibold }}>{m.title}</span>,
                  <span key="p" style={{ color: themeColor.labelTertiary }}>{m.platform}</span>,
                  <span key="pr" style={{ fontWeight: fontWeight.semibold, color: themeColor.labelPrimary }}>
                    {pct(m.probability)}
                    {m.conviction !== null && (
                      <span style={{ color: themeColor.labelTertiary, fontWeight: fontWeight.regular }}>
                        {' '}· ±{(m.conviction * 100).toFixed(1)}
                      </span>
                    )}
                  </span>,
                  <span key="s" style={{ color: themeColor.labelTertiary }}>
                    {m.spread === null ? '—' : `${(m.spread * 100).toFixed(1)}c`}
                    {m.relativeSpread !== null && ` (${(m.relativeSpread * 100).toFixed(0)}%)`}
                  </span>,
                  <span key="b" style={{ color: QUALITY_COLOR[m.bookQuality] }}>{QUALITY_LABEL[m.bookQuality]}</span>,
                  <span key="v">{usd(m.volume24hUsd)}</span>,
                  <span key="e" style={{ color: themeColor.labelTertiary }}>{m.endDate || '—'}</span>,
                ],
              }))}
            />
          )}
          <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
            {feed.slice.note}. A probability is the mid of a two-sided book, not our estimate; ±N is how far it sits
            from a coin flip.
          </p>
        </Card>
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card title="Headlines" subtitle="the outlet's own feed, freshest first — a lexical join to the events above, never a causal one">
          {sources.newsError ? (
            <ErrorState title="The news read failed" detail={sources.newsError} />
          ) : feed.headlines.length === 0 ? (
            <EmptyState>The feed returned no items.</EmptyState>
          ) : (
            <DataTable
              head={['Headline', 'Source', 'Published', 'Matches an event']}
              rows={feed.headlines.map((h) => {
                const matched = feed.markets.filter((m) => m.lexicalMatches.includes(h.link));
                return {
                  href: h.link,
                  cells: [
                    <span key="t" style={{ fontWeight: fontWeight.semibold }}>{h.title}</span>,
                    <span key="s" style={{ color: themeColor.labelTertiary }}>{h.source}</span>,
                    <span key="p" style={{ color: themeColor.labelTertiary }}>{age(h.ageHours)} ago</span>,
                    <span key="m" style={{ color: matched.length ? themeColor.blue : themeColor.labelTertiary }}>
                      {matched.length === 0 ? '— no shared token' : `${matched.length} (lexical)`}
                    </span>,
                  ],
                };
              })}
            />
          )}
        </Card>
      </div>

      {feed.skipped.length > 0 && (
        <div style={{ marginTop: space[12] }}>
          <ErrorState
            title={`${feed.skipped.length} event(s) carry no price`}
            detail={feed.skipped.map((s) => `${s.title} — ${s.reason}`).join(' · ')}
          />
        </div>
      )}

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {feed.derived}
      </p>
    </>
  );
}
