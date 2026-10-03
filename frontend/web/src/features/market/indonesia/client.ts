/**
 * Indonesia macro family (keyless, public) — the contract behind
 * `/api/market/indonesia` and the landing page's "Indonesia" panel.
 *
 * Three upstreams, each covering a different time horizon:
 *
 *  - Yahoo Finance chart — LIVE: the rupiah crosses and the two headline IDX
 *    indices. Same endpoint as the stock/commodity families (one call per symbol).
 *  - BIS WS_CBPOL — the BI-Rate, the policy rate everything else here prices off.
 *  - World Bank — ANNUAL structural indicators. These lag by design (a 2025 figure
 *    is published in 2026), so the year is carried on every row and the UI prints
 *    it; an annual number without its year reads as current when it is not.
 *
 * Every symbol and indicator below was verified live against its upstream.
 */
import { QUOTE_TTL_MS } from '@/features/market/quotes';

// ---- live: rupiah crosses + IDX indices (Yahoo) -----------------------------

export type IdrQuoteSpec = { symbol: string; label: string; group: 'Rupiah' | 'IDX'; note: string };

export const IDR_QUOTES: readonly IdrQuoteSpec[] = [
  { symbol: 'IDR=X', label: 'USD/IDR', group: 'Rupiah', note: 'US dollar in rupiah' },
  { symbol: 'EURIDR=X', label: 'EUR/IDR', group: 'Rupiah', note: 'Euro in rupiah' },
  { symbol: 'JPYIDR=X', label: 'JPY/IDR', group: 'Rupiah', note: 'Japanese yen in rupiah' },
  { symbol: 'CNYIDR=X', label: 'CNY/IDR', group: 'Rupiah', note: 'Chinese yuan in rupiah' },
  { symbol: '^JKSE', label: 'IDX Composite (IHSG)', group: 'IDX', note: 'Jakarta Composite Index' },
  { symbol: '^JKLQ45', label: 'IDX LQ45', group: 'IDX', note: 'IDX LQ45 — 45 most liquid listings' },
];

export const IDR_QUOTE_SYMBOLS = IDR_QUOTES.map((q) => q.symbol);

export const IDR_QUOTE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  IDR_QUOTES.map((q) => [q.symbol, q.label]),
);

export const IDR_QUOTE_NOTES: Readonly<Record<string, string>> = Object.fromEntries(
  IDR_QUOTES.map((q) => [q.symbol, q.note]),
);

export const IDR_QUOTE_TTL_MS = QUOTE_TTL_MS;

// ---- policy rate: the BI-Rate (BIS WS_CBPOL) --------------------------------

/** BIS reference-area code for Indonesia. */
export const ID_POLICY_AREA = 'ID';

/** How the BI-Rate row is labelled. */
export const ID_POLICY_LABEL = 'Bank Indonesia — BI-Rate';

// ---- economy: annual structural indicators (World Bank) ---------------------

/** ISO3 code the World Bank call is scoped to. */
export const ID_COUNTRY = 'IDN';

/** Earliest year to accept; the newest non-null observation wins. */
export const ID_ECONOMY_FROM_YEAR = 2015;

export type IdEconomyGroup = 'Growth & output' | 'Prices & labour' | 'External' | 'Social';

/** How a value is rendered. `usd`/`count` are compacted; the rest are plain. */
export type IdValueKind = 'usd' | 'count' | 'pct' | 'index' | 'years';

export type IdEconomySpec = {
  id: string;
  name: string;
  group: IdEconomyGroup;
  kind: IdValueKind;
  decimals: number;
  note: string;
};

export const ID_ECONOMY: readonly IdEconomySpec[] = [
  // --- growth & output ---
  { id: 'NY.GDP.MKTP.KD.ZG', name: 'GDP growth', group: 'Growth & output', kind: 'pct', decimals: 2, note: 'Annual real GDP growth' },
  { id: 'NY.GDP.MKTP.CD', name: 'GDP (nominal)', group: 'Growth & output', kind: 'usd', decimals: 0, note: 'Gross domestic product, current US$' },
  { id: 'NY.GDP.MKTP.KD', name: 'GDP (constant)', group: 'Growth & output', kind: 'usd', decimals: 0, note: 'GDP at constant 2015 US$' },
  { id: 'NY.GDP.PCAP.CD', name: 'GDP per capita', group: 'Growth & output', kind: 'usd', decimals: 0, note: 'GDP per capita, current US$' },
  { id: 'SP.POP.TOTL', name: 'Population', group: 'Growth & output', kind: 'count', decimals: 0, note: 'Total population' },
  // --- prices & labour ---
  { id: 'FP.CPI.TOTL.ZG', name: 'Inflation', group: 'Prices & labour', kind: 'pct', decimals: 2, note: 'Consumer prices, annual %' },
  { id: 'SL.UEM.TOTL.ZS', name: 'Unemployment', group: 'Prices & labour', kind: 'pct', decimals: 2, note: 'Unemployment, total (% of labour force, ILO estimate)' },
  { id: 'SL.TLF.CACT.ZS', name: 'Labour participation', group: 'Prices & labour', kind: 'pct', decimals: 2, note: 'Labour force participation rate, 15+' },
  { id: 'FR.INR.LEND', name: 'Lending rate', group: 'Prices & labour', kind: 'pct', decimals: 2, note: 'Commercial bank lending rate' },
  // --- external ---
  { id: 'FI.RES.TOTL.CD', name: 'FX reserves', group: 'External', kind: 'usd', decimals: 0, note: 'Total reserves including gold, current US$' },
  { id: 'BN.CAB.XOKA.GD.ZS', name: 'Current account', group: 'External', kind: 'pct', decimals: 2, note: 'Current account balance, % of GDP' },
  { id: 'NE.EXP.GNFS.ZS', name: 'Exports', group: 'External', kind: 'pct', decimals: 2, note: 'Exports of goods and services, % of GDP' },
  { id: 'NE.TRD.GNFS.ZS', name: 'Trade', group: 'External', kind: 'pct', decimals: 2, note: 'Trade (exports + imports), % of GDP' },
  { id: 'DT.DOD.DECT.GN.ZS', name: 'External debt', group: 'External', kind: 'pct', decimals: 2, note: 'External debt stocks, % of GNI' },
  { id: 'BX.KLT.DINV.CD.WD', name: 'FDI inflow', group: 'External', kind: 'usd', decimals: 0, note: 'Foreign direct investment, net inflows, current US$' },
  // --- social ---
  { id: 'SI.POV.GINI', name: 'Gini index', group: 'Social', kind: 'index', decimals: 1, note: 'Gini index (0 = perfect equality, 100 = perfect inequality)' },
  { id: 'SP.DYN.LE00.IN', name: 'Life expectancy', group: 'Social', kind: 'years', decimals: 1, note: 'Life expectancy at birth, total' },
  { id: 'IT.NET.USER.ZS', name: 'Internet users', group: 'Social', kind: 'pct', decimals: 1, note: 'Individuals using the internet, % of population' },
  { id: 'EG.ELC.ACCS.ZS', name: 'Electricity access', group: 'Social', kind: 'pct', decimals: 1, note: 'Access to electricity, % of population' },
];

export const ID_ECONOMY_IDS = ID_ECONOMY.map((e) => e.id);
