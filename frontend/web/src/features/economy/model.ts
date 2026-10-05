/**
 * Economy domain model: taxonomy, entities, country + indicator registries,
 * regime engine, and the view-safe client. One file so the domain has one
 * import address (`@/features/economy/model`). Sections below are the former
 * `taxonomy.ts`, `model.ts`, `countries.ts`, `registry.ts`, `regime.ts`,
 * `client.ts`, concatenated unchanged apart from dropped inter-file imports.
 */

/**
 * The economy domain's canonical taxonomy (plan Phase 2).
 *
 * WHY A TAXONOMY AND NOT A ROUTE LIST. A category is a way of READING a series
 * (Growth, Inflation, Monetary…), not a place in the URL tree. The same CPI
 * series is "Inflation" when you scan a country page and "US" when you scan an
 * inflation page; if the category were the route, the series would have to live
 * in exactly one of them. So the taxonomy is METADATA on every indicator
 * (`category` + `subcategory` on `EconomicIndicator`) and every explorer
 * (`/economy/indicator`, `/economy/compare`) filters by it — nothing is routed
 * BY it.
 *
 * The tree below is the plan's own tree. Subcategories that no source we read
 * can fill are still declared, because a category is the domain's vocabulary
 * and a missing series is a stated gap (`count: 0`), not a missing word. The
 * registry is what decides which of them actually carry data.
 */

/** The eleven top-level categories, in the plan's order. */
export type CategoryId =
  | 'growth'
  | 'labor'
  | 'inflation'
  | 'monetary'
  | 'fiscal'
  | 'trade'
  | 'housing'
  | 'consumer'
  | 'sentiment'
  | 'credit'
  | 'money';

export type SubcategoryId =
  // Growth
  | 'gdp'
  | 'gdp-per-capita'
  | 'industrial-production'
  | 'manufacturing'
  | 'investment'
  | 'pmi-manufacturing'
  | 'pmi-services'
  // Labor
  | 'employment'
  | 'unemployment'
  | 'payrolls'
  | 'job-openings'
  | 'jobless-claims'
  | 'participation'
  | 'wages'
  // Inflation
  | 'cpi'
  | 'core-cpi'
  | 'pce'
  | 'core-pce'
  | 'ppi'
  // Monetary
  | 'policy-rate'
  | 'money-supply'
  | 'central-bank-balance-sheet'
  | 'liquidity'
  // Fiscal
  | 'government-debt'
  | 'deficit'
  | 'revenue'
  | 'spending'
  | 'interest-payments'
  // Trade
  | 'trade-balance'
  | 'trade-openness'
  | 'current-account'
  | 'export'
  | 'import'
  | 'fdi'
  | 'reserves'
  // Housing
  | 'housing-starts'
  | 'house-price'
  // Consumer
  | 'consumer-spending'
  | 'retail-sales'
  | 'consumer-credit'
  // Sentiment
  | 'consumer-sentiment'
  | 'business-sentiment'
  // Credit
  | 'credit-spread'
  | 'lending-rate'
  | 'private-credit'
  // Money
  | 'broad-money'
  | 'm2'
  | 'fx-reserves'
  // Cross-cutting (a country's own structural block)
  | 'population'
  | 'government-education'
  | 'government-health'
  | 'military-expenditure'
  | 'internet-users'
  | 'co2-emissions'
  | 'listed-companies'
  | 'market-capitalisation'
  | 'stocks-traded'
  | 'firm-density';

export type Subcategory = {
  id: SubcategoryId;
  label: string;
  /** One line on what the subcategory measures — the explorer's filter help. */
  note: string;
};

export type Category = {
  id: CategoryId;
  label: string;
  note: string;
  subcategories: readonly Subcategory[];
};

export const TAXONOMY: readonly Category[] = [
  {
    id: 'growth',
    label: 'Growth',
    note: 'Output and activity: how fast the economy is expanding and what is driving it.',
    subcategories: [
      { id: 'gdp', label: 'GDP', note: 'Gross domestic product — the headline output measure' },
      { id: 'gdp-per-capita', label: 'GDP per capita', note: 'Output per person, current US$' },
      { id: 'industrial-production', label: 'Industrial Production', note: 'Output of mining, manufacturing and utilities' },
      { id: 'manufacturing', label: 'Manufacturing', note: 'Manufacturing value added as a share of GDP' },
      { id: 'investment', label: 'Investment', note: 'Gross capital formation, % of GDP' },
      { id: 'pmi-manufacturing', label: 'PMI Manufacturing', note: 'Purchasing managers index, manufacturing (50 = no change)' },
      { id: 'pmi-services', label: 'PMI Services', note: 'Purchasing managers index, services (50 = no change)' },
    ],
  },
  {
    id: 'labor',
    label: 'Labor',
    note: 'The jobs market: who is working, who is looking, and what they are paid.',
    subcategories: [
      { id: 'employment', label: 'Employment', note: 'Number of people in work' },
      { id: 'unemployment', label: 'Unemployment', note: 'Share of the labour force out of work' },
      { id: 'payrolls', label: 'Payrolls', note: 'Change in the number of paid jobs' },
      { id: 'job-openings', label: 'Job Openings', note: 'Unfilled vacancies posted by employers' },
      { id: 'jobless-claims', label: 'Jobless Claims', note: 'New filings for unemployment insurance' },
      { id: 'participation', label: 'Participation', note: 'Share of the population in the labour force' },
      { id: 'wages', label: 'Wages', note: 'Compensation per worker' },
    ],
  },
  {
    id: 'inflation',
    label: 'Inflation',
    note: 'How fast prices are rising, at the headline and at the core the central bank watches.',
    subcategories: [
      { id: 'cpi', label: 'CPI', note: 'Consumer price index, all items' },
      { id: 'core-cpi', label: 'Core CPI', note: 'CPI excluding food and energy' },
      { id: 'pce', label: 'PCE', note: 'Personal consumption expenditures price index' },
      { id: 'core-pce', label: 'Core PCE', note: 'PCE excluding food and energy — the Fed’s preferred gauge' },
      { id: 'ppi', label: 'PPI', note: 'Producer price index, at the factory gate' },
    ],
  },
  {
    id: 'monetary',
    label: 'Monetary',
    note: 'The central bank’s stance and the money it creates.',
    subcategories: [
      { id: 'policy-rate', label: 'Policy Rate', note: 'The central bank’s target or key rate' },
      { id: 'money-supply', label: 'Money Supply', note: 'Broad money in the system' },
      { id: 'central-bank-balance-sheet', label: 'Central Bank Balance Sheet', note: 'Assets held by the central bank — QE/QT in one number' },
      { id: 'liquidity', label: 'Liquidity', note: 'Usable cash and collateral in the financial system' },
    ],
  },
  {
    id: 'fiscal',
    label: 'Fiscal',
    note: 'The government’s books: what it takes in, spends, owes and pays to service.',
    subcategories: [
      { id: 'government-debt', label: 'Government Debt', note: 'General government gross debt, % of GDP' },
      { id: 'deficit', label: 'Deficit', note: 'Revenue minus spending; negative is a deficit' },
      { id: 'revenue', label: 'Revenue', note: 'Government receipts, % of GDP' },
      { id: 'spending', label: 'Spending', note: 'Government outlays, % of GDP' },
      { id: 'interest-payments', label: 'Interest Payments', note: 'Debt service as a share of revenue' },
    ],
  },
  {
    id: 'trade',
    label: 'Trade',
    note: 'What the economy sells abroad, buys from abroad, and what crosses its border.',
    subcategories: [
      { id: 'trade-balance', label: 'Trade Balance', note: 'Exports minus imports of goods and services' },
      { id: 'trade-openness', label: 'Trade Openness', note: 'Exports plus imports, % of GDP' },
      { id: 'current-account', label: 'Current Account', note: 'The widest measure of cross-border flows, % of GDP' },
      { id: 'export', label: 'Export', note: 'Goods and services sold abroad' },
      { id: 'import', label: 'Import', note: 'Goods and services bought from abroad' },
      { id: 'fdi', label: 'FDI', note: 'Foreign direct investment, net inflows' },
      { id: 'reserves', label: 'Reserves', note: 'Foreign exchange reserves including gold' },
    ],
  },
  {
    id: 'housing',
    label: 'Housing',
    note: 'Construction and property prices — the most rate-sensitive corner of the economy.',
    subcategories: [
      { id: 'housing-starts', label: 'Housing Starts', note: 'New residential construction begun' },
      { id: 'house-price', label: 'House Price', note: 'Residential property price index' },
    ],
  },
  {
    id: 'consumer',
    label: 'Consumer',
    note: 'The household: what it spends and what it borrows.',
    subcategories: [
      { id: 'consumer-spending', label: 'Consumer Spending', note: 'Household final consumption expenditure' },
      { id: 'retail-sales', label: 'Retail Sales', note: 'Turnover at retail and food services' },
      { id: 'consumer-credit', label: 'Consumer Credit', note: 'Household borrowing outstanding' },
    ],
  },
  {
    id: 'sentiment',
    label: 'Sentiment',
    note: 'Surveys of what households and firms expect — leading, but self-reported.',
    subcategories: [
      { id: 'consumer-sentiment', label: 'Consumer Sentiment', note: 'Household confidence surveys' },
      { id: 'business-sentiment', label: 'Business Sentiment', note: 'Firm confidence and expectations surveys' },
    ],
  },
  {
    id: 'credit',
    label: 'Credit',
    note: 'The price and quantity of borrowing — where stress shows up first.',
    subcategories: [
      { id: 'credit-spread', label: 'Credit Spread', note: 'Yield over the risk-free curve demanded by lenders' },
      { id: 'lending-rate', label: 'Lending Rate', note: 'The rate banks charge on loans' },
      { id: 'private-credit', label: 'Private Credit', note: 'Credit to the private sector, % of GDP' },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    note: 'Aggregates and cross-border money — the plumbing behind every other block.',
    subcategories: [
      { id: 'broad-money', label: 'Broad Money', note: 'Broad money as a share of GDP' },
      { id: 'm2', label: 'M2', note: 'M2 money stock' },
      { id: 'fx-reserves', label: 'FX Reserves', note: 'Official reserve assets' },
    ],
  },
];

/** Lookup by id — the registry resolves every indicator's category through this. */
export const CATEGORY_BY_ID: Readonly<Record<CategoryId, Category>> = Object.fromEntries(
  TAXONOMY.map((c) => [c.id, c]),
) as Readonly<Record<CategoryId, Category>>;

/** Flat id -> label for every subcategory, across all categories. */
export const SUBCATEGORY_LABELS: Readonly<Record<SubcategoryId, string>> = Object.fromEntries(
  TAXONOMY.flatMap((c) => c.subcategories.map((s) => [s.id, s.label])),
) as Readonly<Record<SubcategoryId, string>>;

/** The category a subcategory belongs to — the reverse edge of the tree. */
export const CATEGORY_OF_SUBCATEGORY: Readonly<Record<SubcategoryId, CategoryId>> = Object.fromEntries(
  TAXONOMY.flatMap((c) => c.subcategories.map((s) => [s.id, c.id])),
) as Readonly<Record<SubcategoryId, CategoryId>>;

/**
 * The economy domain's canonical data model (plan Phase 3).
 *
 * THE POINT OF THIS FILE: the database and the API must NOT take the shape of
 * whichever provider happens to be cheapest this year. FRED, the World Bank,
 * BIS, the IMF and every future source are normalised into these four entities,
 * so a provider can be swapped without touching a single view. The mapping
 * provider → entity lives in `registry.ts` (`source` + `sourceSeriesId`), never
 * in a page.
 *
 * The four entities and what they are for:
 *
 *   Country              — identity. A stable ISO-keyed row, no measurements.
 *   EconomicIndicator    — a SERIES: the taxonomy slot plus the provenance of
 *                          the upstream that fills it. One row per (country,
 *                          series) — this is what a URL slug resolves to.
 *   EconomicObservation  — one dated value of an indicator. The history.
 *   EconomicRelease      — one dated EVENT: the moment a value is published,
 *                          with whatever actual/forecast/previous the source
 *                          gives. Referenced by indicator id, never a separate
 *                          unlinked dataset (plan Phase 8).
 *
 * Honesty rules that live in the TYPES, not in a comment somewhere:
 *   - every measured field is `number | null`, never `0` for "unknown";
 *   - `seasonalAdjustment` and `frequency` are required, because a value
 *     without them cannot be compared to another value;
 *   - `revised` is separate from `previous`, because a revision and a change
 *     are different facts and collapsing them invents history.
 */

/** The region grouping every country and every board uses. */
export type Region = 'Americas' | 'Europe' | 'Asia-Pacific' | 'Africa & Middle East';

/** How often a series prints. Required on every indicator — see the header. */
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual';

/**
 * Whether the published value is seasonally adjusted. `NA` means the upstream
 * does not state it — an explicit "unknown", not an assertion of "not adjusted".
 */
export type SeasonalAdjustment = 'SA' | 'NSA' | 'NA';

/** 3 = market-moving headline, 2 = watched, 1 = context. */
export type Importance = 1 | 2 | 3;

/** The upstream a series is read from. The adapter for each lives in `features/market`. */
export type SourceId = 'worldbank' | 'fred' | 'bis' | 'imf' | 'erapi';

/**
 * How a raw upstream level becomes the number we publish. `yoy` needs `lag`
 * because the transform depends on the series' own frequency: 12 for a monthly
 * year-ago point, 4 for a quarterly one. Reading the lag off date spacing is
 * exactly how a quarterly series silently gets a "YoY" over three years.
 */
export type ValueShape = 'level' | 'yoy' | 'change';

/** Identity of an economy. No measurements — those live on the indicator. */
export type Country = {
  /** ISO 3166-1 alpha-3 — the key every upstream is keyed on. */
  id: string;
  iso2: string;
  iso3: string;
  name: string;
  region: Region;
  /** ISO-4217 code. */
  currency: string;
  /** IANA zone of the capital, or null when not asserted (see `countries.ts`). */
  timezone: string | null;
};

/**
 * A canonical series: the taxonomy slot plus the provenance of the upstream that
 * fills it. `slug` is the canonical URL key (`us-cpi`, `id-cpi`) and is what
 * `/economy/indicator/<slug>` resolves.
 */
export type EconomicIndicator = {
  /** Canonical, stable, URL-safe: `<iso2-lower>-<key>`, e.g. `us-core-cpi`. */
  slug: string;
  name: string;
  /** Country id (ISO3). `null` for a supranational series (e.g. euro-area M3). */
  country: string | null;
  category: CategoryId;
  subcategory: SubcategoryId;
  unit: string;
  frequency: Frequency;
  seasonalAdjustment: SeasonalAdjustment;
  source: SourceId;
  /** The upstream's own series key — the FRED id, the World Bank code, the BIS area. */
  sourceSeriesId: string;
  importance: Importance;
  decimals: number;
  shape: ValueShape;
  /** Periods to look back for a `yoy`; 0 when the shape does not need one. */
  lag: number;
  /** One line on what the series measures, shown as the row's title attribute. */
  note: string;
};

/** One dated value of an indicator. */
export type EconomicObservation = {
  indicatorId: string;
  /** Period the observation is FOR, as the upstream labels it (e.g. `2024`, `2026-08`). */
  date: string;
  value: number | null;
  /** The observation one period earlier, when the window holds one. */
  previous: number | null;
  /** The value as first published, when the source exposes a revision. */
  revised: number | null;
};

/**
 * One scheduled publication. `indicatorId` ties it to the series it belongs to
 * (plan Phase 8: "all events must reference an EconomicIndicator").
 *
 * `actual`, `forecast`, `previous` and `revised` are each `number | null` and
 * MEAN DIFFERENT THINGS when null: a null `forecast` is "no consensus published
 * here", not "consensus is zero", and it must never be rendered as one.
 */
export type EconomicRelease = {
  indicatorId: string;
  /** ISO-8601 instant the value is published, when the source states one. */
  releaseAt: string | null;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  revised: number | null;
  importance: Importance;
  unit: string;
};

/**
 * The economy domain's COUNTRY REGISTRY (plan Phase 3, `Country` entity).
 *
 * This is the economy domain's own copy of the country list, and it is
 * DELIBERATELY not imported from `features/market` — the structure gate forbids
 * a feature from reaching into another feature (rule 5), and the economy domain
 * is meant to stand on its own (a country page is a URL a reader types, so the
 * resolver has to work offline and deterministically).
 *
 * Because it mirrors `features/market/clients.ts`'s `WORLD_COUNTRIES`, the
 * two are kept honest by a GATE, not by discipline: `tests/economy-tests.ts`
 * asserts the ISO3 sets are identical, so a country added on one side and not
 * the other fails `verify-all.sh` instead of drifting silently into two worlds.
 *
 * `timezone` is the IANA zone of the capital, used by the calendar to render a
 * release in local time. It is populated only where the zone is unambiguous and
 * the country carries a central bank we track; `null` means NOT ASSERTED, which
 * the calendar renders as an explicit "time not localised" rather than as UTC.
 */

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

/**
 * The economy domain's INTELLIGENCE LAYER (plan Phase 13, stages 16–17).
 *
 * WHAT THIS FILE IS, AND WHAT IT REFUSES TO BE. The backend computes; it does
 * not narrate. Everything here is arithmetic over published observations —
 * trend detection with an explicit noise model, a rule table over the resulting
 * readings, and a weight table that turns those readings into a directional
 * score per asset class. No language model is involved, nothing is inferred
 * from a headline, and no number is ever invented to fill a gap.
 *
 * The module is PURE: no network, no clock, no I/O. `buildRegime` takes the
 * observations the route already read and returns a complete, auditable result.
 * That is what makes the engine unit-testable offline — the test suite feeds it
 * a series and asserts the regime, instead of asserting whatever today's
 * upstream happened to say.
 *
 * WHY THE TREND TEST IS NOISE-AWARE. "CPI rose from 2.6 to 2.7" is not a
 * trend; it is a print. A rule that called any nonzero change a direction would
 * flip a country between regimes on rounding noise and would be confidently
 * wrong most of the time. So a direction is only declared when the move over
 * the lookback exceeds what the series' own period-to-period variation predicts
 * — a random-walk null, with sigma estimated robustly (MAD of first
 * differences, scaled) so a single outlier cannot inflate the threshold.
 */

export type DimensionId = 'growth' | 'inflation' | 'labor' | 'liquidity' | 'policy';
export type TrendDirection = 'up' | 'down' | 'flat';
export type AssetId = 'btc' | 'gold' | 'usd' | 'bonds' | 'equity';
export type Stance = 'strongly bullish' | 'bullish' | 'neutral' | 'bearish' | 'strongly bearish';

/** The asset classes the impact table scores, in display order. */
export const ASSETS: readonly { id: AssetId; label: string }[] = [
  { id: 'btc', label: 'BTC' },
  { id: 'gold', label: 'Gold' },
  { id: 'usd', label: 'USD' },
  { id: 'bonds', label: 'Bonds' },
  { id: 'equity', label: 'Equity' },
];

/**
 * The word each dimension uses for a direction. Separate from the rule table's
 * tags because the two answer different questions: the word is what a reader
 * sees ("Disinflation"), the tag is what a rule matches on ("cool").
 */
export const VOCAB: Readonly<Record<DimensionId, { up: string; down: string; flat: string }>> = {
  growth: { up: 'Accelerating', down: 'Cooling', flat: 'Steady' },
  inflation: { up: 'Re-accelerating', down: 'Disinflation', flat: 'Sticky' },
  labor: { up: 'Loosening', down: 'Tightening', flat: 'Stable' },
  liquidity: { up: 'Expanding', down: 'Contracting', flat: 'Flat' },
  policy: { up: 'Tightening', down: 'Easing', flat: 'On hold' },
};

/**
 * The rule table's semantic tag per direction. `inflation.flat` is "sticky"
 * rather than "stable" on purpose: an inflation rate that is not moving is not
 * good news, it is the absence of disinflation, and the rule table needs to be
 * able to say so.
 */
const TAGS: Readonly<Record<DimensionId, Record<TrendDirection, string>>> = {
  growth: { up: 'hot', down: 'cool', flat: 'steady' },
  inflation: { up: 'hot', down: 'cool', flat: 'sticky' },
  labor: { up: 'loose', down: 'tight', flat: 'stable' },
  liquidity: { up: 'expand', down: 'contract', flat: 'flat' },
  policy: { up: 'tight', down: 'ease', flat: 'hold' },
};

export type TrendResult = {
  direction: TrendDirection;
  /** latest − value `lookback` periods back. */
  change: number;
  /** Periods actually spanned (clamped to the series length). */
  lookback: number;
  /** The threshold the change was judged against. */
  noise: number;
  /** |change| / noise. 1 means "exactly at the noise floor". */
  strength: number;
};

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Robust sigma: MAD of the values, scaled to be a consistent normal estimate. */
function robustSigma(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const med = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - med)));
}

/**
 * Classify a series' direction over `lookback` periods.
 *
 * Returns `null` when there are too few points to say anything — which is a
 * first-class answer here. A caller that receives `null` reports "insufficient
 * data" for that dimension; it does not fall back to "flat", because "flat" is
 * a claim and "unknown" is not.
 */
export function classifyTrend(values: readonly number[], lookback: number): TrendResult | null {
  const n = values.length;
  if (n < 4) return null;
  const span = Math.max(1, Math.min(lookback, n - 1));
  const latest = values[n - 1];
  const past = values[n - 1 - span];
  const change = latest - past;

  const diffs: number[] = [];
  for (let i = 1; i < n; i++) diffs.push(values[i] - values[i - 1]);
  const sigma = robustSigma(diffs);

  // A series that is constant, or perfectly monotone with equal steps, has a
  // zero MAD of differences — the noise model would then call ANY move
  // significant. Floor the threshold at a scale-relative epsilon so those
  // series still resolve to 'flat' instead of 'up'.
  const scale = Math.max(Math.abs(latest), Math.abs(past), 1e-12);
  const sigmaEff = Math.max(sigma, scale * 1e-9);
  const noise = sigmaEff * Math.sqrt(span);

  const direction: TrendDirection = change > noise ? 'up' : change < -noise ? 'down' : 'flat';
  // A step-function series (a policy rate that holds, then moves) has a zero MAD
  // of differences, so ANY move is significant — which is the right verdict. But
  // the raw ratio is then unbounded and would report strength=1e7, so it is
  // capped: past the cap the number stops carrying information.
  const raw = change === 0 ? 0 : Math.abs(change) / noise;
  const strength = Math.min(raw, 99);
  return { direction, change, lookback: span, noise, strength };
}

/** One dimension's resolved reading, ready for the rule table and the UI. */
export type DimensionReading = {
  id: DimensionId;
  label: string;
  /** The canonical slug the reading came from (e.g. `us-cpi`). */
  series: string;
  unit: string;
  decimals: number;
  latest: { date: string; value: number } | null;
  prior: { date: string; value: number } | null;
  trend: TrendResult | null;
  /** The vocabulary word, or null when the dimension could not be read. */
  word: string | null;
  /** The rule-table tag, or null when unreadable. */
  tag: string | null;
  /** Why the reading is absent, when it is. */
  reason: string | null;
};

/** A series handed to `buildRegime`, already read and filtered by the route. */
export type SeriesInput = {
  id: DimensionId;
  slug: string;
  label: string;
  unit: string;
  decimals: number;
  /** Oldest → newest, finite values only. */
  values: readonly number[];
  dates: readonly string[];
  lookback: number;
  /** Set when the route could not read the series at all. */
  failure?: string | null;
};

/** Periods back a trend is measured, per publication cadence. */
export const LOOKBACK_BY_FREQUENCY: Readonly<Record<string, number>> = {
  daily: 30,
  weekly: 12,
  monthly: 6,
  quarterly: 4,
  annual: 3,
};

/** Read one dimension from a series input. Pure. */
export function readDimension(input: SeriesInput): DimensionReading {
  const base = { id: input.id, label: input.label, series: input.slug, unit: input.unit, decimals: input.decimals };
  if (input.failure) {
    return { ...base, latest: null, prior: null, trend: null, word: null, tag: null, reason: input.failure };
  }
  const trend = classifyTrend(input.values, input.lookback);
  if (!trend) {
    return { ...base, latest: null, prior: null, trend: null, word: null, tag: null, reason: 'not enough published observations to establish a direction' };
  }
  const n = input.values.length;
  const span = trend.lookback;
  const latest = { date: input.dates[n - 1] ?? '', value: input.values[n - 1] };
  const prior = { date: input.dates[n - 1 - span] ?? '', value: input.values[n - 1 - span] };
  return {
    ...base,
    latest,
    prior,
    trend,
    word: VOCAB[input.id][trend.direction],
    tag: TAGS[input.id][trend.direction],
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// Regime rules
// ---------------------------------------------------------------------------

export type RegimeRule = {
  code: string;
  label: string;
  /** One line stating what the combination means. */
  summary: string;
  /** Every listed dimension must be readable AND carry one of the listed tags. */
  when: Partial<Record<DimensionId, readonly string[]>>;
};

/**
 * Ordered, first match wins. Specificity is the order: a rule naming three
 * dimensions is tested before one naming two, so "growth cooling while
 * inflation re-accelerates" cannot be shadowed by the looser "growth cooling".
 */
export const REGIME_RULES: readonly RegimeRule[] = [
  {
    code: 'stagflation',
    label: 'Stagflation risk',
    summary: 'growth is cooling while inflation re-accelerates — the policy trade-off is at its worst, because easing would feed the price pressure it is meant to answer.',
    when: { growth: ['cool'], inflation: ['hot'] },
  },
  {
    code: 'overheating',
    label: 'Overheating',
    summary: 'growth and inflation are both running hot and policy is still tightening — demand is outrunning capacity.',
    when: { growth: ['hot'], inflation: ['hot'], policy: ['tight'] },
  },
  {
    code: 'goldilocks-easing',
    label: 'Goldilocks easing',
    summary: 'growth is holding up while inflation cools and policy eases — the most supportive combination for risk assets.',
    when: { growth: ['hot'], inflation: ['cool'], policy: ['ease'] },
  },
  {
    code: 'late-cycle-easing',
    label: 'Late-cycle easing',
    summary: 'growth is cooling, inflation is falling, and policy has turned — a late-cycle easing regime, historically supportive for duration and risk assets once the slowdown stops deepening.',
    when: { growth: ['cool'], inflation: ['cool'], policy: ['ease'] },
  },
  {
    code: 'reflation',
    label: 'Reflation',
    summary: 'growth and inflation are rising together — nominal activity is re-accelerating.',
    when: { growth: ['hot'], inflation: ['hot'] },
  },
  {
    code: 'goldilocks',
    label: 'Goldilocks',
    summary: 'growth is firm while inflation cools — a benign expansion.',
    when: { growth: ['hot'], inflation: ['cool'] },
  },
  {
    code: 'disinflationary-slowdown',
    label: 'Disinflationary slowdown',
    summary: 'growth and inflation are both falling — activity is cooling and price pressure is easing with it.',
    when: { growth: ['cool'], inflation: ['cool'] },
  },
  {
    code: 'policy-drag',
    label: 'Policy drag',
    summary: 'growth is cooling while policy is still tightening — the brake is applied into a slowdown.',
    when: { growth: ['cool'], policy: ['tight'] },
  },
  {
    code: 'liquidity-drain',
    label: 'Liquidity drain',
    summary: 'liquidity is contracting while policy tightens — the two most direct drains on risk assets are aligned.',
    when: { liquidity: ['contract'], policy: ['tight'] },
  },
  {
    code: 'liquidity-driven-easing',
    label: 'Liquidity-driven easing',
    summary: 'liquidity is expanding while policy eases — the two most direct supports for risk assets are aligned.',
    when: { liquidity: ['expand'], policy: ['ease'] },
  },
  {
    code: 'mid-cycle-expansion',
    label: 'Mid-cycle expansion',
    summary: 'growth is accelerating without a decisive inflation signal — a mid-cycle expansion.',
    when: { growth: ['hot'] },
  },
  {
    code: 'slowdown-policy-hold',
    label: 'Slowdown, policy on hold',
    summary: 'growth is cooling but policy has not moved — the market is waiting on the central bank.',
    when: { growth: ['cool'], policy: ['hold'] },
  },
  {
    code: 'cooling-sticky-prices',
    label: 'Cooling, sticky prices',
    summary: 'growth is cooling while inflation refuses to follow — the easing the slowdown would normally invite is not yet available.',
    when: { growth: ['cool'], inflation: ['sticky'] },
  },
  {
    code: 'inflationary-drift',
    label: 'Inflationary drift',
    summary: 'growth is steady while inflation re-accelerates — the price signal is moving on its own, without a demand impulse behind it.',
    when: { growth: ['steady'], inflation: ['hot'] },
  },
  {
    code: 'disinflationary-drift',
    label: 'Disinflationary drift',
    summary: 'growth is steady while inflation cools — price pressure is easing without the cost of a slowdown.',
    when: { growth: ['steady'], inflation: ['cool'] },
  },
  {
    code: 'wait-and-see',
    label: 'Wait-and-see',
    summary: 'growth is steady, inflation is sticky, and policy has not moved — no dimension has broken decisively in either direction.',
    // Requires policy to be genuinely idle. Without the third clause a country
    // holding rates steady while tightening would be labelled "wait-and-see",
    // which hides the one dimension that is actually moving.
    when: { growth: ['steady'], inflation: ['sticky'], policy: ['hold'] },
  },
  {
    code: 'easing',
    label: 'Easing cycle',
    summary: 'policy is easing — the direction of travel is accommodative.',
    when: { policy: ['ease'] },
  },
  {
    code: 'tightening',
    label: 'Tightening cycle',
    summary: 'policy is tightening — the direction of travel is restrictive.',
    when: { policy: ['tight'] },
  },
];

/** The rule a set of readings matches, or null when none does. Pure. */
export function matchRegime(readings: readonly DimensionReading[]): RegimeRule | null {
  const byId = new Map(readings.map((r) => [r.id, r]));
  for (const rule of REGIME_RULES) {
    let ok = true;
    for (const [id, tags] of Object.entries(rule.when) as [DimensionId, readonly string[]][]) {
      const r = byId.get(id);
      if (!r || r.tag === null || !tags.includes(r.tag)) {
        ok = false;
        break;
      }
    }
    if (ok) return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Market impact
// ---------------------------------------------------------------------------

/**
 * Directional weights, per dimension reading. POSITIVE = supportive for that
 * asset, NEGATIVE = a headwind. These are stated heuristics, not estimates:
 * they encode the conventional transmission channel of each dimension (liquidity
 * and policy dominate risk assets; inflation dominates duration; a stronger
 * dollar tightens global conditions) and every contribution is returned to the
 * caller so a reader can audit the sum instead of trusting it.
 */
const IMPACT_WEIGHTS: Readonly<Record<string, Partial<Record<AssetId, number>>>> = {
  'growth:hot': { equity: 1.5, btc: 1.0, gold: -0.5, bonds: -0.5, usd: 0.5 },
  'growth:cool': { equity: -1.0, btc: -1.0, gold: 0.5, bonds: 1.0, usd: 0.5 },
  'growth:steady': {},
  'inflation:hot': { gold: 1.5, btc: 0.5, bonds: -1.5, equity: -1.0, usd: -0.5 },
  'inflation:cool': { bonds: 1.0, equity: 1.0, btc: 0.5, usd: -0.5 },
  'inflation:sticky': {},
  'labor:loose': { bonds: 0.5, equity: -0.5, btc: -0.5 },
  'labor:tight': { equity: 0.5, btc: 0.5, bonds: -0.5 },
  'labor:stable': {},
  'liquidity:expand': { btc: 2.0, equity: 1.0, gold: 0.5, bonds: 0.5, usd: -1.0 },
  'liquidity:contract': { btc: -2.0, equity: -1.0, gold: -0.5, bonds: -0.5, usd: 1.0 },
  'liquidity:flat': {},
  'policy:ease': { bonds: 1.5, equity: 1.0, btc: 1.0, gold: 1.0, usd: -1.0 },
  'policy:tight': { bonds: -1.5, equity: -1.0, btc: -1.0, gold: -1.0, usd: 1.0 },
  'policy:hold': {},
};

export type ImpactContribution = { dimension: DimensionId; word: string; weight: number };
export type ImpactRow = { asset: AssetId; label: string; stance: Stance; score: number; contributions: ImpactContribution[] };

/** Map a score to a stance. Pure; thresholds are the table's own units. */
export function stanceFor(score: number): Stance {
  if (score >= 2) return 'strongly bullish';
  if (score >= 0.75) return 'bullish';
  if (score <= -2) return 'strongly bearish';
  if (score <= -0.75) return 'bearish';
  return 'neutral';
}

/** Score every asset class from the readings. Pure. */
export function scoreImpacts(readings: readonly DimensionReading[]): ImpactRow[] {
  const rows: ImpactRow[] = ASSETS.map((a) => ({ asset: a.id, label: a.label, stance: 'neutral' as Stance, score: 0, contributions: [] }));
  const byAsset = new Map(rows.map((r) => [r.asset, r]));
  for (const r of readings) {
    if (!r.tag || !r.word) continue;
    const w = IMPACT_WEIGHTS[`${r.id}:${r.tag}`];
    if (!w) continue;
    for (const [asset, weight] of Object.entries(w) as [AssetId, number][]) {
      const row = byAsset.get(asset);
      if (!row || weight === 0) continue;
      row.score = Math.round((row.score + weight) * 100) / 100;
      row.contributions.push({ dimension: r.id, word: r.word, weight });
    }
  }
  for (const row of rows) row.stance = stanceFor(row.score);
  return rows;
}

// ---------------------------------------------------------------------------
// Liquidity breadth (shared with the liquidity board)
// ---------------------------------------------------------------------------

/**
 * The breadth score over a set of liquidity components: the share of live
 * components moving in their LOOSENING direction, 0–100, each casting one vote.
 * Extracted so the liquidity board and the regime engine cannot disagree about
 * what "liquidity is expanding" means.
 *
 * `change * direction > 0` is the loosening test, which is why `direction`
 * exists on the spec at all: a rising reverse-repo balance DRAINS reserves, so
 * a board that treated every rise as expansion would be confidently wrong in
 * exactly the regime it exists to detect.
 */
export function liquidityBreadth(
  components: readonly { change: number | null; direction: 1 | -1 }[]
): { value: number; trend: 'Expanding' | 'Neutral' | 'Contracting'; components: number } | null {
  const live = components.filter((c) => c.change !== null);
  if (live.length === 0) return null;
  let expand = 0;
  let contract = 0;
  for (const c of live) {
    const vote = Math.sign((c.change as number) * c.direction);
    if (vote > 0) expand++;
    else if (vote < 0) contract++;
  }
  const total = live.length;
  const value = Math.round(((expand + (total - expand - contract) * 0.5) / total) * 100);
  const trend = value >= 58 ? 'Expanding' : value <= 42 ? 'Contracting' : 'Neutral';
  return { value, trend, components: total };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export type MacroRegime = {
  /**
   * The scope's DISPLAY NAME ("Global", or a country's name).
   *
   * Deliberately named `subject`, NOT `scope`. The API route spreads this
   * result into a payload that already carries a `scope` OBJECT
   * (`{kind:"global"|"country"}`); while this key was called `scope` it
   * silently overwrote that object with this string, and every consumer
   * reading `scope.kind` crashed. tests/regime-tests.ts pins the name.
   */
  subject: string;
  dimensions: DimensionReading[];
  regime: { code: string; label: string; summary: string } | null;
  /** Why no rule fired, when none did. */
  regimeReason: string | null;
  confidence: 'high' | 'medium' | 'low';
  impacts: ImpactRow[];
  /** Dimensions that could not be read, by id. */
  missing: DimensionId[];
  /** A deterministic reading of the computed facts. No model involved. */
  narrative: string;
};

/** Dimensions a regime needs before it is worth stating, in display order. */
export const DIMENSION_ORDER: readonly DimensionId[] = ['growth', 'inflation', 'labor', 'liquidity', 'policy'];

/** The display name of each dimension. */
export const DIMENSION_LABEL: Readonly<Record<DimensionId, string>> = {
  growth: 'Growth',
  inflation: 'Inflation',
  labor: 'Labor',
  liquidity: 'Liquidity',
  policy: 'Policy',
};

export function buildRegime(subject: string, series: readonly SeriesInput[]): MacroRegime {
  const byId = new Map(series.map((s) => [s.id, s]));
  const dimensions = DIMENSION_ORDER.map((id) => {
    const input = byId.get(id);
    if (!input) {
      return {
        id,
        label: DIMENSION_LABEL[id],
        series: '',
        unit: '',
        decimals: 2,
        latest: null,
        prior: null,
        trend: null,
        word: null,
        tag: null,
        reason: 'no series is bound to this dimension',
      } satisfies DimensionReading;
    }
    return readDimension(input);
  });

  const missing = dimensions.filter((d) => d.tag === null).map((d) => d.id);
  const matched = matchRegime(dimensions);
  const readable = dimensions.filter((d) => d.trend !== null);
  // A dimension that cleared its noise floor is a MOVING dimension; one that did
  // not is a genuine "steady" reading, not evidence for the regime either way.
  const directional = readable.filter((d) => (d.trend?.strength ?? 0) >= 1).length;

  // Confidence is about EVIDENCE, not about the regime being right: how many of
  // the five dimensions resolved, and how many of those actually moved.
  const confidence: MacroRegime['confidence'] =
    readable.length >= 5 && directional >= 3 ? 'high' : readable.length >= 3 && directional >= 2 ? 'medium' : 'low';

  const impacts = scoreImpacts(dimensions);

  const regimeReason = matched
    ? null
    : readable.length === 0
      ? 'no dimension could be read from published observations'
      : `no rule matched the readings (${dimensions.filter((d) => d.word).map((d) => `${d.label} ${d.word}`).join(', ')})`;

  return {
    subject,
    dimensions,
    regime: matched ? { code: matched.code, label: matched.label, summary: matched.summary } : null,
    regimeReason,
    confidence,
    impacts,
    missing,
    narrative: narrate(subject, dimensions, matched, impacts, confidence),
  };
}

/**
 * A deterministic sentence-per-fact reading. It restates ONLY what was computed
 * — the words, the regime, the stance table — so it cannot drift from the
 * numbers above it. This is the seam where an LLM may later rewrite the prose;
 * it must never be the place a number is produced.
 */
function narrate(
  subject: string,
  dimensions: readonly DimensionReading[],
  matched: RegimeRule | null,
  impacts: readonly ImpactRow[],
  confidence: MacroRegime['confidence']
): string {
  const parts: string[] = [];
  const read = dimensions.filter((d) => d.word !== null);
  if (read.length === 0) {
    return `${subject}: no dimension could be read from published observations, so no regime is stated.`;
  }
  parts.push(
    `${subject}: ${read.map((d) => `${d.label.toLowerCase()} ${d.word?.toLowerCase()}`).join(', ')}` +
      (read.length < dimensions.length ? ` (${dimensions.length - read.length} of ${dimensions.length} dimension(s) unreadable)` : '') +
      '.'
  );
  parts.push(
    matched
      ? `That combination reads as ${matched.label.toLowerCase()}.`
      : 'No rule in the table matches that combination, so no regime label is applied.'
  );
  const directional = impacts.filter((i) => i.stance !== 'neutral');
  parts.push(
    directional.length > 0
      ? `The weight table scores ${directional.map((i) => `${i.label} ${i.stance}`).join(', ')}.`
      : 'The weight table leaves every asset class neutral.'
  );
  parts.push(`Evidence confidence: ${confidence}. This is a rule table over published observations, not a forecast.`);
  return parts.join(' ');
}

/**
 * The economy domain's CLIENT — the only thing a view is allowed to know about
 * where a number came from (plan Phase 11).
 *
 * WHY THIS FILE EXISTS. The whole point of the module's shape is that a view
 * never learns the name "FRED". A page imports these types and these two fetch
 * helpers; the upstream, its credential, its rate limit and its revision
 * behaviour live behind `/api/economy/*` and can be replaced without touching a
 * single component. If a component ever needs `fredUrl` or `WORLDBANK_API` to
 * render, the layering has already failed.
 *
 * The envelope types below are the contract with the route layer, and they carry
 * the project's honesty rules as TYPES: every measured value is `number | null`
 * so "the upstream published nothing" cannot be silently rendered as `0`, and
 * every row keeps the `date` its value belongs to, because a number without a
 * reference period is not a measurement.
 */

import { getJSON } from '@/lib/fetch';

/** One headline cell on a country or dashboard board. */
export type Metric = {
  slug: string;
  label: string;
  category: string;
  /** `null` when the upstream has no published observation — rendered `—`. */
  value: number | null;
  /** The period the value belongs to (e.g. `2026-08`, `2025`), never "now". */
  date: string | null;
  /** The observation one period earlier, when the window holds one. */
  previous: number | null;
  unit: string;
  decimals: number;
  frequency: string;
  source: string;
  /** `null` when the source does not state a seasonal adjustment. */
  seasonalAdjustment: string | null;
};

/** One row of an indicator table. */
export type IndicatorRow = Metric & { importance: number; note: string };

/** A category block on a country profile. */
export type CategoryBlock = { category: string; label: string; rows: IndicatorRow[] };

/** One scheduled or recently published event. */
export type ReleaseRow = {
  slug: string;
  label: string;
  country: string | null;
  category: string;
  importance: number;
  unit: string;
  /** ISO-8601 instant, or null when the source states no publication time. */
  releaseAt: string | null;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  revised: number | null;
};

/** A country summary on the explorer. */
export type CountrySummary = {
  id: string;
  iso2: string;
  iso3: string;
  name: string;
  region: string;
  currency: string;
  timezone: string | null;
  indicatorCount: number;
};

export type CountriesEnvelope = {
  countries: CountrySummary[];
  regions: string[];
  total: number;
  asOf: number;
};

export type CountryEnvelope = {
  country: CountrySummary;
  keyMetrics: Metric[];
  groups: CategoryBlock[];
  releases: ReleaseRow[];
  /** Upstream items that failed, named so a gap is never silent. */
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

export type IndicatorMeta = {
  slug: string;
  name: string;
  country: string | null;
  countryName: string | null;
  category: string;
  subcategory: string;
  unit: string;
  frequency: string;
  seasonalAdjustment: string;
  source: string;
  importance: number;
  decimals: number;
  note: string;
};

export type IndicatorsEnvelope = {
  indicators: IndicatorMeta[];
  total: number;
  /** The size of the whole registry, so a filtered count can say "of N". */
  registryTotal: number;
  facets: {
    categories: { id: string; label: string; count: number }[];
    countries: { id: string; name: string; count: number }[];
    frequencies: { id: string; count: number }[];
    sources: { id: string; count: number }[];
  };
  asOf: number;
};

export type IndicatorEnvelope = {
  indicator: IndicatorMeta;
  observations: { date: string; value: number | null; previous: number | null }[];
  latest: { date: string; value: number } | null;
  release: ReleaseRow | null;
  related: IndicatorMeta[];
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

export type CentralBankRow = {
  slug: string;
  short: string;
  name: string;
  area: string;
  country: string | null;
  region: string;
  note: string;
  rate: number | null;
  date: string | null;
  /** The previous DISTINCT rate — null when the window holds only one level. */
  previousRate: number | null;
};

export type CentralBanksEnvelope = {
  banks: CentralBankRow[];
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

export type CentralBankEnvelope = {
  bank: CentralBankRow;
  history: { date: string; value: number | null }[];
  /** Each level change with the date it took effect — the decision list. */
  changes: { date: string; from: number; to: number }[];
  related: IndicatorMeta[];
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

export type LiquidityComponent = {
  id: string;
  label: string;
  /** The level as the upstream publishes it. */
  value: number | null;
  unit: string;
  date: string | null;
  previous: number | null;
  /** The change over the window, in the series' own unit. */
  change: number | null;
  /** Whether a rising value is looser (`+1`) or tighter (`-1`) liquidity. */
  direction: 1 | -1;
  source: string;
  note: string;
};

export type LiquidityEnvelope = {
  components: LiquidityComponent[];
  index: { value: number; trend: 'Expanding' | 'Neutral' | 'Contracting'; components: number } | null;
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

export type CompareSeries = {
  slug: string;
  label: string;
  country: string | null;
  unit: string;
  decimals: number;
  frequency: string;
  points: { date: string; value: number | null }[];
};

export type CompareEnvelope = {
  period: string;
  series: CompareSeries[];
  /** Slugs the request named that resolved to nothing. */
  missing: string[];
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

export type CalendarEnvelope = {
  events: ReleaseRow[];
  window: { from: string; to: string };
  total: number;
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

/** One dimension's reading in a macro regime. */
export type RegimeDimension = {
  id: string;
  label: string;
  /** The canonical slug the reading came from, or '' when none is bound. */
  series: string;
  unit: string;
  decimals: number;
  latest: { date: string; value: number } | null;
  prior: { date: string; value: number } | null;
  /** `null` when the series could not be read — a first-class answer, not "flat". */
  trend: { direction: 'up' | 'down' | 'flat'; change: number; lookback: number; noise: number; strength: number } | null;
  word: string | null;
  tag: string | null;
  reason: string | null;
};

export type RegimeImpact = {
  asset: string;
  label: string;
  stance: string;
  score: number;
  /** Every weight that produced the score, so the sum can be audited. */
  contributions: { dimension: string; word: string; weight: number }[];
};

export type RegimeEnvelope = {
  /** The scope as an OBJECT. Distinct from `subject`, which is its display name. */
  scope: { kind: 'global'; anchor: { iso3: string; name: string } } | { kind: 'country'; country: Country };
  /** The scope's display name ("Global", or a country's name). */
  subject: string;
  dimensions: RegimeDimension[];
  regime: { code: string; label: string; summary: string } | null;
  /** Why no rule fired, when none did. */
  regimeReason: string | null;
  confidence: 'high' | 'medium' | 'low';
  impacts: RegimeImpact[];
  /** Dimensions that could not be read, by id. */
  missing: string[];
  /** A deterministic reading of the computed facts. No model involved. */
  narrative: string;
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

/** The base path every helper here talks to. Views never call an upstream. */
export const ECONOMY_API = '/api/economy';

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return getJSON<T>(path, { signal });
}

export function fetchCountries(signal?: AbortSignal): Promise<CountriesEnvelope> {
  return getJson(`${ECONOMY_API}/countries`, signal);
}

export function fetchCountry(code: string, signal?: AbortSignal): Promise<CountryEnvelope> {
  return getJson(`${ECONOMY_API}/countries/${encodeURIComponent(code)}`, signal);
}

export type IndicatorQuery = {
  category?: string;
  country?: string;
  frequency?: string;
  source?: string;
  importance?: number;
  q?: string;
};

export function fetchIndicators(query: IndicatorQuery = {}, signal?: AbortSignal): Promise<IndicatorsEnvelope> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
  }
  const qs = p.toString();
  return getJson(`${ECONOMY_API}/indicators${qs ? `?${qs}` : ''}`, signal);
}

export function fetchIndicator(slug: string, signal?: AbortSignal): Promise<IndicatorEnvelope> {
  return getJson(`${ECONOMY_API}/indicators/${encodeURIComponent(slug)}`, signal);
}

export function fetchCentralBanks(signal?: AbortSignal): Promise<CentralBanksEnvelope> {
  return getJson(`${ECONOMY_API}/central-banks`, signal);
}

export function fetchCentralBank(slug: string, signal?: AbortSignal): Promise<CentralBankEnvelope> {
  return getJson(`${ECONOMY_API}/central-banks/${encodeURIComponent(slug)}`, signal);
}

export function fetchLiquidity(signal?: AbortSignal): Promise<LiquidityEnvelope> {
  return getJson(`${ECONOMY_API}/liquidity`, signal);
}

export function fetchCompare(
  slugs: readonly string[],
  period: string,
  signal?: AbortSignal
): Promise<CompareEnvelope> {
  const p = new URLSearchParams({ indicators: slugs.join(','), period });
  return getJson(`${ECONOMY_API}/compare?${p}`, signal);
}

export type CalendarQuery = { from?: string; to?: string; country?: string; category?: string; importance?: number };

export function fetchCalendar(query: CalendarQuery = {}, signal?: AbortSignal): Promise<CalendarEnvelope> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
  }
  const qs = p.toString();
  return getJson(`${ECONOMY_API}/calendar${qs ? `?${qs}` : ''}`, signal);
}

/** The macro regime for a country, or global when `country` is omitted. */
export function fetchRegime(country?: string, signal?: AbortSignal): Promise<RegimeEnvelope> {
  const qs = country ? `?country=${encodeURIComponent(country)}` : '';
  return getJson(`${ECONOMY_API}/regime${qs}`, signal);
}

// ---------------------------------------------------------------------------
// Formatting. One place decides how a missing value and a number look, so a
// board and a detail page can never disagree about what an em dash means.
// ---------------------------------------------------------------------------

/** The project's single spelling of "the upstream published nothing". */
export const NO_VALUE = '—';

export function formatValue(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** A compact magnitude for a level too large to print in full (reserves, GDP). */
export function formatCompact(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  const abs = Math.abs(value);
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [scale, suffix] of units) {
    if (abs >= scale) return `${(value / scale).toFixed(decimals)}${suffix}`;
  }
  return value.toFixed(decimals);
}

/** Whether a change reads as up, down or flat — the sign a tint keys off. */
export function changeSign(change: number | null | undefined): -1 | 0 | 1 {
  if (change === null || change === undefined || !Number.isFinite(change) || change === 0) return 0;
  return change > 0 ? 1 : -1;
}

/** A signed delta with the series' own decimals, for a "vs prior" cell. */
export function formatDelta(change: number | null | undefined, decimals: number): string {
  if (change === null || change === undefined || !Number.isFinite(change)) return NO_VALUE;
  const s = change > 0 ? '+' : '';
  return `${s}${change.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return NO_VALUE;
  // Periods arrive as `2026-08` / `2025` / a full instant; only the date part is
  // ever shown, and a period is NOT reformatted into a local midnight (which
  // would shift a month back a day in a negative-offset zone).
  return iso.length <= 10 ? iso : iso.slice(0, 10);
}

/** A relative "how stale is this" label for a release or a rate. */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return NO_VALUE;
  const t = Date.parse(iso.length === 7 ? `${iso}-01` : iso.length === 4 ? `${iso}-01-01` : iso);
  if (!Number.isFinite(t)) return NO_VALUE;
  const days = Math.round((t - now) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0) return `in ${days}d`;
  return `${-days}d ago`;
}
