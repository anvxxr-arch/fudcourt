/**
 * instrument.ts — the trade domain's canonical instrument registry (plan Phase 3).
 *
 * WHY A REGISTRY AND NOT A STRING BUILT IN A VIEW. Every venue spells the same
 * pair differently (`BTCUSDT`, `BTC-USDT`, `BTC/USDT`), so the domain fixes ONE
 * spelling for IDENTITY and lets the adapter resolve the venue's own form (the
 * `model.ts` rule: the native symbol is a FIELD, never the id). This file is the
 * single place that spelling is decided.
 *
 * WHY A CLOSED SET, NOT "ANYTHING THAT PARSES". The registry is the pairs the
 * market board can actually address. `/trade/spot/<id>` must be a REAL 404 for an
 * id we cannot quote — the same rule the ticker detail route keeps — because a
 * shape-only check turns every well-formed pair into an indexable page whose own
 * data source answers "no venue quotes this": a page that exists for a question
 * nobody asked, and a page and its API disagreeing about what exists.
 *
 * The trade domain OWNS this list on purpose (plan Phase 3: "one registry that
 * unifies naming across exchanges"). It is deliberately NOT imported from the
 * ticker family: feature families are independent (DR-018, enforced by the
 * structure gate), so the trade domain declares the identity space it serves
 * rather than reaching into a sibling's module. A board row whose id is not in
 * this registry is left UNLINKED by the board (never a broken link) — see
 * `ui/dashboard.tsx`.
 */
import type { MarketType } from '@/features/trade/taxonomy';

/** The canonical id for a pair: `<base>-<quote>`, lowercased and hyphen-joined. */
export function canonicalInstrumentId(base: string, quote: string): string {
  return `${base.trim().toLowerCase()}-${quote.trim().toLowerCase()}`;
}

/**
 * The bases the trade domain addresses. Every one is quoted against USDT, which
 * is the settlement the cross-venue ticker board reads — so a board row always
 * carries an id this registry has.
 */
const BASES: readonly string[] = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE',
  'ADA', 'AVAX', 'LINK', 'DOT', 'MATIC', 'LTC',
  'TRX', 'TON', 'ARB', 'OP', 'ATOM', 'NEAR',
  'APT', 'SUI', 'PEPE', 'SHIB', 'INJ', 'SEI',
  'TIA', 'RUNE', 'WIF', 'AAVE', 'UNI', 'CRV',
];

/** One canonical instrument. `id` is DERIVED, so it cannot disagree with base/quote. */
export type InstrumentEntry = { id: string; base: string; quote: string };

/** The registry, canonical. `id` is built by `canonicalInstrumentId`, never typed twice. */
export const INSTRUMENTS: readonly InstrumentEntry[] = BASES.map((base) => ({
  id: canonicalInstrumentId(base, 'USDT'),
  base,
  quote: 'USDT',
}));

const INSTRUMENT_BY_ID: ReadonlyMap<string, InstrumentEntry> = new Map(INSTRUMENTS.map((i) => [i.id, i]));

/** Whether a route segment is a canonical instrument id this domain can address. */
export function isInstrumentId(value: string): boolean {
  return INSTRUMENT_BY_ID.has(value);
}

/** The registry entry for an id, or `undefined` when it is not one. */
export function instrumentById(id: string): InstrumentEntry | undefined {
  return INSTRUMENT_BY_ID.get(id);
}

/** `BTC / USDT` — the instrument's display label, from its own halves. */
export function instrumentLabel(id: string): string {
  const entry = INSTRUMENT_BY_ID.get(id);
  return entry ? `${entry.base} / ${entry.quote}` : id.toUpperCase();
}

/**
 * The canonical route for one instrument within a market type
 * (`spot`, `btc-usdt` → `/trade/spot/btc-usdt`). The market type is the route
 * segment and the instrument is its child — the plan's `/trade/<type>/<id>`.
 */
export function instrumentHref(marketType: MarketType, id: string): string {
  return `/trade/${marketType}/${id}`;
}
