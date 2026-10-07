/**
 * The spot-ETF flow desk's domain model — daily creations/redemptions per
 * issuer, read as a cumulative flow series.
 *
 * WHAT THIS IS. Upstream (CoinAnk `mode=etf`) ships one row per UTC day, newest
 * first: the day's net BTC change, its net USD flow (signed), and a per-issuer
 * list. This module reads it into a board — the latest day, the cumulative flow
 * over the window the payload covers, the most recent N days, and the per-issuer
 * totals over that window.
 *
 * THE HAZARD THIS MODULE EXISTS TO HOLD. Older rows ship `ticker: null` — the
 * upstream stopped labelling issuers before a cutoff. A null ticker is a REAL
 * absence, so its rows are grouped under an explicit `UNLABELLED` bucket and are
 * NEVER given a fabricated name and NEVER dropped. A fabricated ticker would be
 * the same lie as a fabricated number.
 *
 * A MISSING NUMBER IS NEVER A ZERO. A `change`/`changeUsd` that is null,
 * undefined or non-finite is treated as ABSENT: it is excluded from every sum (so
 * it cannot poison a cumulative total) and it renders `—` at the edge, never `0`.
 *
 * PURE: no network, no clock, no I/O. Dates come from the payload's own ms epochs
 * and are formatted in UTC, so every read here unit-tests offline.
 */

/** One issuer line inside a day, as CoinAnk ships it. `ticker` is null when unlabelled. */
export type EtfIssuerRow = {
  ticker: string | null;
  change: number;
  changeUsd: number;
};

/** One UTC day of net ETF flow, as CoinAnk ships it. */
export type EtfDayRow = {
  /** ms epoch at UTC midnight. */
  date: number;
  /** net BTC change for the day (signed). */
  change: number;
  /** net USD flow for the day (signed). */
  changeUsd: number;
  list: EtfIssuerRow[];
};

/** The explicit bucket for rows the upstream ships without a ticker. */
export const UNLABELLED = 'unlabelled (upstream)';

/** The board's default recent-window size. */
export const DEFAULT_RECENT_DAYS = 30;

/** An issuer total over the window (a real ticker, or the unlabelled bucket). */
export type TickerTotal = {
  ticker: string;
  unlabelled: boolean;
  totalChangeUsd: number;
  totalChange: number;
  /** How many distinct days this issuer (or bucket) appears on. */
  daysPresent: number;
};

/** One issuer line, ranked by absolute flow, as the day table shows it. */
export type TopIssuer = {
  ticker: string;
  unlabelled: boolean;
  changeUsd: number;
};

/** One point of the cumulative series. */
export type CumulativePoint = {
  date: number;
  dateLabel: string;
  dayChangeUsd: number;
  cumulativeChangeUsd: number;
};

/** The whole board read. */
export type EtfBoard = {
  /** Days, newest first. */
  days: EtfDayRow[];
  /** The newest day, or null when the payload carried none. */
  latest: EtfDayRow | null;
  /** Sum of every day's changeUsd the payload covers. */
  cumulativeChangeUsd: number;
  /** Sum of every day's change the payload covers. */
  cumulativeChange: number;
  /** How many days the payload covers. */
  dayCount: number;
  /** Oldest day in the window, labelled YYYY-MM-DD, or null. */
  windowStart: string | null;
  /** Newest day in the window, labelled YYYY-MM-DD, or null. */
  windowEnd: string | null;
  /** The most recent `recentDays` days, newest first. */
  recent: EtfDayRow[];
  /** The stated recent-window size. */
  recentDays: number;
  /** The slice, stated. */
  sliceNote: string;
  /** Per-issuer totals over the whole window, ranked by |flow|. */
  tickerTotals: TickerTotal[];
  /** The cumulative series, ascending by date. */
  series: CumulativePoint[];
  /** The derivations, stated once. */
  derived: string;
};

/** A finite number, or false for null/undefined/NaN/Infinity. */
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A sort key that ranks a real magnitude by |v| and pushes a missing number last. */
function absKey(v: unknown): number {
  return isNum(v) ? Math.abs(v) : -1;
}

/** A ms epoch as `YYYY-MM-DD` in UTC, or `—` for a missing number. */
export function dayLabel(ms: number): string {
  if (!isNum(ms)) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

/** Days newest-first. Upstream already orders this way; the board does not trust it to. */
export function orderDaysNewestFirst(rows: readonly EtfDayRow[]): EtfDayRow[] {
  return [...rows].sort((a, b) => b.date - a.date);
}

/**
 * The top-N issuers inside one day by ABSOLUTE net flow — the largest creation or
 * redemption that day, whichever direction. A null ticker is labelled UNLABELLED,
 * never dropped and never renamed. A missing number sorts last.
 */
export function topIssuers(day: EtfDayRow, n = 3): TopIssuer[] {
  return (day.list ?? [])
    .map((issuer) => ({
      ticker: issuer.ticker ?? UNLABELLED,
      unlabelled: issuer.ticker == null,
      changeUsd: issuer.changeUsd,
    }))
    .sort((a, b) => absKey(b.changeUsd) - absKey(a.changeUsd))
    .slice(0, n);
}

/**
 * Sum each issuer's daily net flows over the window. Rows with a null ticker are
 * summed under the UNLABELLED bucket. `daysPresent` counts the distinct days the
 * issuer appears on. Ranked by |totalChangeUsd|, largest first.
 *
 * PURE and unit-testable: no network, no clock, no I/O.
 */
export function perTickerTotals(rows: readonly EtfDayRow[]): TickerTotal[] {
  const buckets = new Map<
    string,
    { unlabelled: boolean; totalChangeUsd: number; totalChange: number; days: Set<number> }
  >();
  for (const day of rows) {
    for (const issuer of day.list ?? []) {
      const key = issuer.ticker ?? UNLABELLED;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { unlabelled: issuer.ticker == null, totalChangeUsd: 0, totalChange: 0, days: new Set<number>() };
        buckets.set(key, bucket);
      }
      if (isNum(issuer.changeUsd)) bucket.totalChangeUsd += issuer.changeUsd;
      if (isNum(issuer.change)) bucket.totalChange += issuer.change;
      bucket.days.add(day.date);
    }
  }
  const totals: TickerTotal[] = [];
  for (const [ticker, bucket] of buckets) {
    totals.push({
      ticker,
      unlabelled: bucket.unlabelled,
      totalChangeUsd: bucket.totalChangeUsd,
      totalChange: bucket.totalChange,
      daysPresent: bucket.days.size,
    });
  }
  return totals.sort((a, b) => Math.abs(b.totalChangeUsd) - Math.abs(a.totalChangeUsd));
}

/**
 * The running cumulative net USD flow across the window, ASCENDING by date — the
 * slowest-first series a cumulative chart reads. A missing day value is skipped in
 * the running total, so an absent number can never read as a zero that resets it.
 *
 * PURE and unit-testable.
 */
export function cumulativeSeries(rows: readonly EtfDayRow[]): CumulativePoint[] {
  const ascending = [...rows].sort((a, b) => a.date - b.date);
  const out: CumulativePoint[] = [];
  let running = 0;
  for (const day of ascending) {
    if (isNum(day.changeUsd)) running += day.changeUsd;
    out.push({
      date: day.date,
      dateLabel: dayLabel(day.date),
      dayChangeUsd: day.changeUsd,
      cumulativeChangeUsd: running,
    });
  }
  return out;
}

/**
 * Build the whole board from the payload rows. Pure.
 *
 * `recentDays` sizes the recent-days table (default 30); the slice is always
 * stated in `sliceNote`, so a truncated view can never read as the whole window.
 */
export function buildEtfBoard(
  rows: readonly EtfDayRow[],
  options: { recentDays?: number } = {}
): EtfBoard {
  const days = orderDaysNewestFirst(rows);
  const recentDays = options.recentDays ?? DEFAULT_RECENT_DAYS;
  const recent = days.slice(0, recentDays);

  let cumulativeChangeUsd = 0;
  let cumulativeChange = 0;
  for (const day of days) {
    if (isNum(day.changeUsd)) cumulativeChangeUsd += day.changeUsd;
    if (isNum(day.change)) cumulativeChange += day.change;
  }

  const latest = days[0] ?? null;
  const oldest = days.length > 0 ? days[days.length - 1] : null;

  return {
    days,
    latest,
    cumulativeChangeUsd,
    cumulativeChange,
    dayCount: days.length,
    windowStart: oldest ? dayLabel(oldest.date) : null,
    windowEnd: latest ? dayLabel(latest.date) : null,
    recent,
    recentDays,
    sliceNote:
      `showing the ${recent.length} most recent of the ${days.length} days the payload covers ` +
      '(newest first); the latest row is the newest day upstream has published',
    tickerTotals: perTickerTotals(days),
    series: cumulativeSeries(days),
    derived:
      'the latest net flow is the newest day in the payload and may be an incomplete session — it is ' +
      'not annualised or extrapolated; the cumulative figure is the running sum of every day the ' +
      'payload covers, so its window is exactly those days; a per-issuer total sums that issuer\u2019s ' +
      'daily net flows and its "days present" is the count of days it appears on; rows the upstream ' +
      'ships without a ticker are grouped as "unlabelled (upstream)" and are never given a name; a ' +
      'missing number is shown as a dash, never as zero',
  };
}
