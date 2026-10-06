// Single source of truth for robots/sitemap and the public crawl tier.
// If routes are restructured (e.g. /team, /admin, /member split), edit this
// array only — app/robots.ts and app/sitemap.ts iterate it.
export interface PublicRoute {
  path: string;
  title: string;
  description: string;
  priority: number;
}

export const PUBLIC_ROUTES: PublicRoute[] = [
  {
    path: '/',
    title: 'FUDCOURT — Community, terminal, and management',
    description:
      'FUDCOURT is community, terminal, and management: verified market intelligence boards for everyone, a cross-chain treasury terminal for the team, and an admin control panel for management.',
    priority: 1,
  },
  {
    path: '/signals',
    title: 'Signals — Trading signals feed | FUDCOURT',
    description:
      'Curated trading signals feed with entry levels, confidence and historical accuracy.',
    priority: 0.7,
  },
  {
    path: '/scoreboard',
    title: 'Scoreboard — Trader rankings | FUDCOURT',
    description:
      'Scoreboard ranking tracked traders and wallets by realized performance.',
    priority: 0.7,
  },
  {
    path: '/news',
    title: 'News — Crypto market news | FUDCOURT',
    description:
      'Latest crypto market news aggregated for treasury and trading decisions.',
    priority: 0.5,
  },
  {
    // The blog joined this app in DR-017. Its index is public and crawlable
    // (individual posts at /blog/<slug>, authored in Payload, carry no fixed
    // list, so they are not enumerated here — the index links them).
    path: '/blog',
    title: 'Blog — Research, playbooks & insights | FUDCOURT',
    description:
      'Insights, research, and playbooks from FUDCOURT, published through the Payload CMS.',
    priority: 0.6,
  },
  {
    path: '/market',
    title: 'Market — Crypto, forex, commodity, stock & DEX | FUDCOURT',
    description:
      'The FUDCOURT market hub: cross-checked centralized-exchange instruments, on-chain DEX pairs, and per-asset-class sections for crypto, forex, commodity and stock.',
    priority: 0.8,
  },
  {
    path: '/market/crypto',
    title: 'Crypto — CEX instruments & prices | FUDCOURT',
    description:
      'Crypto market section: spot, perpetual, dated future and option instruments cross-checked across centralized exchanges, plus a top-250 market-cap board.',
    priority: 0.8,
  },
  {
    path: '/market/forex',
    title: 'Forex — Currency pairs | FUDCOURT',
    description:
      'Forex section of the FUDCOURT market hub — curated major pairs from the exchangerate-api free feed.',
    priority: 0.7,
  },
  {
    path: '/market/commodity',
    title: 'Commodity — Metals, energy & agriculture | FUDCOURT',
    description:
      'Commodity section of the FUDCOURT market hub — front-month metals, energy and agriculture futures from Yahoo Finance.',
    priority: 0.7,
  },
  {
    path: '/market/stock',
    title: 'Stock — Equities | FUDCOURT',
    description:
      'Stock section of the FUDCOURT market hub — US, Asia and Europe indices and blue chips from Yahoo Finance.',
    priority: 0.7,
  },
  {
    path: '/market/trench',
    title: 'Trench — DEX pairs & live trench | FUDCOURT',
    description:
      'On-chain DEX section: per-pair liquidity, transactions and FDV, plus the live trench, from DexScreener.',
    priority: 0.7,
  },
  {
    // The trading domain's front door (trade plan Phase 6). Its market-type
    // boards (/trade/<marketType>) are a bounded, known set — the taxonomy
    // itself — so sitemap.ts enumerates them from it, never from a crawl.
    path: '/trade',
    title: 'Trade — Command center | FUDCOURT',
    description:
      'One trading surface across spot, margin, perpetual, futures, options and swap. Market type is what you trade; the venue is only where it executes — CEX and DEX behind one intent, risk engine and execution engine.',
    priority: 0.8,
  },
  {
    // The connected-account surface (plan Phase 17): the masked venue keys, the
    // permission each venue reports, and a capability summary read from the same
    // matrix the boards render. Public like /trade itself — an unauthenticated
    // visitor sees the connect prompt, never another user's account.
    path: '/trade/accounts',
    title: 'Trade accounts — Connected venues | FUDCOURT',
    description:
      'Every venue your trading connects to: the masked API key, the permission the venue reports, and the order types each venue supports — with a withdrawal-capable key warned, never hidden.',
    priority: 0.5,
  },
  {
    // The macro module's front door (plan Phase 4). Its six sub-boards are
    // listed below; the dynamic profiles (/economy/nation/<cc>,
    // /economy/indicator/<slug>, /economy/central-bank/<slug>) are enumerated
    // by sitemap.ts from the registry's own allowlist, never from a crawl.
    path: '/economy',
    title: 'Economy — Global macro dashboard | FUDCOURT',
    description:
      'Global macro dashboard: growth, inflation, labour, money and policy across the major economies, read from FRED, the World Bank and BIS and normalised to one canonical model.',
    priority: 0.8,
  },
  {
    // The country index. Its 125 profile pages are dynamic, so — like the
    // per-coin pages — they are enumerated by sitemap.ts from the family's own
    // allowlist rather than listed here.
    path: '/economy/nation',
    title: 'Economy by nation — 125 economies | FUDCOURT',
    description:
      'Per-country economy profiles: growth, inflation, labour, money, fiscal and trade series, plus the policy rate, normalised to one canonical model.',
    priority: 0.7,
  },
  {
    path: '/economy/indicator',
    title: 'Indicators — Canonical economic series | FUDCOURT',
    description:
      'Browse every canonical economic series by category, country, frequency and source. Each row is one upstream binding behind a stable slug.',
    priority: 0.7,
  },
  {
    path: '/economy/central-bank',
    title: 'Central banks — Policy rates | FUDCOURT',
    description:
      'Policy rates for the major central banks, from BIS WS_CBPOL: level, last move and history, grouped by region.',
    priority: 0.7,
  },
  {
    path: '/economy/calendar',
    title: 'Economic calendar — Release log | FUDCOURT',
    description:
      'A release log of market-moving economic series by reference period, filterable by country, category and date.',
    priority: 0.6,
  },
  {
    path: '/economy/liquidity',
    title: 'Liquidity — Global plumbing | FUDCOURT',
    description:
      'Central-bank balance sheets, reserves, reverse repo, the dollar and financial conditions, with a derived global liquidity index for risk assets.',
    priority: 0.7,
  },
  {
    path: '/economy/regime',
    title: 'Macro regime — Growth, inflation, liquidity, policy | FUDCOURT',
    description:
      'Growth, inflation, labour, liquidity and policy read from published observations and matched against an explicit rule table, with a stated weight table for potential asset impact.',
    priority: 0.7,
  },
  {
    // Discord sign-in landing (middleware 307 target for /team, /admin and the
    // treasury API, plus the OAuth failure return). Public and crawlable like
    // the other static boards -- an unauthenticated visitor sees the sign-in
    // panel, never another user's session.
    path: '/login',
    title: 'Sign In with Discord to Open Your Terminal | FUDCOURT',
    description:
      'Sign in with Discord to open your FudCourt member terminal. Browsing stays free — sign-in only unlocks private terminals.',
    priority: 0.3,
  },
  {
    path: '/economy/compare',
    title: 'Compare — Countries & series | FUDCOURT',
    description:
      'Compare any countries on any measures over one period. The query lives in the URL, so a comparison is shareable without a page per combination.',
    priority: 0.6,
  },
];
