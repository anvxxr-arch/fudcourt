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
    path: '/chainrank',
    title: 'ChainRank — Chain rankings | FUDCOURT',
    description:
      'ChainRank compares chains by activity, liquidity and treasury flow.',
    priority: 0.6,
  },
  {
    path: '/news',
    title: 'News — Crypto market news | FUDCOURT',
    description:
      'Latest crypto market news aggregated for treasury and trading decisions.',
    priority: 0.5,
  },
  {
    path: '/khala',
    title: 'Khala — Research reports | FUDCOURT',
    description:
      'Khala Research reports read inside FUDCOURT: latest publications with resolved dates, the full archive, and the complete report text as a reader view.',
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
];
