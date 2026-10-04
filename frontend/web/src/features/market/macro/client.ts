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
// The worldwide economy board (World Bank, annual).
//
// ONE indicator per request (the API rejects a `;`-separated list — measured),
// but countries batch, so the whole world is 8 calls: one per indicator, each
// carrying every code at once. Every country and aggregate below was verified
// live against the API — a code that returns nothing is deliberately absent,
// because a row that can never fill is worse than no row. Taiwan (`TWN`) is the
// one notable omission: it is not a World Bank member and returns no series.
//
// `region` groups the table; `name` is OUR display label, while `wbName` is the
// exact upstream `country.value` the API answers with. The income-group
// aggregates need `wbName` because they come back with an EMPTY `countryiso3code`
// (see sources/worldbank.ts) — the name is the only key that maps them back.
// ---------------------------------------------------------------------------

export type WorldRegion = 'Americas' | 'Europe' | 'Asia-Pacific' | 'Africa & Middle East';

export type WorldCountrySpec = { code: string; name: string; region: WorldRegion };

/**
 * The countries on the board, grouped by region. 125 economies covering every
 * continent and income level — the G20 in full plus the next tier of markets.
 */
export const WORLD_COUNTRIES: readonly WorldCountrySpec[] = [
  // --- Americas (18) ---
  { code: 'USA', name: 'United States', region: 'Americas' },
  { code: 'CAN', name: 'Canada', region: 'Americas' },
  { code: 'MEX', name: 'Mexico', region: 'Americas' },
  { code: 'BRA', name: 'Brazil', region: 'Americas' },
  { code: 'ARG', name: 'Argentina', region: 'Americas' },
  { code: 'COL', name: 'Colombia', region: 'Americas' },
  { code: 'CHL', name: 'Chile', region: 'Americas' },
  { code: 'PER', name: 'Peru', region: 'Americas' },
  { code: 'DOM', name: 'Dominican Republic', region: 'Americas' },
  { code: 'GTM', name: 'Guatemala', region: 'Americas' },
  { code: 'URY', name: 'Uruguay', region: 'Americas' },
  { code: 'PRY', name: 'Paraguay', region: 'Americas' },
  { code: 'ECU', name: 'Ecuador', region: 'Americas' },
  { code: 'BOL', name: 'Bolivia', region: 'Americas' },
  { code: 'PAN', name: 'Panama', region: 'Americas' },
  { code: 'CRI', name: 'Costa Rica', region: 'Americas' },
  { code: 'TTO', name: 'Trinidad and Tobago', region: 'Americas' },
  { code: 'JAM', name: 'Jamaica', region: 'Americas' },
  // --- Europe (40) ---
  { code: 'DEU', name: 'Germany', region: 'Europe' },
  { code: 'GBR', name: 'United Kingdom', region: 'Europe' },
  { code: 'FRA', name: 'France', region: 'Europe' },
  { code: 'ITA', name: 'Italy', region: 'Europe' },
  { code: 'ESP', name: 'Spain', region: 'Europe' },
  { code: 'NLD', name: 'Netherlands', region: 'Europe' },
  { code: 'CHE', name: 'Switzerland', region: 'Europe' },
  { code: 'SWE', name: 'Sweden', region: 'Europe' },
  { code: 'POL', name: 'Poland', region: 'Europe' },
  { code: 'TUR', name: 'Türkiye', region: 'Europe' },
  { code: 'RUS', name: 'Russia', region: 'Europe' },
  { code: 'NOR', name: 'Norway', region: 'Europe' },
  { code: 'FIN', name: 'Finland', region: 'Europe' },
  { code: 'IRL', name: 'Ireland', region: 'Europe' },
  { code: 'PRT', name: 'Portugal', region: 'Europe' },
  { code: 'GRC', name: 'Greece', region: 'Europe' },
  { code: 'AUT', name: 'Austria', region: 'Europe' },
  { code: 'BEL', name: 'Belgium', region: 'Europe' },
  { code: 'CZE', name: 'Czechia', region: 'Europe' },
  { code: 'HUN', name: 'Hungary', region: 'Europe' },
  { code: 'ROU', name: 'Romania', region: 'Europe' },
  { code: 'UKR', name: 'Ukraine', region: 'Europe' },
  { code: 'ISL', name: 'Iceland', region: 'Europe' },
  { code: 'LUX', name: 'Luxembourg', region: 'Europe' },
  { code: 'CYP', name: 'Cyprus', region: 'Europe' },
  { code: 'MLT', name: 'Malta', region: 'Europe' },
  { code: 'SVK', name: 'Slovakia', region: 'Europe' },
  { code: 'SVN', name: 'Slovenia', region: 'Europe' },
  { code: 'HRV', name: 'Croatia', region: 'Europe' },
  { code: 'BGR', name: 'Bulgaria', region: 'Europe' },
  { code: 'LTU', name: 'Lithuania', region: 'Europe' },
  { code: 'LVA', name: 'Latvia', region: 'Europe' },
  { code: 'EST', name: 'Estonia', region: 'Europe' },
  { code: 'ALB', name: 'Albania', region: 'Europe' },
  { code: 'MKD', name: 'North Macedonia', region: 'Europe' },
  { code: 'BIH', name: 'Bosnia and Herzegovina', region: 'Europe' },
  { code: 'SRB', name: 'Serbia', region: 'Europe' },
  { code: 'MNE', name: 'Montenegro', region: 'Europe' },
  { code: 'BLR', name: 'Belarus', region: 'Europe' },
  { code: 'MDA', name: 'Moldova', region: 'Europe' },
  // --- Asia-Pacific (32) ---
  { code: 'CHN', name: 'China', region: 'Asia-Pacific' },
  { code: 'JPN', name: 'Japan', region: 'Asia-Pacific' },
  { code: 'IND', name: 'India', region: 'Asia-Pacific' },
  { code: 'KOR', name: 'South Korea', region: 'Asia-Pacific' },
  { code: 'IDN', name: 'Indonesia', region: 'Asia-Pacific' },
  { code: 'AUS', name: 'Australia', region: 'Asia-Pacific' },
  { code: 'THA', name: 'Thailand', region: 'Asia-Pacific' },
  { code: 'VNM', name: 'Vietnam', region: 'Asia-Pacific' },
  { code: 'MYS', name: 'Malaysia', region: 'Asia-Pacific' },
  { code: 'PHL', name: 'Philippines', region: 'Asia-Pacific' },
  { code: 'SGP', name: 'Singapore', region: 'Asia-Pacific' },
  { code: 'PAK', name: 'Pakistan', region: 'Asia-Pacific' },
  { code: 'BGD', name: 'Bangladesh', region: 'Asia-Pacific' },
  { code: 'LKA', name: 'Sri Lanka', region: 'Asia-Pacific' },
  { code: 'NPL', name: 'Nepal', region: 'Asia-Pacific' },
  { code: 'MMR', name: 'Myanmar', region: 'Asia-Pacific' },
  { code: 'KHM', name: 'Cambodia', region: 'Asia-Pacific' },
  { code: 'MNG', name: 'Mongolia', region: 'Asia-Pacific' },
  { code: 'NZL', name: 'New Zealand', region: 'Asia-Pacific' },
  { code: 'HKG', name: 'Hong Kong SAR', region: 'Asia-Pacific' },
  { code: 'MAC', name: 'Macao SAR', region: 'Asia-Pacific' },
  { code: 'BRN', name: 'Brunei', region: 'Asia-Pacific' },
  { code: 'FJI', name: 'Fiji', region: 'Asia-Pacific' },
  { code: 'PNG', name: 'Papua New Guinea', region: 'Asia-Pacific' },
  { code: 'KAZ', name: 'Kazakhstan', region: 'Asia-Pacific' },
  { code: 'AZE', name: 'Azerbaijan', region: 'Asia-Pacific' },
  { code: 'UZB', name: 'Uzbekistan', region: 'Asia-Pacific' },
  { code: 'TKM', name: 'Turkmenistan', region: 'Asia-Pacific' },
  { code: 'KGZ', name: 'Kyrgyz Republic', region: 'Asia-Pacific' },
  { code: 'TJK', name: 'Tajikistan', region: 'Asia-Pacific' },
  { code: 'GEO', name: 'Georgia', region: 'Asia-Pacific' },
  { code: 'ARM', name: 'Armenia', region: 'Asia-Pacific' },
  // --- Africa & Middle East (35) ---
  { code: 'SAU', name: 'Saudi Arabia', region: 'Africa & Middle East' },
  { code: 'ARE', name: 'United Arab Emirates', region: 'Africa & Middle East' },
  { code: 'ISR', name: 'Israel', region: 'Africa & Middle East' },
  { code: 'QAT', name: 'Qatar', region: 'Africa & Middle East' },
  { code: 'KWT', name: 'Kuwait', region: 'Africa & Middle East' },
  { code: 'IRQ', name: 'Iraq', region: 'Africa & Middle East' },
  { code: 'IRN', name: 'Iran', region: 'Africa & Middle East' },
  { code: 'JOR', name: 'Jordan', region: 'Africa & Middle East' },
  { code: 'OMN', name: 'Oman', region: 'Africa & Middle East' },
  { code: 'BHR', name: 'Bahrain', region: 'Africa & Middle East' },
  { code: 'EGY', name: 'Egypt', region: 'Africa & Middle East' },
  { code: 'ZAF', name: 'South Africa', region: 'Africa & Middle East' },
  { code: 'NGA', name: 'Nigeria', region: 'Africa & Middle East' },
  { code: 'KEN', name: 'Kenya', region: 'Africa & Middle East' },
  { code: 'ETH', name: 'Ethiopia', region: 'Africa & Middle East' },
  { code: 'MAR', name: 'Morocco', region: 'Africa & Middle East' },
  { code: 'DZA', name: 'Algeria', region: 'Africa & Middle East' },
  { code: 'TZA', name: 'Tanzania', region: 'Africa & Middle East' },
  { code: 'UGA', name: 'Uganda', region: 'Africa & Middle East' },
  { code: 'GHA', name: 'Ghana', region: 'Africa & Middle East' },
  { code: 'CIV', name: 'Côte d’Ivoire', region: 'Africa & Middle East' },
  { code: 'SEN', name: 'Senegal', region: 'Africa & Middle East' },
  { code: 'TUN', name: 'Tunisia', region: 'Africa & Middle East' },
  { code: 'BWA', name: 'Botswana', region: 'Africa & Middle East' },
  { code: 'NAM', name: 'Namibia', region: 'Africa & Middle East' },
  { code: 'ZMB', name: 'Zambia', region: 'Africa & Middle East' },
  { code: 'ZWE', name: 'Zimbabwe', region: 'Africa & Middle East' },
  { code: 'CMR', name: 'Cameroon', region: 'Africa & Middle East' },
  { code: 'MOZ', name: 'Mozambique', region: 'Africa & Middle East' },
  { code: 'AGO', name: 'Angola', region: 'Africa & Middle East' },
  { code: 'SDN', name: 'Sudan', region: 'Africa & Middle East' },
  { code: 'LBY', name: 'Libya', region: 'Africa & Middle East' },
  { code: 'SYR', name: 'Syria', region: 'Africa & Middle East' },
  { code: 'YEM', name: 'Yemen', region: 'Africa & Middle East' },
  { code: 'AFG', name: 'Afghanistan', region: 'Africa & Middle East' },
];

/**
 * World Bank aggregates — the whole planet, the four income groups and the
 * regional/unions blocks, so the board shows a country AGAINST its peer group.
 * `wbName` must match the upstream `country.value` EXACTLY: it is what the
 * parser keys these rows on (their `countryiso3code` is empty — measured).
 */
export type WorldAggregateSpec = {
  code: string;
  name: string;
  wbName: string;
  group: 'World & income' | 'Regions & unions';
};

export const WORLD_AGGREGATES: readonly WorldAggregateSpec[] = [
  { code: 'WLD', name: 'World', wbName: 'World', group: 'World & income' },
  { code: 'HIC', name: 'High income', wbName: 'High income', group: 'World & income' },
  { code: 'UMC', name: 'Upper middle income', wbName: 'Upper middle income', group: 'World & income' },
  { code: 'LMC', name: 'Lower middle income', wbName: 'Lower middle income', group: 'World & income' },
  { code: 'LIC', name: 'Low income', wbName: 'Low income', group: 'World & income' },
  { code: 'MIC', name: 'Middle income', wbName: 'Middle income', group: 'World & income' },
  { code: 'OED', name: 'OECD members', wbName: 'OECD members', group: 'Regions & unions' },
  { code: 'EUU', name: 'European Union', wbName: 'European Union', group: 'Regions & unions' },
  { code: 'EMU', name: 'Euro area', wbName: 'Euro area', group: 'Regions & unions' },
  { code: 'ARB', name: 'Arab World', wbName: 'Arab World', group: 'Regions & unions' },
  { code: 'EAS', name: 'East Asia & Pacific', wbName: 'East Asia & Pacific', group: 'Regions & unions' },
  { code: 'ECS', name: 'Europe & Central Asia', wbName: 'Europe & Central Asia', group: 'Regions & unions' },
  { code: 'LCN', name: 'Latin America & Caribbean', wbName: 'Latin America & Caribbean', group: 'Regions & unions' },
  { code: 'SAS', name: 'South Asia', wbName: 'South Asia', group: 'Regions & unions' },
  { code: 'MEA', name: 'Middle East & North Africa', wbName: 'Middle East, North Africa, Afghanistan & Pakistan', group: 'Regions & unions' },
  { code: 'SSF', name: 'Sub-Saharan Africa', wbName: 'Sub-Saharan Africa', group: 'Regions & unions' },
  { code: 'AFE', name: 'Africa Eastern & Southern', wbName: 'Africa Eastern and Southern', group: 'Regions & unions' },
  { code: 'AFW', name: 'Africa Western & Central', wbName: 'Africa Western and Central', group: 'Regions & unions' },
];

/**
 * Upstream name -> code, for the rows whose iso3 field comes back empty. Passed
 * to the World Bank fetcher so those aggregates resolve instead of vanishing.
 */
export const WB_AGGREGATE_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  WORLD_AGGREGATES.map((a) => [a.wbName, a.code]),
);

/** Every code the board requests: the countries then the aggregates. */
export const WORLD_CODES: readonly string[] = [
  ...WORLD_COUNTRIES.map((c) => c.code),
  ...WORLD_AGGREGATES.map((a) => a.code),
];

/** How a World Bank value is rendered. */
export type WorldValueKind = 'pct' | 'usd' | 'count' | 'pop' | 'years' | 'per1k' | 'tonnes';

/** The themed column blocks the worldwide table groups its indicators under. */
export type WorldTheme =
  | 'Output & prices'
  | 'People'
  | 'Labour & welfare'
  | 'External'
  | 'Money & state'
  | 'Structure & sustainability';

export type WorldIndicatorSpec = {
  id: string;
  /** Full name, used as the column's title attribute. */
  name: string;
  /** Compact column heading. */
  short: string;
  kind: WorldValueKind;
  decimals: number;
  note: string;
  /** Which column block the header groups this indicator under. */
  theme: WorldTheme;
};

/**
 * The 24 annual series the worldwide table carries — a country PROFILE, not a
 * two-line comparison. Array order is render order; `theme` groups the header.
 *
 * Every id here was measured against the live API across the WHOLE board (143
 * codes) before being included, and the ones that failed the measurement were
 * dropped rather than shipped as a mostly blank column: central-government debt
 * resolves for only 46 of the 125 countries, lending rate 36/50, stunting 31/50,
 * Gini 104/125, so none of those earns its width. What remains covers ≥99/125
 * countries and, except for the current account and reserves — which the World
 * Bank publishes for countries only — also most of the 18 aggregates, so the
 * aggregates table fills too. Where a series genuinely has no observation for a
 * row, that cell stays an em dash.
 */
export const ECONOMY_INDICATORS: readonly WorldIndicatorSpec[] = [
  // -- Output & prices ------------------------------------------------------
  { id: 'NY.GDP.MKTP.KD.ZG', name: 'GDP growth', short: 'GDP growth', kind: 'pct', decimals: 2, theme: 'Output & prices', note: 'Annual real GDP growth' },
  { id: 'NY.GDP.MKTP.CD', name: 'GDP (nominal)', short: 'GDP', kind: 'usd', decimals: 0, theme: 'Output & prices', note: 'Gross domestic product, current US$' },
  { id: 'NY.GDP.PCAP.CD', name: 'GDP per capita', short: 'GDP/capita', kind: 'usd', decimals: 0, theme: 'Output & prices', note: 'GDP per capita, current US$' },
  { id: 'FP.CPI.TOTL.ZG', name: 'Inflation', short: 'Inflation', kind: 'pct', decimals: 2, theme: 'Output & prices', note: 'Consumer prices, annual %' },

  // -- People ---------------------------------------------------------------
  { id: 'SP.POP.TOTL', name: 'Population', short: 'Population', kind: 'pop', decimals: 0, theme: 'People', note: 'Total population' },
  { id: 'SP.POP.65UP.TO.ZS', name: 'Population 65+', short: 'Pop 65+', kind: 'pct', decimals: 1, theme: 'People', note: 'Population aged 65 and above, % of total' },
  { id: 'SP.URB.TOTL.IN.ZS', name: 'Urban population', short: 'Urban', kind: 'pct', decimals: 1, theme: 'People', note: 'Urban population, % of total' },
  { id: 'SP.DYN.LE00.IN', name: 'Life expectancy', short: 'Life exp.', kind: 'years', decimals: 1, theme: 'People', note: 'Life expectancy at birth, total' },

  // -- Labour & welfare -----------------------------------------------------
  { id: 'SL.UEM.TOTL.ZS', name: 'Unemployment', short: 'Unemp.', kind: 'pct', decimals: 2, theme: 'Labour & welfare', note: 'Unemployment, total (% of labour force, ILO estimate)' },
  { id: 'SL.TLF.CACT.ZS', name: 'Labour force participation', short: 'LF part.', kind: 'pct', decimals: 1, theme: 'Labour & welfare', note: 'Labour force participation rate, ages 15+, total' },
  { id: 'SP.DYN.IMRT.IN', name: 'Infant mortality', short: 'Inf. mort.', kind: 'per1k', decimals: 1, theme: 'Labour & welfare', note: 'Infant deaths per 1,000 live births' },
  { id: 'SH.XPD.CHEX.GD.ZS', name: 'Health expenditure', short: 'Health', kind: 'pct', decimals: 1, theme: 'Labour & welfare', note: 'Current health expenditure, % of GDP' },

  // -- External -------------------------------------------------------------
  { id: 'NE.TRD.GNFS.ZS', name: 'Trade openness', short: 'Trade', kind: 'pct', decimals: 1, theme: 'External', note: 'Exports plus imports of goods and services, % of GDP' },
  { id: 'BN.CAB.XOKA.GD.ZS', name: 'Current account', short: 'Cur. acct', kind: 'pct', decimals: 2, theme: 'External', note: 'Current account balance, % of GDP (countries only upstream)' },
  { id: 'BX.KLT.DINV.WD.GD.ZS', name: 'FDI inflows', short: 'FDI', kind: 'pct', decimals: 2, theme: 'External', note: 'Foreign direct investment, net inflows, % of GDP' },
  { id: 'FI.RES.TOTL.CD', name: 'Reserves', short: 'Reserves', kind: 'usd', decimals: 0, theme: 'External', note: 'Total reserves including gold, current US$ (countries only upstream)' },

  // -- Money & state --------------------------------------------------------
  { id: 'FM.LBL.BMNY.GD.ZS', name: 'Broad money', short: 'Broad money', kind: 'pct', decimals: 1, theme: 'Money & state', note: 'Broad money, % of GDP' },
  { id: 'SE.XPD.TOTL.GD.ZS', name: 'Government education expenditure', short: 'Education', kind: 'pct', decimals: 1, theme: 'Money & state', note: 'Government expenditure on education, % of GDP' },
  { id: 'GC.TAX.TOTL.GD.ZS', name: 'Tax revenue', short: 'Tax', kind: 'pct', decimals: 1, theme: 'Money & state', note: 'Tax revenue, % of GDP' },
  { id: 'MS.MIL.XPND.GD.ZS', name: 'Military expenditure', short: 'Military', kind: 'pct', decimals: 1, theme: 'Money & state', note: 'Military expenditure, % of GDP' },

  // -- Structure & sustainability -------------------------------------------
  { id: 'NE.GDI.TOTL.ZS', name: 'Gross capital formation', short: 'Investment', kind: 'pct', decimals: 1, theme: 'Structure & sustainability', note: 'Gross capital formation, % of GDP' },
  { id: 'NV.IND.MANF.ZS', name: 'Manufacturing', short: 'Mfg', kind: 'pct', decimals: 1, theme: 'Structure & sustainability', note: 'Manufacturing value added, % of GDP' },
  { id: 'IT.NET.USER.ZS', name: 'Internet users', short: 'Internet', kind: 'pct', decimals: 1, theme: 'Structure & sustainability', note: 'Individuals using the internet, % of population' },
  { id: 'EN.GHG.CO2.PC.CE.AR5', name: 'CO2 emissions', short: 'CO2', kind: 'tonnes', decimals: 1, theme: 'Structure & sustainability', note: 'Carbon dioxide emissions, metric tons per capita' },
];

/** The theme order the table's grouped header renders in. */
export const WORLD_THEMES: readonly WorldTheme[] = [
  'Output & prices',
  'People',
  'Labour & welfare',
  'External',
  'Money & state',
  'Structure & sustainability',
];

/** Earliest year to accept for the annual comparison. */
export const ECONOMY_FROM_YEAR = 2015;
