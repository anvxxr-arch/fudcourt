/**
 * The INSIGHTS boards' domain model — the two questions the quarterly-returns and
 * AI-market-overview surface answers, read from CryptoRank's own tables:
 *   - "How has each asset done, quarter by quarter?" — Quarterly: per-year BTC/ETH
 *     cells carrying an OPEN and a CLOSE price, from which the RETURN is COMPUTED
 *     here (CryptoRank ships no return% at all).
 *   - "What does CryptoRank's own AI digest say about the market right now?" — the
 *     AI overview: a generated market summary, its news list, its funding rollup,
 *     and its drop-hunting / vesting sections.
 *
 * THE ONE RULE EVERY SECTION OBEYS. A metric the upstream did not publish renders
 * `—`, never 0. `0` is a measurement; `—` is the absence of one. A quarter that
 * carries no close yet (a quarter STILL IN PROGRESS) therefore shows no return —
 * it is marked `in-progress` and never dressed as a completed one, because "the
 * quarter is up 3% so far" and "the quarter returned 3%" are different claims and
 * only the first is true.
 *
 * THE RETURN IS OURS, AND IS LABELLED SO. CryptoRank's quarterly table ships an
 * `openUsd` and a `closeUsd` and nothing else; every percentage on this board is
 * `(close - open) / open * 100`, computed in this module, and the board says so at
 * the column and in the footnote. It is the same arithmetic on the same numbers,
 * not a figure the upstream made.
 *
 * THE AI DIGEST IS CRYPTORANK'S WORDS. `aiOverview.*.summary` is generated text
 * CryptoRank wrote; the board quotes it and labels it as theirs, never as ours and
 * never as an independent finding. The literal `"No Data Available"` is a STATED
 * ABSENCE, not data — it is rendered as "the upstream states no summary for this
 * section", never as a summary containing that string.
 *
 * PURE: no network, no clock (`nowSec` is a parameter), no I/O — so it unit-tests
 * offline against fixed rows.
 */

// ---------------------------------------------------------------------------
// Quarterly returns — mode=quarterly
// ---------------------------------------------------------------------------

/** The four quarter keys, in calendar order. */
export const QUARTER_KEYS = ['q1', 'q2', 'q3', 'q4'] as const;
export type QuarterKey = (typeof QUARTER_KEYS)[number];
export const QUARTER_LABELS: Record<QuarterKey, string> = { q1: 'Q1', q2: 'Q2', q3: 'Q3', q4: 'Q4' };

/** One quarter's price bounds, as CryptoRank ships them. `isFull:false` = running. */
export type QuarterCell = {
  openUsd: number | null;
  closeUsd: number | null;
  isFull: boolean;
};

/** One year of a CryptoRank quarterly table. A null cell = the asset did not exist. */
export type QuarterlyRow = {
  year: number;
  q1: QuarterCell | null;
  q2: QuarterCell | null;
  q3: QuarterCell | null;
  q4: QuarterCell | null;
};

/** How a single quarter reads. */
export type QuarterStatus =
  /** Upstream shipped no cell — before that asset existed. */
  | 'absent'
  /** A completed quarter whose open and close upstream did not both state. */
  | 'uncomputable'
  /** A completed quarter with a computed return. */
  | 'complete'
  /** A quarter still open upstream (`isFull:false`) — its move is running, not final. */
  | 'in-progress';

/** One quarter, read. */
export type QuarterRead = {
  key: QuarterKey;
  label: string;
  openUsd: number | null;
  closeUsd: number | null;
  isFull: boolean;
  /** The return% COMPUTED here from open/close; null when it cannot be computed. */
  returnPct: number | null;
  status: QuarterStatus;
  note: string | null;
};

/**
 * The return over a quarter, COMPUTED from upstream open/close.
 *
 * `(close - open) / open * 100`, and null — never 0 — when either bound is absent
 * or the open is zero (a zero denominator is not an infinite nor a zero return; it
 * is no return at all). A close the upstream has not stated yet is a null, and a
 * null close is a quarter with no return to show, not a return of zero.
 */
export function computeReturnPct(openUsd: number | null, closeUsd: number | null): number | null {
  if (openUsd === null || closeUsd === null) return null;
  if (!Number.isFinite(openUsd) || !Number.isFinite(closeUsd)) return null;
  if (openUsd === 0) return null;
  return ((closeUsd - openUsd) / openUsd) * 100;
}

/** Read one quarter cell into its return, its status and why it reads as it does. */
export function readQuarter(cell: QuarterCell | null | undefined, key: QuarterKey): QuarterRead {
  const label = QUARTER_LABELS[key];
  if (cell === null || cell === undefined) {
    return {
      key,
      label,
      openUsd: null,
      closeUsd: null,
      isFull: false,
      returnPct: null,
      status: 'absent',
      note: 'upstream shipped no cell for this quarter (the asset did not exist yet)',
    };
  }
  const { openUsd, closeUsd, isFull } = cell;
  const returnPct = computeReturnPct(openUsd, closeUsd);
  if (!isFull) {
    return {
      key,
      label,
      openUsd,
      closeUsd,
      isFull,
      returnPct,
      status: 'in-progress',
      note:
        closeUsd === null
          ? 'the quarter is in progress and upstream states no close yet — no return can be computed'
          : 'the quarter is in progress — this is the move so far, not a completed return',
    };
  }
  if (returnPct === null) {
    return {
      key,
      label,
      openUsd,
      closeUsd,
      isFull,
      returnPct: null,
      status: 'uncomputable',
      note: 'a complete quarter whose open and close upstream did not both state',
    };
  }
  return { key, label, openUsd, closeUsd, isFull, returnPct, status: 'complete', note: null };
}

/** One year, read: its four quarters, a full-year figure, and the caveats. */
export type YearRead = {
  year: number;
  quarters: QuarterRead[];
  /** First present open -> last present close, COMPUTED; null when not computable. */
  fullYearReturnPct: number | null;
  fullYearOpenUsd: number | null;
  fullYearCloseUsd: number | null;
  fullYearStatus: 'complete' | 'in-progress' | 'uncomputable';
  /** True when every present quarter is a completed one (`isFull`). */
  complete: boolean;
  note: string;
};

/**
 * Read one year. The full-year figure spans the first present quarter's open to
 * the last present quarter's close — so a year whose Q4 is still running reports a
 * YEAR-TO-DATE move and says so, and a year whose last close is absent reports no
 * figure at all (`—`), never a partial one under a "full year" label.
 */
export function readYear(row: QuarterlyRow): YearRead {
  const quarters = QUARTER_KEYS.map((k) => readQuarter(row[k], k));
  const present = quarters.filter((q) => q.status !== 'absent');
  const first = present.length > 0 ? present[0] : null;
  const last = present.length > 0 ? present[present.length - 1] : null;
  const fullYearOpenUsd = first ? first.openUsd : null;
  const fullYearCloseUsd = last ? last.closeUsd : null;
  const fullYearReturnPct = computeReturnPct(fullYearOpenUsd, fullYearCloseUsd);
  const inProgress = present.some((q) => q.status === 'in-progress');
  const complete = present.length > 0 && present.every((q) => q.isFull);
  const fullYearStatus: YearRead['fullYearStatus'] =
    fullYearReturnPct === null ? 'uncomputable' : inProgress ? 'in-progress' : 'complete';
  const note =
    present.length === 0
      ? 'upstream shipped no quarter for this year'
      : fullYearReturnPct === null
        ? inProgress
          ? 'the year is still running and its latest quarter states no close — no year figure is computable'
          : 'a bound of the year is absent upstream — no year figure is computable'
        : inProgress
          ? 'year to date — the latest quarter is still running, so this is not a completed year'
          : 'full year — first open to last close';
  return { year: row.year, quarters, fullYearReturnPct, fullYearOpenUsd, fullYearCloseUsd, fullYearStatus, complete, note };
}

/** The asset's current (running) quarter, as the headline reads it. */
export type CurrentQuarterRead = { year: number; quarter: QuarterRead };

/**
 * The newest year's furthest-along quarter that carries a cell. CryptoRank ships
 * rows newest-first, but the board sorts rather than assumes, and picks the LAST
 * present quarter (Q4 while the year runs) — the one the headline's "current
 * quarter" means.
 */
export function currentQuarter(rows: readonly QuarterlyRow[]): CurrentQuarterRead | null {
  if (rows.length === 0) return null;
  const newest = [...rows].sort((a, b) => b.year - a.year)[0];
  let chosen: QuarterRead | null = null;
  for (let i = QUARTER_KEYS.length - 1; i >= 0; i--) {
    const q = readQuarter(newest[QUARTER_KEYS[i]], QUARTER_KEYS[i]);
    if (q.status !== 'absent') {
      chosen = q;
      break;
    }
  }
  if (chosen === null) return null;
  return { year: newest.year, quarter: chosen };
}

/** One asset's quarterly board, read: newest year first, plus the current quarter. */
export type QuarterlyBoard = {
  /** 'BTC' | 'ETH' — the asset this table is for. */
  asset: string;
  rows: YearRead[];
  count: number;
  current: CurrentQuarterRead | null;
};

/** Read a quarterly table (BTC or ETH). Rows are sorted newest-year first. */
export function readQuarterlyBoard(rows: readonly QuarterlyRow[], asset: string): QuarterlyBoard {
  const sorted = [...rows].sort((a, b) => b.year - a.year);
  return { asset, rows: sorted.map(readYear), count: rows.length, current: currentQuarter(rows) };
}

// ---------------------------------------------------------------------------
// The AI market overview — mode=aioverview
// ---------------------------------------------------------------------------

/** `funding.summary` carries this literal when CryptoRank states no funding text. */
export const AI_ABSENT_SUMMARY = 'No Data Available';

/** The market block: CryptoRank's generated prose and the instant it was written. */
export type AiMarket = { summary: string | null; updatedAt: string | null };
/** One digest headline. */
export type AiNewsItem = { id: number; title: string; date: string | null; isBullish: boolean };
/** One funding round. */
export type AiFundingRound = { key: string; name: string; stage: string | null; raisedUsd: number | null };
/** The funding section: a summary (possibly the absent literal) and its rounds. */
export type AiFunding = { summary: string | null; rounds: AiFundingRound[] };
/** One drop-hunting activity. */
export type AiDropActivity = { key: string; type: string | null; coinName: string | null };
/** The drop-hunting section. */
export type AiDropHunting = { summary: string | null; activities: AiDropActivity[] };
/** One token unlock. `unlockPercent` is a PERCENT of supply, as upstream states it. */
export type AiUnlock = { date: string | null; unlockPercent: number | null; coinName: string | null };
/** The vesting section. */
export type AiVesting = { summary: string | null; unlocks: AiUnlock[] };

/** CryptoRank's AI digest, whole. Any block may be absent. */
export type AiOverview = {
  market: AiMarket | null;
  news: AiNewsItem[] | null;
  funding: AiFunding | null;
  dropHunting: AiDropHunting | null;
  vesting: AiVesting | null;
};

/** A summary string, read: its text when there is one, or a named absence. */
export type StatedText = { text: string | null; absent: boolean; reason: string | null };

/**
 * Read a `summary` string.
 *
 * The literal `"No Data Available"` (case-insensitive, trimmed) and an empty or
 * missing string are each a STATED ABSENCE — the board renders "CryptoRank states
 * no summary for this section" rather than printing that literal as if it were a
 * finding, and rather than printing an empty paragraph as if it were one.
 */
export function readStatedText(summary: string | null | undefined): StatedText {
  if (summary === null || summary === undefined) {
    return { text: null, absent: true, reason: 'upstream shipped no text for this section' };
  }
  const trimmed = summary.trim();
  if (trimmed === '') {
    return { text: null, absent: true, reason: 'upstream shipped an empty text for this section' };
  }
  if (trimmed.toLowerCase() === AI_ABSENT_SUMMARY.toLowerCase()) {
    return { text: null, absent: true, reason: `CryptoRank states “${AI_ABSENT_SUMMARY}” for this section` };
  }
  return { text: trimmed, absent: false, reason: null };
}

/** The funding section, read. */
export type FundingRead = {
  summary: StatedText;
  rounds: AiFundingRound[];
  /** Rounds that state a raisedUsd. */
  raisedStated: number;
  /** Total raised across the rounds, ONLY when every round states one; else null. */
  raisedTotalUsd: number | null;
};

/** Read the funding block. A missing block is a stated absence with no rounds. */
export function readFunding(f: AiFunding | null | undefined): FundingRead {
  if (f === null || f === undefined) {
    return { summary: readStatedText(null), rounds: [], raisedStated: 0, raisedTotalUsd: null };
  }
  const rounds = (f.rounds ?? []).slice();
  let raisedStated = 0;
  let sum = 0;
  let everyStates = rounds.length > 0;
  for (const r of rounds) {
    if (r.raisedUsd !== null && Number.isFinite(r.raisedUsd)) {
      raisedStated += 1;
      sum += r.raisedUsd;
    } else {
      everyStates = false;
    }
  }
  return { summary: readStatedText(f.summary), rounds, raisedStated, raisedTotalUsd: everyStates ? sum : null };
}

/** The drop-hunting section, read. `present` is false when upstream shipped no block. */
export type DropHuntingRead = { present: boolean; summary: StatedText; activities: AiDropActivity[] };

/** The vesting section, read. */
export type VestingRead = { present: boolean; summary: StatedText; unlocks: AiUnlock[]; soonestDate: string | null };

/** Read the drop-hunting block. */
export function readDropHunting(d: AiDropHunting | null | undefined): DropHuntingRead {
  if (d === null || d === undefined) {
    return { present: false, summary: readStatedText(null), activities: [] };
  }
  return { present: true, summary: readStatedText(d.summary), activities: (d.activities ?? []).slice() };
}

/**
 * Read the vesting block. `soonestDate` is the earliest unlock instant upstream
 * lists (its own ordering is not trusted), or null when none carries a date.
 */
export function readVesting(v: AiVesting | null | undefined): VestingRead {
  if (v === null || v === undefined) {
    return { present: false, summary: readStatedText(null), unlocks: [], soonestDate: null };
  }
  const unlocks = (v.unlocks ?? []).slice();
  let soonest: number | null = null;
  for (const u of unlocks) {
    if (u.date === null) continue;
    const t = Date.parse(u.date);
    if (Number.isNaN(t)) continue;
    if (soonest === null || t < soonest) soonest = t;
  }
  return { present: true, summary: readStatedText(v.summary), unlocks, soonestDate: soonest === null ? null : new Date(soonest).toISOString() };
}

/** Parse an upstream ISO instant to whole seconds, or null when absent/unparseable. */
export function parseInstant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

/**
 * CryptoRank's AI digest, read. Returns null when the payload carried no digest at
 * all — an envelope that answers successfully with no `aiOverview` is a FAILURE to
 * report, not an empty board, and the caller renders the error side.
 */
export type AiDigest = {
  marketSummary: StatedText;
  updatedAt: string | null;
  /** Whole seconds since `updatedAt`, or null when it is absent/unparseable. */
  updatedAgeSec: number | null;
  news: AiNewsItem[];
  funding: FundingRead;
  dropHunting: DropHuntingRead;
  vesting: VestingRead;
  /** The derivations and attributions, stated once. */
  derived: string;
};

export function readAiDigest(o: AiOverview | null | undefined, nowSec: number): AiDigest | null {
  if (o === null || o === undefined) return null;
  const market = o.market ?? null;
  const updatedAtSec = parseInstant(market?.updatedAt ?? null);
  const updatedAgeSec = updatedAtSec === null ? null : Math.max(0, nowSec - updatedAtSec);
  return {
    marketSummary: readStatedText(market?.summary ?? null),
    updatedAt: market?.updatedAt ?? null,
    updatedAgeSec,
    news: (o.news ?? []).slice(),
    funding: readFunding(o.funding),
    dropHunting: readDropHunting(o.dropHunting),
    vesting: readVesting(o.vesting),
    derived:
      'every quarterly percentage on this board is COMPUTED from CryptoRank’s open and close prices ' +
      '((close - open) / open), not shipped upstream; a running quarter is marked in progress and is never a ' +
      'completed return. The AI market summary, news, funding, drop-hunting and vesting text is CryptoRank’s OWN ' +
      'generated wording — quoted, not authored or endorsed here; the literal “No Data Available” is read as a ' +
      'stated absence, never as data.',
  };
}
