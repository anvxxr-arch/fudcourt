/**
 * digest.ts — the weekly treasury digest, as a PURE read.
 *
 * WHY A DIGEST AT ALL. `/proof` is a single committed snapshot; the blog is
 * where the treasury's week gets told. The digest is that story, derived from
 * the SAME `asset_history` time series the private board and the public proof
 * read, and it follows the same doctrine: it states what the data supports and
 * REFUSES the rest. A week whose window holds a single observation has no
 * change to report — "the treasury was flat" and "we only looked once" are
 * different claims, and only one of them is ever true. A refusal is a
 * first-class outcome with a stated reason, never a zero and never silence.
 *
 * WHAT THIS MODEL REFUSES.
 *  - fewer than two observations in the window: a change cannot be stated from
 *    a single point, so nothing is published;
 *  - a book with no priced holding at EITHER end: there is no value to report;
 *  - an observation with no holdings is not a snapshot and is dropped by the
 *    reader before it ever reaches the model.
 *
 * The change is measured FIRST-to-LAST within the window, and every published
 * figure carries its coverage (`priced N of M holdings`), so a partial book can
 * never read as the whole one. Unpriced holdings are NAMED, never counted as
 * zero.
 *
 * Everything here is pure: the database read is injected as a `QueryFn` so the
 * sessionization and the aggregation are unit-tested offline against fixed
 * rows, with no clock and no database.
 */

/** One row of the `asset_history` time series, as the read hands it over. */
export type HistoryRow = {
  /** Observation time, ISO. */
  ts: string;
  chain: string;
  asset: string;
  quantity: number | null;
  valueUsd: number | null;
};

/** One sync run, aggregated — the unit the digest compares. */
export type DigestSnapshot = {
  /** The run's observation time, ISO. */
  asOf: string;
  /** Sum over the PRICED holdings of this run. */
  totalUsd: number;
  /** Every holding in the run, priced or not. */
  holdings: number;
  /** Holdings with a finite, positive valuation. */
  priced: number;
  /** Unpriced holdings, named `chain/asset` — never silently dropped. */
  unpriced: string[];
  /** Per-chain value over the priced holdings. */
  slices: { chain: string; valueUsd: number }[];
};

/** How one chain moved across the window. */
export type ChainMove = {
  chain: string;
  startUsd: number;
  endUsd: number;
  changeUsd: number;
  /** Null when the chain held nothing at the window's start (no base to divide by). */
  changePct: number | null;
};

export type DigestPublished = {
  published: true;
  /** First observation in the window, ISO. */
  weekStart: string;
  /** Last observation in the window, ISO. */
  weekEnd: string;
  /** Observations the window held (>= 2). */
  runs: number;
  startUsd: number;
  endUsd: number;
  changeUsd: number;
  /** Null when the window opened on a zero-valued book. */
  changePct: number | null;
  /** From the END snapshot — the book as it stands. */
  holdings: number;
  priced: number;
  unpriced: string[];
  chains: number;
  chainMoves: ChainMove[];
  /** The stated coverage of the published total. */
  coverage: string;
  /** The stated derivation. */
  derived: string;
};

export type DigestRefused = {
  published: false;
  weekStart: string | null;
  weekEnd: string | null;
  /** Why nothing is published. Always a stated reason, never an empty post. */
  reason: string;
  /** Holdings named as the reason, when the refusal is about specific rows. */
  skipped: string[];
};

export type DigestEnvelope = DigestPublished | DigestRefused;

/** The only I/O the reader needs — injected so the whole model is testable. */
export type QueryFn = (sql: string, args?: unknown[]) => Promise<Record<string, unknown>[]>;

/** Two rows further apart than this are different sync runs, not one snapshot. */
export const RUN_GAP_MS = 60_000;

/** A holding is PRICED when its value is a finite number greater than zero. */
const isPriced = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;

/** The public name of a holding — chain and asset. */
const holdingName = (r: HistoryRow): string => `${r.chain}/${r.asset}`;

/**
 * Sessionize raw rows into runs and aggregate each to a snapshot.
 *
 * The 60-second gap rule is the SAME one `@/server/treasury` and
 * `@/server/proof` use to sessionize this series, so every surface agrees on
 * what one sync run is. Pure: rows in, snapshots out, ordered by time.
 */
export function snapshotRuns(rows: readonly HistoryRow[]): DigestSnapshot[] {
  const sorted = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
  const runs: DigestSnapshot[] = [];
  let cur: HistoryRow[] = [];
  let lastTs: number | null = null;

  const flush = () => {
    if (cur.length === 0) return;
    const pricedRows = cur.filter((r) => isPriced(r.valueUsd));
    const totalUsd = pricedRows.reduce((a, r) => a + (r.valueUsd as number), 0);
    const byChain = new Map<string, number>();
    for (const r of pricedRows) byChain.set(r.chain, (byChain.get(r.chain) ?? 0) + (r.valueUsd as number));
    runs.push({
      asOf: cur[cur.length - 1].ts,
      totalUsd,
      holdings: cur.length,
      priced: pricedRows.length,
      unpriced: cur.filter((r) => !isPriced(r.valueUsd)).map(holdingName).sort(),
      slices: [...byChain.entries()]
        .map(([chain, valueUsd]) => ({ chain, valueUsd }))
        .sort((a, b) => b.valueUsd - a.valueUsd || a.chain.localeCompare(b.chain)),
    });
    cur = [];
  };

  for (const r of sorted) {
    const t = Date.parse(r.ts);
    if (lastTs !== null && t - lastTs > RUN_GAP_MS) flush();
    cur.push(r);
    lastTs = t;
  }
  flush();
  return runs;
}

/**
 * Build the weekly digest from the window's snapshots, ordered oldest-first.
 * Pure and synchronous.
 *
 * The refusals are FIRST-CLASS and ordered from the most fundamental: no
 * observation at all, then a single observation (no change to state), then a
 * book that carries no priced holding at either end (no value to report). Only
 * then is a change stated — and always with its coverage.
 */
export function buildDigest(snapshots: readonly DigestSnapshot[]): DigestEnvelope {
  if (snapshots.length === 0) {
    return {
      published: false,
      weekStart: null,
      weekEnd: null,
      reason: 'no observation in the window — there is no week to narrate',
      skipped: [],
    };
  }
  if (snapshots.length === 1) {
    return {
      published: false,
      weekStart: snapshots[0].asOf,
      weekEnd: snapshots[0].asOf,
      reason:
        'a single observation cannot state a change — a week needs at least two, ' +
        'and "the book was flat" and "we only looked once" are different claims',
      skipped: [],
    };
  }

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];

  if (first.totalUsd === 0 && last.totalUsd === 0) {
    return {
      published: false,
      weekStart: first.asOf,
      weekEnd: last.asOf,
      reason:
        'the book carries no priced holding at either end of the window — ' +
        'there is no value to report, and an empty book is not a zero-valued one',
      skipped: last.unpriced,
    };
  }

  const changeUsd = last.totalUsd - first.totalUsd;
  const changePct = first.totalUsd !== 0 ? (changeUsd / first.totalUsd) * 100 : null;

  const chains = new Set<string>([...first.slices.map((s) => s.chain), ...last.slices.map((s) => s.chain)]);
  const startMap = new Map(first.slices.map((s) => [s.chain, s.valueUsd]));
  const endMap = new Map(last.slices.map((s) => [s.chain, s.valueUsd]));
  const chainMoves: ChainMove[] = [...chains]
    .map((chain) => {
      const startUsd = startMap.get(chain) ?? 0;
      const endUsd = endMap.get(chain) ?? 0;
      const c = endUsd - startUsd;
      return { chain, startUsd, endUsd, changeUsd: c, changePct: startUsd !== 0 ? (c / startUsd) * 100 : null };
    })
    .sort((a, b) => Math.abs(b.changeUsd) - Math.abs(a.changeUsd) || a.chain.localeCompare(b.chain));

  return {
    published: true,
    weekStart: first.asOf,
    weekEnd: last.asOf,
    runs: snapshots.length,
    startUsd: first.totalUsd,
    endUsd: last.totalUsd,
    changeUsd,
    changePct,
    holdings: last.holdings,
    priced: last.priced,
    unpriced: last.unpriced,
    chains: new Set(last.slices.map((s) => s.chain)).size,
    chainMoves,
    coverage: `priced ${last.priced} of ${last.holdings} holdings`,
    derived:
      `Change measured first-to-last across ${snapshots.length} observations in the window. ` +
      `The published total covers the PRICED part of the book (${last.priced} of ${last.holdings} holdings)` +
      `${last.unpriced.length ? `; ${last.unpriced.length} unpriced holding(s) are named and never counted as zero` : ''}. ` +
      'Every figure is derived from the same asset_history series the private board and the public proof read.',
  };
}

/** The week a digest covers, for a slug and a title. */
export function digestSlug(digest: DigestPublished): string {
  return `weekly-treasury-digest-${digest.weekEnd.slice(0, 10)}`;
}

/** A one-line title for the digest post. */
export function digestTitle(digest: DigestPublished): string {
  return `Weekly treasury digest — week ending ${digest.weekEnd.slice(0, 10)}`;
}

/** A plain-text excerpt (<= 300 chars, the collection's cap). */
export function digestExcerpt(digest: DigestPublished): string {
  const dir = digest.changeUsd >= 0 ? 'up' : 'down';
  const pct = digest.changePct === null ? 'n/a' : `${Math.abs(digest.changePct).toFixed(2)}%`;
  const text =
    `The treasury closed at $${digest.endUsd.toFixed(2)}, ${dir} $${Math.abs(digest.changeUsd).toFixed(2)} ` +
    `(${pct}) across ${digest.runs} observations. Coverage: ${digest.coverage}. ` +
    'Derived from the same committed series the public proof reads.';
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`;
}

/**
 * The digest as a structured OUTLINE (heading + paragraphs) — pure, so the
 * narrative is testable without Payload. The publisher maps this to the
 * CMS's rich-text tree; the facts never depend on the CMS.
 */
export function digestOutline(digest: DigestPublished): { heading: string; body: string[] }[] {
  const pct = digest.changePct === null ? 'n/a (the window opened on a zero-valued book)' : `${digest.changePct.toFixed(2)}%`;
  const dir = digest.changeUsd >= 0 ? 'up' : 'down';

  const moves = digest.chainMoves.map((m) => {
    const mp = m.changePct === null ? 'new this window' : `${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)}%`;
    return `${m.chain}: $${m.startUsd.toFixed(2)} → $${m.endUsd.toFixed(2)} (${m.changeUsd >= 0 ? '+' : ''}$${m.changeUsd.toFixed(2)}, ${mp})`;
  });

  return [
    {
      heading: 'The week in one line',
      body: [
        `Across ${digest.runs} observations from ${digest.weekStart} to ${digest.weekEnd}, the treasury moved ` +
          `${dir} $${Math.abs(digest.changeUsd).toFixed(2)} (${pct}), closing at $${digest.endUsd.toFixed(2)}.`,
      ],
    },
    {
      heading: 'By chain',
      body: moves.length ? moves : ['No priced holding was recorded in this window.'],
    },
    {
      heading: 'What this covers — and what it does not',
      body: [
        `The published total covers ${digest.coverage}. ` +
          (digest.unpriced.length
            ? `Unpriced holdings are named, never counted as zero: ${digest.unpriced.join(', ')}.`
            : 'Every holding in the window carried a price.'),
        digest.derived,
      ],
    },
  ];
}

/**
 * Read the window's runs from `asset_history` and sessionize them.
 *
 * The window is a rolling `days`-day span ending at the newest observation.
 * Rows are read through the injected `QueryFn` so this is testable offline; the
 * publisher passes a real Postgres client. An observation that carried no
 * holdings never reaches the model (it is not a snapshot).
 */
export async function readWeeklySnapshots(q: QueryFn, days: number): Promise<DigestSnapshot[]> {
  const raw = await q(
    `SELECT ts, chain, asset, quantity, value_usd
       FROM asset_history
      WHERE ts >= now() - make_interval(days => $1)
      ORDER BY ts, chain, asset`,
    [days],
  );
  const rows: HistoryRow[] = raw.map((r) => ({
    ts: new Date(String(r.ts)).toISOString(),
    chain: String(r.chain ?? ''),
    asset: String(r.asset ?? ''),
    quantity: r.quantity === null || r.quantity === undefined ? null : Number(r.quantity),
    valueUsd: r.value_usd === null || r.value_usd === undefined ? null : Number(r.value_usd),
  }));
  return snapshotRuns(rows);
}
