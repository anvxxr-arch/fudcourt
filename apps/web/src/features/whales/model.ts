/**
 * The whale watcher's domain model — the largest open positions on Hyperliquid,
 * read from coinank's `whales` mode, as a reading of positioning.
 *
 * WHAT THIS IS. coinank ranks the biggest open perpetual positions across the
 * book. Each row is one position: whose, which coin, which way, how big, what it
 * would take to liquidate it. This module reads those rows, sums them, and groups
 * them by coin. It is a reading of what the largest accounts are holding. It is
 * not advice, and it is not a forecast.
 *
 * THE BOARD SEES A PAGE, NOT THE BOOK. Upstream ranks the positions and serves
 * page 1 of `data.pagination.total` (1,484 at last read). The payload itself says
 * how many of how many, so `slice` carries it and the board prints it: "the 50
 * largest we can see" and "the whole book" are different claims and only the
 * first is true. Totals are summed over the rows actually shown, and say so.
 *
 * THE SIDE IS THE UPSTREAM'S OWN LABEL; THE SIZE'S SIGN AGREES. `side` is the
 * authoritative field ('Long' | 'Short'); the SIGNED `size` (negative = Short) is
 * the documented cross-check and is what `sideOf` falls back to when the label is
 * absent. `totals.sideMismatches` counts any row where the two disagree, so the
 * board can state whether the cross-check held instead of assuming it did.
 *
 * A MISSING METRIC IS NEVER A ZERO. A `liquidationPx` upstream did not state (one
 * such row is in the live page) is null here and renders `—`; it is EXCLUDED from
 * the liquidation-distance derivation rather than read as "price is at
 * liquidation". `notionalMissing` / `pnlMissing` count rows carrying no value, so
 * a sum is never quietly short. The liquidation DISTANCE is a magnitude — how far
 * the mark must move to reach the liquidation price — and is null, never 0%, when
 * either the price or the liquidation price is absent.
 *
 * PURE: no network, no clock (`nowSec` is a parameter), no I/O — so it unit-tests
 * offline against fixed rows.
 */

/** One position, exactly as coinank's `mode=whales` ships a `data.list[]` row. */
export type WhaleRow = {
  address: string;
  baseCoin: string;
  price: number;
  /** The upstream's own side label: 'Long' | 'Short'. */
  side: string;
  /** Signed size — NEGATIVE for a Short. Agrees with `side` on the live page. */
  size: number;
  preSize: number;
  /** Notional, USD. */
  positionValue: number;
  /** Signed unrealized PnL, USD. */
  unrealizedPnl: number;
  /** Liquidation price, or null when upstream states none (a real absence). */
  liquidationPx: number | null;
  marginUsed: number;
  leverage: number;
  cumFunding: number;
  type: string;
  entryPx: number;
  ts: number;
  maxPosition: number;
  state: number;
  createdAt: number;
  updateTs: number;
  closedAt: number | null;
  isShow: boolean;
  firstGt1000: number;
  isAll: boolean;
  preChangeTime: number;
  preNoticeSize: number;
  follow: boolean;
};

/** The upstream's own page descriptor, `data.pagination`. */
export type WhalePagination = { current: number; total: number; pageSize: number };

export type WhaleSide = 'Long' | 'Short';

/** A position as the board reads it — every metric the upstream omitted is null. */
export type WhalePosition = {
  address: string;
  baseCoin: string;
  side: WhaleSide | null;
  leverage: number | null;
  positionValue: number | null;
  unrealizedPnl: number | null;
  entryPx: number | null;
  liquidationPx: number | null;
  price: number | null;
  /** |liquidationPx - price| / price, or null when either leg is absent. */
  liquidationDistance: number | null;
};

/** A finite number, or null — the one gate every metric passes before use. */
const fin = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * The side of a position. The upstream's `side` label wins; the SIGNED `size`
 * (negative = Short) is the fallback when the label is missing or unexpected.
 * Returns null — rendered `—` — only when neither a label nor a non-zero size is
 * available, because guessing a side would invent a direction the row does not
 * carry.
 */
export function sideOf(row: WhaleRow): WhaleSide | null {
  if (row.side === 'Long' || row.side === 'Short') return row.side;
  const size = fin(row.size);
  if (size === null || size === 0) return null;
  return size < 0 ? 'Short' : 'Long';
}

/**
 * |liquidationPx - price| / price — the proportional move the mark must make to
 * reach the liquidation price (0.53 = 53% away). It is a MAGNITUDE: the side
 * already says the direction. Null when either leg is absent or the price is not
 * positive — never 0%, which would read as "at liquidation".
 */
export function liquidationDistancePct(row: WhaleRow): number | null {
  const liq = fin(row.liquidationPx);
  const px = fin(row.price);
  if (liq === null || px === null || px <= 0) return null;
  return Math.abs(liq - px) / px;
}

/** Read one row into the shape the board renders. Pure. */
export function readPosition(row: WhaleRow): WhalePosition {
  return {
    address: row.address,
    baseCoin: row.baseCoin,
    side: sideOf(row),
    leverage: fin(row.leverage),
    positionValue: fin(row.positionValue),
    unrealizedPnl: fin(row.unrealizedPnl),
    entryPx: fin(row.entryPx),
    liquidationPx: fin(row.liquidationPx),
    price: fin(row.price),
    liquidationDistance: liquidationDistancePct(row),
  };
}

/** A sum that states how many rows it could not include. */
export type Sum = { total: number; missing: number };

/** Sum a metric over the rows, counting — never zero-filling — absent values. */
function sumField(rows: readonly WhaleRow[], pick: (r: WhaleRow) => number | null | undefined): Sum {
  let total = 0;
  let missing = 0;
  for (const r of rows) {
    const v = fin(pick(r));
    if (v === null) missing += 1;
    else total += v;
  }
  return { total, missing };
}

/** Total notional: the sum of `positionValue`. Pure. */
export function totalNotional(rows: readonly WhaleRow[]): Sum {
  return sumField(rows, (r) => r.positionValue);
}

/** Net unrealized PnL: the sum of signed `unrealizedPnl`. Pure. */
export function netUnrealizedPnl(rows: readonly WhaleRow[]): Sum {
  return sumField(rows, (r) => r.unrealizedPnl);
}

export type NotionalSplit = {
  long: number;
  short: number;
  total: number;
  /** long / total, or null when the total is not positive. */
  longShare: number | null;
  /** Rows with no notional or no resolvable side — excluded, not zeroed. */
  missing: number;
};

/** The long / short notional split. Pure. */
export function notionalSplit(rows: readonly WhaleRow[]): NotionalSplit {
  let long = 0;
  let short = 0;
  let missing = 0;
  for (const r of rows) {
    const v = fin(r.positionValue);
    const side = sideOf(r);
    if (v === null || side === null) {
      missing += 1;
      continue;
    }
    if (side === 'Long') long += v;
    else short += v;
  }
  const total = long + short;
  return { long, short, total, longShare: total > 0 ? long / total : null, missing };
}

/** One coin's positions, collapsed. */
export type CoinGroup = {
  baseCoin: string;
  count: number;
  notional: number;
  longNotional: number;
  shortNotional: number;
  /** longNotional - shortNotional: > 0 net long, < 0 net short. */
  netNotional: number;
  netSide: WhaleSide | 'Flat';
  unrealizedPnl: number;
};

/**
 * Group the positions by `baseCoin`, one row per coin, sorted by total notional
 * (largest first). `netSide` is which side holds more of that coin's notional, or
 * 'Flat' when the two are exactly equal. Pure.
 */
export function groupByCoin(rows: readonly WhaleRow[]): CoinGroup[] {
  const byCoin = new Map<string, CoinGroup>();
  for (const r of rows) {
    const coin = r.baseCoin || '—';
    let g = byCoin.get(coin);
    if (!g) {
      g = { baseCoin: coin, count: 0, notional: 0, longNotional: 0, shortNotional: 0, netNotional: 0, netSide: 'Flat', unrealizedPnl: 0 };
      byCoin.set(coin, g);
    }
    g.count += 1;
    const v = fin(r.positionValue);
    if (v !== null) {
      g.notional += v;
      if (sideOf(r) === 'Long') g.longNotional += v;
      else if (sideOf(r) === 'Short') g.shortNotional += v;
    }
    const pnl = fin(r.unrealizedPnl);
    if (pnl !== null) g.unrealizedPnl += pnl;
  }
  const out = [...byCoin.values()];
  for (const g of out) {
    g.netNotional = g.longNotional - g.shortNotional;
    g.netSide = g.netNotional > 0 ? 'Long' : g.netNotional < 0 ? 'Short' : 'Flat';
  }
  out.sort((a, b) => b.notional - a.notional);
  return out;
}

/** The single largest position by notional, or null when none carries one. Pure. */
export function largestPosition(rows: readonly WhaleRow[]): WhalePosition | null {
  let best: WhaleRow | null = null;
  let bestVal = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    const v = fin(r.positionValue);
    if (v !== null && v > bestVal) {
      bestVal = v;
      best = r;
    }
  }
  return best === null ? null : readPosition(best);
}

/** The deepest single unrealized loss (most negative PnL), or null. Pure. */
export function largestLoss(rows: readonly WhaleRow[]): WhalePosition | null {
  let worst: WhaleRow | null = null;
  let worstVal = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    const v = fin(r.unrealizedPnl);
    if (v !== null && v < worstVal) {
      worstVal = v;
      worst = r;
    }
  }
  return worst === null ? null : readPosition(worst);
}

export type WhaleBoard = {
  /** The page's positions, in upstream order. */
  positions: WhalePosition[];
  totals: {
    /** Rows on this page (50). */
    seen: number;
    /** Upstream's own count across every page (`pagination.total`). */
    upstreamTotal: number;
    totalNotional: number;
    notionalMissing: number;
    netUnrealizedPnl: number;
    pnlMissing: number;
    split: NotionalSplit;
    /** Rows whose signed size disagreed with the stated side label. */
    sideMismatches: number;
  };
  coinGroups: CoinGroup[];
  largest: WhalePosition | null;
  largestLoss: WhalePosition | null;
  /** How much of the upstream book this page can see — stated, never implied. */
  slice: { current: number; total: number; pageSize: number; seen: number; note: string };
  /** The derivations, stated once. */
  derived: string;
  asOf: number;
};

/**
 * Build the board from the page's rows and its pagination. Pure.
 *
 * `nowSec` is passed in rather than read, so the board's `asOf` is deterministic
 * and the whole thing unit-tests without a clock.
 */
export function buildWhaleBoard(
  rows: readonly WhaleRow[],
  pagination: WhalePagination | null,
  nowSec: number,
): WhaleBoard {
  const seen = rows.length;
  const upstreamTotal = pagination && fin(pagination.total) !== null ? (pagination.total as number) : seen;
  const current = pagination && fin(pagination.current) !== null ? pagination.current : 1;
  const pageSize = pagination && fin(pagination.pageSize) !== null ? pagination.pageSize : seen;

  let sideMismatches = 0;
  for (const r of rows) {
    const size = fin(r.size);
    const stated = r.side === 'Long' || r.side === 'Short' ? r.side : null;
    if (size !== null && size !== 0 && stated !== null && (size < 0 ? 'Short' : 'Long') !== stated) {
      sideMismatches += 1;
    }
  }

  const notional = totalNotional(rows);
  const pnl = netUnrealizedPnl(rows);
  const split = notionalSplit(rows);
  const pages = pageSize > 0 ? Math.ceil(upstreamTotal / pageSize) : null;

  return {
    positions: rows.map(readPosition),
    totals: {
      seen,
      upstreamTotal,
      totalNotional: notional.total,
      notionalMissing: notional.missing,
      netUnrealizedPnl: pnl.total,
      pnlMissing: pnl.missing,
      split,
      sideMismatches,
    },
    coinGroups: groupByCoin(rows),
    largest: largestPosition(rows),
    largestLoss: largestLoss(rows),
    slice: {
      current,
      total: upstreamTotal,
      pageSize,
      seen,
      note:
        `this board reads page ${current} of the upstream ranking — ${seen} positions of ${upstreamTotal}` +
        `${pages === null ? '' : ` (page size ${pageSize}, ${pages} pages)`}; ` +
        `the ${seen} shown are the largest the upstream ranks onto page ${current}, not the whole book`,
    },
    derived:
      'notional is the sum of the positionValue the upstream reports, and net unrealized PnL the sum of its signed ' +
      'unrealizedPnl — both over the rows on this page only, never the whole book; the side is the upstream\u2019s own ' +
      'label (the signed size, negative = Short, agrees on every row of the live page) and the coin grouping nets ' +
      'long against short notional per baseCoin; the liquidation distance is |liquidationPx - price| / price, the ' +
      'proportional move to liquidation, stated as a magnitude and left as a dash when either leg is absent',
    asOf: nowSec,
  };
}
