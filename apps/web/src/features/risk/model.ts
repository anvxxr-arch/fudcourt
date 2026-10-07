/**
 * The risk feed's domain model — prediction-market pricing joined with the
 * headlines being reported, as a READING of discrete event risk.
 *
 * WHAT THIS IS. A prediction market prices a DISCRETE event: "will X happen by
 * date D". Its book (bid/ask) therefore carries an IMPLIED PROBABILITY — the
 * market's own priced odds — and that is the one number here that is not ours.
 * This module reads it, ranks it by the liquidity that makes it meaningful, and
 * shows it beside the headlines the outlet is running. It is a reading of what
 * the market prices and what is being reported. It is not a forecast, and it is
 * not advice.
 *
 * THE PROBABILITY IS DERIVED, AND REFUSED WHEN THE BOOK CANNOT SUPPORT ONE.
 * The mid of a two-sided book is an implied probability; a crossed book
 * (ask <= bid), a one-sided or absent book, and a non-positive quote are each
 * NOT a price, and each holding is NAMED in `skipped[]` with its reason rather
 * than printed as 0 or 0.5. A fabricated 50% is the exact failure this refusal
 * exists to prevent: it would read as "the market is undecided" when the truth
 * is "there is no market here".
 *
 * A WIDE BOOK IS SHOWN, BUT MARKED. A quote one cent wide on a 1.5c market is
 * a 67% relative spread — the mid is arithmetic, not a consensus. The row is
 * kept (it is real data) and carries `bookQuality: 'wide'` so the board can say
 * so instead of letting a thin market masquerade as a liquid one.
 *
 * THE FEED SEES A PAGE, NOT THE MARKET. CryptoRank serves page 1 — 20 rows of
 * 50,307. The payload says so, and the board renders it, because "the 20
 * highest-volume markets we can see" and "what the market thinks" are different
 * claims and only the first is true.
 *
 * THE NEWS JOIN IS LEXICAL AND IS LABELLED AS SUCH. A market and a headline are
 * linked only when they share a significant token (>= 5 characters, not a
 * stopword). That is a lexical overlap, NOT a claim that the headline caused or
 * explains the price; the field is named `lexicalMatches` and the board says so.
 * Inventing a causal link between a headline and a price would be the same
 * fabrication as inventing the price.
 *
 * PURE: no network, no clock (`now` is a parameter), no I/O — so it unit-tests
 * offline against fixed rows.
 */

/** One prediction-market row, as CryptoRank's `prediction` mode ships it. */
export type PredictionRow = {
  id: string;
  title: string;
  platform: string;
  category: string;
  /** ISO date the event resolves, or '' when upstream states none. */
  endDate: string;
  volume24hUsd: number;
  bid: number;
  ask: number;
  /** The raw (ask - bid) the upstream reports, in basis points of probability. */
  spread: number;
  externalUrl: string;
};

/** One news item, as the `news` family ships it (the six Go keys, verbatim). */
export type Headline = {
  title: string;
  link: string;
  pubDate: string;
  source: string;
};

/** The platform aggregates CryptoRank returns beside the rows. */
export type PredictionAggregate = {
  totalVolumeUsd: number;
  volumeChangePct: number;
  marketsCount: number;
  marketsChangePct: number;
  openInterestUsd: number;
  oiChangePct: number;
  platforms: { platform: string; volumeUsd: number; marketsCount: number; openInterestUsd: number }[];
};

/** How much the book supports the mid as a consensus. */
export type BookQuality = 'tight' | 'wide' | 'unknown';

/** One market, read. */
export type MarketRead = {
  id: string;
  title: string;
  platform: string;
  category: string;
  endDate: string;
  externalUrl: string;
  volume24hUsd: number;
  /** The book's mid — the implied probability — or null when the book cannot support one. */
  probability: number | null;
  /** Why no probability is stated, when none is. */
  probabilityReason: string | null;
  /** The absolute (ask - bid) in probability, or null when unquotable. */
  spread: number | null;
  /** The spread as a share of the mid, or null. 0.67 = a 67%-wide book. */
  relativeSpread: number | null;
  bookQuality: BookQuality;
  /** How far the priced probability sits from a coin flip: |p - 0.5|, or null. */
  conviction: number | null;
  /** Headlines sharing a significant token with this title. Lexical, not causal. */
  lexicalMatches: string[];
};

/** A headline as the feed shows it. */
export type FeedHeadline = Headline & { ageHours: number | null };

export type RiskFeed = {
  /** Markets that carry a usable price, ranked by 24h volume, largest first. */
  markets: MarketRead[];
  /** Every market that could not be priced, each naming its reason. */
  skipped: { id: string; title: string; reason: string }[];
  /** The freshest headlines first. */
  headlines: FeedHeadline[];
  /** The upstream platform split, when the payload carried it. */
  aggregate: PredictionAggregate | null;
  /** How much of the market this page can see — stated, never implied. */
  slice: { shown: number; priced: number; upstreamTotal: number; note: string };
  /** The derivations, stated once. */
  derived: string;
  asOf: number;
};

/** Tokens too common to evidence a lexical link. Matched lowercase, whole-token. */
const STOPWORDS = new Set([
  'will', 'would', 'the', 'this', 'that', 'with', 'from', 'have', 'has', 'had',
  'does', 'done', 'than', 'then', 'when', 'what', 'which', 'who', 'whom',
  'there', 'their', 'them', 'they', 'your', 'yours', 'about', 'after', 'before',
  'between', 'into', 'over', 'under', 'more', 'most', 'much', 'many', 'some',
  'such', 'only', 'also', 'just', 'like', 'make', 'made', 'take', 'taken',
  'year', 'years', 'month', 'months', 'week', 'weeks', 'day', 'days', 'today',
  'time', 'times', 'next', 'last', 'first', 'second', 'third', 'ever', 'never',
  'above', 'below', 'win', 'wins', 'won', 'beat', 'beats', 'reach', 'reaches',
  'price', 'prices', 'market', 'markets', 'crypto', 'token', 'tokens', 'coin',
  'coins', 'chain', 'chains', 'money', 'stock', 'stocks', 'close', 'closes',
  'high', 'higher', 'higher', 'lower', 'lowest', 'higher', 'happen', 'happens',
  'point', 'points', 'percent', 'percentage', 'team', 'game', 'games', 'match',
  'matches', 'league', 'season', 'final', 'finals', 'championship', 'playoff',
  'playoffs', 'conference', 'division', 'super', 'bowl', 'cup', 'world',
  'united', 'states', 'state', 'country', 'national', 'city', 'county',
]);

/**
 * A token is significant when it is long enough, is not a stopword, and is not
 * a bare number.
 *
 * The letter requirement is not decoration: "Will Bitcoin reach 200000?" and
 * "Will Ethereum reach 200000?" share the token `200000` and nothing else. A
 * bare figure is a magnitude, not a subject, so linking two markets through one
 * would be a false match dressed as evidence.
 */
function significant(token: string): boolean {
  return token.length >= 5 && !STOPWORDS.has(token) && /[a-z]/.test(token);
}

/** Lowercase word tokens, punctuation stripped. Shared by both sides of the join. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** The set of significant tokens in a title, for the lexical join. */
export function significantTokens(text: string): Set<string> {
  return new Set(tokens(text).filter(significant));
}

/** Days between two ISO dates, or null when either is unusable. */
function daysBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (b - a) / 86_400_000;
}

/** Whether an ISO instant is in the past relative to `nowSec`. Unknown dates are kept. */
function isResolved(endDate: string, nowSec: number): boolean {
  const t = Date.parse(endDate);
  if (Number.isNaN(t)) return false;
  return t / 1000 < nowSec;
}

/** RFC-822 (`pubDate`) or ISO, to seconds, or null when unparseable. */
export function parsePubDate(value: string): number | null {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

/**
 * The implied probability of a two-sided book: the mid of bid and ask.
 *
 * Returns the mid when the book is a real price, and a NAMED reason when it is
 * not — a crossed book, a non-positive quote, or a quote above 1 are each not a
 * probability, and stating one anyway would be inventing the market's view.
 */
export function impliedProbability(
  bid: number,
  ask: number
): { probability: number; spread: number; relativeSpread: number } | { reason: string } {
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return { reason: 'the book is not numeric' };
  if (bid <= 0 || ask <= 0) return { reason: 'the book quotes a non-positive price' };
  if (ask <= bid) return { reason: 'the book is crossed or one-sided (ask is not above bid)' };
  if (bid > 1 || ask > 1) return { reason: 'the book quotes above 1, which is not a probability' };
  const probability = (bid + ask) / 2;
  const spread = ask - bid;
  return { probability, spread, relativeSpread: spread / probability };
}

/** The book is 'tight' under a 10% relative spread, 'wide' above it. */
const WIDE_RELATIVE_SPREAD = 0.1;

export function bookQualityOf(relativeSpread: number | null): BookQuality {
  if (relativeSpread === null) return 'unknown';
  return relativeSpread <= WIDE_RELATIVE_SPREAD ? 'tight' : 'wide';
}

/**
 * Read one market: its implied probability, the book's quality, how far the
 * price sits from a coin flip, and the headlines that share a significant token
 * with its title. Pure.
 */
export function readMarket(
  row: PredictionRow,
  headlines: readonly Headline[],
  headlineTokens: readonly Set<string>[]
): MarketRead | { skipped: { id: string; title: string; reason: string } } {
  const quote = impliedProbability(row.bid, row.ask);
  if ('reason' in quote) {
    return { skipped: { id: row.id, title: row.title, reason: quote.reason } };
  }
  const own = significantTokens(row.title);
  const lexicalMatches: string[] = [];
  for (let i = 0; i < headlines.length; i++) {
    const shared = headlineTokens[i];
    let hit = false;
    for (const t of own) {
      if (shared.has(t)) {
        hit = true;
        break;
      }
    }
    if (hit) lexicalMatches.push(headlines[i].link);
  }
  return {
    id: row.id,
    title: row.title,
    platform: row.platform,
    category: row.category,
    endDate: row.endDate,
    externalUrl: row.externalUrl,
    volume24hUsd: row.volume24hUsd,
    probability: quote.probability,
    probabilityReason: null,
    spread: quote.spread,
    relativeSpread: quote.relativeSpread,
    bookQuality: bookQualityOf(quote.relativeSpread),
    conviction: Math.abs(quote.probability - 0.5),
    lexicalMatches,
  };
}

/**
 * Build the risk feed from CryptoRank's prediction rows and the news items.
 * Pure.
 *
 * `nowSec` is passed in rather than read, so a market that already resolved is
 * excluded deterministically and the whole thing unit-tests without a clock.
 */
export function buildRiskFeed(
  rows: readonly PredictionRow[],
  headlines: readonly Headline[],
  options: { aggregate?: PredictionAggregate | null; upstreamTotal?: number; nowSec: number }
): RiskFeed {
  const headlineTokens = headlines.map((h) => significantTokens(h.title));

  const markets: MarketRead[] = [];
  const skipped: { id: string; title: string; reason: string }[] = [];

  for (const row of rows) {
    if (isResolved(row.endDate, options.nowSec)) {
      skipped.push({ id: row.id, title: row.title, reason: `the event resolved on ${row.endDate}` });
      continue;
    }
    const read = readMarket(row, headlines, headlineTokens);
    if ('skipped' in read) {
      skipped.push(read.skipped);
      continue;
    }
    markets.push(read);
  }

  // Liquidity is what makes a price mean anything, so volume ranks the board.
  markets.sort((a, b) => b.volume24hUsd - a.volume24hUsd);

  const shown = rows.length;
  const priced = markets.length;
  const upstreamTotal = options.upstreamTotal ?? shown;

  const feedHeadlines: FeedHeadline[] = headlines
    .map((h) => {
      const ts = parsePubDate(h.pubDate);
      return { ...h, ageHours: ts === null ? null : Math.max(0, (options.nowSec - ts) / 3600) };
    })
    .sort((a, b) => (a.ageHours ?? Number.POSITIVE_INFINITY) - (b.ageHours ?? Number.POSITIVE_INFINITY));

  return {
    markets,
    skipped,
    headlines: feedHeadlines,
    aggregate: options.aggregate ?? null,
    slice: {
      shown,
      priced,
      upstreamTotal,
      note:
        `this feed reads page 1 of the upstream listing — ${shown} rows of ${upstreamTotal}; ` +
        'the ranking is by 24h volume within those rows, not across the whole market',
    },
    derived:
      'the implied probability is the MID of the two-sided book (bid+ask)/2 — the market\u2019s own priced odds, ' +
      'not our estimate; a crossed, one-sided or non-positive book states no probability and is listed instead; ' +
      'conviction is |p - 0.5|, how far the price sits from a coin flip; book quality is the spread as a share of ' +
      'the mid, and a book wider than 10% is marked wide because its mid is arithmetic rather than consensus; ' +
      'headline matches are LEXICAL (a shared token of 5+ characters that is not a stopword) and assert no causal ' +
      'link between a headline and a price',
    asOf: options.nowSec,
  };
}
