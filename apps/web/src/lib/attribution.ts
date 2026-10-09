/**
 * attribution.ts — WHY the net worth moved: the window's change split into the
 * part the MARKET moved and the part the BOOK moved.
 *
 * THE QUESTION THIS ANSWERS. The treasury boards already state that net worth
 * moved, by how much, and which holdings moved with it. None of them says WHY.
 * A book that grew $400 because every holding repriced up and a book that grew
 * $400 because $400 of new capital arrived render identically on every existing
 * panel, and they are different facts about the treasury. The data to separate
 * them is already accumulating: `asset_history` stores each holding's `quantity`
 * AND its `value_usd` per sync, so the ratio is a price and the quantity is the
 * book.
 *
 * THE DECOMPOSITION IS EXACT, NOT AN APPROXIMATION. For one asset with start
 * `(q0, p0)` and end `(q1, p1)`:
 *
 *     q1·p1 − q0·p0 = q0·(p1 − p0) + p1·(q1 − q0)
 *
 * so `priceEffect = q0·(p1 − p0)` (the book as it stood, repriced) and
 * `flowEffect` (the book itself changing) sum to the change with no residual
 * and no cross term to hand-wave. `flowEffect` is therefore computed as the
 * residual of that identity, making the sum exact to the last bit; the
 * independent form `p1·(q1 − q0)` is asserted against it in the offline test, so
 * the identity and its derivation are both checked.
 *
 * DECOMPOSE PER ASSET, AGGREGATE PER KEY. A chain or a wallet holds many assets,
 * and summing their quantities is meaningless (BTC + USDC is not a quantity).
 * Every pair below is one (key, asset) so each price is a REAL unit price the
 * holding actually traded at; the key's row is then the SUM of its assets'
 * effects. Because the per-asset identity is exact, the key's is too — the same
 * weights, no blended-price approximation anywhere.
 *
 * THE TWO CASES WITHOUT A PRICE, WHICH ARE NOT THE SAME AS A FLAT PRICE.
 *  - `opened` (q0 = 0): there was no position to reprice, so the price effect is
 *    genuinely 0 and the whole value arrived as a flow. Exact, and flagged.
 *  - `closed` (q1 = 0): there is no end price to split against, so the split is
 *    not identified from this data. The row stays exact (the whole value left)
 *    but reports flow-only and is flagged `closed` — never as "the price did not
 *    move".
 * A quantity-less holding (a row whose `quantity` is NULL while its `value_usd`
 * is not) lands in the first case for the same honest reason: with no quantity
 * there is no unit price to reprice.
 *
 * NEVER-FAKE. A window holding fewer than two observations has no change to
 * attribute, so every total is `null` and renders the em dash — the same refusal
 * the analytics read makes. A key that did not move carries no share, so
 * `priceSharePct` is `null` rather than a division by zero.
 *
 * Everything here is pure — no clock, no database — so the arithmetic is
 * unit-tested offline against fixed rows. The read that feeds it lives in
 * `@/server/treasury`, which owns the SQL and the allowlists.
 */

/** The dimension a key identifies. */
export type AttrDimension = 'chain' | 'wallet' | 'asset';

/** One endpoint of a pair: a (key, asset)'s summed quantity and value at one observation. */
export type AttrEndpoint = {
  qty: number;
  valueUsd: number;
};

/** A (key, asset) as the read hands it over: its first and last observation in the window. */
export type AttrPairInput = {
  key: string;
  asset: string;
  /** Null when the pair does not exist at the window's start (it opened inside the window). */
  start: AttrEndpoint | null;
  /** Null when the pair does not exist at the window's end (it closed inside the window). */
  end: AttrEndpoint | null;
};

/** One (key, asset), decomposed. */
export type AttrPair = {
  key: string;
  asset: string;
  startQty: number;
  endQty: number;
  startValueUsd: number;
  endValueUsd: number;
  /** `valueUsd / qty` at the start, or null when nothing was held then. */
  startPrice: number | null;
  /** `valueUsd / qty` at the end, or null when nothing is held now. */
  endPrice: number | null;
  deltaUsd: number;
  /** The book as it stood, repriced. 0 when there was no start position. */
  priceEffectUsd: number;
  /** The book itself changing. The residual of the identity, so the sum is exact. */
  flowEffectUsd: number;
  /** Held nothing at the window's start: the whole value arrived as a flow. */
  opened: boolean;
  /** Holds nothing now: the whole value left, and no end price exists to split it. */
  closed: boolean;
  /** The price effect as a share of `deltaUsd`; with the book share it sums to 100%. */
  priceSharePct: number | null;
};

/** One dimension key, aggregated over its assets. */
export type AttrRow = {
  key: string;
  startValueUsd: number;
  endValueUsd: number;
  deltaUsd: number;
  priceEffectUsd: number;
  flowEffectUsd: number;
  /** The price effect as a share of `deltaUsd`; with the book share it sums to 100%. */
  priceSharePct: number | null;
  /** How many (key, asset) pairs the row covers. */
  assets: number;
  /** Pairs that opened inside the window. */
  openedAssets: number;
  /** Pairs that closed inside the window. */
  closedAssets: number;
};

export type AttributionResult = {
  dimension: AttrDimension;
  range: string;
  /** True sync observations in the window (runs, not rows). */
  observations: number;
  fromTs: string | null;
  toTs: string | null;
  /** Every total is null when the window cannot yield a change (see the header). */
  totalStartUsd: number | null;
  totalEndUsd: number | null;
  totalDeltaUsd: number | null;
  totalPriceEffectUsd: number | null;
  totalFlowEffectUsd: number | null;
  /**
   * `totalDeltaUsd − (price + flow)`. Zero by construction; published so a
   * reader can CHECK the split rather than take it on faith.
   */
  residualUsd: number | null;
  /** The price effect as a share of `totalDeltaUsd`; with the book share it sums to 100%. */
  marketSharePct: number | null;
  /** True when fewer than two observations were available: no change to attribute. */
  singleObservation: boolean;
  rows: AttrRow[];
  /** Every decomposed (key, asset), biggest absolute move first. */
  pairs: AttrPair[];
};

/** A finite number, or `null` for anything that is not one. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * `part` as a share of `whole`, in percent, or null when there is nothing to
 * divide by. `whole` is the SIGNED move, so the price share and the book share
 * sum to exactly 100% whenever the pair moved: `100·(price/Δ) + 100·(book/Δ)` is
 * `100·(price + book)/Δ`, and `price + book` IS `Δ`. Against `|Δ|` the shares
 * would instead carry each effect's own sign, so a market that fell WITH a
 * falling portfolio would read as a negative percentage of the move — the
 * opposite of what the panel's "X% of the move" says.
 */
function share(part: number, whole: number): number | null {
  if (!Number.isFinite(whole) || whole === 0) return null;
  return (part / whole) * 100;
}

/**
 * Decompose one (key, asset) across the window.
 *
 * The identity `price + flow === delta` holds exactly in all four cases (both
 * ends priced, opened, closed, and quantity-less), which the offline test
 * asserts directly rather than trusting this comment.
 */
export function decomposePair(input: AttrPairInput): AttrPair {
  const startQty = input.start === null ? 0 : input.start.qty;
  const endQty = input.end === null ? 0 : input.end.qty;
  const startValueUsd = input.start === null ? 0 : input.start.valueUsd;
  const endValueUsd = input.end === null ? 0 : input.end.valueUsd;

  // A price needs a quantity to divide by. `qty <= 0` is no position, not a
  // zero-priced one — hence null rather than 0.
  const startPrice = startQty > 0 ? startValueUsd / startQty : null;
  const endPrice = endQty > 0 ? endValueUsd / endQty : null;

  const deltaUsd = endValueUsd - startValueUsd;
  const opened = !(startQty > 0);
  const closed = !(endQty > 0);

  // `q0·(p1 − p0)`: zero when there is no start position (nothing to reprice).
  const priceEffectUsd =
    startPrice !== null && endPrice !== null ? startQty * (endPrice - startPrice) : 0;
  // The residual of the identity, so `priceEffectUsd + flowEffectUsd === deltaUsd`
  // to the last bit.
  const flowEffectUsd = deltaUsd - priceEffectUsd;

  return {
    key: input.key,
    asset: input.asset,
    startQty,
    endQty,
    startValueUsd,
    endValueUsd,
    startPrice,
    endPrice,
    deltaUsd,
    priceEffectUsd,
    flowEffectUsd,
    opened,
    closed,
    priceSharePct: share(priceEffectUsd, deltaUsd),
  };
}

/**
 * Decompose every pair and aggregate the effects by key.
 *
 * The totals are the sum of the PAIR effects, not a decomposition of the summed
 * values: because each pair's split is exact, the sum of the splits is exactly
 * the sum of the deltas, and no blend of prices ever enters the arithmetic.
 */
export function buildAttribution(input: {
  dimension: AttrDimension;
  range: string;
  observations: number;
  fromTs: string | null;
  toTs: string | null;
  pairs: AttrPairInput[];
}): AttributionResult {
  const pairs = input.pairs
    .map(decomposePair)
    .sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd) || a.key.localeCompare(b.key) || a.asset.localeCompare(b.asset));

  // Fewer than two observations is one point in time: there is no change, and a
  // "$0.00 moved" would be a claim the window cannot support.
  if (input.observations < 2) {
    return {
      dimension: input.dimension,
      range: input.range,
      observations: input.observations,
      fromTs: input.fromTs,
      toTs: input.toTs,
      totalStartUsd: null,
      totalEndUsd: null,
      totalDeltaUsd: null,
      totalPriceEffectUsd: null,
      totalFlowEffectUsd: null,
      residualUsd: null,
      marketSharePct: null,
      singleObservation: true,
      rows: [],
      pairs: [],
    };
  }

  const byKey = new Map<string, AttrRow>();
  for (const p of pairs) {
    const row = byKey.get(p.key) ?? {
      key: p.key,
      startValueUsd: 0,
      endValueUsd: 0,
      deltaUsd: 0,
      priceEffectUsd: 0,
      flowEffectUsd: 0,
      priceSharePct: null,
      assets: 0,
      openedAssets: 0,
      closedAssets: 0,
    };
    row.startValueUsd += p.startValueUsd;
    row.endValueUsd += p.endValueUsd;
    row.deltaUsd += p.deltaUsd;
    row.priceEffectUsd += p.priceEffectUsd;
    row.flowEffectUsd += p.flowEffectUsd;
    row.assets += 1;
    if (p.opened) row.openedAssets += 1;
    if (p.closed) row.closedAssets += 1;
    byKey.set(p.key, row);
  }

  const rows = [...byKey.values()]
    .map((r) => ({ ...r, priceSharePct: share(r.priceEffectUsd, r.deltaUsd) }))
    .sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd) || a.key.localeCompare(b.key));

  const totalStartUsd = rows.reduce((a, r) => a + r.startValueUsd, 0);
  const totalEndUsd = rows.reduce((a, r) => a + r.endValueUsd, 0);
  const totalDeltaUsd = rows.reduce((a, r) => a + r.deltaUsd, 0);
  const totalPriceEffectUsd = rows.reduce((a, r) => a + r.priceEffectUsd, 0);
  const totalFlowEffectUsd = rows.reduce((a, r) => a + r.flowEffectUsd, 0);

  return {
    dimension: input.dimension,
    range: input.range,
    observations: input.observations,
    fromTs: input.fromTs,
    toTs: input.toTs,
    totalStartUsd,
    totalEndUsd,
    totalDeltaUsd,
    totalPriceEffectUsd,
    totalFlowEffectUsd,
    residualUsd: totalDeltaUsd - (totalPriceEffectUsd + totalFlowEffectUsd),
    marketSharePct: share(totalPriceEffectUsd, totalDeltaUsd),
    singleObservation: false,
    rows,
    pairs,
  };
}

/** Turn raw driver rows into pair inputs, tolerating a missing endpoint and a null quantity. */
export function pairInputsFromRows(raw: Record<string, unknown>[]): AttrPairInput[] {
  const out: AttrPairInput[] = [];
  for (const r of raw) {
    const key = String(r.key ?? '');
    const asset = String(r.asset ?? '');
    const q0 = num(r.q0);
    const v0 = num(r.v0);
    const q1 = num(r.q1);
    const v1 = num(r.v1);
    // A side with no row at all is the `null` endpoint. A row whose quantity is
    // NULL is a real endpoint with no quantity — 0 here, which reads as "nothing
    // to reprice", exactly the case the header describes.
    const start = q0 === null && v0 === null ? null : { qty: q0 ?? 0, valueUsd: v0 ?? 0 };
    const end = q1 === null && v1 === null ? null : { qty: q1 ?? 0, valueUsd: v1 ?? 0 };
    if (start === null && end === null) continue;
    out.push({ key, asset, start, end });
  }
  return out;
}
