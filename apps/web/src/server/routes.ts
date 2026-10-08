// Single source of truth for robots/sitemap and the public crawl tier.
// If routes are restructured (e.g. /team, /admin, /member split), edit this
// array only — app/robots.ts and app/sitemap.ts iterate it.
import 'server-only';
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
    // The risk feed (F10): prediction-market pricing beside the headlines being
    // reported. Public like the other boards — an unauthenticated visitor sees
    // the reading, never anything private.
    path: '/risk',
    title: 'Prediction markets & event risk | FUDCOURT',
    description:
      'Prediction-market pricing joined with the headlines being reported. Every probability is the mid of a two-sided book, a thin book is marked wide, and no headline is claimed to have moved a price.',
    priority: 0.6,
  },
  {
    // The public proof of treasury (F11): the aggregate total, a per-chain
    // breakdown and a SHA-256 commitment to the private holdings behind them.
    // Public by design — it publishes aggregates and a digest, never a wallet
    // address or a per-asset position. Registered here so it is crawlable and
    // so `routing-tests.ts` sees the `(public)/proof` page.
    path: '/proof',
    title: 'Proof of treasury — the public commitment | FUDCOURT',
    description:
      'The treasury\u2019s public commitment: an aggregate total, a per-chain breakdown and a SHA-256 digest over the full snapshot. Only aggregates are published; the holdings behind the digest stay private and can be revealed later.',
    priority: 0.6,
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
  {
    // The derivatives desk: the futures tape the /risk board does not read —
    // open interest, funding extremes, liquidations per venue and the
    // long/short ratio, all keyless from CoinGlass and CoinAnk.
    path: '/derivatives',
    title: 'Derivatives — Open interest, funding & liquidations | FUDCOURT',
    description:
      'The futures tape: open interest and its change, funding-rate extremes, per-venue liquidations across six intervals, and the long/short ratio. Every field is read verbatim from the venue aggregates; a missing venue is a dash, never a zero.',
    priority: 0.7,
  },
  {
    // The spot-ETF flow desk: daily creations and redemptions per issuer.
    path: '/etf',
    title: 'ETF flows — Daily creations & redemptions | FUDCOURT',
    description:
      'Spot-Bitcoin ETF flows per issuer per day: net creations and redemptions in USD and BTC, a cumulative series and per-issuer totals. Rows the upstream ships without a ticker are grouped as unlabelled rather than given a fabricated name.',
    priority: 0.7,
  },
  {
    // The global market pulse: dominance, segment volumes, gas, venue ranking.
    path: '/global',
    title: 'Global — Market cap, dominance & venue ranking | FUDCOURT',
    description:
      'The whole-market read: total market cap and 24h volume, BTC and ETH dominance with their daily change, DeFi, stablecoin and derivatives segment volumes, the gas oracle, and the venue ranking by reported volume and market share.',
    priority: 0.7,
  },
  {
    // The crypto breadth boards: RWA, launch calendar, sector rotation, venues.
    path: '/breadth',
    title: 'Breadth — RWA, launches, sectors & venues | FUDCOURT',
    description:
      'Where the market is widening: tokenized real-world assets, the launchpool and node-sale calendar, sector rotation across 28 categories, and the exchange ranking by reported volume.',
    priority: 0.7,
  },
  {
    // The whale watcher: the largest open positions on Hyperliquid.
    path: '/whales',
    title: 'Whales — Largest open positions | FUDCOURT',
    description:
      'The largest open positions on Hyperliquid by notional: side, leverage, entry, liquidation price and unrealized PnL, plus a per-coin concentration read. The board states how many of the upstream total it can see.',
    priority: 0.6,
  },
  {
    // Chains & ecosystems — the CryptoRank chains surface (TIER-2 idle modes come online).
    path: '/chains',
    title: 'Chains & ecosystems | FUDCOURT',
    description:
      'The chain directory read verbatim from CryptoRank: 277 chains with their market caps and explorers, the ecosystem index with projects and TVL, and per-chain token tables. A chain the upstream ships without a market cap is a dash, never a zero.',
    priority: 0.6,
  },
  {
    // Sector taxonomy — the CryptoRank sectors surface (TIER-2 idle modes come online).
    path: '/sectors',
    title: 'Sector taxonomy | FUDCOURT',
    description:
      'The tag taxonomy: 183 sectors with market cap, dominance, the gainers-to-losers split and their ranked coins, plus a per-sector coin table. A sector with no 24h change is reported as absent, never as flat.',
    priority: 0.6,
  },
  {
    // Coin directory — the CryptoRank coins surface (TIER-2 idle modes come online).
    path: '/coins',
    title: 'Coin directory | FUDCOURT',
    description:
      'A 100-row coin directory with market cap, volume, category and all-time high, the recently-added, most-searched and most-visited listings, and a per-coin drill-down joining the CryptoRank detail with CMC market pairs and CoinGlass open interest.',
    priority: 0.6,
  },
  {
    // CryptoRank media — the CryptoRank media surface (TIER-2 idle modes come online).
    path: '/media',
    title: 'CryptoRank media | FUDCOURT',
    description:
      'The CryptoRank media surface: the video feed with channel and duration, the latest news items with their sentiment tags, and a tag-filtered news drill-down. A pinned promo slot with no date renders a dash, never dropped.',
    priority: 0.6,
  },
  {
    // Quarterly & AI digest — the CryptoRank insights surface (TIER-2 idle modes come online).
    path: '/insights',
    title: 'Quarterly & AI digest | FUDCOURT',
    description:
      'BTC and ETH quarterly open/close with return percentages computed and labelled, next to the CryptoRank generated AI market digest, its funding rounds and its drop-hunting and vesting slices.',
    priority: 0.6,
  },
  {
    // Full price list — the CryptoRank/CoinAnk screener surface (the last idle modes come online).
    path: '/screener',
    title: 'Full price list | FUDCOURT',
    description:
      'The full price list read verbatim from the CryptoRank converter payload: all 5413 tracked coins with their live price, filterable and paginated client-side. The mode ships price only, so there is no change column — never a zero.',
    priority: 0.6,
  },
  {
    // Per-symbol funding rates — the CryptoRank/CoinAnk funding surface (the last idle modes come online).
    path: '/funding',
    title: 'Per-symbol funding rates | FUDCOURT',
    description:
      'Per-symbol funding rates across every venue CoinAnk tracks: 885 symbols, each with its USDT- and COIN-margined rate maps, filterable and sortable, with a per-symbol venue drill-down. Rates are fractions rendered as percents; an absent venue is simply absent.',
    priority: 0.6,
  },
];
