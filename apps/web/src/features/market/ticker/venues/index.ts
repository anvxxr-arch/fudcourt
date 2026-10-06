import 'server-only';
import { l2GetJson, l2SetJson } from '@/lib/l2';
import { TICKER_EXCHANGES, TICKER_TTL_MS, isQuotableSettlement } from '../client';
import type { TickerExchange, TickerInstrument, TickerRow, TickerType } from '../client';
let sweepCache: { at: number; rows: TickerRow[] } | null = null;
const SWEEP_KEY = 'fudcourt:web:ticker:sweep';

/**
 * The tiered venue-sweep cache.
 *
 * The sweep is the most expensive thing this app does: a cold process pays
 * 71-80 s for it (measured), because it is one quote per (venue, symbol, type)
 * job across ten exchanges. Optimising half of it would be worse than not
 * optimising it — measured, a process restart with a 60 s cache TTL always
 * re-paid the full sweep, since the sweep outlives the TTL. So the TTLs are
 * deliberately tiered:
 *
 *   FRESH (60 s)   prices are current; serve from memory, no refresh.
 *   STALE (1 h)    a serve-stale window. Between the two, the caller serves the
 *                  last known sweep immediately and a refresh runs in the
 *                  background, so no request ever blocks on the sweep again.
 *                  The response carries `timestamp`, so a stale read is visible
 *                  rather than passed off as current.
 *   VALKEY (1 h)   the L2, which is what makes the first call after a restart
 *                  fast: a restart discards module state but not Valkey.
 *
 * Beyond STALE nothing is served: an hour-old price is not "stale but usable",
 * it is wrong. Past that the caller waits for a real sweep, and if it fails the
 * route reports the failure instead of showing the old numbers as live.
 *
 * Rejections are never cached, in any tier, so a venue outage is retried on the
 * next request rather than being pinned for a window.
 */
export const SWEEP_FRESH_MS = TICKER_TTL_MS;
export const SWEEP_STALE_MS = 60 * 60 * 1000;

/** The freshest sweep available from memory, and its age. */
export function sweepSnapshot(): { at: number; rows: TickerRow[] } | null {
  return sweepCache;
}

/** Adopt a sweep read from the L2 as this process's memory copy. */
export function primeSweep(snapshot: { at: number; rows: TickerRow[] }): void {
  sweepCache = snapshot;
}

/** Read the L2 copy (survives restarts). Null on any miss or failure. */
export async function readSweepL2(): Promise<{ at: number; rows: TickerRow[] } | null> {
  const v = await l2GetJson<{ at: number; rows: TickerRow[] }>(SWEEP_KEY).catch(() => null);
  return v?.rows?.length ? v : null;
}

/** Single-flight gate: concurrent cold/stale sweep callers share one sweep. */
let sweepInFlight: Promise<TickerRow[]> | null = null;

/**
 * Run one sweep and record it in memory and in the L2.
 *
 * The L2 entry is given the STALE lifetime, not the fresh one: it is the
 * restart-recovery copy, and expiring it after 60 s is exactly the bug that made
 * every post-restart request pay the full sweep.
 */
export async function runSweep(run: () => Promise<TickerRow[]>): Promise<TickerRow[]> {
  if (sweepInFlight) return sweepInFlight;
  const task = (async (): Promise<TickerRow[]> => {
    const rows = await run();
    if (!rows.length) return rows;
    sweepCache = { at: Date.now(), rows };
    await l2SetJson(SWEEP_KEY, sweepCache, SWEEP_STALE_MS).catch(() => {});
    return rows;
  })();
  sweepInFlight = task;
  try {
    return await task;
  } finally {
    // Always release the gate: a resolved sweep must not pin future callers
    // to its rows, and a failure must retry upstream on the next call.
    if (sweepInFlight === task) sweepInFlight = null;
  }
}

/**
 * CCXT venue loader.
 *
 * CCXT publishes a single `exports` map exposing only the package root. That
 * root barrel eagerly imports every one of its ~100 exchange classes, two of
 * which (dYdX v4) pull in `protobufjs` files Next's bundler cannot resolve —
 * so importing the barrel breaks the production build outright.
 *
 * Loading only the venues we actually read, from ccxt's own per-exchange
 * modules, avoids that. Two upstream packaging constraints stack up here:
 *
 *   1. The export map blocks a subpath for both `import` and `require`, so the
 *      package is located on disk and venue files are addressed by path.
 *   2. The bundler will not leave a literal `require()` of a computed path
 *      alone — it tries to resolve it at build time and fails — so the load
 *      goes through createRequire, which the bundler treats as a runtime call.
 *
 * The trade-off is worth stating: adding a venue means adding it to
 * TICKER_EXCHANGES and confirming the matching module exists, so a typo
 * surfaces as a failed venue on the board rather than a row that silently
 * never fills in.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Exchange as CcxtExchange } from 'ccxt';

/**
 * Locate ccxt by walking up until its `node_modules` entry appears.
 *
 * The anchor is `process.cwd()` rather than `__dirname` on purpose: this is a
 * bundled server module, and the bundler replaces `__dirname` with a build-time
 * placeholder ("/ROOT/lib") that does not exist on disk, so a directory-based
 * search silently finds nothing. The server is started from the app root, so
 * walking up from there finds the real package. If it is ever missing, venues
 * report as failed and the board says so rather than going quiet.
 */
function findCcxtRoot(start: string): string | null {
  let dir = start;
  for (let hop = 0; hop < 10; hop++) {
    const candidate = join(dir, 'node_modules', 'ccxt');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const ccxtRoot = findCcxtRoot(process.cwd());

// `require` does not exist in ES module scope, so it cannot be referenced
// directly. createRequire only needs a real path to anchor resolution; the
// bundle's own location is useless for that (see above), so the app root is
// used, and an unresolved ccxt simply yields no venues.
const loadModule = createRequire(join(ccxtRoot ?? process.cwd(), 'noop.cjs'));

type VenueConstructor = new (config?: object) => CcxtExchange;

/** The per-exchange module is ESM, so it arrives as `{ __esModule, default }`. */
function loadVenue(id: TickerExchange): VenueConstructor | null {
  if (!ccxtRoot) return null;
  try {
    const mod = loadModule(join(ccxtRoot, 'js', 'src', `${id}.js`)) as
      | VenueConstructor
      | { default: VenueConstructor };
    const Ctor = 'default' in mod ? mod.default : mod;
    return typeof Ctor === 'function' ? Ctor : null;
  } catch {
    return null;
  }
}

let clients: Map<TickerExchange, CcxtExchange> | null = null;

/**
 * One client per venue for the process lifetime. CCXT clients are stateless
 * between calls and `enableRateLimit` is per-client, so sharing one is what
 * keeps the venue's published rate limits respected.
 */
export function tickerClients(): Map<TickerExchange, CcxtExchange> {
  if (clients) return clients;
  clients = new Map();
  for (const id of TICKER_EXCHANGES) {
    const Ctor = loadVenue(id);
    // A venue that cannot be constructed is absent from the map, so the sweep
    // reports it in each row's `failed` rather than pretending the pair has
    // only one source.
    if (Ctor) clients.set(id, new Ctor({ enableRateLimit: true, timeout: 12_000 }));
  }
  return clients;
}

/**
 * Instrument discovery for the ticker family.
 *
 * Futures and options are not one price each: an exchange lists many expiries,
 * and an option adds a strike and a call/put on top. The set of instruments
 * therefore has to come from the venues themselves rather than from a guess
 * hardcoded here — a hand-written symbol like 'BTC/USDT:BTC-240927C50000' is
 * rejected outright by the exchange it was written for.
 *
 * Cost matters: `loadMarkets` pulls thousands of instruments per venue and
 * takes seconds, so the market maps are cached for a long window and shared
 * across every request. Instrument *prices* are not cached here; those go
 * through the TTL memo in lib/ticker.ts.
 */


/**
 * Market maps change only when an exchange lists or delists something, so
 * this is far longer than any price TTL. A day is still short enough that a
 * newly listed contract appears within a day of being live.
 */
const MARKETS_TTL_MS = 24 * 60 * 60 * 1000;

type LoadedMarkets = { at: number; markets: Record<string, CcxtExchange['markets'][string]> };

const marketsCache = new Map<TickerExchange, LoadedMarkets>();
const marketsInFlight = new Map<TickerExchange, Promise<void>>();

/**
 * A usable market list for one venue, loaded once per MARKETS_TTL_MS.
 *
 * Failure is cached too, but only for a short window: a venue that is briefly
 * unreachable should not be written off for a day, and a load that throws on
 * every request would hammer an upstream that is already struggling.
 */
export async function ensureMarkets(
  venue: TickerExchange,
  load: (client: CcxtExchange) => Promise<unknown>,
): Promise<CcxtExchange['markets'] | null> {
  const hit = marketsCache.get(venue);
  if (hit && Date.now() - hit.at < MARKETS_TTL_MS) return hit.markets;

  const running = marketsInFlight.get(venue);
  if (running) {
    await running;
    return marketsCache.get(venue)?.markets ?? null;
  }

  const client = tickerClients().get(venue);
  if (!client) return null;

  const task = load(client)
    .then(() => {
      marketsCache.set(venue, { at: Date.now(), markets: client.markets });
    })
    .catch(() => {
      // A failed load must not be memoised for the full TTL: record it as a
      // short-lived empty result so the next request retries.
      marketsCache.delete(venue);
    })
    .finally(() => {
      marketsInFlight.delete(venue);
    });
  marketsInFlight.set(venue, task);
  await task;
  return marketsCache.get(venue)?.markets ?? null;
}

/** The type ccxt's unified symbol implies, or null if it is not one of ours. */
function marketType(market: CcxtExchange['markets'][string]): TickerType | null {
  if (market.option) return 'option';
  if (market.future) return 'future';
  if (market.swap) return 'swap';
  if (market.spot) return 'spot';
  return null;
}

/**
 * Every instrument a venue lists for one base asset and market type.
 *
 * `settle` optionally pins the settlement currency (e.g. 'USDT'). The same
 * coin is listed settled in USD at one venue and USDT at another, and those
 * are genuinely different contracts whose prices differ by a real basis.
 * Callers that need to compare prices across venues pass the settlement they
 * want; the sweep deliberately does not, because it groups by settlement
 * instead so a basis is never reported as venue disagreement.
 */
export function instrumentsFor(
  markets: CcxtExchange['markets'],
  base: string,
  type: TickerType,
  settle?: string,
): TickerInstrument[] {
  const out: TickerInstrument[] = [];
  for (const [symbol, market] of Object.entries(markets)) {
    if (!market.active) continue;
    if (marketType(market) !== type) continue;
    if (market.base !== base) continue;
    if (settle && market.settle !== settle && market.quote !== settle) continue;
    // Only USD, USD-pegged and coin-margined settlements. Fiat is excluded: a
    // BTC/AUD market quoted next to BTC/USDT would differ by the AUD/USD rate
    // and the board would report that exchange rate as venue disagreement.
    if (!settle && !isQuotableSettlement(market.settle ?? market.quote, base)) continue;

    out.push({
      symbol,
      type,
      settle: market.settle ?? market.quote ?? null,
      expiry: typeof market.expiry === 'number' ? market.expiry : null,
      strike: typeof market.strike === 'number' ? market.strike : null,
      // ccxt's `market.contract` is a boolean flag, NOT the 'call'/'put' string
      // its docs imply — verified on OKX, where a -C symbol reports
      // `contract: true`. Reading the kind off that field silently labels every
      // option a put, so it is parsed from the symbol's own -C/-P suffix,
      // which is unambiguous in ccxt's unified format.
      optionKind: market.option
        ? (symbol.endsWith('-P') ? 'put' : 'call')
        : null,
      contractSize: typeof market.contractSize === 'number' ? market.contractSize : null,
    });
  }
  return out;
}

/**
 * The per-type summary the instruments route returns for the UI selectors.
 *
 * Strikes are keyed by expiry date rather than flattened, because an option
 * chain's strike ladder is a function of its expiry: the nearest chain ladders
 * around spot, a later month lists a different and wider ladder. One flat
 * list would offer strikes the chosen expiry does not list.
 */
export interface TypeInstrumentSummary {
  venues: TickerExchange[];
  expiries: string[];
  strikesByExpiry: Record<string, number[]>;
  default: {
    symbol: string;
    expiry: string | null;
    strike: number | null;
    optionKind: 'call' | 'put' | null;
  } | null;
}
/**
 * Pick the instrument a board row should show when the reader has not chosen
 * one. Spot and perpetual have exactly one; dated and option do not.
 *
 * For a future the nearest expiry is the front of the curve and the one people
 * mean by "the BTC future". For an option the choice is near-the-money at the
 * nearest expiry: an option far out of the money is a different trade, not a
 * better default.
 *
 * `spotPrice` is the reference that makes near-the-money meaningful, and it
 * must be the spot for the SAME base asset at the time of the call. Callers
 * that hold one pass it; callers that do not pass null, which selects the
 * median strike at the nearest expiry — the honest fallback, since without a
 * spot there is nothing to be near. Passing a stale or absent price as if it
 * were spot would mislabel the default rather than fall back.
 */
export function defaultInstrument(
  instruments: TickerInstrument[],
  spotPrice: number | null,
): TickerInstrument | null {
  if (instruments.length === 0) return null;
  if (instruments.length === 1) return instruments[0];

  const dated = instruments.filter(i => i.expiry !== null);
  if (dated.length === 0) return instruments[0];
  const nearestExpiry = Math.min(...dated.map(i => i.expiry as number));

  const atExpiry = dated.filter(i => i.expiry === nearestExpiry);
  const strikes = atExpiry.filter(i => i.strike !== null);
  if (strikes.length === 0) return atExpiry[0];
  if (spotPrice === null) {
    // Without a spot price we cannot call anything at-the-money, so fall back
    // to the median strike rather than picking arbitrarily.
    const sorted = strikes.map(i => i.strike as number).sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)];
    return strikes.find(i => i.strike === mid) ?? strikes[0];
  }
  let best = strikes[0];
  let bestDist = Math.abs((best.strike as number) - spotPrice);
  for (const i of strikes) {
    const d = Math.abs((i.strike as number) - spotPrice);
    if (d < bestDist) { best = i; bestDist = d; }
  }
  return best;
}

/**
 * The distinct expiries present, as ISO dates, ascending.
 *
 * ISO dates rather than raw timestamps because that is what the UI can both
 * display and use as a stable selector value, and because ccxt's expiry is a
 * timestamp at market open whose time-of-day component carries no meaning
 * here.
 */
export function expiriesFor(instruments: TickerInstrument[]): string[] {
  const seen = new Set<string>();
  for (const i of instruments) {
    if (i.expiry === null) continue;
    seen.add(new Date(i.expiry).toISOString().slice(0, 10));
  }
  return [...seen].sort();
}

export function strikesFor(instruments: TickerInstrument[], expiryIso: string): number[] {
  const seen = new Set<number>();
  for (const i of instruments) {
    if (i.strike === null) continue;
    // Expiries are timestamps at market open; compare by calendar day.
    if (new Date(i.expiry as number).toISOString().slice(0, 10) !== expiryIso) continue;
    seen.add(i.strike);
  }
  return [...seen].sort((a, b) => a - b);
}
