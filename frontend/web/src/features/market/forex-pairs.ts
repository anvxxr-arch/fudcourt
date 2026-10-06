/**
 * Forex contract (server-safe) — the pure data + derivation behind the
 * /market/forex section and /api/market/forex.
 *
 * NOTE: this module MUST stay free of 'use client' and of client-only imports
 * (react, ui/*, …). The API route imports from here; importing from
 * '@/features/market/forex' (a 'use client' module) made Next resolve the
 * client boundary at runtime, so every named import arrived as a stub and the
 * route passed a blank URL to fetch (502 "fetch() URL must not be a blank
 * string.").
 *
 * Upstream is open.er-api.com (exchangerate-api free tier): one keyless GET
 * returns 160+ rates against a single base. It publishes once a day (ECB-fed),
 * hence the long TTL. `api.frankfurter.app` was the first choice but now answers
 * `301 Moved Permanently` (measured), so this uses the endpoint that actually
 * resolves.
 *
 * The hub shows curated MAJOR pairs, not all 160 -- a 160-row dump is a mirror
 * of the provider, a curated board is a view. Pairs are DERIVED locally from the
 * USD base rates (`EUR/USD = 1 / rate(EUR)`); the route labels that as
 * `derived`, never presenting the provider as having shipped these pairs.
 */
/** Fixed upstream: exchangerate-api free feed (public, keyless, GET-only). */
export const FOREX_UPSTREAM = 'https://open.er-api.com/v6/latest/USD';
/** The feed republishes daily; 5 min is ample and keeps us far under any limit. */
export const FOREX_TTL_MS = 300_000;
export type ForexPairSpec = {
  pair: string;
  base: string;
  quote: string;
  /** true when the USD rate is the QUOTE, so the displayed rate is its reciprocal. */
  invert: boolean;
};
/** Curated majors + Asia (IDR included). */
export const FOREX_PAIRS: readonly ForexPairSpec[] = [
  { pair: 'EUR/USD', base: 'EUR', quote: 'USD', invert: true },
  { pair: 'GBP/USD', base: 'GBP', quote: 'USD', invert: true },
  { pair: 'AUD/USD', base: 'AUD', quote: 'USD', invert: true },
  { pair: 'NZD/USD', base: 'NZD', quote: 'USD', invert: true },
  { pair: 'USD/JPY', base: 'USD', quote: 'JPY', invert: false },
  { pair: 'USD/CHF', base: 'USD', quote: 'CHF', invert: false },
  { pair: 'USD/CAD', base: 'USD', quote: 'CAD', invert: false },
  { pair: 'USD/CNY', base: 'USD', quote: 'CNY', invert: false },
  { pair: 'USD/SGD', base: 'USD', quote: 'SGD', invert: false },
  { pair: 'USD/HKD', base: 'USD', quote: 'HKD', invert: false },
  { pair: 'USD/IDR', base: 'USD', quote: 'IDR', invert: false },
  { pair: 'USD/MYR', base: 'USD', quote: 'MYR', invert: false },
  { pair: 'USD/THB', base: 'USD', quote: 'THB', invert: false },
  { pair: 'USD/PHP', base: 'USD', quote: 'PHP', invert: false },
  { pair: 'USD/INR', base: 'USD', quote: 'INR', invert: false },
  { pair: 'USD/KRW', base: 'USD', quote: 'KRW', invert: false },
];
export type ForexPair = { pair: string; base: string; quote: string; rate: number; inverse: number };
/** Build one displayed pair from the USD-base rate map; null if the leg is absent. */
export function buildPair(spec: ForexPairSpec, rates: Record<string, number>): ForexPair | null {
  const usdRate = rates[spec.invert ? spec.base : spec.quote];
  if (typeof usdRate !== 'number' || !Number.isFinite(usdRate) || usdRate <= 0) return null;
  const rate = spec.invert ? 1 / usdRate : usdRate;
  return { pair: spec.pair, base: spec.base, quote: spec.quote, rate, inverse: 1 / rate };
}
