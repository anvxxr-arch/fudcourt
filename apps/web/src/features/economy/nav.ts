/** The economy module's entry nav, consumed by every economy PageHeader. */
export const ECONOMY_NAV = [
  { href: '/economy', label: 'Dashboard' },
  { href: '/economy/nation', label: 'Nations' },
  { href: '/economy/indicator', label: 'Indicators' },
  { href: '/economy/central-bank', label: 'Central banks' },
  { href: '/economy/regime', label: 'Regime' },
  { href: '/economy/liquidity', label: 'Liquidity' },
  { href: '/economy/calendar', label: 'Calendar' },
  { href: '/economy/compare', label: 'Compare' },
] as const;
