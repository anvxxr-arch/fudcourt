/**
 * client.ts — a thin typed fetch client over the FUDCourt executor surface.
 *
 * One method per endpoint of `shared/contracts/openapi/fudcourt.yaml` (the
 * compatibility contract for backend/api + backend/workers/executor). Request and
 * response types are derived from the generated schema — `components["schemas"]`
 * produced by `bun run generate` — with thin hand-written aliases below; no
 * field definitions are duplicated here.
 *
 * Semantics (from the contract): error bodies keep the server's own text and
 * `request()` rejects with it verbatim — never substitute a message. Secrets
 * are write-only (`ConnectAccountInput`); responses only ever carry masked
 * keys. `cancel` cancels open orders and never closes a position.
 */
import type { components, operations } from './generated/schema.js';

/** Component schemas of the generated OpenAPI schema. */
export type Schemas = components['schemas'];

// ---------------------------------------------------------------------------
// Thin aliases onto the generated component types (no duplicated fields).
// ---------------------------------------------------------------------------

export type MarketType = Schemas['MarketType'];
export type Side = Schemas['Side'];
export type Intent = Schemas['Intent'];
export type ExchangeId = Schemas['ExchangeId'];
export type VenueKey = Schemas['VenueKey'];
export type TimeInForce = Schemas['TimeInForce'];
export type ExecutionUrgency = Schemas['ExecutionUrgency'];
export type LeverageMode = Schemas['LeverageMode'];
export type MarginMode = Schemas['MarginMode'];
export type PositionMode = Schemas['PositionMode'];
export type ExecutionStatus = Schemas['ExecutionStatus'];
export type ChildOrderStatus = Schemas['ChildOrderStatus'];
export type CredentialHealth = Schemas['CredentialHealth'];
export type ErrorCategory = Schemas['ErrorCategory'];
export type RiskBreachPolicy = Schemas['RiskBreachPolicy'];
export type ExistingPositionPolicy = Schemas['ExistingPositionPolicy'];
export type ExecutionMode = Schemas['ExecutionMode'];
export type StopMode = Schemas['StopMode'];
export type ExecutionEventName = Schemas['ExecutionEventName'];
export type BalanceBasis = Schemas['BalanceBasis'];
export type SizingMode = Schemas['SizingMode'];

export type SizingDefinition = Schemas['SizingDefinition'];
export type EntryDefinition = Schemas['EntryDefinition'];
export type PriceDefinition = Schemas['PriceDefinition'];
export type TakeProfitDefinition = Schemas['TakeProfitDefinition'];
export type ScaleLevel = Schemas['ScaleLevel'];
export type LeverageDefinition = Schemas['LeverageDefinition'];
export type TwapConfig = Schemas['TwapConfig'];
export type ExecutionDefinition = Schemas['ExecutionDefinition'];
export type ExecutionStrategy = Schemas['ExecutionStrategy'];
export type ExecutionConstraints = Schemas['ExecutionConstraints'];
export type ExecutionRequest = Schemas['ExecutionRequest'];

export type LeverageBracket = Schemas['LeverageBracket'];
export type InstrumentMetadata = Schemas['InstrumentMetadata'];
export type BalanceSnapshot = Schemas['BalanceSnapshot'];
export type MarketSnapshot = Schemas['MarketSnapshot'];
export type FeeModel = Schemas['FeeModel'];
export type SlippageModel = Schemas['SlippageModel'];
export type ConstraintConflict = Schemas['ConstraintConflict'];

export type ExecutionPlanRisk = Schemas['ExecutionPlanRisk'];
export type ExecutionPlan = Schemas['ExecutionPlan'];
export type PreviewResult = Schemas['PreviewResult'];

export type AccountPermissions = Schemas['AccountPermissions'];
export type AccountMetadata = Schemas['AccountMetadata'];
export type CredentialRecord = Schemas['CredentialRecord'];
export type ExecutionRecord = Schemas['ExecutionRecord'];
export type ChildOrderRecord = Schemas['ChildOrderRecord'];
export type FillRecord = Schemas['FillRecord'];
export type ExecutionEventRecord = Schemas['ExecutionEventRecord'];
export type RiskProfile = Schemas['RiskProfile'];
export type RiskProfilePatch = Schemas['RiskProfilePatch'];

/** BYOK connect body — secrets are write-only, sealed server-side. */
export type ConnectAccountInput = Schemas['ConnectAccountInput'];
export type EmergencyStopInput = Schemas['EmergencyStopInput'];

// Response envelopes — exactly the bodies the routes answer.
export type PreviewResponse = Schemas['PreviewResponse'];
export type CreateExecutionResponse = Schemas['CreateExecutionResponse'];
export type LifecycleResponse = Schemas['LifecycleResponse'];
export type ExecutionDetailResponse = Schemas['ExecutionDetailResponse'];
export type ListExecutionsResponse = Schemas['ListExecutionsResponse'];
export type ListOrdersResponse = Schemas['ListOrdersResponse'];
export type ListFillsResponse = Schemas['ListFillsResponse'];
export type ListEventsResponse = Schemas['ListEventsResponse'];
export type ListAccountsResponse = Schemas['ListAccountsResponse'];
export type AccountResponse = Schemas['AccountResponse'];
export type DeleteAccountResponse = Schemas['DeleteAccountResponse'];
export type SettingsResponse = Schemas['SettingsResponse'];
export type EmergencyStopResponse = Schemas['EmergencyStopResponse'];

// Error shapes.
export type ErrorBasic = Schemas['ErrorBasic'];
export type ErrorDetail = Schemas['ErrorDetail'];
export type ValidationError = Schemas['ValidationError'];
export type ConflictError = Schemas['ConflictError'];

// Operation inputs — path/query/request types straight from the generated
// operation objects.
export type ListExecutionsParams = NonNullable<operations['listExecutions']['parameters']['query']>;
export type ExecutionPathParams = operations['getExecution']['parameters']['path'];
export type AccountPathParams = operations['getAccount']['parameters']['path'];

/** The normalized cross-service error model (shared/contracts/schemas/error-envelope.json). */
export interface NormalizedError {
  code:
    | 'validation'
    | 'authorization'
    | 'credential'
    | 'exchange'
    | 'insufficient_balance'
    | 'risk_limit'
    | 'rate_limit'
    | 'timeout'
    | 'network'
    | 'conflict'
    | 'not_found'
    | 'internal';
  message: string;
  request_id?: string | null;
}

export interface ExecutorClientOptions {
  /** Origin prefix; defaults to same-origin. */
  baseUrl?: string;
  /** Per-request hook (auth headers etc). `cache: 'no-store'` is always applied. */
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

/** Thrown on any non-2xx; `status` plus the server's own body. */
export class ExecutorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ExecutorApiError';
  }
}

/**
 * The server's own error text, flattened into one message. Every executor
 * error body carries `error`; `detail` adds the specific reason, `errors`
 * (validation) is a list of field-named messages, and `conflicts` (409) are
 * the planner's blocking reasons.
 */
function messageFromBody(body: unknown, status: number): string {
  if (body === null || typeof body !== 'object') return `HTTP ${status}`;
  const record = body as Record<string, unknown>;
  const parts: string[] = [typeof record.error === 'string' ? record.error : `HTTP ${status}`];
  if (Array.isArray(record.errors)) {
    const listed = record.errors.filter((e): e is string => typeof e === 'string');
    if (listed.length > 0) parts.push(listed.join('; '));
  }
  if (typeof record.detail === 'string' && record.detail !== '') parts.push(record.detail);
  return parts.join(' — ');
}

/**
 * Typed fetch client for the 17 endpoints of the executor surface (plus the
 * two route-only extras — `getAccount` and `emergencyStop` — kept so the whole
 * contract is clientable).
 */
export class ExecutorClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: Record<string, string>;

  constructor(options: ExecutorClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = options.headers ?? {};
  }

  /** Single request funnel: `cache: 'no-store'`, JSON in/out, thrown ExecutorApiError on non-2xx. */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...this.headers, ...init.headers },
      ...init,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ExecutorApiError(messageFromBody(body, response.status), response.status, body);
    }
    return body as T;
  }

  /** POST /api/executor/preview — dry run (PRD §80, §98). */
  preview(request: ExecutionRequest): Promise<PreviewResponse> {
    return this.request('/api/executor/preview', { method: 'POST', body: JSON.stringify(request) });
  }

  /** POST /api/executor/executions — create (PRD §99). A conflicting plan is a 409 ConflictError. */
  createExecution(request: ExecutionRequest): Promise<CreateExecutionResponse> {
    return this.request('/api/executor/executions', { method: 'POST', body: JSON.stringify(request) });
  }

  /** GET /api/executor/executions[?status=] — history for the session user (§22, §97). */
  listExecutions(status?: ExecutionStatus): Promise<ListExecutionsResponse> {
    const query = status === undefined ? '' : `?status=${encodeURIComponent(status)}`;
    return this.request(`/api/executor/executions${query}`);
  }

  /** GET /api/executor/executions/{id} — the record and its immutable plan. */
  getExecution(id: ExecutionPathParams['id']): Promise<ExecutionDetailResponse> {
    return this.request(`/api/executor/executions/${encodeURIComponent(id)}`);
  }

  /** POST /api/executor/executions/{id}/start — READY → RUNNING (PRD §57). */
  startExecution(id: ExecutionPathParams['id']): Promise<LifecycleResponse> {
    return this.request(`/api/executor/executions/${encodeURIComponent(id)}/start`, { method: 'POST' });
  }

  /** POST /api/executor/executions/{id}/pause — RUNNING → PAUSED. */
  pauseExecution(id: ExecutionPathParams['id']): Promise<LifecycleResponse> {
    return this.request(`/api/executor/executions/${encodeURIComponent(id)}/pause`, { method: 'POST' });
  }

  /** POST /api/executor/executions/{id}/resume — PAUSED → RUNNING. */
  resumeExecution(id: ExecutionPathParams['id']): Promise<LifecycleResponse> {
    return this.request(`/api/executor/executions/${encodeURIComponent(id)}/resume`, { method: 'POST' });
  }

  /** POST /api/executor/executions/{id}/cancel — cancels orders; never closes the position. */
  cancelExecution(id: ExecutionPathParams['id']): Promise<LifecycleResponse> {
    return this.request(`/api/executor/executions/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  /** GET /api/executor/executions/{id}/orders — child orders (PRD §61). */
  listOrders(id: ExecutionPathParams['id']): Promise<ListOrdersResponse> {
    return this.request(`/api/executor/executions/${encodeURIComponent(id)}/orders`);
  }

  /** GET /api/executor/executions/{id}/fills — deduped fill history (PRD §62). */
  listFills(id: ExecutionPathParams['id']): Promise<ListFillsResponse> {
    return this.request(`/api/executor/executions/${encodeURIComponent(id)}/fills`);
  }

  /** GET /api/executor/executions/{id}/events — immutable event log (PRD §63). */
  listEvents(id: ExecutionPathParams['id']): Promise<ListEventsResponse> {
    return this.request(`/api/executor/executions/${encodeURIComponent(id)}/events`);
  }

  /** GET /api/executor/accounts — connected accounts, masked key only (§87). */
  listAccounts(): Promise<ListAccountsResponse> {
    return this.request('/api/executor/accounts');
  }

  /** POST /api/executor/accounts — BYOK connect; secrets are sealed server-side, never returned. */
  connectAccount(input: ConnectAccountInput): Promise<AccountResponse> {
    return this.request('/api/executor/accounts', { method: 'POST', body: JSON.stringify(input) });
  }

  /** GET /api/executor/accounts/{id} — one account, masked key only (route-only today). */
  getAccount(id: AccountPathParams['id']): Promise<AccountResponse> {
    return this.request(`/api/executor/accounts/${encodeURIComponent(id)}`);
  }

  /** POST /api/executor/accounts/{id}/test — live credential validation (§46). */
  testAccount(id: AccountPathParams['id']): Promise<AccountResponse> {
    return this.request(`/api/executor/accounts/${encodeURIComponent(id)}/test`, { method: 'POST' });
  }

  /** DELETE /api/executor/accounts/{id} — revocation. */
  deleteAccount(id: AccountPathParams['id']): Promise<DeleteAccountResponse> {
    return this.request(`/api/executor/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** GET /api/executor/settings — the user's risk profile (PRD §88). */
  getSettings(): Promise<SettingsResponse> {
    return this.request('/api/executor/settings');
  }

  /** PUT /api/executor/settings — partial update; unlisted keys fall back to defaults. */
  putSettings(profile: RiskProfilePatch): Promise<SettingsResponse> {
    return this.request('/api/executor/settings', { method: 'PUT', body: JSON.stringify(profile) });
  }

  /** POST /api/executor/emergency — stop managed strategies, cancel managed orders (PRD §75; route-only). */
  emergencyStop(input?: EmergencyStopInput): Promise<EmergencyStopResponse> {
    return this.request('/api/executor/emergency', { method: 'POST', body: JSON.stringify(input ?? {}) });
  }
}

/** The one catch → message conversion consumers use instead of `String(e)`. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
