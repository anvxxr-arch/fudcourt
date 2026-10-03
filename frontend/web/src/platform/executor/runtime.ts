/**
 * runtime.ts — the executor API service layer (PRD §79, §97-§100, §108-§110).
 *
 * One composition root for every `/api/executor/*` handler: session + ownership
 * checks, credential handling, market/fee/balance fetch, plan computation and
 * lifecycle intents. The route files stay thin (parse → call → respond).
 *
 * Non-negotiables enforced here:
 *  - BYOK (§43-44): secrets enter once, are sealed at rest, and NEVER leave this
 *    layer — responses carry `CredentialRecord` (masked), never plaintext.
 *  - Withdrawal permission is UNSUPPORTED (§43): a key whose restrictions report
 *    `withdraw: true` is refused at connect/test with the reason spelled out.
 *  - Ownership (§108): every read and write is scoped to the session's Discord
 *    user id. Wrong owner ⇒ 404 (not 403 — existence is not leaked).
 *  - Kill switch (§108/§118): `mode: 'live'` requires `FUDCOURT_EXECUTOR_LIVE=1`
 *    at CREATE time; the worker re-checks at every placement. Paper is the
 *    default mode; PREVIEW never persists anything (§98).
 *  - Conflicts BLOCK creation (§117 default): a preview may show Requested vs
 *    Possible, but `POST /executions` refuses a conflicting plan outright.
 *
 * Balance basis mapping (§10): each adapter is configured for one wallet class
 * (spot or linear_perp), so only that class's figures are populated — the other
 * side is `null`, and a percentage basis that resolves to nothing is an ERROR
 * naming the basis, never a fabricated 0 (house rule).
 */
import { NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/platform/auth/session';
import { hasTier } from '@/platform/auth/guard';
import {
  canTransition,
  DEFAULT_RISK_PROFILE,
  maskApiKey,
  type AccountMetadata,
  type BalanceSnapshot,
  type CredentialRecord,
  type DecryptedCredentials,
  type ErrorCategory,
  type ExecutionMode,
  type Intent,
  type ExecutionPlan,
  type ExecutionRecord,
  type ExecutionRequest,
  type ExecutorStore,
  type ExchangeAdapter,
  type ExchangeId,
  type FeeModel,
  type InstrumentMetadata,
  type MarketSnapshot,
  type PreviewResult,
  type RiskProfile,
  type SizingMode,
  type Side,
} from '@/platform/executor/types';
import { DEFAULT_SLIPPAGE_MODEL, planExecution, type PlanInputs } from '@/platform/executor/plan';
import { createStrategy } from '@/platform/executor/engine';
import { createAdapter, mapError } from '@/platform/executor/exchange';
import { emergencyStop, setLiveAdapterFactory, tickerToSnapshot } from '@/platform/executor/worker';
import { ensureExecutorSchema, store } from '@/platform/executor/store';

const EXCHANGES: readonly ExchangeId[] = ['binance', 'bybit', 'mexc'];

// Composition hook, mirroring the worker's `setLiveAdapterFactory` (§68). The
// production entry point leaves this null so every venue is built from real
// revealed credentials; the paper harness substitutes a venue it controls, which
// is what lets the §93 position gate be exercised without a live account.
type PlanAdapterFactory = (
  exchange: ExchangeId,
  marketType: 'spot' | 'linear_perp',
  credentials: DecryptedCredentials,
) => Promise<ExchangeAdapter>;
let planAdapterFactory: PlanAdapterFactory | null = null;

export function setPlanAdapterFactory(factory: PlanAdapterFactory): void {
  planAdapterFactory = factory;
}

/** Test seam: restore the production composition root. */
export function resetPlanAdapterFactory(): void {
  planAdapterFactory = null;
}

/** The one place a venue is built for the plan/position path (§100). */
async function adapterFor(
  exchange: ExchangeId,
  marketType: 'spot' | 'linear_perp',
  credentials: DecryptedCredentials,
): Promise<ExchangeAdapter> {
  return planAdapterFactory
    ? planAdapterFactory(exchange, marketType, credentials)
    : createAdapter({ exchange, marketType, credentials });
}

/** Markets cache: fetchMarkets is the heaviest read on the preview path. */
const MARKETS_TTL_MS = 10 * 60 * 1000;
const marketsCache = new Map<string, { at: number; instruments: Map<string, InstrumentMetadata> }>();

export function resetRuntimeCaches(): void {
  marketsCache.clear();
}

// ---------------------------------------------------------------------------
// session + schema bootstrap
// ---------------------------------------------------------------------------

export type AuthOutcome = { user: SessionUser; denied?: undefined } | { user?: undefined; denied: NextResponse };

/**
 * The one composition step both surfaces need (API handlers AND the worker
 * entry share this — there is deliberately no second wiring path): the
 * executor schema exists, and execution rows can become venue connections via
 * the store's reveal path. Idempotent and lazily memoized.
 */
let bootstrapped: Promise<void> | null = null;

export function bootstrapExecutor(): Promise<void> {
  bootstrapped ??= (async () => {
    await ensureExecutorSchema();
    setLiveAdapterFactory(async (execution) => {
      const credentials = await store.revealCredentials(execution.userId, execution.accountId);
      if (!credentials) {
        throw new Error(`credentials for account ${execution.accountId} are revoked or missing`);
      }
      return createAdapter({
        exchange: execution.exchange,
        marketType: execution.marketType,
        credentials,
      });
    });
  })();
  return bootstrapped;
}

/**
 * Fail-closed session check (§108), server-side from the cookie — the same
 * semantics as requireMutationAuth, but it also hands back the user because
 * every store call below is scoped by their id.
 */
export async function requireExecutorUser(): Promise<AuthOutcome> {
  await bootstrapExecutor();
  const user = await getSession();
  if (!user || !hasTier(user, 'team')) {
    return {
      denied: NextResponse.json(
        { error: 'unauthorized', detail: 'requires team tier (no session)' },
        { status: 401 },
      ),
    };
  }
  return { user };
}

/** 404 for wrong-owner access: existence is never leaked (§108). */
export function notFound(what: string): NextResponse {
  return NextResponse.json({ error: `${what} not found` }, { status: 404 });
}

export function validationError(errors: string[]): NextResponse {
  return NextResponse.json({ error: 'validation', errors }, { status: 400 });
}

// ---------------------------------------------------------------------------
// accounts (§42-47)
// ---------------------------------------------------------------------------

export async function listAccounts(store: ExecutorStore, user: SessionUser): Promise<{ accounts: CredentialRecord[] }> {
  return { accounts: await store.listCredentials(user.id) };
}

export async function connectAccount(
  store: ExecutorStore,
  user: SessionUser,
  body: { exchange?: unknown; label?: unknown; apiKey?: unknown; apiSecret?: unknown; passphrase?: unknown },
): Promise<NextResponse | { account: CredentialRecord; metadata: AccountMetadata }> {
  const errors: string[] = [];
  const exchange = body.exchange;
  if (typeof exchange !== 'string' || !EXCHANGES.includes(exchange as ExchangeId)) {
    errors.push(`exchange: expected one of ${EXCHANGES.join(', ')}`);
  }
  if (typeof body.label !== 'string' || body.label.trim() === '') errors.push('label: must be a non-empty string');
  if (typeof body.apiKey !== 'string' || body.apiKey.trim() === '') errors.push('apiKey: must be a non-empty string');
  if (typeof body.apiSecret !== 'string' || body.apiSecret.trim() === '') errors.push('apiSecret: must be a non-empty string');
  if (body.passphrase !== undefined && typeof body.passphrase !== 'string') errors.push('passphrase: must be a string when given');
  if (errors.length) return validationError(errors);

  const credentials: DecryptedCredentials = {
    apiKey: body.apiKey as string,
    apiSecret: body.apiSecret as string,
    passphrase: (body.passphrase as string | undefined) ?? null,
  };
  let metadata: AccountMetadata;
  try {
    const adapter = createAdapter({
      exchange: exchange as ExchangeId,
      marketType: 'linear_perp',
      credentials,
    });
    metadata = await adapter.validateCredentials();
  } catch (err) {
    const mapped = mapError(err);
    return NextResponse.json(
      { error: 'credential check failed', detail: mapped.message, category: mapped.category },
      { status: 502 },
    );
  }
  if (metadata.permissions.withdraw === true) {
    // §43: withdrawal capability is unsupported and undesirable — refuse the key.
    return NextResponse.json(
      {
        error: 'withdrawal permission not supported',
        detail: 'this API key grants withdrawal permission — FUDCourt only supports keys WITHOUT it; revoke the permission on the exchange and reconnect',
      },
      { status: 400 },
    );
  }
  const record = await store.createCredential({
    userId: user.id,
    exchange: exchange as ExchangeId,
    label: (body.label as string).trim(),
    credentials,
    permissions: metadata.permissions,
  });
  await store.updateCredentialHealth(user.id, record.id, metadata.health);
  await store.audit({
    userId: user.id,
    action: 'credential_connected',
    target: record.id,
    payload: { exchange, label: record.label, health: metadata.health },
  });
  return { account: record, metadata: { ...metadata, apiKeyMasked: maskApiKey(credentials.apiKey) } };
}

export async function testAccount(
  store: ExecutorStore,
  user: SessionUser,
  id: string,
): Promise<NextResponse | { account: CredentialRecord; metadata: AccountMetadata }> {
  const record = await store.getCredential(user.id, id);
  if (!record || record.revokedAt !== null) return notFound('account');
  const credentials = await store.revealCredentials(user.id, id);
  if (!credentials) return notFound('account');
  let metadata: AccountMetadata;
  try {
    const adapter = createAdapter({ exchange: record.exchange, marketType: 'linear_perp', credentials });
    metadata = await adapter.validateCredentials();
  } catch (err) {
    const mapped = mapError(err);
    await store.updateCredentialHealth(user.id, id, healthForError(mapped.category));
    await store.audit({ userId: user.id, action: 'credential_tested', target: id, payload: { ok: false, category: mapped.category } });
    return NextResponse.json(
      { error: 'credential check failed', detail: mapped.message, category: mapped.category },
      { status: 502 },
    );
  }
  if (metadata.permissions.withdraw === true) {
    await store.updateCredentialHealth(user.id, id, 'PERMISSION_ERROR');
    await store.audit({ userId: user.id, action: 'credential_tested', target: id, payload: { ok: false, withdraw: true } });
    return NextResponse.json(
      {
        error: 'withdrawal permission not supported',
        detail: 'this API key grants withdrawal permission — FUDCourt only supports keys WITHOUT it',
      },
      { status: 400 },
    );
  }
  await store.updateCredentialHealth(user.id, id, metadata.health);
  await store.touchCredential(user.id, id, Date.now());
  await store.audit({ userId: user.id, action: 'credential_tested', target: id, payload: { ok: true, health: metadata.health } });
  const fresh = await store.getCredential(user.id, id);
  return {
    account: fresh ?? record,
    metadata: { ...metadata, apiKeyMasked: maskApiKey(credentials.apiKey) },
  };
}

export async function deleteAccount(store: ExecutorStore, user: SessionUser, id: string): Promise<NextResponse | { ok: true }> {
  const record = await store.getCredential(user.id, id);
  if (!record) return notFound('account');
  await store.revokeCredential(user.id, id, Date.now());
  await store.audit({ userId: user.id, action: 'credential_revoked', target: id, payload: { exchange: record.exchange } });
  return { ok: true };
}

function healthForError(category: ErrorCategory): CredentialRecord['health'] {
  const byCategory: Readonly<Record<ErrorCategory, CredentialRecord['health']>> = {
    network_retryable: 'UNKNOWN',
    rate_limited: 'RATE_LIMITED',
    exchange_overload: 'UNKNOWN',
    invalid_order: 'UNKNOWN',
    permission_error: 'PERMISSION_ERROR',
    insufficient_balance: 'ACTIVE',
    fatal: 'INVALID',
    unknown: 'UNKNOWN',
  };
  return byCategory[category];
}

// ---------------------------------------------------------------------------
// preview + creation (§79-80, §98-99)
// ---------------------------------------------------------------------------

interface PlanContext {
  inputs: PlanInputs;
  snapshot: MarketSnapshot;
}

/**
 * Everything planExecution needs, fetched from the venue: instrument metadata,
 * market snapshot, fees, balances (PRD §98's fetch responsibilities).
 */
async function buildPlanContext(
  store: ExecutorStore,
  user: SessionUser,
  request: ExecutionRequest,
  accountOverride?: CredentialRecord,
): Promise<NextResponse | PlanContext> {
  const account = accountOverride ?? (await store.getCredential(user.id, request.accountId));
  if (!account || account.revokedAt !== null) return notFound('account');
  if (account.health === 'REVOKED' || account.health === 'INVALID') {
    return NextResponse.json(
      { error: 'credential not healthy', detail: `account health is ${account.health}` },
      { status: 409 },
    );
  }
  const credentials = await store.revealCredentials(user.id, account.id);
  if (!credentials) return notFound('account');
  const adapter = await adapterFor(account.exchange, request.marketType, credentials);

  const instruments = await loadInstruments(adapter, account.id, request.marketType);
  const instrument = instruments.get(request.symbol);
  if (!instrument) {
    return NextResponse.json(
      { error: 'symbol not supported', detail: `${request.symbol} is not a ${request.marketType} market on ${account.exchange}` },
      { status: 400 },
    );
  }

  let snapshot: MarketSnapshot;
  let feeModel: FeeModel;
  let balances: BalanceSnapshot | null = null;
  try {
    const ticker = await adapter.getTicker(request.symbol);
    snapshot = tickerToSnapshot(ticker, Date.now());
    const fees = await adapter.getFees(request.symbol);
    feeModel = { makerBps: fees.makerBps, takerBps: fees.takerBps };
    const equity = await adapter.getAccountEquity();
    balances = toBalanceSnapshot(equity, request.marketType);
  } catch (err) {
    const mapped = mapError(err);
    return NextResponse.json(
      { error: 'market data unavailable', detail: mapped.message, category: mapped.category },
      { status: 502 },
    );
  }

  const riskProfile = await store.getRiskProfile(user.id);
  return {
    inputs: {
      request,
      snapshot,
      exchange: account.exchange,
      instrument,
      feeModel,
      slippageModel: DEFAULT_SLIPPAGE_MODEL,
      balances,
      riskProfile,
    },
    snapshot,
  };
}

async function loadInstruments(
  adapter: ExchangeAdapter,
  accountId: string,
  marketType: 'spot' | 'linear_perp',
): Promise<Map<string, InstrumentMetadata>> {
  const key = `${accountId}:${marketType}`;
  const cached = marketsCache.get(key);
  if (cached && Date.now() - cached.at < MARKETS_TTL_MS) return cached.instruments;
  const markets = await adapter.getMarkets();
  const instruments = new Map<string, InstrumentMetadata>();
  for (const m of markets) {
    if (m.marketType === marketType) instruments.set(m.symbol, m.metadata);
  }
  marketsCache.set(key, { at: Date.now(), instruments });
  return instruments;
}

/**
 * Wallet-class mapping (§10). One adapter sees ONE wallet class; the other
 * side stays null — a basis that resolves to nothing errors at the planner.
 */
export function toBalanceSnapshot(
  equity: { spotEquity: number | null; futuresEquity: number | null; totalEquity: number | null; balances: { asset: string; free: number; total: number }[] },
  marketType: 'spot' | 'linear_perp',
  quoteAsset = 'USDT',
): BalanceSnapshot {
  const quote = equity.balances.find((b) => b.asset === quoteAsset);
  if (marketType === 'spot') {
    return {
      spotAvailable: quote?.free ?? null,
      spotEquity: equity.spotEquity ?? equity.totalEquity,
      futuresAvailable: null,
      futuresEquity: null,
      totalExchangeEquity: equity.totalEquity,
    };
  }
  return {
    spotAvailable: null,
    spotEquity: null,
    futuresAvailable: quote?.free ?? null,
    futuresEquity: equity.futuresEquity ?? equity.totalEquity,
    totalExchangeEquity: equity.totalEquity,
  };
}

export async function previewExecution(
  store: ExecutorStore,
  user: SessionUser,
  request: ExecutionRequest,
): Promise<NextResponse | { preview: PreviewResult; liveEnabled: boolean }> {
  const errors = validateRequestShape(request);
  if (errors.length) return validationError(errors);
  const ctx = await buildPlanContext(store, user, request);
  if ('status' in ctx) return ctx;
  const outcome = planExecution(ctx.inputs);
  if (outcome.errors.length || !outcome.preview) return validationError(outcome.errors);
  await store.touchCredential(user.id, request.accountId, Date.now()).catch(() => undefined);
  return { preview: outcome.preview, liveEnabled: process.env.FUDCOURT_EXECUTOR_LIVE === '1' };
}

// ---------------------------------------------------------------------------
// Portfolio gates (PRD §73 open risk, §74 daily loss guard)
// ---------------------------------------------------------------------------

/** Start of the user's local day, in unix ms — the §74 loss window. */
function startOfLocalDay(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The equity basis a profile percentage is measured against. `total` is the whole
 * exchange account, which is the only basis on which a cross-account portfolio
 * ceiling is meaningful: an open-risk sum spanning accounts, measured against a
 * single account's equity, would not mean anything.
 */
function portfolioEquity(balances: BalanceSnapshot | null): number | null {
  if (!balances) return null;
  if (balances.totalExchangeEquity > 0) return balances.totalExchangeEquity;
  const parts = [balances.spotEquity, balances.futuresEquity].filter(
    (v): v is number => typeof v === 'number' && v > 0,
  );
  if (parts.length === 0) return null;
  return parts.reduce((a, v) => a + v, 0);
}

/** Money in a user-facing message: fixed 2dp, thousands-separated. */
function usd(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A refusal from a portfolio gate, with the numbers that produced it. */
interface PortfolioGateRefusal {
  error: string;
  status: number;
  detail: string;
  fields: Record<string, number>;
}

/**
 * The portfolio-gate DECISION as a pure function of committed state.
 *
 * Split from `checkPortfolioGates` so the rule is testable with no database and
 * no venue: the wrapper only gathers numbers, this decides. `null` = allow.
 *
 * Both gates are §133 hard constraints, so the answer is REFUSE — never resize
 * and never merely warn. Closing and reducing are never gated: §74 blocks only
 * new openings, because refusing an exit would trap the user in the very risk
 * the guard exists to bound.
 */
export function evaluatePortfolioGates(input: {
  intent: Intent;
  equity: number | null;
  openRisk: number;
  realizedPnlToday: number;
  ownRisk: number | null;
  profile: RiskProfile;
}): PortfolioGateRefusal | null {
  const { intent, equity, profile } = input;
  if (intent !== 'open') return null;
  // No basis to express a percentage against ⇒ the ceiling is not computable, so
  // nothing is invented and nothing blocks.
  if (equity === null) return null;

  // §74: once the day's realized loss reaches the ceiling, block new openings.
  const dailyCeiling = (equity * profile.maxDailyLossPct) / 100;
  if (input.realizedPnlToday <= -dailyCeiling) {
    return {
      error: 'daily loss guard reached',
      status: 409,
      fields: {
        realizedPnlToday: input.realizedPnlToday,
        maxDailyLossPct: profile.maxDailyLossPct,
        maxDailyLossUsd: dailyCeiling,
      },
      detail:
        `realized P&L today is ${usd(input.realizedPnlToday)}, at or beyond your ` +
        `-${profile.maxDailyLossPct}% limit (${usd(dailyCeiling)}) — new openings are blocked (PRD §74). ` +
        `Closing and reducing still work.`,
    };
  }

  // §73: this execution's own risk plus everything already committed must fit
  // inside the open-risk ceiling. An unbounded plan (no stop ⇒ no bounded risk,
  // §38) contributes nothing to the sum; the stop requirement is enforced
  // separately at planning time.
  if (input.ownRisk === null) return null;
  const openCeiling = (equity * profile.maxOpenRiskPct) / 100;
  const afterCreate = input.openRisk + input.ownRisk;
  if (afterCreate <= openCeiling) return null;
  return {
    error: 'max open risk exceeded',
    status: 409,
    fields: {
      openRisk: input.openRisk,
      requestedRisk: input.ownRisk,
      maxOpenRiskPct: profile.maxOpenRiskPct,
      maxOpenRiskUsd: openCeiling,
    },
    detail:
      `open risk would reach ${usd(afterCreate)}, beyond your ${profile.maxOpenRiskPct}% limit ` +
      `(${usd(openCeiling)}): already committed ${usd(input.openRisk)}, this one adds ${usd(input.ownRisk)} (PRD §73).`,
  };
}

/** Gathers committed state from the store, then defers to the pure rule. */
async function checkPortfolioGates(
  store: ExecutorStore,
  userId: string,
  request: ExecutionRequest,
  plan: ExecutionPlan,
  inputs: PlanInputs,
): Promise<NextResponse | null> {
  const summary = await store.summarizePortfolioRisk(userId, startOfLocalDay(Date.now()));
  const refusal = evaluatePortfolioGates({
    intent: request.intent,
    equity: portfolioEquity(inputs.balances),
    openRisk: summary.openRisk,
    realizedPnlToday: summary.realizedPnlToday,
    ownRisk: plan.risk.estimatedTotalRisk,
    profile: inputs.riskProfile ?? DEFAULT_RISK_PROFILE,
  });
  if (!refusal) return null;
  return NextResponse.json({ error: refusal.error, detail: refusal.detail, ...refusal.fields }, { status: refusal.status });
}

/**
 * §93 — existing-position policy, as a PURE decision.
 *
 * The venue is the source of truth (§41/§95): before opening, the executor must
 * know whether this account already holds this symbol. MVP policy is ADD or
 * REJECT depending on explicit intent — and the rule is about DIRECTION, not
 * about "a position exists". Adding to a long is ADD; adding a SHORT to a long
 * on a one-way account nets through flat rather than adding, which the user
 * never asked for and which passes through a flat moment their stop does not
 * describe.
 *
 * Returns a refusal to surface, or null to proceed.
 */
export function evaluatePositionPolicy(input: {
  intent: Intent;
  side: Side;
  symbol: string;
  /** Signed venue quantity for this symbol; 0 when flat. */
  existingQuantity: number;
}): { error: string; status: number; detail: string } | null {
  // Closing and reducing are always allowed: a gate that could refuse an exit
  // would trap the user in the position it exists to bound (§74 reasoning).
  if (input.intent !== 'open') return null;
  const existing = input.existingQuantity;
  if (existing === 0) return null;

  const wanted = input.side === 'buy' ? 1 : -1;
  if (Math.sign(existing) === wanted) return null; // ADD — an explicit increase.

  return {
    error: 'opposing position exists',
    status: 409,
    detail:
      `${input.symbol} already holds ${Math.abs(existing)} on the ` +
      `${existing > 0 ? 'long' : 'short'} side, so this ${input.side} would net through ` +
      `flat rather than add. Submit intent 'reduce' or 'close' to act on the ` +
      `existing position, or flatten it first (PRD §93: no accidental position netting).`,
  };
}

/**
 * Gathers the venue's position, then defers to the pure rule. A venue that
 * cannot be read is NOT treated as "flat" — inventing a zero would turn an
 * unreachable exchange into permission to open into a position we cannot see.
 */


async function checkPositionPolicy(
  store: ExecutorStore,
  user: SessionUser,
  request: ExecutionRequest,
): Promise<NextResponse | null> {
  const account = await store.getCredential(user.id, request.accountId);
  if (!account) return notFound('account');
  const credentials = await store.revealCredentials(user.id, account.id);
  if (!credentials) return notFound('account');
  const adapter = planAdapterFactory
    ? await planAdapterFactory(account.exchange, request.marketType, credentials)
    : createAdapter({ exchange: account.exchange, marketType: request.marketType, credentials });

  let existingQuantity: number;
  try {
    const positions = await adapter.getPositions();
    existingQuantity = positions
      .filter((p) => p.symbol === request.symbol)
      .reduce((sum, p) => sum + p.quantity, 0);
  } catch (err) {
    const mapped = mapError(err);
    return NextResponse.json(
      {
        error: 'position check unavailable',
        detail: `${mapped.message} — refusing to assume a flat account (PRD §93/§95)`,
        category: mapped.category,
      },
      { status: 502 },
    );
  }

  const refusal = evaluatePositionPolicy({
    intent: request.intent,
    side: request.side,
    symbol: request.symbol,
    existingQuantity,
  });
  if (!refusal) return null;
  return NextResponse.json({ error: refusal.error, detail: refusal.detail }, { status: refusal.status });
}


export async function createExecution(
  store: ExecutorStore,
  user: SessionUser,
  request: ExecutionRequest,
): Promise<NextResponse | { execution: ExecutionRecord; plan: ExecutionPlan }> {
  const errors = validateRequestShape(request);
  if (errors.length) return validationError(errors);
  if (request.mode === 'preview') {
    // A preview persists nothing and places nothing (§98) — a 'preview' record
    // would be a third execution mode the runtime must never route to a venue.
    return NextResponse.json(
      { error: 'invalid mode', detail: "mode 'preview' is not creatable — use POST /api/executor/preview for a dry run, 'paper' or 'live' to create" },
      { status: 400 },
    );
  }
  const mode: ExecutionMode = request.mode ?? 'paper';
  if (mode === 'live' && process.env.FUDCOURT_EXECUTOR_LIVE !== '1') {
    return NextResponse.json(
      {
        error: 'live trading disabled',
        detail: 'FUDCOURT_EXECUTOR_LIVE is not 1 — the kill switch refuses live execution creation (PRD §108); use paper mode',
      },
      { status: 403 },
    );
  }

  const ctx = await buildPlanContext(store, user, request);
  if ('status' in ctx) return ctx;
  const outcome = planExecution(ctx.inputs);
  if (outcome.errors.length || !outcome.plan || !outcome.preview) return validationError(outcome.errors);
  // §117 default BLOCK: a conflicting plan is never created, only shown.
  if (outcome.preview.conflicts.length > 0) {
    return NextResponse.json(
      { error: 'conflict', conflicts: outcome.preview.conflicts, preview: outcome.preview },
      { status: 409 },
    );
  }

  const plan = outcome.plan;

  // Portfolio gates (§73 open risk, §74 daily loss). Checked BEFORE the row is
  // created so a refused execution leaves nothing behind to reconcile.
  const gate = await checkPortfolioGates(store, user.id, request, plan, ctx.inputs);
  if (gate) return gate;

  // §93 existing-position policy, checked BEFORE the row exists so a refusal
  // leaves nothing behind to reconcile. After the portfolio gates: both only
  // ever REFUSE, and refusing for the cheaper reason first avoids spending a
  // venue round-trip on a request the portfolio was going to reject anyway.
  const positionGate = await checkPositionPolicy(store, user, request);
  if (positionGate) return positionGate;

  const execution = await store.createExecution({
    userId: user.id,
    accountId: request.accountId,
    exchange: ctx.inputs.exchange,
    symbol: request.symbol,
    marketType: request.marketType,
    side: request.side,
    intent: request.intent,
    status: 'READY',
    mode,
    sizingMode: request.sizing.mode,
    sizingValue: request.sizing.value,
    riskBudget: plan.risk.budget,
    riskBasis: plan.riskBasis,
    entryDefinition: request.entry,
    stopDefinition: request.stopLoss ?? null,
    takeProfitDefinition: request.takeProfits ?? [],
    executionStrategy: plan.execution.strategy,
    executionConfig: request.execution,
    constraints: request.constraints ?? {},
    plannedQuantity: plan.quantity,
    plannedNotional: plan.notional,
    actualQuantity: 0,
    actualNotional: 0,
    averageFillPrice: null,
    estimatedFees: plan.risk.estimatedFees,
    actualFees: 0,
    plannedRisk: plan.risk.estimatedTotalRisk,
    currentRisk: null,
    plan,
  });
  // Strategy state is built AFTER the id exists: its seeded PRNG and client
  // order id base embed it (fud_{executionId}_{seq}, §66) — a 'pending' id here
  // would mint unmatchable order ids on every create.
  await store.updateExecutionStrategyState(execution.id, createStrategy({
    executionId: execution.id,
    plan,
    execution: request.execution,
    constraints: request.constraints ?? {},
  }));
  await store.appendEvent(execution.id, 'EXECUTION_CREATED', {
    mode,
    sizingMode: plan.sizingMode,
    quantity: plan.quantity,
    riskBudget: plan.risk.budget,
  }, Date.now());
  await store.appendEvent(execution.id, 'RISK_CALCULATED', {
    estimatedTotalRisk: plan.risk.estimatedTotalRisk,
    estimatedFees: plan.risk.estimatedFees,
    slippageBudget: plan.risk.slippageBudget,
  }, Date.now());
  await store.appendEvent(execution.id, 'PLAN_CREATED', {
    venueKey: plan.venueKey,
    strategy: plan.execution.strategy,
    estimatedSlices: plan.execution.estimatedSlices,
  }, Date.now());
  await store.audit({
    userId: user.id,
    action: 'execution_created',
    target: execution.id,
    payload: { symbol: request.symbol, mode, strategy: plan.execution.strategy },
  });
  return { execution, plan };
}

/** §79's locally-checkable subset as cheap structural guards; the planner is strict. */
function validateRequestShape(request: ExecutionRequest): string[] {
  const errors: string[] = [];
  if (typeof request.accountId !== 'string' || request.accountId === '') errors.push('accountId: must be a non-empty string');
  if (request.marketType !== 'spot' && request.marketType !== 'linear_perp') errors.push('marketType: must be spot or linear_perp');
  if (request.side !== 'buy' && request.side !== 'sell') errors.push('side: must be buy or sell');
  if (!['open', 'close', 'reduce'].includes(request.intent)) errors.push('intent: must be open, close or reduce');
  if (request.mode !== undefined && !['preview', 'paper', 'live'].includes(request.mode)) errors.push('mode: must be preview, paper or live');
  return errors;
}

// ---------------------------------------------------------------------------
// lifecycle intents (§57, §97) — the API decides intent, the worker executes it.
// ---------------------------------------------------------------------------

type LifecycleOp = 'start' | 'pause' | 'resume' | 'cancel';

export async function lifecycle(
  store: ExecutorStore,
  user: SessionUser,
  id: string,
  op: LifecycleOp,
): Promise<NextResponse | { execution: ExecutionRecord }> {
  const execution = await store.getExecution(user.id, id);
  if (!execution) return notFound('execution');

  // Intent → target status. `cancel` on a never-started execution cancels
  // outright; while running it goes through CANCEL_REQUESTED so the worker
  // cancels venue orders first (§57/§75).
  let to = execution.status;
  switch (op) {
    case 'start':
      to = execution.status === 'READY' ? 'RUNNING' : execution.status;
      break;
    case 'pause':
      to = execution.status === 'RUNNING' || execution.status === 'PARTIALLY_FILLED' || execution.status === 'RECONCILING' ? 'PAUSED' : execution.status;
      break;
    case 'resume':
      to = execution.status === 'PAUSED' ? 'RUNNING' : execution.status;
      break;
    case 'cancel':
      to = execution.status === 'READY' || execution.status === 'DRAFT' ? 'CANCELLED' : 'CANCEL_REQUESTED';
      break;
  }
  if (to === execution.status) {
    return NextResponse.json(
      { error: 'invalid transition', detail: `${op} is not applicable in status ${execution.status}` },
      { status: 409 },
    );
  }
  if (!canTransition(execution.status, to)) {
    return NextResponse.json(
      { error: 'invalid transition', detail: `${execution.status} → ${to} is not a legal lifecycle step (PRD §57)` },
      { status: 409 },
    );
  }
  const at = Date.now();
  await store.updateExecutionStatus(execution.id, to, at);
  const eventName =
    op === 'start' ? 'EXECUTION_STARTED'
    : op === 'pause' ? 'EXECUTION_PAUSED'
    : op === 'resume' ? 'EXECUTION_RESUMED'
    : 'EXECUTION_CANCELLED';
  await store.appendEvent(execution.id, eventName, { from: execution.status, to }, at);
  await store.audit({
    userId: user.id,
    action: `execution_${op}`,
    target: execution.id,
    payload: { from: execution.status, to },
  });
  const fresh = await store.getExecution(user.id, id);
  return { execution: fresh ?? { ...execution, status: to } };
}

export async function runEmergencyStop(
  store: ExecutorStore,
  user: SessionUser,
  body: { accountId?: unknown },
): Promise<NextResponse | { stopped: number; cancelledOrders: number }> {
  if (body.accountId !== undefined && typeof body.accountId !== 'string') {
    return validationError(['accountId: must be a string when given']);
  }
  const result = await emergencyStop(store, {
    userId: user.id,
    accountId: typeof body.accountId === 'string' ? body.accountId : undefined,
  }, 'api-emergency');
  await store.audit({
    userId: user.id,
    action: 'emergency_stop',
    target: typeof body.accountId === 'string' ? body.accountId : null,
    payload: result,
  });
  return result;
}

// ---------------------------------------------------------------------------
// settings (§88, §119)
// ---------------------------------------------------------------------------

const PROFILE_KEYS: Readonly<Record<string, 'number' | 'string'>> = {
  defaultRiskMode: 'string',
  defaultRisk: 'number',
  maxRiskPerTradePct: 'number',
  maxOpenRiskPct: 'number',
  maxDailyLossPct: 'number',
  maxLeverage: 'number',
  defaultMarginMode: 'string',
  defaultExecutionUrgency: 'string',
};

export async function getSettings(store: ExecutorStore, user: SessionUser): Promise<{ profile: RiskProfile }> {
  return { profile: await store.getRiskProfile(user.id) };
}

export async function putSettings(
  store: ExecutorStore,
  user: SessionUser,
  body: Record<string, unknown>,
): Promise<NextResponse | { profile: RiskProfile }> {
  const errors: string[] = [];
  const merged: Record<string, unknown> = { ...DEFAULT_RISK_PROFILE };
  for (const [key, kind] of Object.entries(PROFILE_KEYS)) {
    const value = body[key];
    if (value === undefined) continue;
    if (kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      errors.push(`${key}: must be a positive number`);
      continue;
    }
    if (kind === 'string' && typeof value !== 'string') {
      errors.push(`${key}: must be a string`);
      continue;
    }
    merged[key] = value;
  }
  if (typeof merged.defaultRiskMode === 'string' && !['risk_usd', 'risk_percent'].includes(merged.defaultRiskMode)) {
    errors.push('defaultRiskMode: must be risk_usd or risk_percent');
  }
  if (typeof merged.defaultMarginMode === 'string' && !['isolated', 'cross'].includes(merged.defaultMarginMode)) {
    errors.push('defaultMarginMode: must be isolated or cross');
  }
  if (typeof merged.defaultExecutionUrgency === 'string' && !['passive', 'balanced', 'aggressive', 'immediate'].includes(merged.defaultExecutionUrgency)) {
    errors.push('defaultExecutionUrgency: must be passive, balanced, aggressive or immediate');
  }
  if (errors.length) return validationError(errors);
  // Boundary cast: every key above was type-checked against PROFILE_KEYS; there
  // is no schema validator in this app, so this is the validated-shape handoff.
  const profile = merged as unknown as RiskProfile;
  return { profile: await store.putRiskProfile(user.id, profile) };
}
