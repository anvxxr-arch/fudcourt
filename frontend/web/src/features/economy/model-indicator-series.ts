/** Economy indicator domain: series table and derived series legs. */
import type { CategoryId, SubcategoryId } from './model-taxonomy';
import type { Frequency, Importance, SeasonalAdjustment, ValueShape } from './model-nation';

// ---------------------------------------------------------------------------
// The series table. One row = one canonical series key, with the bindings that
// can fill it. `fred` wins over `wb` for a country that carries both.
// ---------------------------------------------------------------------------

/** How one upstream's series is read and rendered. */
export type Binding = {
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

export type SeriesDef = {
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

export const SERIES: readonly SeriesDef[] = [
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
    // The money-supply input for the 124 countries whose M2 is not on FRED. It is
    // a GROWTH rate, not a level, because the regime engine reads the direction of
    // money growth: a rising nominal money stock is not "expanding liquidity" if
    // it is rising slower than before.
    key: 'money-growth', label: 'Broad money growth', category: 'monetary', subcategory: 'money-supply', importance: 2,
    note: 'Broad money growth, year over year',
    wb: { id: 'FM.LBL.BMNY.ZG', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% YoY', decimals: 2 },
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

/**
 * The legs behind a derived series, keyed by the slug suffix. Exported because
 * the ADAPTER — which lives in the route layer — must fetch both legs; the
 * provider codes stay out of `model.ts` so a view can never reach one.
 */
export const DERIVED_LEGS: Readonly<Record<string, readonly [string, string]>> = Object.fromEntries(
  SERIES.filter((s) => s.derive).map((s) => [s.key, s.derive!.legs]),
);
