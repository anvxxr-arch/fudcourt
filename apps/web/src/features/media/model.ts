/**
 * The CryptoRank media & news board's domain model — the video feed, the news
 * wire and the per-tag news reader, as a READING of what CryptoRank publishes.
 *
 * WHY THIS IS ITS OWN FAMILY AND NOT `news`. The `/news` surface reads the
 * `news` family — the Cointelegraph RSS feed, whose items are headline/link/
 * pubDate/source. This surface reads CryptoRank's OWN media and news tables:
 * a YouTube video feed (`mode=media`), a publisher news wire with upstream
 * sentiment and related-coin joins (`mode=news`), and a tag-filtered news
 * reader (`mode=newstag`). Same word, different upstream, different rows — so
 * it is a different family with its own model, not a second view of `/news`.
 *
 * THE ONE RULE THIS MODULE OBEYS. A metric the upstream did not publish renders
 * `—`, never 0 — and a value that is absent is NOT a value of zero. `—` is the
 * absence of a measurement; `0:00` would assert a zero-length video, and a `0`
 * reading count would assert an unread article. A `date: null` on the news wire
 * is a PINNED PROMO SLOT (upstream ships no publish time for it) — the row is
 * kept and its date cell shows `—`; dropping it would hide a row upstream
 * actually published.
 *
 * PURE: no network, no clock (`nowSec` is a parameter where a read needs one),
 * no I/O — so it unit-tests offline against fixed rows. It does include the
 * display derivations the board is required to share (the mm:ss duration
 * formatter and the YouTube watch-URL builder) so the UI cannot drift from a
 * second copy of either.
 */

import { dash } from '@/lib/format';

/** One video row, as CryptoRank's `media` mode ships it (10 of 479). */
export type MediaRow = {
  /** The YouTube video id — the watch URL is built from it (see `watchUrl`). */
  id: string;
  title: string;
  channelTitle: string;
  /** Upstream ISO instant; null = absent -> em dash. */
  publishedAt: string | null;
  /** Length in seconds; null = upstream published none -> em dash, never 0:00. */
  durationSeconds: number | null;
  tags: string[];
};

/** One coin joined to a news row: symbol plus upstream price/change. */
export type RelatedCoin = {
  symbol: string;
  priceUsd: number | null;
  /** A PERCENT (e.g. -2.84), unlike the fraction change fields elsewhere. */
  change24h: number | null;
};

/** One news row, as `mode=news` and `mode=newstag` ship it. */
export type NewsRow = {
  id: number;
  title: string;
  url: string;
  source: string;
  /** ISO instant, or null for a pinned promo slot -> em dash, row KEPT. */
  date: string | null;
  /** Upstream sentiment tag ('bullish' | 'bearish'), or null when untagged. */
  status: string | null;
  readingMinutes: number | null;
  isAdvertisement: boolean;
  relatedCoins: RelatedCoin[];
};

/** The tag header `mode=newstag` ships beside its rows. */
export type NewsTagInfo = {
  slug: string;
  name: string;
  subtitle: string | null;
};

/** A related tag offered by `mode=newstag` (its `slug` is the next read). */
export type RelatedTag = {
  slug: string;
  name: string;
};

/** The default tag slug the selector opens on (a real, live upstream tag). */
export const DEFAULT_TAG_SLUG = 'defi';

// ---------------------------------------------------------------------------
// Pure derivations — the display rules, shared so they cannot drift.
// ---------------------------------------------------------------------------

/**
 * A video length in seconds as `mm:ss`.
 *
 * Null, absent, non-finite or negative is the em dash — NEVER `0:00`, which
 * would read as a real zero-length video rather than a length upstream did not
 * publish. `mm` is the whole minute count (a 908s video is `15:08`); `ss` is
 * zero-padded to two digits.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return dash;
  const total = Math.floor(seconds);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

/** The canonical YouTube watch URL for a media row's video id. */
export function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** The date part of an upstream ISO instant; null/absent -> the em dash. */
export function dateOf(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : dash;
}

/**
 * A tag's display name, trimmed.
 *
 * Upstream ships some related-tag names padded with whitespace/newlines (the
 * `-news-` chip carries `"\n   News   "`); a blank name falls back to the slug
 * so a chip is never an empty clickable box.
 */
export function tagLabel(tag: RelatedTag): string {
  const name = tag.name.trim();
  return name === '' ? tag.slug : name;
}

/**
 * A news row's related coins as a symbol list.
 *
 * An empty list is the em dash, never `''`: a row joined to no coin states no
 * symbols rather than an empty cell that reads as a rendering failure.
 */
export function relatedSymbols(coins: readonly RelatedCoin[]): string {
  const symbols = coins.map((c) => c.symbol).filter((s) => s !== '');
  return symbols.length === 0 ? dash : symbols.join(', ');
}

/** The video feed's slice line — how many of how many, and that it is page 1. */
export function videosState(shown: number, upstreamTotal: number | null): string {
  if (upstreamTotal === null) {
    return `${shown} videos (upstream stated no total; SSR page 1 only)`;
  }
  return `${shown} of ${upstreamTotal} videos (SSR page 1)`;
}

// ---------------------------------------------------------------------------
// Board reads — pure, so each refusal is unit-testable offline.
// ---------------------------------------------------------------------------

/** The video board, read. */
export type MediaBoard = {
  rows: MediaRow[];
  shown: number;
  upstreamTotal: number | null;
  /** The required slice statement, e.g. `10 of 479 videos (SSR page 1)`. */
  state: string;
};

/**
 * Read the video feed. The slice is STATED because "the 10 videos we can see"
 * and "the 479 the feed holds" are different claims, and the board must make
 * clear it is page 1 of a larger feed.
 */
export function readMediaBoard(rows: readonly MediaRow[], upstreamTotal: number | null): MediaBoard {
  const shown = rows.length;
  return { rows: [...rows], shown, upstreamTotal, state: videosState(shown, upstreamTotal) };
}

/** The news board, read. */
export type NewsBoard = {
  rows: NewsRow[];
  shown: number;
  /** Rows carrying an upstream sentiment status (bullish/bearish). */
  withStatus: number;
  /** Rows pinned as a promo slot (date === null) — kept, dated with the em dash. */
  pinned: number;
};

/**
 * Read the news wire. `pinned` is counted, not dropped: a null date is a real
 * upstream state (a promo slot), so the row stays and the board can say how
 * many of the rows in view are undated.
 */
export function readNewsBoard(rows: readonly NewsRow[]): NewsBoard {
  let withStatus = 0;
  let pinned = 0;
  for (const row of rows) {
    if (row.status !== null && row.status !== '') withStatus += 1;
    if (row.date === null) pinned += 1;
  }
  return { rows: [...rows], shown: rows.length, withStatus, pinned };
}

/** One tag's board, read: its header, its news rows and its related tags. */
export type TagBoard = {
  tag: NewsTagInfo | null;
  rows: NewsRow[];
  relatedTags: RelatedTag[];
  shown: number;
};

/**
 * Read a tag board. A null `tag` is upstream's soft-404 marker (the sidecar
 * answers it as HTTP 404, so the client never reaches this with a null tag on
 * an unknown slug) — the board must never render an unfiltered feed under a
 * tag label, so the reader keeps the null and lets the UI surface the error.
 */
export function readTagBoard(
  tag: NewsTagInfo | null,
  rows: readonly NewsRow[],
  relatedTags: readonly RelatedTag[],
): TagBoard {
  return { tag, rows: [...rows], relatedTags: [...relatedTags], shown: rows.length };
}
