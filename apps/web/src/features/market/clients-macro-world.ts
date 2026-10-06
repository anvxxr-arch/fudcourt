/**
 * The worldwide economy board (World Bank, annual) — split out of `clients-macro.ts`.
 * Re-exported through `clients-macro.ts`; import from there.
 */
export * from './clients-macro-world-countries';
import { WORLD_COUNTRIES } from './clients-macro-world-countries';
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
  | 'Government finance'
  | 'Companies'
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
 * The derived budget-balance column's id. It has no upstream series of its own,
 * so it is not fetched: the route computes it from `BALANCE_LEGS` after both
 * legs land. The `derived:` prefix keeps it from ever colliding with a real
 * World Bank indicator code.
 */
export const BALANCE_ID = 'derived:balance';

/**
 * The two legs the balance is derived from, in `revenue − expense` order.
 * Net lending is negative, so a country spending more than it takes in shows a
 * negative balance — the sign is the convention, not a judgement.
 */
export const BALANCE_LEGS = ['GC.REV.XGRT.GD.ZS', 'GC.XPN.TOTL.GD.ZS'] as const;

/**
 * The 32 annual series the worldwide table carries — a country PROFILE, not a
 * two-line comparison. Array order is render order; `theme` groups the header.
 *
 * Every id here was measured against the live API across the WHOLE board (143
 * codes) before being included, and the ones that failed the measurement were
 * dropped rather than shipped as a mostly blank column: central-government debt
 * resolves for only 46 of the 125 countries, lending rate 36/50, stunting 31/50,
 * Gini 104/125, so none of those earns its width. The market series are the
 * thinnest that still clear the board's half-a-table rule — listed companies
 * 79/125 countries and 13/18 aggregates, stocks traded 76/125 and 11/18 — and
 * each of those still fills most of the 18 aggregates, so the aggregates table
 * does not lose a block. Where a series genuinely has no observation for a row,
 * that cell stays an em dash.
 *
 * One column is NOT a World Bank series: `BALANCE_ID` is derived by the route
 * from the revenue and expense legs, because the upstream's own cash-balance
 * series is archived and no longer served. See its note for why the legs must
 * share a year.
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

  // -- Government finance ---------------------------------------------------
  // The APBN block: what the state takes in, what it spends, the gap, and the
  // cost of servicing what it already owes. Revenue and expense are the IMF's
  // government-finance aggregates as the World Bank republishes them.
  { id: 'GC.REV.XGRT.GD.ZS', name: 'Government revenue', short: 'Revenue', kind: 'pct', decimals: 1, theme: 'Government finance', note: 'Revenue, excluding grants, % of GDP (IMF GFS via World Bank)' },
  { id: 'GC.XPN.TOTL.GD.ZS', name: 'Government expense', short: 'Expense', kind: 'pct', decimals: 1, theme: 'Government finance', note: 'Expense, % of GDP (IMF GFS via World Bank)' },
  { id: BALANCE_ID, name: 'Budget balance', short: 'Balance', kind: 'pct', decimals: 2, theme: 'Government finance', note: 'Revenue minus expense, both legs read from the SAME year — a difference between a 2024 revenue and a 2023 expense is not any year’s balance, so the route aligns the two series and publishes nothing for a country whose legs never share a year. Negative is a deficit.' },
  { id: 'GC.XPN.INTP.RV.ZS', name: 'Interest payments', short: 'Interest', kind: 'pct', decimals: 1, theme: 'Government finance', note: 'Interest payments, % of government revenue — the share of intake already committed to debt service' },

  // -- Companies ------------------------------------------------------------
  // The corporate sector as the market sizes it: how many firms are listed, how
  // much they are worth, how much they change hands, and how fast new ones form.
  { id: 'CM.MKT.LDOM.NO', name: 'Listed domestic companies', short: 'Listed cos.', kind: 'count', decimals: 0, theme: 'Companies', note: 'Listed domestic companies, total (countries only upstream)' },
  { id: 'CM.MKT.LCAP.CD', name: 'Market capitalisation', short: 'Market cap', kind: 'usd', decimals: 0, theme: 'Companies', note: 'Market capitalisation of listed domestic companies, current US$' },
  { id: 'CM.MKT.TRAD.CD', name: 'Stocks traded', short: 'Stocks traded', kind: 'usd', decimals: 0, theme: 'Companies', note: 'Stocks traded, total value, current US$ — turnover, not market size' },
  { id: 'IC.BUS.NDNS.ZS', name: 'New business density', short: 'Firm density', kind: 'per1k', decimals: 1, theme: 'Companies', note: 'New business registrations per 1,000 people aged 15-64' },

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
  'Government finance',
  'Companies',
  'Structure & sustainability',
];

/** Earliest year to accept for the annual comparison. */
export const ECONOMY_FROM_YEAR = 2015;
