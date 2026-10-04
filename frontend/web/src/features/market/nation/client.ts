/**
 * Nation family (keyless, public) — the contract behind `/economy/nation` and
 * `/api/market/nation/<code>`.
 *
 * ONE country, every block we can source about it, each labelled with the
 * upstream it came from and the horizon that upstream belongs to:
 *
 *  - World Bank (annual)     — the structural profile: the same 32 themed series
 *    the worldwide board carries, so a country page and that country's row on
 *    the board can never disagree about a number. Every cell keeps the year it
 *    was published FOR, because an annual figure printed without its year reads
 *    as current when it is not.
 *  - IMF Fiscal Monitor      — the government-finance block, ACTUALS ONLY (see
 *    `sources/imf.ts` for the publication-date boundary that produces them).
 *  - BIS WS_CBPOL (daily)    — the policy rate, for the countries BIS carries.
 *  - open.er-api.com (daily) — the currency against the dollar.
 *
 * WHY THE COUNTRY TABLE IS STATIC. A country page is a URL a reader types, so the
 * code has to resolve offline and deterministically — `/economy/nation/id` must be
 * a page, not a lookup that depends on an upstream being reachable. The 125 entries
 * below are exactly `WORLD_COUNTRIES` (the worldwide board's own allowlist), so the
 * two can never disagree about which countries exist; `iso2`, `currency` and
 * `capital` were taken from the World Bank country API and the ISO-4217 list, and
 * every currency was verified present in the exchangerate feed before shipping (a
 * currency the feed does not carry would render a live row that can never fill).
 *
 * `policyArea` is the BIS reference area for that country's policy rate. Most are
 * the ISO2 code; the euro-area members resolve to `XM`, because the ECB — not a
 * national bank — sets their rate, and a country BIS does not carry gets `null`
 * rather than a row that can never fill.
 */
import {
  BALANCE_ID,
  BALANCE_LEGS,
  ECONOMY_FROM_YEAR,
  ECONOMY_INDICATORS,
  WORLD_THEMES,
  type WorldIndicatorSpec,
  type WorldRegion,
  type WorldTheme,
} from '@/features/market/macro/client';
import { ID_APBN, ID_APBN_FROM_YEAR, type IdEconomySpec } from '@/features/market/indonesia/client';

/** The index that lists every country this family serves. */
export const NATION_INDEX_PATH = '/economy/nation';

/** One country: the URL keys, the identity, and the rate/currency wiring. */
export type NationSpec = {
  /** ISO 3166-1 alpha-3 — the code every upstream is keyed on. */
  code: string;
  /** ISO 3166-1 alpha-2 — the BIS area code and the canonical URL slug. */
  iso2: string;
  name: string;
  region: WorldRegion;
  /** ISO-4217 code the currency block quotes. */
  currency: string;
  /** World Bank income classification. */
  income: string;
  /** Capital city as the World Bank spells it; '' when it publishes none. */
  capital: string;
  /** BIS WS_CBPOL reference area, or null when BIS carries no rate for it. */
  policyArea: string | null;
};

/**
 * The 125 economies, in the worldwide board's order and grouped by the same
 * regions, so the index reads the same way the board does.
 */
export const NATIONS: readonly NationSpec[] = [
  // --- Americas ---
  { code: 'USA', iso2: 'US', name: 'United States', region: 'Americas', currency: 'USD', income: 'High income', capital: 'Washington D.C.', policyArea: 'US' },
  { code: 'CAN', iso2: 'CA', name: 'Canada', region: 'Americas', currency: 'CAD', income: 'High income', capital: 'Ottawa', policyArea: 'CA' },
  { code: 'MEX', iso2: 'MX', name: 'Mexico', region: 'Americas', currency: 'MXN', income: 'Upper middle income', capital: 'Mexico City', policyArea: 'MX' },
  { code: 'BRA', iso2: 'BR', name: 'Brazil', region: 'Americas', currency: 'BRL', income: 'Upper middle income', capital: 'Brasilia', policyArea: 'BR' },
  { code: 'ARG', iso2: 'AR', name: 'Argentina', region: 'Americas', currency: 'ARS', income: 'Upper middle income', capital: 'Buenos Aires', policyArea: null },
  { code: 'COL', iso2: 'CO', name: 'Colombia', region: 'Americas', currency: 'COP', income: 'Upper middle income', capital: 'Bogota', policyArea: 'CO' },
  { code: 'CHL', iso2: 'CL', name: 'Chile', region: 'Americas', currency: 'CLP', income: 'High income', capital: 'Santiago', policyArea: 'CL' },
  { code: 'PER', iso2: 'PE', name: 'Peru', region: 'Americas', currency: 'PEN', income: 'Upper middle income', capital: 'Lima', policyArea: 'PE' },
  { code: 'DOM', iso2: 'DO', name: 'Dominican Republic', region: 'Americas', currency: 'DOP', income: 'Upper middle income', capital: 'Santo Domingo', policyArea: null },
  { code: 'GTM', iso2: 'GT', name: 'Guatemala', region: 'Americas', currency: 'GTQ', income: 'Upper middle income', capital: 'Guatemala City', policyArea: null },
  { code: 'URY', iso2: 'UY', name: 'Uruguay', region: 'Americas', currency: 'UYU', income: 'High income', capital: 'Montevideo', policyArea: null },
  { code: 'PRY', iso2: 'PY', name: 'Paraguay', region: 'Americas', currency: 'PYG', income: 'Upper middle income', capital: 'Asuncion', policyArea: null },
  { code: 'ECU', iso2: 'EC', name: 'Ecuador', region: 'Americas', currency: 'USD', income: 'Upper middle income', capital: 'Quito', policyArea: null },
  { code: 'BOL', iso2: 'BO', name: 'Bolivia', region: 'Americas', currency: 'BOB', income: 'Lower middle income', capital: 'La Paz', policyArea: null },
  { code: 'PAN', iso2: 'PA', name: 'Panama', region: 'Americas', currency: 'PAB', income: 'High income', capital: 'Panama City', policyArea: null },
  { code: 'CRI', iso2: 'CR', name: 'Costa Rica', region: 'Americas', currency: 'CRC', income: 'High income', capital: 'San Jose', policyArea: null },
  { code: 'TTO', iso2: 'TT', name: 'Trinidad and Tobago', region: 'Americas', currency: 'TTD', income: 'High income', capital: 'Port-of-Spain', policyArea: null },
  { code: 'JAM', iso2: 'JM', name: 'Jamaica', region: 'Americas', currency: 'JMD', income: 'Upper middle income', capital: 'Kingston', policyArea: null },
  // --- Europe ---
  { code: 'DEU', iso2: 'DE', name: 'Germany', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Berlin', policyArea: 'XM' },
  { code: 'GBR', iso2: 'GB', name: 'United Kingdom', region: 'Europe', currency: 'GBP', income: 'High income', capital: 'London', policyArea: 'GB' },
  { code: 'FRA', iso2: 'FR', name: 'France', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Paris', policyArea: 'XM' },
  { code: 'ITA', iso2: 'IT', name: 'Italy', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Rome', policyArea: 'XM' },
  { code: 'ESP', iso2: 'ES', name: 'Spain', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Madrid', policyArea: 'XM' },
  { code: 'NLD', iso2: 'NL', name: 'Netherlands', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Amsterdam', policyArea: 'XM' },
  { code: 'CHE', iso2: 'CH', name: 'Switzerland', region: 'Europe', currency: 'CHF', income: 'High income', capital: 'Bern', policyArea: 'CH' },
  { code: 'SWE', iso2: 'SE', name: 'Sweden', region: 'Europe', currency: 'SEK', income: 'High income', capital: 'Stockholm', policyArea: 'SE' },
  { code: 'POL', iso2: 'PL', name: 'Poland', region: 'Europe', currency: 'PLN', income: 'High income', capital: 'Warsaw', policyArea: 'PL' },
  { code: 'TUR', iso2: 'TR', name: 'Türkiye', region: 'Europe', currency: 'TRY', income: 'Upper middle income', capital: 'Ankara', policyArea: 'TR' },
  { code: 'RUS', iso2: 'RU', name: 'Russia', region: 'Europe', currency: 'RUB', income: 'High income', capital: 'Moscow', policyArea: 'RU' },
  { code: 'NOR', iso2: 'NO', name: 'Norway', region: 'Europe', currency: 'NOK', income: 'High income', capital: 'Oslo', policyArea: 'NO' },
  { code: 'FIN', iso2: 'FI', name: 'Finland', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Helsinki', policyArea: 'XM' },
  { code: 'IRL', iso2: 'IE', name: 'Ireland', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Dublin', policyArea: 'XM' },
  { code: 'PRT', iso2: 'PT', name: 'Portugal', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Lisbon', policyArea: 'XM' },
  { code: 'GRC', iso2: 'GR', name: 'Greece', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Athens', policyArea: 'XM' },
  { code: 'AUT', iso2: 'AT', name: 'Austria', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Vienna', policyArea: 'XM' },
  { code: 'BEL', iso2: 'BE', name: 'Belgium', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Brussels', policyArea: 'XM' },
  { code: 'CZE', iso2: 'CZ', name: 'Czechia', region: 'Europe', currency: 'CZK', income: 'High income', capital: 'Prague', policyArea: 'CZ' },
  { code: 'HUN', iso2: 'HU', name: 'Hungary', region: 'Europe', currency: 'HUF', income: 'High income', capital: 'Budapest', policyArea: 'HU' },
  { code: 'ROU', iso2: 'RO', name: 'Romania', region: 'Europe', currency: 'RON', income: 'High income', capital: 'Bucharest', policyArea: 'RO' },
  { code: 'UKR', iso2: 'UA', name: 'Ukraine', region: 'Europe', currency: 'UAH', income: 'Upper middle income', capital: 'Kiev', policyArea: null },
  { code: 'ISL', iso2: 'IS', name: 'Iceland', region: 'Europe', currency: 'ISK', income: 'High income', capital: 'Reykjavik', policyArea: 'IS' },
  { code: 'LUX', iso2: 'LU', name: 'Luxembourg', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Luxembourg', policyArea: 'XM' },
  { code: 'CYP', iso2: 'CY', name: 'Cyprus', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Nicosia', policyArea: 'XM' },
  { code: 'MLT', iso2: 'MT', name: 'Malta', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Valletta', policyArea: 'XM' },
  { code: 'SVK', iso2: 'SK', name: 'Slovakia', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Bratislava', policyArea: 'XM' },
  { code: 'SVN', iso2: 'SI', name: 'Slovenia', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Ljubljana', policyArea: 'XM' },
  { code: 'HRV', iso2: 'HR', name: 'Croatia', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Zagreb', policyArea: 'XM' },
  { code: 'BGR', iso2: 'BG', name: 'Bulgaria', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Sofia', policyArea: 'XM' },
  { code: 'LTU', iso2: 'LT', name: 'Lithuania', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Vilnius', policyArea: 'XM' },
  { code: 'LVA', iso2: 'LV', name: 'Latvia', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Riga', policyArea: 'XM' },
  { code: 'EST', iso2: 'EE', name: 'Estonia', region: 'Europe', currency: 'EUR', income: 'High income', capital: 'Tallinn', policyArea: 'XM' },
  { code: 'ALB', iso2: 'AL', name: 'Albania', region: 'Europe', currency: 'ALL', income: 'Upper middle income', capital: 'Tirane', policyArea: null },
  { code: 'MKD', iso2: 'MK', name: 'North Macedonia', region: 'Europe', currency: 'MKD', income: 'Upper middle income', capital: 'Skopje', policyArea: null },
  { code: 'BIH', iso2: 'BA', name: 'Bosnia and Herzegovina', region: 'Europe', currency: 'BAM', income: 'Upper middle income', capital: 'Sarajevo', policyArea: null },
  { code: 'SRB', iso2: 'RS', name: 'Serbia', region: 'Europe', currency: 'RSD', income: 'Upper middle income', capital: 'Belgrade', policyArea: 'RS' },
  { code: 'MNE', iso2: 'ME', name: 'Montenegro', region: 'Europe', currency: 'EUR', income: 'Upper middle income', capital: 'Podgorica', policyArea: 'XM' },
  { code: 'BLR', iso2: 'BY', name: 'Belarus', region: 'Europe', currency: 'BYN', income: 'Upper middle income', capital: 'Minsk', policyArea: null },
  { code: 'MDA', iso2: 'MD', name: 'Moldova', region: 'Europe', currency: 'MDL', income: 'Upper middle income', capital: 'Chisinau', policyArea: null },
  // --- Asia-Pacific ---
  { code: 'CHN', iso2: 'CN', name: 'China', region: 'Asia-Pacific', currency: 'CNY', income: 'Upper middle income', capital: 'Beijing', policyArea: 'CN' },
  { code: 'JPN', iso2: 'JP', name: 'Japan', region: 'Asia-Pacific', currency: 'JPY', income: 'High income', capital: 'Tokyo', policyArea: 'JP' },
  { code: 'IND', iso2: 'IN', name: 'India', region: 'Asia-Pacific', currency: 'INR', income: 'Lower middle income', capital: 'New Delhi', policyArea: null },
  { code: 'KOR', iso2: 'KR', name: 'South Korea', region: 'Asia-Pacific', currency: 'KRW', income: 'High income', capital: 'Seoul', policyArea: 'KR' },
  { code: 'IDN', iso2: 'ID', name: 'Indonesia', region: 'Asia-Pacific', currency: 'IDR', income: 'Upper middle income', capital: 'Jakarta', policyArea: 'ID' },
  { code: 'AUS', iso2: 'AU', name: 'Australia', region: 'Asia-Pacific', currency: 'AUD', income: 'High income', capital: 'Canberra', policyArea: 'AU' },
  { code: 'THA', iso2: 'TH', name: 'Thailand', region: 'Asia-Pacific', currency: 'THB', income: 'Upper middle income', capital: 'Bangkok', policyArea: 'TH' },
  { code: 'VNM', iso2: 'VN', name: 'Vietnam', region: 'Asia-Pacific', currency: 'VND', income: 'Upper middle income', capital: 'Hanoi', policyArea: null },
  { code: 'MYS', iso2: 'MY', name: 'Malaysia', region: 'Asia-Pacific', currency: 'MYR', income: 'Upper middle income', capital: 'Kuala Lumpur', policyArea: 'MY' },
  { code: 'PHL', iso2: 'PH', name: 'Philippines', region: 'Asia-Pacific', currency: 'PHP', income: 'Upper middle income', capital: 'Manila', policyArea: 'PH' },
  { code: 'SGP', iso2: 'SG', name: 'Singapore', region: 'Asia-Pacific', currency: 'SGD', income: 'High income', capital: 'Singapore', policyArea: null },
  { code: 'PAK', iso2: 'PK', name: 'Pakistan', region: 'Asia-Pacific', currency: 'PKR', income: 'Lower middle income', capital: 'Islamabad', policyArea: null },
  { code: 'BGD', iso2: 'BD', name: 'Bangladesh', region: 'Asia-Pacific', currency: 'BDT', income: 'Lower middle income', capital: 'Dhaka', policyArea: null },
  { code: 'LKA', iso2: 'LK', name: 'Sri Lanka', region: 'Asia-Pacific', currency: 'LKR', income: 'Upper middle income', capital: 'Colombo', policyArea: null },
  { code: 'NPL', iso2: 'NP', name: 'Nepal', region: 'Asia-Pacific', currency: 'NPR', income: 'Lower middle income', capital: 'Kathmandu', policyArea: null },
  { code: 'MMR', iso2: 'MM', name: 'Myanmar', region: 'Asia-Pacific', currency: 'MMK', income: 'Lower middle income', capital: 'Naypyidaw', policyArea: null },
  { code: 'KHM', iso2: 'KH', name: 'Cambodia', region: 'Asia-Pacific', currency: 'KHR', income: 'Lower middle income', capital: 'Phnom Penh', policyArea: null },
  { code: 'MNG', iso2: 'MN', name: 'Mongolia', region: 'Asia-Pacific', currency: 'MNT', income: 'Upper middle income', capital: 'Ulaanbaatar', policyArea: null },
  { code: 'NZL', iso2: 'NZ', name: 'New Zealand', region: 'Asia-Pacific', currency: 'NZD', income: 'High income', capital: 'Wellington', policyArea: 'NZ' },
  { code: 'HKG', iso2: 'HK', name: 'Hong Kong SAR', region: 'Asia-Pacific', currency: 'HKD', income: 'High income', capital: '', policyArea: 'HK' },
  { code: 'MAC', iso2: 'MO', name: 'Macao SAR', region: 'Asia-Pacific', currency: 'MOP', income: 'High income', capital: '', policyArea: null },
  { code: 'BRN', iso2: 'BN', name: 'Brunei', region: 'Asia-Pacific', currency: 'BND', income: 'High income', capital: 'Bandar Seri Begawan', policyArea: null },
  { code: 'FJI', iso2: 'FJ', name: 'Fiji', region: 'Asia-Pacific', currency: 'FJD', income: 'Upper middle income', capital: 'Suva', policyArea: null },
  { code: 'PNG', iso2: 'PG', name: 'Papua New Guinea', region: 'Asia-Pacific', currency: 'PGK', income: 'Lower middle income', capital: 'Port Moresby', policyArea: null },
  { code: 'KAZ', iso2: 'KZ', name: 'Kazakhstan', region: 'Asia-Pacific', currency: 'KZT', income: 'Upper middle income', capital: 'Astana', policyArea: null },
  { code: 'AZE', iso2: 'AZ', name: 'Azerbaijan', region: 'Asia-Pacific', currency: 'AZN', income: 'Upper middle income', capital: 'Baku', policyArea: null },
  { code: 'UZB', iso2: 'UZ', name: 'Uzbekistan', region: 'Asia-Pacific', currency: 'UZS', income: 'Lower middle income', capital: 'Tashkent', policyArea: null },
  { code: 'TKM', iso2: 'TM', name: 'Turkmenistan', region: 'Asia-Pacific', currency: 'TMT', income: 'Upper middle income', capital: 'Ashgabat', policyArea: null },
  { code: 'KGZ', iso2: 'KG', name: 'Kyrgyz Republic', region: 'Asia-Pacific', currency: 'KGS', income: 'Lower middle income', capital: 'Bishkek', policyArea: null },
  { code: 'TJK', iso2: 'TJ', name: 'Tajikistan', region: 'Asia-Pacific', currency: 'TJS', income: 'Lower middle income', capital: 'Dushanbe', policyArea: null },
  { code: 'GEO', iso2: 'GE', name: 'Georgia', region: 'Asia-Pacific', currency: 'GEL', income: 'Upper middle income', capital: 'Tbilisi', policyArea: null },
  { code: 'ARM', iso2: 'AM', name: 'Armenia', region: 'Asia-Pacific', currency: 'AMD', income: 'Upper middle income', capital: 'Yerevan', policyArea: null },
  // --- Africa & Middle East ---
  { code: 'SAU', iso2: 'SA', name: 'Saudi Arabia', region: 'Africa & Middle East', currency: 'SAR', income: 'High income', capital: 'Riyadh', policyArea: 'SA' },
  { code: 'ARE', iso2: 'AE', name: 'United Arab Emirates', region: 'Africa & Middle East', currency: 'AED', income: 'High income', capital: 'Abu Dhabi', policyArea: null },
  { code: 'ISR', iso2: 'IL', name: 'Israel', region: 'Africa & Middle East', currency: 'ILS', income: 'High income', capital: '', policyArea: null },
  { code: 'QAT', iso2: 'QA', name: 'Qatar', region: 'Africa & Middle East', currency: 'QAR', income: 'High income', capital: 'Doha', policyArea: null },
  { code: 'KWT', iso2: 'KW', name: 'Kuwait', region: 'Africa & Middle East', currency: 'KWD', income: 'High income', capital: 'Kuwait City', policyArea: null },
  { code: 'IRQ', iso2: 'IQ', name: 'Iraq', region: 'Africa & Middle East', currency: 'IQD', income: 'Upper middle income', capital: 'Baghdad', policyArea: null },
  { code: 'IRN', iso2: 'IR', name: 'Iran', region: 'Africa & Middle East', currency: 'IRR', income: 'Upper middle income', capital: 'Tehran', policyArea: null },
  { code: 'JOR', iso2: 'JO', name: 'Jordan', region: 'Africa & Middle East', currency: 'JOD', income: 'Upper middle income', capital: 'Amman', policyArea: null },
  { code: 'OMN', iso2: 'OM', name: 'Oman', region: 'Africa & Middle East', currency: 'OMR', income: 'High income', capital: 'Muscat', policyArea: null },
  { code: 'BHR', iso2: 'BH', name: 'Bahrain', region: 'Africa & Middle East', currency: 'BHD', income: 'High income', capital: 'Manama', policyArea: null },
  { code: 'EGY', iso2: 'EG', name: 'Egypt', region: 'Africa & Middle East', currency: 'EGP', income: 'Lower middle income', capital: 'Cairo', policyArea: null },
  { code: 'ZAF', iso2: 'ZA', name: 'South Africa', region: 'Africa & Middle East', currency: 'ZAR', income: 'Upper middle income', capital: 'Pretoria', policyArea: 'ZA' },
  { code: 'NGA', iso2: 'NG', name: 'Nigeria', region: 'Africa & Middle East', currency: 'NGN', income: 'Lower middle income', capital: 'Abuja', policyArea: null },
  { code: 'KEN', iso2: 'KE', name: 'Kenya', region: 'Africa & Middle East', currency: 'KES', income: 'Lower middle income', capital: 'Nairobi', policyArea: null },
  { code: 'ETH', iso2: 'ET', name: 'Ethiopia', region: 'Africa & Middle East', currency: 'ETB', income: 'Low income', capital: 'Addis Ababa', policyArea: null },
  { code: 'MAR', iso2: 'MA', name: 'Morocco', region: 'Africa & Middle East', currency: 'MAD', income: 'Lower middle income', capital: 'Rabat', policyArea: null },
  { code: 'DZA', iso2: 'DZ', name: 'Algeria', region: 'Africa & Middle East', currency: 'DZD', income: 'Upper middle income', capital: 'Algiers', policyArea: null },
  { code: 'TZA', iso2: 'TZ', name: 'Tanzania', region: 'Africa & Middle East', currency: 'TZS', income: 'Lower middle income', capital: 'Dodoma', policyArea: null },
  { code: 'UGA', iso2: 'UG', name: 'Uganda', region: 'Africa & Middle East', currency: 'UGX', income: 'Low income', capital: 'Kampala', policyArea: null },
  { code: 'GHA', iso2: 'GH', name: 'Ghana', region: 'Africa & Middle East', currency: 'GHS', income: 'Lower middle income', capital: 'Accra', policyArea: null },
  { code: 'CIV', iso2: 'CI', name: 'Côte d’Ivoire', region: 'Africa & Middle East', currency: 'XOF', income: 'Lower middle income', capital: 'Yamoussoukro', policyArea: null },
  { code: 'SEN', iso2: 'SN', name: 'Senegal', region: 'Africa & Middle East', currency: 'XOF', income: 'Lower middle income', capital: 'Dakar', policyArea: null },
  { code: 'TUN', iso2: 'TN', name: 'Tunisia', region: 'Africa & Middle East', currency: 'TND', income: 'Lower middle income', capital: 'Tunis', policyArea: null },
  { code: 'BWA', iso2: 'BW', name: 'Botswana', region: 'Africa & Middle East', currency: 'BWP', income: 'Upper middle income', capital: 'Gaborone', policyArea: null },
  { code: 'NAM', iso2: 'NA', name: 'Namibia', region: 'Africa & Middle East', currency: 'NAD', income: 'Lower middle income', capital: 'Windhoek', policyArea: null },
  { code: 'ZMB', iso2: 'ZM', name: 'Zambia', region: 'Africa & Middle East', currency: 'ZMW', income: 'Lower middle income', capital: 'Lusaka', policyArea: null },
  { code: 'ZWE', iso2: 'ZW', name: 'Zimbabwe', region: 'Africa & Middle East', currency: 'ZWG', income: 'Lower middle income', capital: 'Harare', policyArea: null },
  { code: 'CMR', iso2: 'CM', name: 'Cameroon', region: 'Africa & Middle East', currency: 'XAF', income: 'Lower middle income', capital: 'Yaounde', policyArea: null },
  { code: 'MOZ', iso2: 'MZ', name: 'Mozambique', region: 'Africa & Middle East', currency: 'MZN', income: 'Low income', capital: 'Maputo', policyArea: null },
  { code: 'AGO', iso2: 'AO', name: 'Angola', region: 'Africa & Middle East', currency: 'AOA', income: 'Lower middle income', capital: 'Luanda', policyArea: null },
  { code: 'SDN', iso2: 'SD', name: 'Sudan', region: 'Africa & Middle East', currency: 'SDG', income: 'Low income', capital: 'Khartoum', policyArea: null },
  { code: 'LBY', iso2: 'LY', name: 'Libya', region: 'Africa & Middle East', currency: 'LYD', income: 'Upper middle income', capital: 'Tripoli', policyArea: null },
  { code: 'SYR', iso2: 'SY', name: 'Syria', region: 'Africa & Middle East', currency: 'SYP', income: 'Low income', capital: 'Damascus', policyArea: null },
  { code: 'YEM', iso2: 'YE', name: 'Yemen', region: 'Africa & Middle East', currency: 'YER', income: 'Low income', capital: 'Sana\'a', policyArea: null },
  { code: 'AFG', iso2: 'AF', name: 'Afghanistan', region: 'Africa & Middle East', currency: 'AFN', income: 'Low income', capital: 'Kabul', policyArea: null },
];

/**
 * ISO2 and ISO3 both resolve, because a reader types whichever they know. The two
 * namespaces cannot collide — alpha-2 is two characters and alpha-3 is three — so
 * one flat map is safe and needs no length check.
 */
const BY_CODE: ReadonlyMap<string, NationSpec> = new Map(
  NATIONS.flatMap((n) => [
    [n.code, n],
    [n.iso2, n],
  ])
);

/**
 * Resolve a URL segment to a country, case-insensitively. Returns null for
 * anything not on the list — the page turns that into a real 404 rather than a
 * 200 that renders an error table.
 */
export function nationByCode(raw: string): NationSpec | null {
  return BY_CODE.get((raw ?? '').trim().toUpperCase()) ?? null;
}

/** The canonical path for a country: lowercase alpha-2, e.g. `/economy/nation/id`. */
export function nationPath(n: NationSpec): string {
  return `${NATION_INDEX_PATH}/${n.iso2.toLowerCase()}`;
}

/** The country codes that appear in `sitemap.xml`. */
export const NATION_SLUGS: readonly string[] = NATIONS.map((n) => n.iso2.toLowerCase());

/**
 * The flag for a country, built from its alpha-2 code: the two letters as
 * regional indicator symbols, which is exactly how a flag sequence is defined,
 * so no per-country asset or lookup table is needed. Returns '' for anything
 * that is not two A-Z letters.
 */
export function nationFlag(iso2: string): string {
  if (!/^[A-Za-z]{2}$/.test(iso2)) return '';
  return String.fromCodePoint(...[...iso2.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// ---------------------------------------------------------------------------
// The blocks a country page renders.
//
// The indicator SPECS are not restated here: they are the worldwide board's own
// list (`ECONOMY_INDICATORS` / `WORLD_THEMES`) and the Indonesia family's IMF
// list (`ID_APBN`). A second copy would be free to drift from the board, and a
// country page that disagreed with the board's row for the same country would be
// worse than no page. Both modules are inside the `market` family, so importing
// them is not a cross-feature dependency.
// ---------------------------------------------------------------------------

/** The World Bank structural columns, in board order. */
export const NATION_INDICATORS: readonly WorldIndicatorSpec[] = ECONOMY_INDICATORS;

/** The column-block order the profile renders in. */
export const NATION_THEMES: readonly WorldTheme[] = WORLD_THEMES;

/** Earliest year accepted for the annual profile. */
export const NATION_FROM_YEAR = ECONOMY_FROM_YEAR;

/** The derived budget-balance column: no upstream series of its own. */
export const NATION_BALANCE_ID = BALANCE_ID;

/** Its two legs, in `revenue − expense` order. */
export const NATION_BALANCE_LEGS = BALANCE_LEGS;

/**
 * The IMF Fiscal Monitor block. The eight ids are IMF government-finance codes,
 * not Indonesia-specific — the vintage publishes the same eight series for every
 * country it covers — so the list is reused rather than duplicated.
 */
export const NATION_FISCAL: readonly IdEconomySpec[] = ID_APBN;

export const NATION_FISCAL_FROM_YEAR = ID_APBN_FROM_YEAR;

export const NATION_FISCAL_IDS: readonly string[] = NATION_FISCAL.map((s) => s.id);

/**
 * Which upstream a row came from. The page renders the two in separate blocks
 * rather than merging them: the World Bank's government-finance columns and the
 * IMF's are different measurements of the same concept, and a reader is entitled
 * to know which one they are looking at.
 */
export type NationSource = 'World Bank' | 'IMF Fiscal Monitor';
