/**
 * client.ts — the browser-side typed surface of the CEX Executor API (PRD §81, §97).
 *
 * One function per endpoint the UI calls, each returning the JSON that route
 * actually answers, typed against the frozen contract in
 * `@/lib/executor`. The route handlers are the ground truth for
 * both the method/path and the response envelope:
 *
 *   POST   /api/executor/preview                  → { preview, liveEnabled }
 *   POST   /api/executor/executions              → { execution, plan }
 *   GET    /api/executor/executions[?status=]    → { executions }
 *   GET    /api/executor/executions/:id           → { execution, plan }
 *   POST   /api/executor/executions/:id/start    → { execution }
 *   POST   /api/executor/executions/:id/pause    → { execution }
 *   POST   /api/executor/executions/:id/resume   → { execution }
 *   POST   /api/executor/executions/:id/cancel   → { execution }
 *   GET    /api/executor/executions/:id/orders   → { childOrders }
 *   GET    /api/executor/executions/:id/fills    → { fills }
 *   GET    /api/executor/executions/:id/events   → { events }
 *   GET    /api/executor/accounts                → { accounts }
 *   POST   /api/executor/accounts                → { account, metadata }
 *   POST   /api/executor/accounts/:id/test       → { account, metadata }
 *   DELETE /api/executor/accounts/:id            → { ok: true }
 *   GET    /api/executor/settings                → { profile }
 *   PUT    /api/executor/settings                → { profile }
 *
 * Errors: every non-2xx becomes a thrown `Error` carrying the URL and status.
 * Panels therefore only ever display `err.message`.
 */
import type {
  AccountMetadata,
  ChildOrderRecord,
  CredentialRecord,
  ExecutionEventRecord,
  ExecutionPlan,
  ExecutionRecord,
  ExecutionRequest,
  ExecutionStatus,
  FillRecord,
  PreviewResult,
  RiskProfile,
} from '@/lib/executor';
import { getJSON } from '@/lib/fetch';

/** POST /preview — a dry run: nothing is created, nothing is sent (§98). */
export interface PreviewResponse {
  preview: PreviewResult;
  /** Server-side kill switch (`FUDCOURT_EXECUTOR_LIVE === '1'`). Never client-side. */
  liveEnabled: boolean;
}

/** POST /executions — the created record plus its immutable creation-time plan. */
export interface CreateExecutionResponse {
  execution: ExecutionRecord;
  plan: ExecutionPlan;
}

/** A lifecycle intent (start/pause/resume/cancel) returns the updated record. */
export interface LifecycleResponse {
  execution: ExecutionRecord;
}

/** GET /executions/:id — the record plus the plan it was created from. */
export interface ExecutionDetailResponse {
  execution: ExecutionRecord;
  /** Null only for a record with no persisted plan; never faked. */
  plan: ExecutionPlan | null;
}

export interface ListExecutionsResponse {
  executions: ExecutionRecord[];
}

export interface ListOrdersResponse {
  childOrders: ChildOrderRecord[];
}

export interface ListFillsResponse {
  fills: FillRecord[];
}

export interface ListEventsResponse {
  events: ExecutionEventRecord[];
}

export interface ListAccountsResponse {
  accounts: CredentialRecord[];
}

/** Connect + test both answer the sealed record and the venue's probe result. */
export interface AccountResponse {
  account: CredentialRecord;
  metadata: AccountMetadata;
}

export interface DeleteAccountResponse {
  ok: true;
}

export interface SettingsResponse {
  profile: RiskProfile;
}

/** BYOK connect body. Secrets are write-only: no route ever reads them back. */
export interface ConnectAccountInput {
  exchange: string;
  label: string;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
}

/**
 * Single request funnel: `cache: 'no-store'` (executor state is per-user and
 * changes while the page is open), JSON in/out, and a thrown `Error` carrying
 * the URL and status on any non-2xx.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return getJSON<T>(path, {
    ...init,
    cache: 'no-store',
    headers: init.body === undefined ? init.headers : { 'Content-Type': 'application/json', ...init.headers },
  });
}

function post<T>(path: string, payload?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(payload ?? {}) });
}

/** POST /api/executor/preview — dry run (PRD §80, §98). */
export function preview(request: ExecutionRequest): Promise<PreviewResponse> {
  return post<PreviewResponse>('/api/executor/preview', request);
}

/** POST /api/executor/executions — create (PRD §99). A conflicting plan is a 409. */
export function createExecution(request: ExecutionRequest): Promise<CreateExecutionResponse> {
  return post<CreateExecutionResponse>('/api/executor/executions', request);
}

/** GET /api/executor/executions — history for the session user (§22, §97). */
export function listExecutions(status?: ExecutionStatus): Promise<ListExecutionsResponse> {
  const query = status === undefined ? '' : `?status=${encodeURIComponent(status)}`;
  return request<ListExecutionsResponse>(`/api/executor/executions${query}`);
}

/** GET /api/executor/executions/:id — the record and its immutable plan. */
export function getExecution(id: string): Promise<ExecutionDetailResponse> {
  return request<ExecutionDetailResponse>(`/api/executor/executions/${encodeURIComponent(id)}`);
}

/** POST /api/executor/executions/:id/start — READY → RUNNING (PRD §57). */
export function startExecution(id: string): Promise<LifecycleResponse> {
  return post<LifecycleResponse>(`/api/executor/executions/${encodeURIComponent(id)}/start`);
}

/** POST /api/executor/executions/:id/pause — RUNNING → PAUSED. */
export function pauseExecution(id: string): Promise<LifecycleResponse> {
  return post<LifecycleResponse>(`/api/executor/executions/${encodeURIComponent(id)}/pause`);
}

/** POST /api/executor/executions/:id/resume — PAUSED → RUNNING. */
export function resumeExecution(id: string): Promise<LifecycleResponse> {
  return post<LifecycleResponse>(`/api/executor/executions/${encodeURIComponent(id)}/resume`);
}

/** POST /api/executor/executions/:id/cancel — cancels orders; never closes the position. */
export function cancelExecution(id: string): Promise<LifecycleResponse> {
  return post<LifecycleResponse>(`/api/executor/executions/${encodeURIComponent(id)}/cancel`);
}

/** GET /api/executor/executions/:id/orders — child orders (PRD §61). */
export function listOrders(id: string): Promise<ListOrdersResponse> {
  return request<ListOrdersResponse>(`/api/executor/executions/${encodeURIComponent(id)}/orders`);
}

/** GET /api/executor/executions/:id/fills — deduped fill history (PRD §62). */
export function listFills(id: string): Promise<ListFillsResponse> {
  return request<ListFillsResponse>(`/api/executor/executions/${encodeURIComponent(id)}/fills`);
}

/** GET /api/executor/executions/:id/events — immutable event log (PRD §63). */
export function listEvents(id: string): Promise<ListEventsResponse> {
  return request<ListEventsResponse>(`/api/executor/executions/${encodeURIComponent(id)}/events`);
}

/** GET /api/executor/accounts — connected accounts, masked key only (§87). */
export function listAccounts(): Promise<ListAccountsResponse> {
  return request<ListAccountsResponse>('/api/executor/accounts');
}

/** POST /api/executor/accounts — BYOK connect; secrets are sealed server-side. */
export function connectAccount(input: ConnectAccountInput): Promise<AccountResponse> {
  return post<AccountResponse>('/api/executor/accounts', input);
}

/** POST /api/executor/accounts/:id/test — live credential validation (§46). */
export function testAccount(id: string): Promise<AccountResponse> {
  return post<AccountResponse>(`/api/executor/accounts/${encodeURIComponent(id)}/test`);
}

/** DELETE /api/executor/accounts/:id — revocation. */
export function deleteAccount(id: string): Promise<DeleteAccountResponse> {
  return request<DeleteAccountResponse>(`/api/executor/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** GET /api/executor/settings — the user's risk profile (PRD §88). */
export function getSettings(): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/executor/settings');
}

/** PUT /api/executor/settings — partial update; unlisted keys fall back to defaults. */
export function putSettings(profile: Partial<RiskProfile>): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/executor/settings', { method: 'PUT', body: JSON.stringify(profile) });
}

/** The one catch → message conversion panels use instead of `String(e)`. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
