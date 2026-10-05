/**
 * Global policy rates (BIS WS_CBPOL) — split out of `clients-macro.ts`.
 * Re-exported through `clients-macro.ts`; import from there.
 */
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
