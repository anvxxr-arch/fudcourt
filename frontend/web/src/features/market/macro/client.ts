/**
 * Macro family (keyless, public) — the contract behind the landing page's
 * "Macro" panel and `/api/market/macro`.
 *
 * Same Yahoo Finance chart endpoint as the stock and commodity families (see
 * `features/market/quotes.ts` for why it is one call per symbol rather than the
 * batch quote endpoint). What is different here is the UNIT: a Treasury yield is
 * quoted in percent, so a move is conventionally measured in BASIS POINTS
 * (`Δprice × 100`), not in percent-of-percent. The board therefore renders yields
 * as `5.277%` with a `+7.7 bp` delta, and the index rows (DXY, VIX) in points
 * with a percent delta. `unit` on each spec is what drives that choice.
 *
 * DELIBERATELY NOT INCLUDED: `^MOVE`. Yahoo maps that symbol to "Northern Trust
 * iBoxx 5-Year Target" (measured), NOT the ICE BofA MOVE index, so labelling it
 * "MOVE" would be a fabricated claim. The bond-volatility row is omitted rather
 * than mislabelled.
 *
 * Every symbol below was verified live against the chart endpoint.
 */
import { QUOTE_TTL_MS } from '@/features/market/quotes';

export type MacroGroup = 'Rates' | 'Dollar & volatility';

/** How a row's level and delta are rendered. */
export type MacroUnit = 'yield' | 'index';

export type MacroSpec = {
  symbol: string;
  label: string;
  group: MacroGroup;
  unit: MacroUnit;
  /** One line on what the series is, shown as the row's title attribute. */
  note: string;
};

/**
 * A macro quote as the route emits it: the Yahoo chart row plus the presentation
 * metadata (`group` / `unit` / `note`) a board needs to render it. The metadata
 * rides in the PAYLOAD so a consumer in another feature (the landing page) reads
 * it from the API rather than importing this module across feature boundaries.
 */
export type MacroQuote = import('@/features/market/quotes').MarketQuote & {
  group: MacroGroup;
  unit: MacroUnit;
  note: string;
};

export const MACRO: readonly MacroSpec[] = [
  // --- US Treasury yields (the curve, short end to long end) ---
  { symbol: '^IRX', label: 'US 13-week T-bill', group: 'Rates', unit: 'yield', note: 'CBOE 13-week T-bill yield (short end)' },
  { symbol: '^FVX', label: 'US 5-year', group: 'Rates', unit: 'yield', note: 'CBOE 5-year Treasury note yield' },
  { symbol: '^TNX', label: 'US 10-year', group: 'Rates', unit: 'yield', note: 'CBOE 10-year Treasury note yield (benchmark)' },
  { symbol: '^TYX', label: 'US 30-year', group: 'Rates', unit: 'yield', note: 'CBOE 30-year Treasury bond yield (long end)' },
  // --- Dollar and risk appetite ---
  { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', group: 'Dollar & volatility', unit: 'index', note: 'ICE US Dollar Index — USD vs a basket of majors' },
  { symbol: '^VIX', label: 'VIX', group: 'Dollar & volatility', unit: 'index', note: 'CBOE S&P 500 implied volatility (30-day)' },
  { symbol: '^VVIX', label: 'VVIX', group: 'Dollar & volatility', unit: 'index', note: 'CBOE volatility of the VIX' },
];

export const MACRO_SYMBOLS = MACRO.map((m) => m.symbol);

export const MACRO_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  MACRO.map((m) => [m.symbol, m.label]),
);

export const MACRO_NOTES: Readonly<Record<string, string>> = Object.fromEntries(
  MACRO.map((m) => [m.symbol, m.note]),
);

/**
 * Curve spreads, DERIVED LOCALLY from the quotes above (the upstream publishes
 * no spread series). `bp` is null unless BOTH legs returned a quote — a spread
 * over a missing leg is withheld, never computed from a zero.
 */
export type MacroSpreadSpec = { label: string; long: string; short: string; note: string };

export const MACRO_SPREADS: readonly MacroSpreadSpec[] = [
  { label: '10y − 13w', long: '^TNX', short: '^IRX', note: 'Benchmark minus the short end — the classic inversion gauge' },
  { label: '30y − 10y', long: '^TYX', short: '^TNX', note: 'Long-end steepness' },
];

export const MACRO_TTL_MS = QUOTE_TTL_MS;
