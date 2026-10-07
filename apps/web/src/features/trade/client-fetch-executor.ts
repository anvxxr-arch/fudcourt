/**
 * client-fetch-executor.ts — account/preview/execution fetchers of the trade domain.
 *
 * Composes the endpoints that already exist (`/api/executor/*`); invents no
 * private aggregate. Every call here is BOUNDED (see FETCH_TIMEOUT_MS in
 * `./client-fetch-transport`).
 */
import type { PortfolioSummary } from '@/features/trade/model';
import { VENUE_BY_ID, type VenueId } from '@/features/trade/model';
import type { ExecutionPlan, ExecutionRecord, ExecutionRequest, PreviewResult } from '@/lib/executor';
import { getJSON } from '@/lib/fetch';
import { bounded, postJson } from './client-fetch-transport';

/**
 * The account headline, composed from the executor's own endpoints.
 *
 * A 401 (no session) is NOT an error here — it is the ordinary "not connected"
 * state, and the board renders the connect prompt. Every other failure is
 * surfaced, because a 500 on a funded account must never look like an empty one.
 */
export async function fetchPortfolioSummary(signal?: AbortSignal): Promise<PortfolioSummary> {
  let body: { accounts?: unknown[] };
  try {
    body = await getJSON<{ accounts?: unknown[] }>('/api/executor/accounts', { signal: bounded(signal), cache: 'no-store' });
  } catch (err) {
    if (err instanceof Error && /HTTP 40[13]$/.test(err.message)) {
      return { equity: null, available: null, exposure: null, pnlToday: null, connected: false };
    }
    throw err;
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
  let body: { executions?: ExecutionLite[] };
  try {
    body = await getJSON<{ executions?: ExecutionLite[] }>('/api/executor/executions', { signal: bounded(signal), cache: 'no-store' });
  } catch (err) {
    if (err instanceof Error && /HTTP 40[13]$/.test(err.message)) return [];
    throw err;
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
// those endpoints, typed against the frozen `@/lib/executor` — the
// same contract the executor's own client speaks, so a field rename fails to
// compile here.
// ---------------------------------------------------------------------------
export { executorMarketTypeFor } from './model-taxonomy';

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
  let body: Record<string, unknown>;
  try {
    body = await getJSON<Record<string, unknown>>('/api/executor/accounts', { signal: bounded(signal), cache: 'no-store' });
  } catch (err) {
    if (err instanceof Error && /HTTP 40[13]$/.test(err.message)) return [];
    throw err;
  }
  return Array.isArray(body.accounts) ? (body.accounts as TradeAccountLite[]) : [];
}

/**
 * The handful of fill fields the trades board reads. A fill is the venue's own
 * record of one match, deduped on `exchangeTradeId` (PRD §62) — the ground truth
 * a trade is built from, not a derived guess.
 */
export type FillLite = {
  id: string;
  executionId: string;
  childOrderId: string | null;
  exchangeTradeId: string;
  price: number;
  quantity: number;
  quoteQuantity: number;
  fee: number;
  feeAsset: string;
  timestamp: number;
};

/**
 * GET /api/executor/executions/{id}/fills — the deduped fill history of one
 * execution (PRD §62).
 *
 * Returns an empty list on 401/403 (not signed in), the same "not connected"
 * state the portfolio call reports, and throws on any other failure so a real
 * error is never rendered as "no fills".
 */
export async function fetchFills(executionId: string, signal?: AbortSignal): Promise<FillLite[]> {
  let body: { fills?: FillLite[] };
  try {
    body = await getJSON<{ fills?: FillLite[] }>(`/api/executor/executions/${encodeURIComponent(executionId)}/fills`, {
      signal: bounded(signal),
      cache: 'no-store',
    });
  } catch (err) {
    if (err instanceof Error && /HTTP 40[13]$/.test(err.message)) return [];
    throw err;
  }
  return Array.isArray(body.fills) ? body.fills : [];
}
