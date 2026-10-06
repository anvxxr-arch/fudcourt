/**
 * client-format.ts — the trade module's single spelling of every rendered number.
 *
 * Pure presentation: no fetching, no imports. A price at a precision that suits its
 * magnitude; changes/percents already in percent (never scaled here).
 */

/** The one em dash the module prints for "the source did not report this". */
export const NO_VALUE = '—';

/**
 * A price at a precision that suits its magnitude: sub-cent assets need more
 * decimals than BTC, and a fixed 2 would print an altcoin as `0.00`.
 */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : 8;
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * A signed 24h change. The input is ALREADY IN PERCENT (`1.39` → `+1.39%`) —
 * the ticker reports ccxt's `percentage` field directly and its own board
 * prints it with no x100. Multiplying by 100 here printed +138.87% for a
 * +1.39% move, so there is deliberately no scaling in this function.
 */
export function formatChange(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return NO_VALUE;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(2)}%`;
}

/** A compact quote-currency figure: `$1.24M`, `$18.9K`, `$412`. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** The trade module's entry nav, rendered by every board's header. */
export const TRADE_NAV = [
  { href: '/trade', label: 'Command center' },
  { href: '/trade/spot', label: 'Spot' },
  { href: '/trade/margin', label: 'Margin' },
  { href: '/trade/perpetual', label: 'Perpetual' },
  { href: '/trade/futures', label: 'Futures' },
  { href: '/trade/options', label: 'Options' },
  { href: '/trade/swap', label: 'Swap' },
  { href: '/trade/accounts', label: 'Accounts' },
] as const;
