// Canonical tab-key → route-path map for the SPA shell (app/store/store-shell.tsx).
// Both the nav `href`s and the `history.replaceState` effect MUST use
// `viewPath` so the two can never diverge again (previously two hand-written
// nested ternaries fell through to `/${key}`, producing 404s for tab-only
// views like /wallets, /transactions, /reconciliation).
export const VIEW_PATHS: Record<string, string> = {
  dashboard: '/team/balance',
  portfolio: '/team/portfolio',
  wallets: '/team/wallets',
  transactions: '/team/transactions',
  reconciliation: '/team/reconciliation',
  // The Net-Worth Time Machine (DR-040): charts `asset_history` over a window.
  treasury: '/team/treasury',
  // The treasury leaderboard (DR-045): ranks chains/wallets/assets by window.
  leaderboard: '/team/leaderboard',
  // Cost basis + P&L over the transaction ledger (DR-046).
  pnl: '/team/pnl',
  market: '/market',
  'market-crypto': '/market/crypto',
  'market-forex': '/market/forex',
  'market-commodity': '/market/commodity',
  'market-stock': '/market/stock',
  'market-trench': '/market/trench',
  signals: '/signals',
  scoreboard: '/scoreboard',
  ticker: '/market/crypto',
  news: '/news',
  // CEX Executor (PRD §81): a multi-route area (/executor/new, /:id, …), not a
  // single shell tab — this entry is the canonical deep link for nav callers.
  executor: '/executor',
};

export const viewPath = (key: string): string => VIEW_PATHS[key] ?? '/';
