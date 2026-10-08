'use client';

/**
 * The CryptoRank media & news board — `/media`: the video feed, the news wire
 * and the per-tag news reader, on one surface. This is a DIFFERENT source from
 * the `/news` board (the Cointelegraph RSS family); these rows come from
 * CryptoRank's own `media`, `news` and `newstag` modes.
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never print 0 where the upstream published nothing. A null
 *    `durationSeconds` is the em dash, never `0:00` (which would assert a
 *    zero-length video); a null `date` is the em dash, and the row is KEPT — a
 *    null date is a pinned promo slot, not a row to drop.
 *  - It must never render an empty-but-successful payload as an empty board. An
 *    upstream that answers 200 with no rows is reported as a failure.
 *  - It must never render an unfiltered feed under a tag label. An unknown tag
 *    slug is a 404 from the sidecar, surfaced as the error side for that
 *    section — never a full news list wearing the tag's name.
 *  - It must never let the slice read as the whole. The video feed is 10 of
 *    479 and the board states `10 of 479 videos (SSR page 1)`.
 *
 * The reading itself lives in `./model.ts` and is pure, so every refusal above
 * is unit-tested offline against fixed rows.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, radius, space } from '@/styles/tokens';
import { dash } from '@/lib/format';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import {
  fetchMedia,
  fetchNews,
  fetchNewstag,
  type MediaEnvelope,
  type NewsEnvelope,
  type NewstagEnvelope,
  type Source,
} from './client';
import {
  DEFAULT_TAG_SLUG,
  dateOf,
  formatDuration,
  readMediaBoard,
  readNewsBoard,
  readTagBoard,
  relatedSymbols,
  tagLabel,
  videosState,
  watchUrl,
  type NewsRow,
} from './model';

/** A string field; absent or '' -> the em dash. */
function text(v: string | null | undefined): string {
  return v === null || v === undefined || v === '' ? dash : v;
}

/** A reading-time cell: `8 min`, or the em dash when upstream states none. */
function readingMinutes(v: number | null): string {
  return v === null || !Number.isFinite(v) ? dash : `${v} min`;
}

/** The sentiment cell colour: bullish -> green, bearish -> red, else muted. */
function statusColor(status: string | null): string {
  if (status === 'bullish') return themeColor.green;
  if (status === 'bearish') return themeColor.red;
  return themeColor.labelTertiary;
}

/** The shared footnote treatment. */
const FOOTNOTE: CSSProperties = {
  margin: `${space[8]}px 0 0`,
  fontSize: fontSize[11],
  color: themeColor.labelTertiary,
  lineHeight: lineHeight.normal,
};

/** The stat-tile treatment the headline row repeats. */
const TILE: CSSProperties = { padding: `${space[8]}px ${space[8]}px`, flex: '1 1 180px' };

/** The select / input / button / chip controls, all token-derived. */
const CONTROL: CSSProperties = {
  background: themeColor.bgTertiary,
  color: themeColor.labelSecondary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[8]}px`,
  fontSize: fontSize[12],
  fontFamily: 'inherit',
  cursor: 'pointer',
};
const INPUT: CSSProperties = { ...CONTROL, cursor: 'text' };
const BUTTON: CSSProperties = {
  background: themeColor.blue,
  color: themeColor.labelOnAccent,
  border: 'none',
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[12]}px`,
  fontSize: fontSize[12],
  fontWeight: fontWeight.semibold,
  fontFamily: 'inherit',
  cursor: 'pointer',
};
const CHIP: CSSProperties = {
  background: themeColor.bgTertiary,
  color: themeColor.labelSecondary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[8]}px`,
  fontSize: fontSize[11],
  fontFamily: 'inherit',
  cursor: 'pointer',
};

/**
 * One read, keyed by a selector string. The loader closure is re-created each
 * render, but the effect depends on `key` — the SELECTION the read was made for
 * — so switching a tag refetches and an unrelated re-render does not.
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
// (1) Headline row — three Stats over the two page-1 reads.
// ---------------------------------------------------------------------------
function HeadlineRow({ media, news }: { media: Source<MediaEnvelope> | null; news: Source<NewsEnvelope> | null }) {
  const mediaBoard = media?.data ? readMediaBoard(media.data.mediaRows ?? [], media.data.upstreamTotal ?? null) : null;
  const newsBoard = news?.data ? readNewsBoard(news.data.newsRows ?? []) : null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
      <Stat
        label="Videos in view"
        value={
          mediaBoard === null
            ? dash
            : mediaBoard.upstreamTotal === null
              ? String(mediaBoard.shown)
              : `${mediaBoard.shown} of ${mediaBoard.upstreamTotal}`
        }
        hint="CryptoRank media feed — SSR page 1 only"
        valueSize={fontSize[17]}
        style={TILE}
      />
      <Stat
        label="News in view"
        value={newsBoard === null ? dash : String(newsBoard.shown)}
        hint="CryptoRank news wire — page 1"
        valueSize={fontSize[17]}
        style={TILE}
      />
      <Stat
        label="With a sentiment status"
        value={newsBoard === null ? dash : String(newsBoard.withStatus)}
        hint={newsBoard === null ? 'the news read did not resolve' : `of ${newsBoard.shown} news rows read`}
        valueSize={fontSize[17]}
        style={TILE}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// (2) Video feed — mode=media (10 of 479)
// ---------------------------------------------------------------------------
function MediaCard({ src }: { src: Source<MediaEnvelope> | null }) {
  if (src === null) return <Loading what="the video feed" />;
  if (src.data === null) {
    return <ErrorState title="Could not load the video feed" detail={src.error ?? 'the upstream returned no rows and named no reason'} />;
  }
  const board = readMediaBoard(src.data.mediaRows ?? [], src.data.upstreamTotal ?? null);
  if (board.rows.length === 0) {
    return (
      <ErrorState
        title="The video feed came back empty"
        detail="the upstream answered successfully with no rows — an empty board is not a valid read, so this is reported as a failure, not an empty table"
      />
    );
  }
  return (
    <Card
      title="Video feed"
      subtitle="CryptoRank's media feed — each title links to its YouTube watch page; a length upstream did not publish renders —"
    >
      <DataTable
        head={['Title', 'Channel', 'Published', 'Duration']}
        rows={board.rows.map((r) => ({
          href: watchUrl(r.id),
          cells: [
            <span key="t" style={{ fontWeight: fontWeight.semibold }}>{text(r.title)}</span>,
            <span key="c" style={{ color: themeColor.labelTertiary }}>{text(r.channelTitle)}</span>,
            <span key="p" style={{ color: themeColor.labelTertiary }}>{dateOf(r.publishedAt)}</span>,
            <span key="d">{formatDuration(r.durationSeconds)}</span>,
          ],
        }))}
      />
      <p style={FOOTNOTE}>
        {board.state}. The duration is upstream&apos;s own length in mm:ss; a null length is a metric the upstream did not
        publish, shown as — rather than 0:00. {text(src.data.slice)}.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (3) News wire — mode=news (10 items; a null date is a pinned promo slot)
// ---------------------------------------------------------------------------
function NewsCard({ src }: { src: Source<NewsEnvelope> | null }) {
  if (src === null) return <Loading what="the news wire" />;
  if (src.data === null) {
    return <ErrorState title="Could not load the news wire" detail={src.error ?? 'the upstream returned no rows and named no reason'} />;
  }
  const board = readNewsBoard(src.data.newsRows ?? []);
  if (board.rows.length === 0) {
    return (
      <ErrorState
        title="The news wire came back empty"
        detail="the upstream answered successfully with no rows — reported as a failure, not an empty board"
      />
    );
  }
  return (
    <Card
      title="News wire"
      subtitle="CryptoRank's own news table — each headline links to its publisher; a null date is a pinned promo slot, kept and dated with —"
    >
      <DataTable
        head={['Headline', 'Source', 'Date', 'Status', 'Read', 'Related coins']}
        rows={board.rows.map((r: NewsRow) => ({
          href: r.url,
          cells: [
            <span key="t" style={{ fontWeight: fontWeight.semibold }}>{text(r.title)}</span>,
            <span key="s" style={{ color: themeColor.labelTertiary }}>{text(r.source)}</span>,
            <span key="d" style={{ color: themeColor.labelTertiary }}>{dateOf(r.date)}</span>,
            <span key="st" style={{ color: statusColor(r.status) }}>{text(r.status)}</span>,
            <span key="r" style={{ color: themeColor.labelTertiary }}>{readingMinutes(r.readingMinutes)}</span>,
            <span key="c" style={{ color: themeColor.labelTertiary }}>{relatedSymbols(r.relatedCoins)}</span>,
          ],
        }))}
      />
      <p style={FOOTNOTE}>
        {board.pinned} of {board.shown} rows are pinned promo slots (a null date upstream) — kept and dated —, never
        dropped. {board.withStatus} of {board.shown} carry an upstream sentiment status. {text(src.data.slice)}.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (4) Tag reader — mode=newstag (keyed detail over the tag slug)
// ---------------------------------------------------------------------------
function TagSection() {
  const [slug, setSlug] = useState<string>(DEFAULT_TAG_SLUG);
  const [draft, setDraft] = useState<string>(DEFAULT_TAG_SLUG);
  const src = useSource<NewstagEnvelope>((s) => fetchNewstag(slug, s), `newstag:${slug}`);

  const choose = (next: string) => {
    const s = next.trim();
    if (s === '') return;
    setSlug(s);
    setDraft(s);
  };

  const options = src?.data?.relatedTags ?? [];

  return (
    <Card
      title="News by tag"
      subtitle="pick a tag slug, or type your own — an unknown slug is a 404 surfaced as the error side, never an unfiltered feed"
      right={
        <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={slug} onChange={(e) => choose(e.target.value)} aria-label="tag slug" style={CONTROL}>
            {!options.some((t) => t.slug === slug) ? <option value={slug}>{slug}</option> : null}
            {options.map((t) => (
              <option key={t.slug} value={t.slug}>{tagLabel(t)}</option>
            ))}
          </select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              choose(draft);
            }}
            style={{ display: 'flex', gap: space[8] }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="tag slug"
              aria-label="tag slug (free text)"
              style={INPUT}
            />
            <button type="submit" style={BUTTON}>Load</button>
          </form>
        </div>
      }
    >
      {src === null ? (
        <Loading what="the tag feed" />
      ) : src.data === null ? (
        <ErrorState
          title={`Could not load the "${slug}" tag`}
          detail={src.error ?? 'the upstream returned no rows and named no reason'}
        />
      ) : (
        (() => {
          const board = readTagBoard(src.data.tag ?? null, src.data.newsRows ?? [], src.data.relatedTags ?? []);
          if (board.rows.length === 0) {
            return (
              <ErrorState
                title={`The "${slug}" tag came back with no articles`}
                detail="the upstream answered successfully with no rows — reported as a failure, not an empty board"
              />
            );
          }
          return (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
                <Stat
                  label="Tag"
                  value={text(board.tag?.name ?? slug)}
                  hint={`slug ${slug}`}
                  valueSize={fontSize[17]}
                  style={TILE}
                />
                <Stat
                  label="Slug"
                  value={text(board.tag?.slug ?? slug)}
                  hint="the upstream key this board read"
                  valueSize={fontSize[17]}
                  style={TILE}
                />
                <Stat
                  label="Subtitle"
                  value={text(board.tag?.subtitle)}
                  hint="upstream's own tag subtitle, or — when it ships none"
                  valueSize={fontSize[13]}
                  style={TILE}
                />
              </div>

              <DataTable
                head={['Headline', 'Source', 'Date', 'Status', 'Read', 'Related coins']}
                rows={board.rows.map((r: NewsRow) => ({
                  href: r.url,
                  cells: [
                    <span key="t" style={{ fontWeight: fontWeight.semibold }}>{text(r.title)}</span>,
                    <span key="s" style={{ color: themeColor.labelTertiary }}>{text(r.source)}</span>,
                    <span key="d" style={{ color: themeColor.labelTertiary }}>{dateOf(r.date)}</span>,
                    <span key="st" style={{ color: statusColor(r.status) }}>{text(r.status)}</span>,
                    <span key="r" style={{ color: themeColor.labelTertiary }}>{readingMinutes(r.readingMinutes)}</span>,
                    <span key="c" style={{ color: themeColor.labelTertiary }}>{relatedSymbols(r.relatedCoins)}</span>,
                  ],
                }))}
              />

              {board.relatedTags.length > 0 && (
                <div style={{ marginTop: space[12] }}>
                  <div style={{ color: themeColor.labelSecondary, fontSize: fontSize[11], marginBottom: space[8] }}>
                    Related tags — pick one to reload this board
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
                    {board.relatedTags.map((t) => (
                      <button key={t.slug} type="button" onClick={() => choose(t.slug)} style={CHIP}>
                        {tagLabel(t)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <p style={FOOTNOTE}>
                {board.shown} article(s) upstream tagged &quot;{text(board.tag?.slug ?? slug)}&quot; (upstream ships no tag
                total); {board.relatedTags.length} related tags offered. An unknown slug is a 404, surfaced as an error
                rather than an unfiltered feed. {text(src.data.slice)}.
              </p>
            </>
          );
        })()
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The route surface — three independent reads; one failing read never blanks another.
// ---------------------------------------------------------------------------
export default function MediaNewsBoards() {
  const media = useSource<MediaEnvelope>((s) => fetchMedia(s), 'media');
  const news = useSource<NewsEnvelope>((s) => fetchNews(s), 'news');

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[16] }}>
      <HeadlineRow media={media} news={news} />
      <MediaCard src={media} />
      <NewsCard src={news} />
      <TagSection />
      <p style={{ margin: 0, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        Three CryptoRank tables — the video feed, the news wire and the tag reader — on one rule: a metric the upstream
        did not publish renders —, never 0. The video feed is 10 of 479 and says so; a null news date is a pinned promo
        slot and its row is kept; an unknown tag slug is a 404, never an unfiltered feed. This is a different source
        from the /news board, which reads the Cointelegraph RSS family. Nothing here is a recommendation.
      </p>
    </div>
  );
}
