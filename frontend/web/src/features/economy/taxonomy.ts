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
