/**
 * client.ts — the browser-side typed surface of the trade domain (plan Phase 6).
 *
 * ONE RULE THIS FILE KEEPS: it COMPOSES the endpoints that already exist, it
 * does not invent a private aggregate. The market board reads `/api/ticker`
 * (the cross-venue board the site already serves); the account panels read
 * `/api/executor/*` (the CEX executor that already exists). A bespoke
 * `/api/trade/dashboard` would be a second source of truth for numbers the
 * other pages already serve, and the two would drift the first time one moved.
 *
 * The ticker's response is described here as a LOCAL contract — the handful of
 * fields this module actually reads — rather than imported from
 * `features/ticker`. Feature families are independent (DR-018): a family that
 * needs another family's data goes through its API, and the API's shape is what
 * this type records. If the ticker route changes a field, this file fails to
 * compile against the new shape, which is the point.
 */
import type { MarketRow, PortfolioSummary } from '@/features/trade/model';
import { MARKET_TYPE_BY_ID, VENUE_BY_ID, type MarketType, type TickerType, type VenueId } from '@/features/trade/taxonomy';
import type { ExecutionPlan, ExecutionRecord, ExecutionRequest, PreviewResult } from '@/platform/executor/types';

/** The one em dash the module prints for "the source did not report this". */
export const NO_VALUE = '—';

/**
 * Every call this module makes is BOUNDED. The cross-venue ticker fans out to
 * ten exchanges and is staged-cached — cold it has been measured at 71–80 s, and
 * a stuck upstream can push it past two minutes. A board that hangs the page is
 * worse than one that says it could not reach the source, so no panel is allowed
 * to wait forever: on timeout the panel renders a named failure and the rest of
 * the page stays usable.
 */
const FETCH_TIMEOUT_MS = 30_000;

/** Combine the caller's abort signal with this module's timeout. */
function bounded(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// ---------------------------------------------------------------------------
// The ticker envelope (the fields this module reads, not the whole shape)
// ---------------------------------------------------------------------------

type TickerVenueQuote = {
  exchange: string;
  last: number | null;
};

type TickerRowLite = {
  symbol: string;
  base: string;
  quote: string;
  type: TickerType;
  price: number | null;
  /** 24h change in PERCENT (1.39 = +1.39%), not a fraction. See `formatChange`. */
  change24h: number | null;
  quoteVolume: number | null;
  venues: TickerVenueQuote[];
  spread: number | null;
};

type TickerEnvelope = {
  rows: TickerRowLite[];
  count: number;
  total: number;
  /** Row counts per ticker type across the WHOLE filtered set, not the page. */
  typeCounts: Partial<Record<TickerType, number>>;
  /** Null-valued when the route answered an error body; see `fetchMarketRows`. */
  error?: string;
  detail?: string;
};

/**
 * The ticker's own vocabulary does not have a slot for every market type
 * (`margin` is an account setting, not a quotable instrument). A market type
 * with no `tickerType` is a stated gap, so the board renders its structure with
 * an honest empty board rather than silently showing spot rows under a Margin
 * heading.
 */
export function tickerTypeFor(marketType: MarketType): TickerType | null {
  return MARKET_TYPE_BY_ID[marketType].tickerType;
}

/** The canonical route for a market type (`perpetual` → `/trade/perpetual`). */
export function marketTypeHref(marketType: MarketType): string {
  return `/trade/${marketType}`;
}

function toMarketRow(row: TickerRowLite, marketType: MarketType): MarketRow {
  return {
    instrumentId: `${row.base}-${row.quote}`.toLowerCase(),
    base: row.base,
    quote: row.quote,
    marketType,
    price: row.price,
    change24h: row.change24h,
    quoteVolume: row.quoteVolume,
    venues: row.venues.map((v) => ({ venue: v.exchange, price: v.last })),
    spreadPct: row.spread,
  };
}

/** The market type a ticker row belongs to, in the ticker's own vocabulary. */
function marketTypeOfTickerRow(type: TickerType): MarketType {
  switch (type) {
    case 'swap':
      return 'perpetual';
    case 'future':
      return 'futures';
    case 'option':
      return 'options';
    default:
      return 'spot';
  }
}

/**
 * The market board for one market type, or `'all'` for the command center's
 * cross-type board.
 *
 * `'all'` asks the ticker for every type at once (its default) and labels each
 * row by the type the ticker reported. A specific type asks only for that type.
 * A type the ticker cannot quote (`margin`) is NOT mapped to another type — it
 * returns an empty board, which the caller renders as a stated gap.
 */
export async function fetchMarketRows(
  marketType: MarketType | 'all',
  signal?: AbortSignal,
): Promise<MarketRow[]> {
  const params = new URLSearchParams({ sort: 'volume', order: 'desc', limit: '50' });
  if (marketType !== 'all') {
    const tickerType = tickerTypeFor(marketType);
    if (tickerType === null) return [];
    params.set('type', tickerType);
  }
  const res = await fetch(`/api/ticker?${params.toString()}`, { signal: bounded(signal), cache: 'no-store' });
  const body = (await res.json().catch(() => ({}))) as TickerEnvelope;
  if (!res.ok) {
    throw new Error(body.detail ? `${body.error ?? `HTTP ${res.status}`} — ${body.detail}` : (body.error ?? `HTTP ${res.status}`));
  }
  return (body.rows ?? []).map((r) =>
    toMarketRow(r, marketType === 'all' ? marketTypeOfTickerRow(r.type) : marketType),
  );
}

/**
 * The account headline, composed from the executor's own endpoints.
 *
 * A 401 (no session) is NOT an error here — it is the ordinary "not connected"
 * state, and the board renders the connect prompt. Every other failure is
 * surfaced, because a 500 on a funded account must never look like an empty one.
 */
export async function fetchPortfolioSummary(signal?: AbortSignal): Promise<PortfolioSummary> {
  const res = await fetch('/api/executor/accounts', { signal: bounded(signal), cache: 'no-store' });
  if (res.status === 401 || res.status === 403) {
    return { equity: null, available: null, exposure: null, pnlToday: null, connected: false };
  }
  const body = (await res.json().catch(() => ({}))) as { accounts?: unknown[]; error?: string; detail?: string };
  if (!res.ok) {
    throw new Error(body.detail ? `${body.error ?? `HTTP ${res.status}`} — ${body.detail}` : (body.error ?? `HTTP ${res.status}`));
  }
  const connected = Array.isArray(body.accounts) && body.accounts.length > 0;
  // Equity/available/exposure are not on the accounts endpoint; a funded figure
  // is only real once a venue answers, so they stay null here rather than being
  // guessed. `connected` is the one fact this call establishes.
  return { equity: null, available: null, exposure: null, pnlToday: null, connected };
}

/** The handful of execution fields the command center reads, not the whole record. */
export type ExecutionLite = {
  id: string;
  symbol: string;
  marketType: string;
  side: string;
  status: string;
  /** Planned notional in quote units, or null when the planner had none. */
  plannedNotional: number | null;
};

/** Execution states that are live (still working) rather than terminal. */
const LIVE_STATUSES = new Set(['RUNNING', 'PARTIALLY_FILLED', 'PAUSED', 'CANCEL_REQUESTED', 'RECONCILING', 'READY', 'VALIDATED', 'CALCULATED']);

/**
 * The session user's executions, newest first.
 *
 * Returns an empty list on 401/403 (not signed in) — the same "not connected"
 * state the portfolio call reports — and throws on any other failure so a real
 * error is never rendered as "no orders".
 */
export async function fetchExecutions(signal?: AbortSignal): Promise<ExecutionLite[]> {
  const res = await fetch('/api/executor/executions', { signal: bounded(signal), cache: 'no-store' });
  if (res.status === 401 || res.status === 403) return [];
  const body = (await res.json().catch(() => ({}))) as { executions?: ExecutionLite[]; error?: string; detail?: string };
  if (!res.ok) {
    throw new Error(body.detail ? `${body.error ?? `HTTP ${res.status}`} — ${body.detail}` : (body.error ?? `HTTP ${res.status}`));
  }
  return Array.isArray(body.executions) ? body.executions : [];
}

/** Whether an execution status is still working (not terminal). */
export function isLiveExecution(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// The executor composition — preview, place, and the connected accounts
//
// The trade domain does NOT place orders: it COMPOSES the executor's own routes
// (`/api/executor/preview`, `/api/executor/executions`, `/api/executor/accounts`).
// Feature families are independent (DR-018), so this is a local contract over
// those endpoints, typed against the frozen `@/platform/executor/types` — the
// same contract the executor's own client speaks, so a field rename fails to
// compile here.
// ---------------------------------------------------------------------------

/**
 * The executor's market vocabulary is narrower than the trade taxonomy: it can
 * work a spot book or a linear perpetual, and nothing else. A trade market type
 * with no executor counterpart returns `null`, and the composer renders that as
 * a stated gap rather than sending a request the planner would reject.
 */
export function executorMarketTypeFor(marketType: MarketType): 'spot' | 'linear_perp' | null {
  switch (marketType) {
    case 'spot':
    case 'margin':
      return 'spot';
    case 'perpetual':
    case 'futures':
      return 'linear_perp';
    case 'options':
    case 'swap':
      return null;
  }
}

/** The trade venue an executor account belongs to, or `null` when it is not a routable venue. */
export function venueOfExchange(exchange: string): VenueId | null {
  return exchange in VENUE_BY_ID ? (exchange as VenueId) : null;
}

/** The handful of account fields the trade strip reads — a local contract, not the whole record. */
export type TradeAccountLite = {
  id: string;
  exchange: string;
  label: string;
  /** Masked `abc...xyz` only — the API never returns a key (PRD §109). */
  apiKeyMasked: string;
  health: string;
  revokedAt: number | null;
  permissions: {
    read: boolean | null;
    spotTrade: boolean | null;
    futuresTrade: boolean | null;
    /** True when the key was granted withdrawal rights — the strip warns, never hides. */
    withdraw: boolean | null;
  };
};

/** POST /api/executor/preview — a dry run: nothing is created, nothing is sent (§98). */
export interface TradePreviewResponse {
  preview: PreviewResult;
  /** Server-side kill switch (`FUDCOURT_EXECUTOR_LIVE === '1'`). Never trusted from the client. */
  liveEnabled: boolean;
}

/** POST /api/executor/executions — the created record plus its immutable plan. */
export interface TradeCreateResponse {
  execution: ExecutionRecord;
  plan: ExecutionPlan;
}

/** The server's own error text, flattened into one message — never a substituted one. */
function apiError(body: Record<string, unknown>, status: number): string {
  const parts: string[] = [typeof body.error === 'string' ? body.error : `HTTP ${status}`];
  if (Array.isArray(body.errors)) {
    const listed = body.errors.filter((e): e is string => typeof e === 'string');
    if (listed.length > 0) parts.push(listed.join('; '));
  }
  if (typeof body.detail === 'string' && body.detail !== '') parts.push(body.detail);
  if (Array.isArray(body.conflicts)) {
    for (const conflict of body.conflicts) {
      if (conflict !== null && typeof conflict === 'object' && 'message' in conflict && typeof conflict.message === 'string') {
        parts.push(conflict.message);
      }
    }
  }
  return parts.join(' — ');
}

async function postJson<T>(url: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: bounded(signal),
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(apiError(body, res.status));
  return body as T;
}

/**
 * A dry run of a trade intent through the executor's risk engine. Persists
 * nothing and places nothing (PRD §98) — the composer shows the returned
 * figures and the user decides whether to create the execution.
 */
export function previewTradeIntent(request: ExecutionRequest, signal?: AbortSignal): Promise<TradePreviewResponse> {
  return postJson<TradePreviewResponse>('/api/executor/preview', request, signal);
}

/** Create the execution from the intent that was just previewed. */
export function createTradeExecution(request: ExecutionRequest, signal?: AbortSignal): Promise<TradeCreateResponse> {
  return postJson<TradeCreateResponse>('/api/executor/executions', request, signal);
}

/**
 * The session user's connected venue accounts. A 401/403 is the ordinary
 * "not connected" state, not an error; every other failure is surfaced, because
 * a 500 on a funded account must never look like an empty one.
 */
export async function fetchTradeAccounts(signal?: AbortSignal): Promise<TradeAccountLite[]> {
  const res = await fetch('/api/executor/accounts', { signal: bounded(signal), cache: 'no-store' });
  if (res.status === 401 || res.status === 403) return [];
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(apiError(body, res.status));
  return Array.isArray(body.accounts) ? (body.accounts as TradeAccountLite[]) : [];
}

// ---------------------------------------------------------------------------
// Formatters — the module's single spelling of every rendered number
// ---------------------------------------------------------------------------

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

/** A signed quote-currency delta: `+$142.00`. */
export function formatSignedUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
}

/** A percentage that is ALREADY in percent (`4.2` → `4.20%`). */
export function formatPercent(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return `${value.toFixed(decimals)}%`;
}

/**
 * The shared catch → message conversion, so no panel calls `String(e)`.
 *
 * A timeout is reported as what it is — the source did not answer inside the
 * module's budget — rather than as a bare "signal timed out", which tells a
 * trader nothing about whether their order or the board was at fault.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `timed out after ${FETCH_TIMEOUT_MS / 1000}s — the source did not answer`;
  }
  return err instanceof Error ? err.message : String(err);
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