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

// ---------------------------------------------------------------------------
// Global policy rates (BIS WS_CBPOL).
//
// `area` is the BIS reference-area code. The list is the 27 codes BIS actually
// carries on the DAILY series (measured against a 60-day window) — India,
// Singapore and Vietnam are deliberately absent because BIS returns nothing for
// them, and a row that never fills is worse than no row. `bank` is our label;
// BIS's own title is a generic "Central bank policy rates - <country>".
// ---------------------------------------------------------------------------

export type PolicyRateSpec = { area: string; bank: string; region: string; note: string };

export const POLICY_RATES: readonly PolicyRateSpec[] = [
  { area: 'US', bank: 'United States — Fed', region: 'Americas', note: 'Federal Reserve target rate (upper bound)' },
  { area: 'CA', bank: 'Canada — BoC', region: 'Americas', note: 'Bank of Canada overnight target' },
  { area: 'BR', bank: 'Brazil — BCB', region: 'Americas', note: 'Banco Central do Brasil Selic target' },
  { area: 'MX', bank: 'Mexico — Banxico', region: 'Americas', note: 'Banco de México overnight target' },
  { area: 'CL', bank: 'Chile — BCCh', region: 'Americas', note: 'Banco Central de Chile policy rate' },
  { area: 'CO', bank: 'Colombia — BanRep', region: 'Americas', note: 'Banco de la República policy rate' },
  { area: 'PE', bank: 'Peru — BCRP', region: 'Americas', note: 'Banco Central de Reserva del Perú reference rate' },
  { area: 'XM', bank: 'Euro area — ECB', region: 'Europe', note: 'ECB deposit facility rate' },
  { area: 'GB', bank: 'United Kingdom — BoE', region: 'Europe', note: 'Bank of England Bank Rate' },
  { area: 'CH', bank: 'Switzerland — SNB', region: 'Europe', note: 'Swiss National Bank policy rate' },
  { area: 'SE', bank: 'Sweden — Riksbank', region: 'Europe', note: 'Sveriges Riksbank policy rate' },
  { area: 'NO', bank: 'Norway — Norges Bank', region: 'Europe', note: 'Norges Bank policy rate' },
  { area: 'DK', bank: 'Denmark — Nationalbanken', region: 'Europe', note: 'Danmarks Nationalbank certificate rate' },
  { area: 'PL', bank: 'Poland — NBP', region: 'Europe', note: 'Narodowy Bank Polski reference rate' },
  { area: 'CZ', bank: 'Czechia — CNB', region: 'Europe', note: 'Česká národní banka 2-week repo rate' },
  { area: 'HU', bank: 'Hungary — MNB', region: 'Europe', note: 'Magyar Nemzeti Bank base rate' },
  { area: 'RO', bank: 'Romania — BNR', region: 'Europe', note: 'Banca Națională a României policy rate' },
  { area: 'RS', bank: 'Serbia — NBS', region: 'Europe', note: 'Narodna banka Srbije reference rate' },
  { area: 'IS', bank: 'Iceland — CBI', region: 'Europe', note: 'Central Bank of Iceland policy rate' },
  { area: 'RU', bank: 'Russia — CBR', region: 'Europe', note: 'Bank of Russia key rate' },
  { area: 'TR', bank: 'Türkiye — CBRT', region: 'Europe', note: 'CBRT one-week repo rate' },
  { area: 'JP', bank: 'Japan — BoJ', region: 'Asia-Pacific', note: 'Bank of Japan policy rate' },
  { area: 'CN', bank: 'China — PBoC', region: 'Asia-Pacific', note: 'People’s Bank of China policy rate' },
  { area: 'KR', bank: 'South Korea — BoK', region: 'Asia-Pacific', note: 'Bank of Korea base rate (reports monthly)' },
  { area: 'ID', bank: 'Indonesia — BI', region: 'Asia-Pacific', note: 'Bank Indonesia BI-Rate' },
  { area: 'TH', bank: 'Thailand — BoT', region: 'Asia-Pacific', note: 'Bank of Thailand policy rate' },
  { area: 'MY', bank: 'Malaysia — BNM', region: 'Asia-Pacific', note: 'Bank Negara Malaysia overnight policy rate' },
  { area: 'PH', bank: 'Philippines — BSP', region: 'Asia-Pacific', note: 'Bangko Sentral ng Pilipinas target rate' },
  { area: 'HK', bank: 'Hong Kong — HKMA', region: 'Asia-Pacific', note: 'HKMA base rate' },
  { area: 'AU', bank: 'Australia — RBA', region: 'Asia-Pacific', note: 'Reserve Bank of Australia cash rate' },
  { area: 'NZ', bank: 'New Zealand — RBNZ', region: 'Asia-Pacific', note: 'Reserve Bank of New Zealand OCR' },
  { area: 'ZA', bank: 'South Africa — SARB', region: 'Africa & Middle East', note: 'South African Reserve Bank repo rate' },
  { area: 'SA', bank: 'Saudi Arabia — SAMA', region: 'Africa & Middle East', note: 'Saudi Central Bank repo rate' },
];

export const POLICY_RATE_AREAS = POLICY_RATES.map((p) => p.area);

// ---------------------------------------------------------------------------
// Global macro indicators (FRED CSV).
//
// `lag` is explicit per series because the transform depends on the series'
// frequency: 12 for a monthly year-ago point, 4 for a quarterly one. Reading it
// off date spacing is how a quarterly series silently gets a "YoY" over 3 years.
// ---------------------------------------------------------------------------

export type IndicatorGroup = 'Prices' | 'Labour' | 'Money & growth' | 'Rates & sentiment';

export type IndicatorSpec = {
  id: string;
  name: string;
  group: IndicatorGroup;
  unit: string;
  shape: 'level' | 'yoy' | 'change';
  lag: number;
  decimals: number;
  note: string;
};

export const INDICATORS: readonly IndicatorSpec[] = [
  { id: 'CPIAUCSL', name: 'US CPI', group: 'Prices', unit: '% YoY', shape: 'yoy', lag: 12, decimals: 2, note: 'All-items consumer price index, year over year' },
  { id: 'CPILFESL', name: 'US core CPI', group: 'Prices', unit: '% YoY', shape: 'yoy', lag: 12, decimals: 2, note: 'CPI excluding food and energy, year over year' },
  { id: 'PCEPI', name: 'US PCE price index', group: 'Prices', unit: '% YoY', shape: 'yoy', lag: 12, decimals: 2, note: 'Personal consumption expenditures price index, YoY — the Fed’s preferred gauge' },
  { id: 'UNRATE', name: 'US unemployment', group: 'Labour', unit: '%', shape: 'level', lag: 0, decimals: 1, note: 'Civilian unemployment rate' },
  { id: 'PAYEMS', name: 'US nonfarm payrolls', group: 'Labour', unit: 'K MoM', shape: 'change', lag: 1, decimals: 0, note: 'Month-over-month change in total nonfarm payrolls, thousands' },
  { id: 'ICSA', name: 'US initial claims', group: 'Labour', unit: 'claims', shape: 'level', lag: 0, decimals: 0, note: 'Initial unemployment insurance claims, weekly, in persons' },
  { id: 'M2SL', name: 'US M2', group: 'Money & growth', unit: '% YoY', shape: 'yoy', lag: 12, decimals: 2, note: 'M2 money stock, year over year' },
  { id: 'GDPC1', name: 'US real GDP', group: 'Money & growth', unit: '% YoY', shape: 'yoy', lag: 4, decimals: 2, note: 'Real gross domestic product, year over year (quarterly)' },
  { id: 'T10Y2Y', name: 'US 10y−2y spread', group: 'Rates & sentiment', unit: 'pp', shape: 'level', lag: 0, decimals: 2, note: '10-year minus 2-year Treasury constant-maturity spread; negative = inverted' },
  { id: 'UMCSENT', name: 'US consumer sentiment', group: 'Rates & sentiment', unit: 'index', shape: 'level', lag: 0, decimals: 1, note: 'University of Michigan consumer sentiment index' },
];

/** How far back to ask FRED for, in days — covers the largest `lag` with slack. */
export const FRED_LOOKBACK_DAYS = 1_500;

// ---------------------------------------------------------------------------
// Global economy comparison (World Bank, annual).
//
// ONE indicator per request (the API rejects a `;`-separated list — measured),
// but countries batch, so this is two calls for the whole table.
// ---------------------------------------------------------------------------

export type EconomySpec = { code: string; name: string };

export const ECONOMY_COUNTRIES: readonly EconomySpec[] = [
  { code: 'USA', name: 'United States' },
  { code: 'CHN', name: 'China' },
  { code: 'JPN', name: 'Japan' },
  { code: 'DEU', name: 'Germany' },
  { code: 'IND', name: 'India' },
  { code: 'GBR', name: 'United Kingdom' },
  { code: 'BRA', name: 'Brazil' },
  { code: 'IDN', name: 'Indonesia' },
];

export type EconomyIndicatorSpec = { id: string; name: string; unit: string; decimals: number };

export const ECONOMY_INDICATORS: readonly EconomyIndicatorSpec[] = [
  { id: 'NY.GDP.MKTP.KD.ZG', name: 'GDP growth', unit: '%', decimals: 2 },
  { id: 'FP.CPI.TOTL.ZG', name: 'Inflation', unit: '%', decimals: 2 },
];

/** Earliest year to accept for the annual comparison. */
export const ECONOMY_FROM_YEAR = 2015;
