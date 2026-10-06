/** Economy central-bank domain: authorities and their policy-rate series. */
import type { EconomicIndicator } from './model-indicator';
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
