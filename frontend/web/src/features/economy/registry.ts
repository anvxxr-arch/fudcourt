/**
 * The economy domain's INDICATOR REGISTRY and CENTRAL-BANK registry
 * (plan Phases 3, 6, 7).
 *
 * WHAT THIS FILE IS. The single place that answers "which upstream series backs
 * the slug `us-core-cpi`?". It is generated from two compact inputs — the
 * country list (`countries.ts`) and the series table below — so a new country
 * adds its whole indicator set by existing, and a new series adds one row here
 * and lands for every country that carries it. Nothing downstream hardcodes a
 * FRED id or a World Bank code: the API resolves a slug through this registry
 * and reads `source` + `sourceSeriesId` off the result.
 *
 * WHY METADATA IS PER-BINDING, NOT PER-SERIES. The same taxonomy slot is filled
 * by different measurements on different clocks. `us-cpi` is FRED's
 * seasonally-adjusted monthly index that needs a 12-period year-ago transform;
 * `id-cpi` is the World Bank's annual print that IS the inflation rate already
 * and needs no transform at all. Frequency, seasonal adjustment, shape, lag,
 * decimals and unit therefore hang off each BINDING, never off the series — a
 * shared frequency is exactly how a monthly series gets compared to an annual
 * one as if they were the same number.
 *
 * THE SELECTION RULE (one slug per country per series key). A country resolves a
 * key to the MOST CURRENT source that carries it: the United States reads FRED
 * where FRED has the series, every other country falls back to the World Bank.
 * A key with no binding for a country produces NO row rather than a row that can
 * never fill — an indicator that exists only to render an em dash reads as "this
 * country has no inflation" when the truth is "we do not read that series for
 * it".
 */
import { CATEGORY_OF_SUBCATEGORY, type CategoryId, type SubcategoryId } from '@/features/economy/taxonomy';
import { COUNTRIES, type CountryRow } from '@/features/economy/countries';
import type {
  Country,
  EconomicIndicator,
  Frequency,
  Importance,
  SeasonalAdjustment,
  SourceId,
  ValueShape,
} from '@/features/economy/model';

// ---------------------------------------------------------------------------
// Country registry — the `Country` entity, resolved from the raw rows.
// ---------------------------------------------------------------------------

export const COUNTRY_LIST: readonly Country[] = COUNTRIES.map((c) => ({
  id: c.iso3,
  iso2: c.iso2,
  iso3: c.iso3,
  name: c.name,
  region: c.region,
  currency: c.currency,
  timezone: c.timezone,
}));

export const COUNTRY_BY_ISO2: Readonly<Record<string, Country>> = Object.fromEntries(
  COUNTRY_LIST.map((c) => [c.iso2, c]),
);

export const COUNTRY_BY_ISO3: Readonly<Record<string, Country>> = Object.fromEntries(
  COUNTRY_LIST.map((c) => [c.id, c]),
);

/** Resolve a URL segment: accepts `us`, `US`, `USA`, `usa` — or nothing. */
export function countryByAnyCode(code: string): Country | null {
  const up = (code ?? '').trim().toUpperCase();
  if (up.length === 2) return COUNTRY_BY_ISO2[up] ?? null;
  if (up.length === 3) return COUNTRY_BY_ISO3[up] ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// The series table. One row = one canonical series key, with the bindings that
// can fill it. `fred` wins over `wb` for a country that carries both.
// ---------------------------------------------------------------------------

/** How one upstream's series is read and rendered. */
type Binding = {
  /** The upstream's own series key — the FRED id, the World Bank code. */
  id: string;
  frequency: Frequency;
  seasonalAdjustment: SeasonalAdjustment;
  shape: ValueShape;
  /** Periods to look back for a `yoy`; 0 when the shape does not need one. */
  lag: number;
  unit: string;
  decimals: number;
};

type SeriesDef = {
  /** Slug suffix. `<iso2-lower>-<key>`, e.g. `us-cpi`. */
  key: string;
  /** Display label; the indicator's name is `<country> <label>`. */
  label: string;
  category: CategoryId;
  subcategory: SubcategoryId;
  importance: Importance;
  note: string;
  /** US-preferred binding (FRED). Only ever bound for the United States. */
  fred?: Binding;
  /** Fallback / rest-of-world binding (World Bank). */
  wb?: Binding;
  /**
   * A series with no upstream of its own: the value is `legs[0] − legs[1]`,
   * published ONLY for a period both legs observe. The difference between a
   * 2024 revenue and a 2023 expense is not any year's balance, so a country
   * whose legs never share a year gets no row at all.
   */
  derive?: { legs: readonly [string, string]; frequency: Frequency; seasonalAdjustment: SeasonalAdjustment; unit: string; decimals: number };
};

const SERIES: readonly SeriesDef[] = [
  // -- Growth ---------------------------------------------------------------
  {
    key: 'gdp', label: 'GDP growth', category: 'growth', subcategory: 'gdp', importance: 3,
    note: 'Real gross domestic product, year over year',
    fred: { id: 'GDPC1', frequency: 'quarterly', seasonalAdjustment: 'SA', shape: 'yoy', lag: 4, unit: '% YoY', decimals: 2 },
    wb: { id: 'NY.GDP.MKTP.KD.ZG', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% YoY', decimals: 2 },
  },
  {
    key: 'gdp-nominal', label: 'GDP (nominal)', category: 'growth', subcategory: 'gdp', importance: 2,
    note: 'Gross domestic product, current US$',
    wb: { id: 'NY.GDP.MKTP.CD', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: 'US$', decimals: 0 },
  },
  {
    key: 'gdp-per-capita', label: 'GDP per capita', category: 'growth', subcategory: 'gdp-per-capita', importance: 2,
    note: 'GDP per capita, current US$',
    wb: { id: 'NY.GDP.PCAP.CD', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: 'US$', decimals: 0 },
  },
  {
    key: 'investment', label: 'Gross capital formation', category: 'growth', subcategory: 'investment', importance: 2,
    note: 'Gross capital formation, % of GDP — the investment share of output',
    wb: { id: 'NE.GDI.TOTL.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },
  {
    key: 'manufacturing', label: 'Manufacturing', category: 'growth', subcategory: 'manufacturing', importance: 2,
    note: 'Manufacturing value added, % of GDP',
    wb: { id: 'NV.IND.MANF.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },

  // -- Labor ----------------------------------------------------------------
  {
    key: 'unemployment', label: 'Unemployment', category: 'labor', subcategory: 'unemployment', importance: 3,
    note: 'Unemployment rate, % of the labour force',
    fred: { id: 'UNRATE', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'level', lag: 0, unit: '%', decimals: 1 },
    wb: { id: 'SL.UEM.TOTL.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '%', decimals: 2 },
  },
  {
    key: 'nonfarm-payrolls', label: 'Nonfarm payrolls', category: 'labor', subcategory: 'payrolls', importance: 3,
    note: 'Month-over-month change in total nonfarm payrolls, thousands',
    fred: { id: 'PAYEMS', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'change', lag: 1, unit: 'K MoM', decimals: 0 },
  },
  {
    key: 'jobless-claims', label: 'Initial jobless claims', category: 'labor', subcategory: 'jobless-claims', importance: 3,
    note: 'Initial unemployment insurance claims, weekly, in persons',
    fred: { id: 'ICSA', frequency: 'weekly', seasonalAdjustment: 'SA', shape: 'level', lag: 0, unit: 'claims', decimals: 0 },
  },
  {
    key: 'participation', label: 'Labour force participation', category: 'labor', subcategory: 'participation', importance: 2,
    note: 'Labour force participation rate, ages 15+, total',
    wb: { id: 'SL.TLF.CACT.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '%', decimals: 1 },
  },

  // -- Inflation ------------------------------------------------------------
  {
    key: 'cpi', label: 'CPI', category: 'inflation', subcategory: 'cpi', importance: 3,
    note: 'Consumer price index, all items, year over year',
    fred: { id: 'CPIAUCSL', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'yoy', lag: 12, unit: '% YoY', decimals: 2 },
    wb: { id: 'FP.CPI.TOTL.ZG', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% YoY', decimals: 2 },
  },
  {
    key: 'core-cpi', label: 'Core CPI', category: 'inflation', subcategory: 'core-cpi', importance: 3,
    note: 'CPI excluding food and energy, year over year',
    fred: { id: 'CPILFESL', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'yoy', lag: 12, unit: '% YoY', decimals: 2 },
  },
  {
    key: 'pce', label: 'PCE price index', category: 'inflation', subcategory: 'pce', importance: 3,
    note: 'Personal consumption expenditures price index, year over year',
    fred: { id: 'PCEPI', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'yoy', lag: 12, unit: '% YoY', decimals: 2 },
  },
  {
    key: 'core-pce', label: 'Core PCE', category: 'inflation', subcategory: 'core-pce', importance: 3,
    note: 'PCE excluding food and energy — the Federal Reserve’s preferred inflation gauge',
    fred: { id: 'PCEPILFE', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'yoy', lag: 12, unit: '% YoY', decimals: 2 },
  },

  // -- Monetary & money -----------------------------------------------------
  {
    key: 'm2', label: 'M2', category: 'monetary', subcategory: 'money-supply', importance: 3,
    note: 'M2 money stock, year over year',
    fred: { id: 'M2SL', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'yoy', lag: 12, unit: '% YoY', decimals: 2 },
  },
  {
    key: 'broad-money', label: 'Broad money', category: 'money', subcategory: 'broad-money', importance: 2,
    note: 'Broad money, % of GDP',
    wb: { id: 'FM.LBL.BMNY.GD.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },

  // -- Fiscal ---------------------------------------------------------------
  {
    key: 'gov-revenue', label: 'Government revenue', category: 'fiscal', subcategory: 'revenue', importance: 3,
    note: 'Government revenue excluding grants, % of GDP (IMF GFS via World Bank)',
    wb: { id: 'GC.REV.XGRT.GD.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },
  {
    key: 'gov-expense', label: 'Government expense', category: 'fiscal', subcategory: 'spending', importance: 3,
    note: 'Government expense, % of GDP (IMF GFS via World Bank)',
    wb: { id: 'GC.XPN.TOTL.GD.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },
  {
    key: 'deficit', label: 'Budget balance', category: 'fiscal', subcategory: 'deficit', importance: 3,
    note: 'Revenue minus expense, both legs read from the SAME year. Negative is a deficit.',
    derive: { legs: ['GC.REV.XGRT.GD.ZS', 'GC.XPN.TOTL.GD.ZS'], frequency: 'annual', seasonalAdjustment: 'NA', unit: '% GDP', decimals: 2 },
  },
  {
    key: 'tax-revenue', label: 'Tax revenue', category: 'fiscal', subcategory: 'revenue', importance: 2,
    note: 'Tax revenue, % of GDP',
    wb: { id: 'GC.TAX.TOTL.GD.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },
  {
    key: 'interest-payments', label: 'Interest payments', category: 'fiscal', subcategory: 'interest-payments', importance: 2,
    note: 'Interest payments, % of government revenue — the share of intake already committed to debt service',
    wb: { id: 'GC.XPN.INTP.RV.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% rev.', decimals: 1 },
  },

  // -- Trade ----------------------------------------------------------------
  {
    key: 'trade-openness', label: 'Trade openness', category: 'trade', subcategory: 'trade-openness', importance: 2,
    note: 'Exports plus imports of goods and services, % of GDP',
    wb: { id: 'NE.TRD.GNFS.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },
  {
    key: 'current-account', label: 'Current account', category: 'trade', subcategory: 'current-account', importance: 3,
    note: 'Current account balance, % of GDP (countries only upstream)',
    wb: { id: 'BN.CAB.XOKA.GD.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 2 },
  },
  {
    key: 'fdi', label: 'FDI inflows', category: 'trade', subcategory: 'fdi', importance: 2,
    note: 'Foreign direct investment, net inflows, % of GDP',
    wb: { id: 'BX.KLT.DINV.WD.GD.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 2 },
  },
  {
    key: 'reserves', label: 'Reserves', category: 'trade', subcategory: 'reserves', importance: 2,
    note: 'Total reserves including gold, current US$ (countries only upstream)',
    wb: { id: 'FI.RES.TOTL.CD', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: 'US$', decimals: 0 },
  },

  // -- Sentiment & credit ---------------------------------------------------
  {
    key: 'consumer-sentiment', label: 'Consumer sentiment', category: 'sentiment', subcategory: 'consumer-sentiment', importance: 2,
    note: 'University of Michigan consumer sentiment index',
    fred: { id: 'UMCSENT', frequency: 'monthly', seasonalAdjustment: 'NSA', shape: 'level', lag: 0, unit: 'index', decimals: 1 },
  },
  {
    key: 'term-spread', label: '10y − 2y spread', category: 'credit', subcategory: 'credit-spread', importance: 2,
    note: '10-year minus 2-year Treasury constant-maturity spread; negative = inverted',
    fred: { id: 'T10Y2Y', frequency: 'daily', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: 'pp', decimals: 2 },
  },
];

// ---------------------------------------------------------------------------
// Generate the canonical indicators. One row per (country, series) the country
// can actually fill, plus one per central bank for its policy rate.
// ---------------------------------------------------------------------------

function buildIndicator(country: CountryRow, def: SeriesDef): EconomicIndicator | null {
  // The most current source that carries the series wins. FRED is US-only.
  let source: SourceId;
  let binding: Binding | null = null;

  if (def.derive) {
    source = 'worldbank';
    binding = { id: `derived:${def.key}`, frequency: def.derive.frequency, seasonalAdjustment: def.derive.seasonalAdjustment, shape: 'level', lag: 0, unit: def.derive.unit, decimals: def.derive.decimals };
  } else if (def.fred && country.iso3 === 'USA') {
    source = 'fred';
    binding = def.fred;
  } else if (def.wb) {
    source = 'worldbank';
    binding = def.wb;
  } else {
    return null;
  }

  return {
    slug: `${country.iso2.toLowerCase()}-${def.key}`,
    name: `${country.name} ${def.label}`,
    country: country.iso3,
    category: def.category,
    subcategory: def.subcategory,
    unit: binding.unit,
    frequency: binding.frequency,
    seasonalAdjustment: binding.seasonalAdjustment,
    source,
    sourceSeriesId: binding.id,
    importance: def.importance,
    decimals: binding.decimals,
    shape: binding.shape,
    lag: binding.lag,
    note: def.note,
  };
}

/**
 * The legs behind a derived series, keyed by the slug suffix. Exported because
 * the ADAPTER — which lives in the route layer — must fetch both legs; the
 * provider codes stay out of `model.ts` so a view can never reach one.
 */
export const DERIVED_LEGS: Readonly<Record<string, readonly [string, string]>> = Object.fromEntries(
  SERIES.filter((s) => s.derive).map((s) => [s.key, s.derive!.legs]),
);

const SERIES_INDICATORS: readonly EconomicIndicator[] = COUNTRIES.flatMap((c) =>
  SERIES.map((d) => buildIndicator(c, d)).filter((x): x is EconomicIndicator => x !== null),
);

// ---------------------------------------------------------------------------
// Central banks (plan Phase 7).
//
// One row per monetary authority whose policy rate BIS actually carries on
// WS_CBPOL. `area` is the BIS reference area; the euro area resolves to `XM`,
// because the ECB — not a national central bank — sets the rate for its members.
// ---------------------------------------------------------------------------

export type CentralBank = {
  /** URL slug: `/economy/central-bank/<slug>`. */
  slug: string;
  /** Short name used in dense tables. */
  short: string;
  name: string;
  /** BIS WS_CBPOL reference area — the key the policy rate is fetched with. */
  area: string;
  /** ISO3 of the country it serves; null for a supranational authority (ECB). */
  country: string | null;
  region: string;
  note: string;
};

export const CENTRAL_BANKS: readonly CentralBank[] = [
  { slug: 'fed', short: 'Fed', name: 'Federal Reserve', area: 'US', country: 'USA', region: 'Americas', note: 'Federal Reserve target rate (upper bound)' },
  { slug: 'boc', short: 'BoC', name: 'Bank of Canada', area: 'CA', country: 'CAN', region: 'Americas', note: 'Bank of Canada overnight target' },
  { slug: 'bcb', short: 'BCB', name: 'Banco Central do Brasil', area: 'BR', country: 'BRA', region: 'Americas', note: 'Banco Central do Brasil Selic target' },
  { slug: 'banxico', short: 'Banxico', name: 'Banco de México', area: 'MX', country: 'MEX', region: 'Americas', note: 'Banco de México overnight target' },
  { slug: 'bcch', short: 'BCCh', name: 'Banco Central de Chile', area: 'CL', country: 'CHL', region: 'Americas', note: 'Banco Central de Chile policy rate' },
  { slug: 'banrep', short: 'BanRep', name: 'Banco de la República', area: 'CO', country: 'COL', region: 'Americas', note: 'Banco de la República policy rate' },
  { slug: 'bcrp', short: 'BCRP', name: 'Banco Central de Reserva del Perú', area: 'PE', country: 'PER', region: 'Americas', note: 'Banco Central de Reserva del Perú reference rate' },
  { slug: 'ecb', short: 'ECB', name: 'European Central Bank', area: 'XM', country: null, region: 'Europe', note: 'ECB deposit facility rate' },
  { slug: 'boe', short: 'BoE', name: 'Bank of England', area: 'GB', country: 'GBR', region: 'Europe', note: 'Bank of England Bank Rate' },
  { slug: 'snb', short: 'SNB', name: 'Swiss National Bank', area: 'CH', country: 'CHE', region: 'Europe', note: 'Swiss National Bank policy rate' },
  { slug: 'riksbank', short: 'Riksbank', name: 'Sveriges Riksbank', area: 'SE', country: 'SWE', region: 'Europe', note: 'Sveriges Riksbank policy rate' },
  { slug: 'norges', short: 'Norges', name: 'Norges Bank', area: 'NO', country: 'NOR', region: 'Europe', note: 'Norges Bank policy rate' },
  { slug: 'nationalbanken', short: 'Nationalbanken', name: 'Danmarks Nationalbank', area: 'DK', country: 'DNK', region: 'Europe', note: 'Danmarks Nationalbank certificate rate' },
  { slug: 'nbp', short: 'NBP', name: 'Narodowy Bank Polski', area: 'PL', country: 'POL', region: 'Europe', note: 'Narodowy Bank Polski reference rate' },
  { slug: 'cnb', short: 'CNB', name: 'Česká národní banka', area: 'CZ', country: 'CZE', region: 'Europe', note: 'Česká národní banka 2-week repo rate' },
  { slug: 'mnb', short: 'MNB', name: 'Magyar Nemzeti Bank', area: 'HU', country: 'HUN', region: 'Europe', note: 'Magyar Nemzeti Bank base rate' },
  { slug: 'bnr', short: 'BNR', name: 'Banca Națională a României', area: 'RO', country: 'ROU', region: 'Europe', note: 'Banca Națională a României policy rate' },
  { slug: 'nbs', short: 'NBS', name: 'Narodna banka Srbije', area: 'RS', country: 'SRB', region: 'Europe', note: 'Narodna banka Srbije reference rate' },
  { slug: 'cbi', short: 'CBI', name: 'Central Bank of Iceland', area: 'IS', country: 'ISL', region: 'Europe', note: 'Central Bank of Iceland policy rate' },
  { slug: 'cbr', short: 'CBR', name: 'Bank of Russia', area: 'RU', country: 'RUS', region: 'Europe', note: 'Bank of Russia key rate' },
  { slug: 'cbrt', short: 'CBRT', name: 'Central Bank of the Republic of Türkiye', area: 'TR', country: 'TUR', region: 'Europe', note: 'CBRT one-week repo rate' },
  { slug: 'boj', short: 'BoJ', name: 'Bank of Japan', area: 'JP', country: 'JPN', region: 'Asia-Pacific', note: 'Bank of Japan policy rate' },
  { slug: 'pboc', short: 'PBoC', name: 'People’s Bank of China', area: 'CN', country: 'CHN', region: 'Asia-Pacific', note: 'People’s Bank of China policy rate' },
  { slug: 'bok', short: 'BoK', name: 'Bank of Korea', area: 'KR', country: 'KOR', region: 'Asia-Pacific', note: 'Bank of Korea base rate (reports monthly)' },
  { slug: 'bi', short: 'BI', name: 'Bank Indonesia', area: 'ID', country: 'IDN', region: 'Asia-Pacific', note: 'Bank Indonesia BI-Rate' },
  { slug: 'bot', short: 'BoT', name: 'Bank of Thailand', area: 'TH', country: 'THA', region: 'Asia-Pacific', note: 'Bank of Thailand policy rate' },
  { slug: 'bnm', short: 'BNM', name: 'Bank Negara Malaysia', area: 'MY', country: 'MYS', region: 'Asia-Pacific', note: 'Bank Negara Malaysia overnight policy rate' },
  { slug: 'bsp', short: 'BSP', name: 'Bangko Sentral ng Pilipinas', area: 'PH', country: 'PHL', region: 'Asia-Pacific', note: 'Bangko Sentral ng Pilipinas target rate' },
  { slug: 'hkma', short: 'HKMA', name: 'Hong Kong Monetary Authority', area: 'HK', country: 'HKG', region: 'Asia-Pacific', note: 'HKMA base rate' },
  { slug: 'rba', short: 'RBA', name: 'Reserve Bank of Australia', area: 'AU', country: 'AUS', region: 'Asia-Pacific', note: 'Reserve Bank of Australia cash rate' },
  { slug: 'rbnz', short: 'RBNZ', name: 'Reserve Bank of New Zealand', area: 'NZ', country: 'NZL', region: 'Asia-Pacific', note: 'Reserve Bank of New Zealand OCR' },
  { slug: 'sarb', short: 'SARB', name: 'South African Reserve Bank', area: 'ZA', country: 'ZAF', region: 'Africa & Middle East', note: 'South African Reserve Bank repo rate' },
  { slug: 'sama', short: 'SAMA', name: 'Saudi Central Bank', area: 'SA', country: 'SAU', region: 'Africa & Middle East', note: 'Saudi Central Bank repo rate' },
];

export const CENTRAL_BANK_BY_SLUG: Readonly<Record<string, CentralBank>> = Object.fromEntries(
  CENTRAL_BANKS.map((b) => [b.slug, b]),
);

export const CENTRAL_BANK_BY_AREA: Readonly<Record<string, CentralBank>> = Object.fromEntries(
  CENTRAL_BANKS.map((b) => [b.area, b]),
);

/**
 * One `policy-rate` indicator per central bank. The slug is keyed on the BIS
 * AREA, not the country, because the euro area's rate belongs to the ECB and not
 * to any one member state — `xm-policy-rate` is the only slug that is true for
 * all twenty of them.
 */
export const POLICY_RATE_INDICATORS: readonly EconomicIndicator[] = CENTRAL_BANKS.map((b) => ({
  slug: `${b.area.toLowerCase()}-policy-rate`,
  name: `${b.name} policy rate`,
  country: b.country,
  category: 'monetary',
  subcategory: 'policy-rate',
  unit: '%',
  frequency: 'daily',
  seasonalAdjustment: 'NA',
  source: 'bis',
  sourceSeriesId: b.area,
  importance: 3,
  decimals: 2,
  shape: 'level',
  lag: 0,
  note: b.note,
}));

export const INDICATORS: readonly EconomicIndicator[] = [...SERIES_INDICATORS, ...POLICY_RATE_INDICATORS];

export const INDICATOR_BY_SLUG: Readonly<Record<string, EconomicIndicator>> = Object.fromEntries(
  INDICATORS.map((i) => [i.slug, i]),
);

/** Every indicator for one country, in series-table order, policy rate last. */
export function indicatorsForCountry(iso3: string): EconomicIndicator[] {
  return INDICATORS.filter((i) => i.country === iso3);
}

/** Every indicator in one category, optionally narrowed to one country. */
export function indicatorsForCategory(category: CategoryId, iso3?: string): EconomicIndicator[] {
  return INDICATORS.filter((i) => i.category === category && (iso3 === undefined || i.country === iso3));
}

/** The category a subcategory resolves to — used by the explorer's filters. */
export function categoryOf(subcategory: SubcategoryId): CategoryId {
  return CATEGORY_OF_SUBCATEGORY[subcategory];
}

/** The `policy-rate` slug for a country, when it has a central bank we track. */
export function policyRateSlug(iso3: string): string | null {
  const bank = CENTRAL_BANKS.find((b) => b.country === iso3);
  return bank ? `${bank.area.toLowerCase()}-policy-rate` : null;
}
