/**
 * The economy domain's COUNTRY REGISTRY (plan Phase 3, `Country` entity).
 *
 * This is the economy domain's own copy of the country list, and it is
 * DELIBERATELY not imported from `features/market` — the structure gate forbids
 * a feature from reaching into another feature (rule 5), and the economy domain
 * is meant to stand on its own (a country page is a URL a reader types, so the
 * resolver has to work offline and deterministically).
 *
 * Because it mirrors `features/market/macro/client.ts`'s `WORLD_COUNTRIES`, the
 * two are kept honest by a GATE, not by discipline: `tests/economy-tests.ts`
 * asserts the ISO3 sets are identical, so a country added on one side and not
 * the other fails `verify-all.sh` instead of drifting silently into two worlds.
 *
 * `timezone` is the IANA zone of the capital, used by the calendar to render a
 * release in local time. It is populated only where the zone is unambiguous and
 * the country carries a central bank we track; `null` means NOT ASSERTED, which
 * the calendar renders as an explicit "time not localised" rather than as UTC.
 */
import type { Region } from '@/features/economy/model';

/** One row of the registry: the identity fields, nothing derived. */
export type CountryRow = {
  iso2: string;
  iso3: string;
  name: string;
  region: Region;
  currency: string;
  timezone: string | null;
};

/** The 125 economies, grouped by the same regions the market board uses. */
export const COUNTRIES: readonly CountryRow[] = [
  // --- Americas ---
  { iso2: 'US', iso3: 'USA', name: 'United States', region: 'Americas', currency: 'USD', timezone: 'America/New_York' },
  { iso2: 'CA', iso3: 'CAN', name: 'Canada', region: 'Americas', currency: 'CAD', timezone: 'America/Toronto' },
  { iso2: 'MX', iso3: 'MEX', name: 'Mexico', region: 'Americas', currency: 'MXN', timezone: 'America/Mexico_City' },
  { iso2: 'BR', iso3: 'BRA', name: 'Brazil', region: 'Americas', currency: 'BRL', timezone: 'America/Sao_Paulo' },
  { iso2: 'AR', iso3: 'ARG', name: 'Argentina', region: 'Americas', currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires' },
  { iso2: 'CO', iso3: 'COL', name: 'Colombia', region: 'Americas', currency: 'COP', timezone: 'America/Bogota' },
  { iso2: 'CL', iso3: 'CHL', name: 'Chile', region: 'Americas', currency: 'CLP', timezone: 'America/Santiago' },
  { iso2: 'PE', iso3: 'PER', name: 'Peru', region: 'Americas', currency: 'PEN', timezone: 'America/Lima' },
  { iso2: 'DO', iso3: 'DOM', name: 'Dominican Republic', region: 'Americas', currency: 'DOP', timezone: null },
  { iso2: 'GT', iso3: 'GTM', name: 'Guatemala', region: 'Americas', currency: 'GTQ', timezone: null },
  { iso2: 'UY', iso3: 'URY', name: 'Uruguay', region: 'Americas', currency: 'UYU', timezone: null },
  { iso2: 'PY', iso3: 'PRY', name: 'Paraguay', region: 'Americas', currency: 'PYG', timezone: null },
  { iso2: 'EC', iso3: 'ECU', name: 'Ecuador', region: 'Americas', currency: 'USD', timezone: null },
  { iso2: 'BO', iso3: 'BOL', name: 'Bolivia', region: 'Americas', currency: 'BOB', timezone: null },
  { iso2: 'PA', iso3: 'PAN', name: 'Panama', region: 'Americas', currency: 'PAB', timezone: null },
  { iso2: 'CR', iso3: 'CRI', name: 'Costa Rica', region: 'Americas', currency: 'CRC', timezone: null },
  { iso2: 'TT', iso3: 'TTO', name: 'Trinidad and Tobago', region: 'Americas', currency: 'TTD', timezone: null },
  { iso2: 'JM', iso3: 'JAM', name: 'Jamaica', region: 'Americas', currency: 'JMD', timezone: null },
  // --- Europe ---
  { iso2: 'DE', iso3: 'DEU', name: 'Germany', region: 'Europe', currency: 'EUR', timezone: 'Europe/Berlin' },
  { iso2: 'GB', iso3: 'GBR', name: 'United Kingdom', region: 'Europe', currency: 'GBP', timezone: 'Europe/London' },
  { iso2: 'FR', iso3: 'FRA', name: 'France', region: 'Europe', currency: 'EUR', timezone: 'Europe/Paris' },
  { iso2: 'IT', iso3: 'ITA', name: 'Italy', region: 'Europe', currency: 'EUR', timezone: 'Europe/Rome' },
  { iso2: 'ES', iso3: 'ESP', name: 'Spain', region: 'Europe', currency: 'EUR', timezone: 'Europe/Madrid' },
  { iso2: 'NL', iso3: 'NLD', name: 'Netherlands', region: 'Europe', currency: 'EUR', timezone: 'Europe/Amsterdam' },
  { iso2: 'CH', iso3: 'CHE', name: 'Switzerland', region: 'Europe', currency: 'CHF', timezone: 'Europe/Zurich' },
  { iso2: 'SE', iso3: 'SWE', name: 'Sweden', region: 'Europe', currency: 'SEK', timezone: 'Europe/Stockholm' },
  { iso2: 'PL', iso3: 'POL', name: 'Poland', region: 'Europe', currency: 'PLN', timezone: 'Europe/Warsaw' },
  { iso2: 'TR', iso3: 'TUR', name: 'Türkiye', region: 'Europe', currency: 'TRY', timezone: 'Europe/Istanbul' },
  { iso2: 'RU', iso3: 'RUS', name: 'Russia', region: 'Europe', currency: 'RUB', timezone: 'Europe/Moscow' },
  { iso2: 'NO', iso3: 'NOR', name: 'Norway', region: 'Europe', currency: 'NOK', timezone: 'Europe/Oslo' },
  { iso2: 'FI', iso3: 'FIN', name: 'Finland', region: 'Europe', currency: 'EUR', timezone: 'Europe/Helsinki' },
  { iso2: 'IE', iso3: 'IRL', name: 'Ireland', region: 'Europe', currency: 'EUR', timezone: 'Europe/Dublin' },
  { iso2: 'PT', iso3: 'PRT', name: 'Portugal', region: 'Europe', currency: 'EUR', timezone: 'Europe/Lisbon' },
  { iso2: 'GR', iso3: 'GRC', name: 'Greece', region: 'Europe', currency: 'EUR', timezone: 'Europe/Athens' },
  { iso2: 'AT', iso3: 'AUT', name: 'Austria', region: 'Europe', currency: 'EUR', timezone: 'Europe/Vienna' },
  { iso2: 'BE', iso3: 'BEL', name: 'Belgium', region: 'Europe', currency: 'EUR', timezone: 'Europe/Brussels' },
  { iso2: 'CZ', iso3: 'CZE', name: 'Czechia', region: 'Europe', currency: 'CZK', timezone: 'Europe/Prague' },
  { iso2: 'HU', iso3: 'HUN', name: 'Hungary', region: 'Europe', currency: 'HUF', timezone: 'Europe/Budapest' },
  { iso2: 'RO', iso3: 'ROU', name: 'Romania', region: 'Europe', currency: 'RON', timezone: 'Europe/Bucharest' },
  { iso2: 'UA', iso3: 'UKR', name: 'Ukraine', region: 'Europe', currency: 'UAH', timezone: 'Europe/Kiev' },
  { iso2: 'IS', iso3: 'ISL', name: 'Iceland', region: 'Europe', currency: 'ISK', timezone: null },
  { iso2: 'LU', iso3: 'LUX', name: 'Luxembourg', region: 'Europe', currency: 'EUR', timezone: 'Europe/Luxembourg' },
  { iso2: 'CY', iso3: 'CYP', name: 'Cyprus', region: 'Europe', currency: 'EUR', timezone: 'Europe/Nicosia' },
  { iso2: 'MT', iso3: 'MLT', name: 'Malta', region: 'Europe', currency: 'EUR', timezone: 'Europe/Malta' },
  { iso2: 'SK', iso3: 'SVK', name: 'Slovakia', region: 'Europe', currency: 'EUR', timezone: 'Europe/Bratislava' },
  { iso2: 'SI', iso3: 'SVN', name: 'Slovenia', region: 'Europe', currency: 'EUR', timezone: 'Europe/Ljubljana' },
  { iso2: 'HR', iso3: 'HRV', name: 'Croatia', region: 'Europe', currency: 'EUR', timezone: 'Europe/Zagreb' },
  { iso2: 'BG', iso3: 'BGR', name: 'Bulgaria', region: 'Europe', currency: 'EUR', timezone: null },
  { iso2: 'LT', iso3: 'LTU', name: 'Lithuania', region: 'Europe', currency: 'EUR', timezone: 'Europe/Vilnius' },
  { iso2: 'LV', iso3: 'LVA', name: 'Latvia', region: 'Europe', currency: 'EUR', timezone: 'Europe/Riga' },
  { iso2: 'EE', iso3: 'EST', name: 'Estonia', region: 'Europe', currency: 'EUR', timezone: 'Europe/Tallinn' },
  { iso2: 'AL', iso3: 'ALB', name: 'Albania', region: 'Europe', currency: 'ALL', timezone: null },
  { iso2: 'MK', iso3: 'MKD', name: 'North Macedonia', region: 'Europe', currency: 'MKD', timezone: null },
  { iso2: 'BA', iso3: 'BIH', name: 'Bosnia and Herzegovina', region: 'Europe', currency: 'BAM', timezone: null },
  { iso2: 'RS', iso3: 'SRB', name: 'Serbia', region: 'Europe', currency: 'RSD', timezone: null },
  { iso2: 'ME', iso3: 'MNE', name: 'Montenegro', region: 'Europe', currency: 'EUR', timezone: null },
  { iso2: 'BY', iso3: 'BLR', name: 'Belarus', region: 'Europe', currency: 'BYN', timezone: null },
  { iso2: 'MD', iso3: 'MDA', name: 'Moldova', region: 'Europe', currency: 'MDL', timezone: null },
  // --- Asia-Pacific ---
  { iso2: 'CN', iso3: 'CHN', name: 'China', region: 'Asia-Pacific', currency: 'CNY', timezone: 'Asia/Shanghai' },
  { iso2: 'JP', iso3: 'JPN', name: 'Japan', region: 'Asia-Pacific', currency: 'JPY', timezone: 'Asia/Tokyo' },
  { iso2: 'IN', iso3: 'IND', name: 'India', region: 'Asia-Pacific', currency: 'INR', timezone: 'Asia/Kolkata' },
  { iso2: 'KR', iso3: 'KOR', name: 'South Korea', region: 'Asia-Pacific', currency: 'KRW', timezone: 'Asia/Seoul' },
  { iso2: 'ID', iso3: 'IDN', name: 'Indonesia', region: 'Asia-Pacific', currency: 'IDR', timezone: 'Asia/Jakarta' },
  { iso2: 'AU', iso3: 'AUS', name: 'Australia', region: 'Asia-Pacific', currency: 'AUD', timezone: 'Australia/Sydney' },
  { iso2: 'TH', iso3: 'THA', name: 'Thailand', region: 'Asia-Pacific', currency: 'THB', timezone: 'Asia/Bangkok' },
  { iso2: 'VN', iso3: 'VNM', name: 'Vietnam', region: 'Asia-Pacific', currency: 'VND', timezone: 'Asia/Ho_Chi_Minh' },
  { iso2: 'MY', iso3: 'MYS', name: 'Malaysia', region: 'Asia-Pacific', currency: 'MYR', timezone: 'Asia/Kuala_Lumpur' },
  { iso2: 'PH', iso3: 'PHL', name: 'Philippines', region: 'Asia-Pacific', currency: 'PHP', timezone: 'Asia/Manila' },
  { iso2: 'SG', iso3: 'SGP', name: 'Singapore', region: 'Asia-Pacific', currency: 'SGD', timezone: 'Asia/Singapore' },
  { iso2: 'PK', iso3: 'PAK', name: 'Pakistan', region: 'Asia-Pacific', currency: 'PKR', timezone: 'Asia/Karachi' },
  { iso2: 'BD', iso3: 'BGD', name: 'Bangladesh', region: 'Asia-Pacific', currency: 'BDT', timezone: 'Asia/Dhaka' },
  { iso2: 'LK', iso3: 'LKA', name: 'Sri Lanka', region: 'Asia-Pacific', currency: 'LKR', timezone: null },
  { iso2: 'NP', iso3: 'NPL', name: 'Nepal', region: 'Asia-Pacific', currency: 'NPR', timezone: null },
  { iso2: 'MM', iso3: 'MMR', name: 'Myanmar', region: 'Asia-Pacific', currency: 'MMK', timezone: null },
  { iso2: 'KH', iso3: 'KHM', name: 'Cambodia', region: 'Asia-Pacific', currency: 'KHR', timezone: null },
  { iso2: 'MN', iso3: 'MNG', name: 'Mongolia', region: 'Asia-Pacific', currency: 'MNT', timezone: null },
  { iso2: 'NZ', iso3: 'NZL', name: 'New Zealand', region: 'Asia-Pacific', currency: 'NZD', timezone: 'Pacific/Auckland' },
  { iso2: 'HK', iso3: 'HKG', name: 'Hong Kong SAR', region: 'Asia-Pacific', currency: 'HKD', timezone: 'Asia/Hong_Kong' },
  { iso2: 'MO', iso3: 'MAC', name: 'Macao SAR', region: 'Asia-Pacific', currency: 'MOP', timezone: null },
  { iso2: 'BN', iso3: 'BRN', name: 'Brunei', region: 'Asia-Pacific', currency: 'BND', timezone: null },
  { iso2: 'FJ', iso3: 'FJI', name: 'Fiji', region: 'Asia-Pacific', currency: 'FJD', timezone: null },
  { iso2: 'PG', iso3: 'PNG', name: 'Papua New Guinea', region: 'Asia-Pacific', currency: 'PGK', timezone: null },
  { iso2: 'KZ', iso3: 'KAZ', name: 'Kazakhstan', region: 'Asia-Pacific', currency: 'KZT', timezone: null },
  { iso2: 'AZ', iso3: 'AZE', name: 'Azerbaijan', region: 'Asia-Pacific', currency: 'AZN', timezone: null },
  { iso2: 'UZ', iso3: 'UZB', name: 'Uzbekistan', region: 'Asia-Pacific', currency: 'UZS', timezone: null },
  { iso2: 'TM', iso3: 'TKM', name: 'Turkmenistan', region: 'Asia-Pacific', currency: 'TMT', timezone: null },
  { iso2: 'KG', iso3: 'KGZ', name: 'Kyrgyz Republic', region: 'Asia-Pacific', currency: 'KGS', timezone: null },
  { iso2: 'TJ', iso3: 'TJK', name: 'Tajikistan', region: 'Asia-Pacific', currency: 'TJS', timezone: null },
  { iso2: 'GE', iso3: 'GEO', name: 'Georgia', region: 'Asia-Pacific', currency: 'GEL', timezone: null },
  { iso2: 'AM', iso3: 'ARM', name: 'Armenia', region: 'Asia-Pacific', currency: 'AMD', timezone: null },
  // --- Africa & Middle East ---
  { iso2: 'SA', iso3: 'SAU', name: 'Saudi Arabia', region: 'Africa & Middle East', currency: 'SAR', timezone: 'Asia/Riyadh' },
  { iso2: 'AE', iso3: 'ARE', name: 'United Arab Emirates', region: 'Africa & Middle East', currency: 'AED', timezone: 'Asia/Dubai' },
  { iso2: 'IL', iso3: 'ISR', name: 'Israel', region: 'Africa & Middle East', currency: 'ILS', timezone: 'Asia/Jerusalem' },
  { iso2: 'QA', iso3: 'QAT', name: 'Qatar', region: 'Africa & Middle East', currency: 'QAR', timezone: 'Asia/Qatar' },
  { iso2: 'KW', iso3: 'KWT', name: 'Kuwait', region: 'Africa & Middle East', currency: 'KWD', timezone: 'Asia/Kuwait' },
  { iso2: 'IQ', iso3: 'IRQ', name: 'Iraq', region: 'Africa & Middle East', currency: 'IQD', timezone: null },
  { iso2: 'IR', iso3: 'IRN', name: 'Iran', region: 'Africa & Middle East', currency: 'IRR', timezone: null },
  { iso2: 'JO', iso3: 'JOR', name: 'Jordan', region: 'Africa & Middle East', currency: 'JOD', timezone: null },
  { iso2: 'OM', iso3: 'OMN', name: 'Oman', region: 'Africa & Middle East', currency: 'OMR', timezone: null },
  { iso2: 'BH', iso3: 'BHR', name: 'Bahrain', region: 'Africa & Middle East', currency: 'BHD', timezone: null },
  { iso2: 'EG', iso3: 'EGY', name: 'Egypt', region: 'Africa & Middle East', currency: 'EGP', timezone: 'Africa/Cairo' },
  { iso2: 'ZA', iso3: 'ZAF', name: 'South Africa', region: 'Africa & Middle East', currency: 'ZAR', timezone: 'Africa/Johannesburg' },
  { iso2: 'NG', iso3: 'NGA', name: 'Nigeria', region: 'Africa & Middle East', currency: 'NGN', timezone: 'Africa/Lagos' },
  { iso2: 'KE', iso3: 'KEN', name: 'Kenya', region: 'Africa & Middle East', currency: 'KES', timezone: 'Africa/Nairobi' },
  { iso2: 'ET', iso3: 'ETH', name: 'Ethiopia', region: 'Africa & Middle East', currency: 'ETB', timezone: null },
  { iso2: 'MA', iso3: 'MAR', name: 'Morocco', region: 'Africa & Middle East', currency: 'MAD', timezone: null },
  { iso2: 'DZ', iso3: 'DZA', name: 'Algeria', region: 'Africa & Middle East', currency: 'DZD', timezone: null },
  { iso2: 'TZ', iso3: 'TZA', name: 'Tanzania', region: 'Africa & Middle East', currency: 'TZS', timezone: null },
  { iso2: 'UG', iso3: 'UGA', name: 'Uganda', region: 'Africa & Middle East', currency: 'UGX', timezone: null },
  { iso2: 'GH', iso3: 'GHA', name: 'Ghana', region: 'Africa & Middle East', currency: 'GHS', timezone: null },
  { iso2: 'CI', iso3: 'CIV', name: 'Côte d’Ivoire', region: 'Africa & Middle East', currency: 'XOF', timezone: null },
  { iso2: 'SN', iso3: 'SEN', name: 'Senegal', region: 'Africa & Middle East', currency: 'XOF', timezone: null },
  { iso2: 'TN', iso3: 'TUN', name: 'Tunisia', region: 'Africa & Middle East', currency: 'TND', timezone: null },
  { iso2: 'BW', iso3: 'BWA', name: 'Botswana', region: 'Africa & Middle East', currency: 'BWP', timezone: null },
  { iso2: 'NA', iso3: 'NAM', name: 'Namibia', region: 'Africa & Middle East', currency: 'NAD', timezone: null },
  { iso2: 'ZM', iso3: 'ZMB', name: 'Zambia', region: 'Africa & Middle East', currency: 'ZMW', timezone: null },
  { iso2: 'ZW', iso3: 'ZWE', name: 'Zimbabwe', region: 'Africa & Middle East', currency: 'ZWG', timezone: null },
  { iso2: 'CM', iso3: 'CMR', name: 'Cameroon', region: 'Africa & Middle East', currency: 'XAF', timezone: null },
  { iso2: 'MZ', iso3: 'MOZ', name: 'Mozambique', region: 'Africa & Middle East', currency: 'MZN', timezone: null },
  { iso2: 'AO', iso3: 'AGO', name: 'Angola', region: 'Africa & Middle East', currency: 'AOA', timezone: null },
  { iso2: 'SD', iso3: 'SDN', name: 'Sudan', region: 'Africa & Middle East', currency: 'SDG', timezone: null },
  { iso2: 'LY', iso3: 'LBY', name: 'Libya', region: 'Africa & Middle East', currency: 'LYD', timezone: null },
  { iso2: 'SY', iso3: 'SYR', name: 'Syria', region: 'Africa & Middle East', currency: 'SYP', timezone: null },
  { iso2: 'YE', iso3: 'YEM', name: 'Yemen', region: 'Africa & Middle East', currency: 'YER', timezone: null },
  { iso2: 'AF', iso3: 'AFG', name: 'Afghanistan', region: 'Africa & Middle East', currency: 'AFN', timezone: null },
];
