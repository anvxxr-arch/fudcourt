/**
 * khala client surface, shared by the API route and the UI.
 *
 * Contract source: the Go sidecar's frozen wire contract (services/data,
 * `GET /api/khala`, DR-006 era) — this file is its TS mirror, exactly as
 * lib/cryptorank.ts mirrors the cryptorank mode table. Nothing here re-validates
 * what the sidecar already validates at runtime; the values exist so the board
 * can render without guessing at key names, and so a reader can see the wire
 * contract in one place. The sidecar remains the only validator.
 *
 * Measured upstream facts (2026-09-29, /home/dwizzy/khala-probe/RESULTS.md):
 * khala.io is Framer static HTML, its complete report set is the 11-URL
 * sitemap.xml (8 reports + `/`, `/about`, `/disclaimer`), and it publishes
 * research reports ONLY — /news, /blog, /rss.xml, /feed are all real 404s. That
 * is why `latest` exists at all: there is no news feed to read, so "latest
 * research" is the honest news surface and the sidecar says so in `slice`.
 *
 * `mode=report` ships the article as a STRUCTURED block array, never as HTML.
 * That is a wire-contract decision with a UI consequence: the board renders
 * `body` as React elements, needs no `dangerouslySetInnerHTML`, and therefore
 * needs no sanitizer for third-party markup.
 */
/** Canonical upstream origin. Report URLs are `KH_BASE + '/' + slug`. */
export const KH_BASE = 'https://www.khala.io';
/**
 * Modes, in the sidecar's declaration order. Order is part of the contract: the
 * array ships verbatim in the 400 unknown-mode body.
 */
export const KH_MODES = ['reports', 'report', 'latest'] as const;
export type KhMode = (typeof KH_MODES)[number];
/**
 * Report-slug regex, mirrored for display/UX only (the sidecar's key regex is
 * authoritative). The cap is 128, not cryptorank's 64, and that is MEASURED:
 * the walrus slug is 94 chars (sitemap.xml), so a 64-char cap would reject the
 * flagship report. Other measured lengths: surf 76, x402 70, xmaquina 64,
 * bintensor-an-investment-history 61, openclaw 46, bittensor-the-intelligence-
 * olympics 35, decentralized-robotics 31.
 */
export const KH_KEY_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
/** `limit` is strict 1..50 (default 5) and only valid on `mode=latest`. */
export const KH_LIMIT_MIN = 1;
export const KH_LIMIT_MAX = 50;
export const KH_DEFAULT_LIMIT = 5;
/** One author link. `url` is null when the byline carried no anchor. */
export type KhAuthor = { name: string; url: string | null };
/** A document-order heading, used as the reader view's table of contents. */
export type KhSection = { id: string; level: number; title: string };
/**
 * One structured body block. Inline `<em>`/`<strong>`/`<a>` are already
 * flattened to text upstream, so `text` is render-ready and carries no markup.
 */
export type KhBlock = { type: 'h2' | 'h3' | 'h4' | 'p' | 'li'; id?: string; text: string };
/**
 * A list row. `published`/`publishedISO` are present ONLY on `mode=latest` rows
 * (the sidecar resolves them by fetching each report page and says so in
 * `slice`); on `mode=reports` the keys are ABSENT by design because the
 * homepage list source publishes no dates. Absent means "not reported", so the
 * table renders the house `—` and never a date, and never `0`.
 */
export type KhRow = {
  position: number;
  slug: string;
  url: string;
  title: string;
  summary: string | null;
  published?: string | null;
  publishedISO?: string | null;
};
/** A full report. `published` and `authors` may be present-null (render `—`). */
export type KhReport = {
  slug: string;
  url: string;
  title: string;
  metaTitle: string;
  published: string | null;
  publishedISO: string | null;
  authors: KhAuthor[] | null;
  sections: KhSection[];
  body: KhBlock[];
};
/**
 * `kind` is authoritative (the RESOLVED mode); `mode` is the echoed request
 * param and may be absent, so the board reads `env.kind` directly rather than
 * trusting an echo.
 */
export type KhEnvelope = {
  kind: KhMode;
  mode?: KhMode;
  upstream: string;
  fetchedAt: number;
  cache: 'MISS' | 'HIT';
  count: number;
  upstreamTotal?: number;
  slice?: string;
  /** Present only when the homepage parse missed part of the sitemap set. */
  missingSlugs?: string[];
  rows?: KhRow[];
  report?: KhReport;
};
/** Error body the sidecar (and this proxy) returns on 400/404/502. */
export type KhError = {
  error: string;
  detail?: string;
  mode?: string;
  key?: string;
  limit?: string;
  upstreamStatus?: number | null;
  upstream?: string;
  kind?: string | null;
};
/** `/api/khala` URL builder — one place that knows the query shape. */
export function khalaUrl(mode: KhMode, opts: { key?: string; limit?: number } = {}): string {
  const q = new URLSearchParams({ mode });
  if (opts.key !== undefined) q.set('key', opts.key);
  if (opts.limit !== undefined) q.set('limit', String(opts.limit));
  return `/api/khala?${q.toString()}`;
}
