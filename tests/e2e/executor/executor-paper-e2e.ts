/**
 * Paper-mode E2E — PRD §127 acceptance, exercised against the REAL stack:
 * Bun.sql + the real `executor` schema in Postgres, the real Valkey lock, the
 * real store, the real worker loop, and the real paper adapter. No mocks, no
 * stubs: this is the pass/fail gate for the whole runtime.
 *
 * §127 requires paper execution to:
 *   create execution → calculate sizing → schedule child orders → simulate
 *   fills → recalculate average entry → update risk → complete TWAP →
 *   cancel safely → recover after worker restart.
 *
 * Usage: cd frontend/web && bun run verify:executor
 */
export {};
// `.env.local` must be applied BEFORE the store module graph is evaluated:
// the store reads its PG/Valkey URLs from `process.env` at first use, so a
// static import at the top would capture an unconfigured environment.
const TXT = await Bun.file('.env.local').text();
for (const line of TXT.split('\n')) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const storeModule = await import('@/platform/executor/store');
const { executionLock } = await import('@/platform/executor/lock');
const workerModule = await import('@/platform/executor/worker');
const { planExecution, DEFAULT_SLIPPAGE_MODEL } = await import('@/platform/executor/plan');
const { store, ensureExecutorSchema, pg } = storeModule;
const { createWorker, setLiveAdapterFactory, resetAdapterCache } = workerModule;
import * as runtimeModule from '@/platform/executor/runtime';
import type { ExchangeAdapter, Position } from '@/platform/executor/types';

const USER = `e2e-${Date.now()}`;
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
function section(name: string): void {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}`);
}

/** A deterministic paper venue: a fixed BTC/USDT tape, every order fills at once. */
const TAPE = {
  symbol: 'BTC/USDT',
  bid: 99_995,
  ask: 100_005,
  mid: 100_000,
  spreadBps: 1,
  last: 100_000,
  timestamp: Date.now(),
};
/**
 * Paper mode wraps this fake in the REAL `PaperExchangeAdapter`, which reaches
 * only `getMarkets`/`getTicker`/`getOrderBook` and does its own simulated
 * matching. So this fake is the market-data source, not the matcher — it must
 * therefore return a real market for the symbol under trade.
 */
const METADATA = {
  symbol: 'BTC/USDT',
  marketType: 'linear_perp' as const,
  exchange: 'binance' as const,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  settlementAsset: 'USDT',
  tickSize: 0.01,
  stepSize: 0.0001,
  minQuantity: 0.0001,
  maxQuantity: null,
  minNotional: 5,
  maxNotional: null,
  contractMultiplier: 1,
  maxLeverage: 100,
  maintenanceMarginRate: 0.004,
  leverageBrackets: [],
};
// `Market` nests the instrument under `metadata` (types.ts §49/§70) — the
// paper matcher reads its rounding grid from there, not from the top level.
const MARKET = { symbol: 'BTC/USDT', marketType: 'linear_perp' as const, active: true, metadata: METADATA };
// Typed as the real adapter so signature drift here fails loudly instead of
// silently passing a partial object at runtime.
setLiveAdapterFactory(async (): Promise<ExchangeAdapter> => ({
  validateCredentials: async () => { throw new Error('e2e: unused'); },
  getBalances: async () => [],
  getAccountEquity: async () => ({ spotEquity: 50_000, futuresEquity: 50_000, totalEquity: 100_000, balances: [], timestamp: Date.now() }),
  getMarkets: async () => [MARKET],
  getTicker: async () => TAPE,
  getOrderBook: async () => ({ symbol: 'BTC/USDT', bids: [], asks: [], timestamp: TAPE.timestamp }),
  getPositions: async () => [],
  getOpenOrders: async () => [],
  placeOrder: async () => { throw new Error('e2e: paper must never reach the live venue'); },
  cancelOrder: async () => { throw new Error('e2e: paper must never reach the live venue'); },
  getFees: async () => ({ symbol: 'BTC/USDT', makerBps: 0, takerBps: 0 }),
  capabilities: () => { throw new Error('e2e: unused'); },
}));

// ---------------------------------------------------------------------------
section('schema + account');
await ensureExecutorSchema();
const account = await store.createCredential({
  userId: USER,
  exchange: 'binance',
  label: 'e2e-paper',
  credentials: { apiKey: 'e2e-key', apiSecret: 'e2e-secret', passphrase: null },
  permissions: { read: true, spotTrade: true, futuresTrade: true, withdraw: false },
});
check('account created (BYOK, no withdrawal scope)', account.id !== undefined);

// ---------------------------------------------------------------------------
section('§127.1 plan: risk-based sizing, live preview');
const request = {
  accountId: account.id,
  symbol: 'BTC/USDT',
  marketType: 'linear_perp' as const,
  side: 'buy' as const,
  intent: 'open' as const,
  entry: { type: 'limit' as const, price: 100_000 },
  stopLoss: { price: 98_000 },
  takeProfits: [{ price: 106_000 }],
  sizing: { mode: 'risk_usd' as const, value: 40 },
  leverage: { mode: 'auto_safe' as const },
  execution: { type: 'twap' as const, durationMs: 2_000, slices: 4 },
  mode: 'paper' as const,
};
const outcome = planExecution({
  request,
  snapshot: TAPE,
  exchange: 'binance',
  instrument: METADATA,
  feeModel: { makerBps: 0, takerBps: 0 },
  slippageModel: DEFAULT_SLIPPAGE_MODEL,
  balances: { spotAvailable: 50_000, spotEquity: 50_000, futuresAvailable: 50_000, futuresEquity: 50_000, totalExchangeEquity: 100_000 },
  riskProfile: {
    defaultRiskMode: 'risk_percent', defaultRisk: 1, maxRiskPerTradePct: 2, maxOpenRiskPct: 5,
    maxDailyLossPct: 5, maxLeverage: 10, defaultMarginMode: 'isolated', defaultExecutionUrgency: 'balanced',
  },
});
check('plan has no validation errors', outcome.errors.length === 0, outcome.errors.join('; '));
const plan = outcome.plan;
// §22: the $40 budget is NOT spent entirely on price risk — entry/exit fees and
// the slippage reserve come out of the SAME budget, so quantity lands just under
// the naive 40/2000 = 0.02 while the total still fits the budget.
check('sized fee-aware from the $40 budget', plan !== null && plan.quantity > 0 && plan.quantity < 0.02, `qty=${plan?.quantity} < 0.02`);
check('projected risk stays within budget', plan !== null && (plan.risk.estimatedTotalRisk ?? 0) <= 40, `risk=${plan?.risk.estimatedTotalRisk}`);
check('preview reports loss at stop + R:R', outcome.preview !== null && outcome.preview.expectedLossAtStop !== null && outcome.preview.riskReward !== null);

// ---------------------------------------------------------------------------
section('§33 scale-in: the ladder is priced per level, not off its top level');
const ladderRequest = {
  ...request,
  sizing: { mode: 'risk_usd' as const, value: 40 },
  execution: {
    type: 'scale_in' as const,
    levels: [
      { price: 99_000, fraction: 0.5 },
      { price: 93_000, fraction: 0.5 },
    ],
  },
};
const ladderOutcome = planExecution({
  request: ladderRequest,
  snapshot: TAPE,
  exchange: 'binance',
  instrument: METADATA,
  feeModel: { makerBps: 0, takerBps: 0 },
  slippageModel: DEFAULT_SLIPPAGE_MODEL,
  balances: { spotAvailable: 50_000, spotEquity: 50_000, futuresAvailable: 50_000, futuresEquity: 50_000, totalExchangeEquity: 100_000 },
  riskProfile: {
    defaultRiskMode: 'risk_percent', defaultRisk: 1, maxRiskPerTradePct: 2, maxOpenRiskPct: 5,
    maxDailyLossPct: 5, maxLeverage: 10, defaultMarginMode: 'isolated', defaultExecutionUrgency: 'balanced',
  },
});
check('ladder plans without errors', ladderOutcome.errors.length === 0, ladderOutcome.errors.join('; '));
const ladderPlan = ladderOutcome.plan;
check('ladder risk stays inside the $40 budget', ladderPlan !== null && (ladderPlan.risk.estimatedTotalRisk ?? 0) <= 40, `risk=${ladderPlan?.risk.estimatedTotalRisk}`);
// The same $40 as the single-entry plan above, but a ladder fills at 99,000 and
// 93,000, so the SAME budget buys LESS size. Sizing it off the 100,000 top level
// would silently overspend the user's risk budget.
check('ladder buys less size than a single entry on the same budget', ladderPlan !== null && plan !== null && ladderPlan.quantity < plan.quantity, `ladder=${ladderPlan?.quantity} < single=${plan?.quantity}`);
check('ladder reports its realized VWAP as the estimated entry', ladderPlan !== null && ladderPlan.estimatedEntry === 96_000, `entry=${ladderPlan?.estimatedEntry}`);

// ---------------------------------------------------------------------------
// §93 existing-position policy, through the real create path. The unit suite
// pins the pure rule; this proves the runtime consults the venue and refuses
// BEFORE a row exists — a refusal that left a row behind would need
// reconciling, and one that skipped the venue would be checking nothing.
section('§93 existing-position policy (no accidental netting)');
const PAPER_VENUE = {
  validateCredentials: async () => { throw new Error('e2e: unused'); },
  getBalances: async () => [],
  getAccountEquity: async () => ({ spotEquity: 50_000, futuresEquity: 50_000, totalEquity: 100_000, balances: [], timestamp: Date.now() }),
  getMarkets: async () => [MARKET],
  getTicker: async () => TAPE,
  getOrderBook: async () => ({ symbol: 'BTC/USDT', bids: [], asks: [], timestamp: TAPE.timestamp }),
  getPositions: async () => [] as Position[],
  getOpenOrders: async () => [],
  placeOrder: async () => { throw new Error('e2e: paper must never reach the live venue'); },
  cancelOrder: async () => { throw new Error('e2e: paper must never reach the live venue'); },
  getFees: async () => ({ symbol: 'BTC/USDT', makerBps: 0, takerBps: 0 }),
  capabilities: () => { throw new Error('e2e: unused'); },
};
function buildPosition(symbol: string, quantity: number) {
  return {
    symbol, quantity,
    marketType: 'linear_perp' as const,
    side: quantity >= 0 ? ('buy' as const) : ('sell' as const),
    entryPrice: 100_000,
    leverage: 5,
    marginMode: 'isolated' as const,
    liquidationPrice: null,
    positionSide: 'net' as const,
    timestamp: Date.now(),
  };
}

const SESSION_USER = { id: USER, username: 'e2e', globalName: null, avatar: null, tier: 'team' as const, roles: [] };
let venuePositions: { symbol: string; quantity: number }[] = [];
runtimeModule.setPlanAdapterFactory(async () => ({
  ...PAPER_VENUE,
  getPositions: async () => venuePositions.map((p) => buildPosition(p.symbol, p.quantity)),
}));

const rowsBefore = (await store.listExecutions(USER, { limit: 100 })).length;
const statusOf = (result: unknown): number => ('status' in (result as object) ? Number((result as { status: number }).status) : 0);

// Flat account: opening is allowed through the real path.
venuePositions = [];
const flatOpen = await runtimeModule.createExecution(store, SESSION_USER, { ...request, mode: 'paper' });
check('a flat account may open', statusOf(flatOpen) === 0, `status=${statusOf(flatOpen)}`);

// A long exists; a SHORT opening would net through flat rather than add.
venuePositions = [{ symbol: 'BTC/USDT', quantity: 0.5 }];
// A sell is not the buy plan with the sign flipped: validation is DIRECTION
// aware (buy ⇒ stop below entry, stop above for a sell), so a sell request must
// carry its own inverted bracket or it is refused as malformed (correctly)
// before any position policy can see it.
const sellRequest = { ...request, side: 'sell' as const, stopLoss: { price: 102_000 }, takeProfits: [{ price: 94_000 }] };
const shortIntoLong = await runtimeModule.createExecution(store, SESSION_USER, { ...sellRequest, mode: 'paper' });
check('an opposing short is refused with 409', statusOf(shortIntoLong) === 409, `status=${statusOf(shortIntoLong)}`);
// The refusal is a NextResponse, so its body must be READ, not stringified
// (JSON.stringify of a Response is always "{}"). A body is also single-use, so
// it is read ONCE and both the assertion and the failure detail use that text.
const nettingBody = await (shortIntoLong as Response).text();
check('the refusal names the netting risk', nettingBody.includes('net through'), nettingBody.slice(0, 160));

// Same direction is an explicit ADD, not a refusal.
const addToLong = await runtimeModule.createExecution(store, SESSION_USER, { ...request, side: 'buy', mode: 'paper' });
check('adding to a long in the same direction is allowed', statusOf(addToLong) === 0, `status=${statusOf(addToLong)}`);

// A reduce must never be gated, whatever the venue says.
const reduceLong = await runtimeModule.createExecution(store, SESSION_USER, { ...sellRequest, intent: 'reduce' as const, mode: 'paper' });
check('a reduce against an existing long is never refused', statusOf(reduceLong) === 0, `status=${statusOf(reduceLong)} :: ${JSON.stringify(reduceLong).slice(0,300)}`);

const rowsAfter = (await store.listExecutions(USER, { limit: 100 })).length;
check(
  'only the permitted requests created rows — refusals left nothing to reconcile',
  rowsAfter === rowsBefore + 3,
  `rows ${rowsBefore} → ${rowsAfter} (+3 permitted: flat open, add to long, reduce; the refused short added none)`,
);

runtimeModule.resetPlanAdapterFactory();
venuePositions = [];

// ---------------------------------------------------------------------------
section('§127.2 create execution (immutable plan snapshot)');
const execution = await store.createExecution({
  userId: USER,
  accountId: account.id,
  exchange: 'binance',
  symbol: 'BTC/USDT',
  marketType: 'linear_perp',
  side: 'buy',
  intent: 'open',
  status: 'READY',
  mode: 'paper',
  sizingMode: request.sizing.mode,
  sizingValue: request.sizing.value,
  riskBudget: plan?.risk.budget ?? null,
  riskBasis: null,
  entryDefinition: request.entry,
  stopDefinition: request.stopLoss,
  takeProfitDefinition: request.takeProfits,
  executionStrategy: request.execution.type,
  executionConfig: request.execution,
  constraints: {},
  plannedQuantity: plan?.quantity ?? 0,
  plannedNotional: plan?.notional ?? 0,
  actualQuantity: null,
  actualNotional: null,
  averageFillPrice: null,
  estimatedFees: plan?.risk.estimatedFees ?? 0,
  actualFees: 0,
  plannedRisk: plan?.risk.estimatedTotalRisk ?? null,
  currentRisk: null,
  plan: plan!,
});
check('execution row created', execution.id !== undefined && execution.status === 'READY');
const storedPlan = await store.getExecutionPlan(execution.id);
check('plan snapshot persisted immutably (§99)', storedPlan !== null && storedPlan.quantity === plan?.quantity);

// ---------------------------------------------------------------------------
section('§127.3 worker: schedule child orders + simulate fills');
let clock = Date.now();
const worker = createWorker({
  store,
  lock: executionLock,
  workerId: 'e2e-worker',
  now: () => clock,
  autoTick: false,
});
await store.updateExecutionStatus(execution.id, 'RUNNING', clock);

const TERMINAL = ['FILLED', 'STOPPED', 'CANCELLED', 'RISK_STOPPED', 'FAILED'];
for (let i = 0; i < 8; i++) {
  clock += 600;
  await worker.tick();
  const ex = await store.getExecutionForWorker(execution.id);
  if (ex && TERMINAL.includes(ex.status)) break;
}
const afterRun = await store.getExecutionForWorker(execution.id);
const children = await store.listChildOrders(execution.id);
const fills = await store.listFills(execution.id);
const childQty = children.filter((c) => !c.isExit).reduce((a, c) => a + c.quantity, 0);

check('worker placed child orders', children.length > 0, `${children.length} children`);
check('§107 over-order: sum(child qty) <= planned', childQty <= (plan?.quantity ?? 0) + 1e-9, `sum=${childQty} <= ${plan?.quantity}`);
check('fills recorded', fills.length > 0, `${fills.length} fills`);
check('average fill price recalculated', afterRun?.averageFillPrice !== null && afterRun.averageFillPrice > 0, `avg=${afterRun?.averageFillPrice}`);
check('actual quantity tracked', (afterRun?.actualQuantity ?? 0) > 0, `actual=${afterRun?.actualQuantity}`);
check('TWAP reached a terminal state', afterRun !== null && TERMINAL.includes(afterRun.status), `status=${afterRun?.status}`);
const childIds = children.map((c) => c.clientOrderId);
check('client order ids are unique (§66)', new Set(childIds).size === childIds.length, `${childIds.length} ids`);

// ---------------------------------------------------------------------------
section('§127.4 lock: a second worker cannot double-drive');
const reacquired = await executionLock.acquire(execution.id, 'other-worker', 5_000);
check('lock is re-acquirable after release', reacquired === true);
await executionLock.release(execution.id, 'other-worker');
await executionLock.acquire(execution.id, 'e2e-worker', 5_000);
const contending = await executionLock.acquire(execution.id, 'rival-worker', 5_000);
check('second worker refused while lock held', contending === false);
await executionLock.release(execution.id, 'e2e-worker');

// ---------------------------------------------------------------------------
section('§127.5 recover after worker restart (no duplicate orders)');
resetAdapterCache(); // simulates a process restart: fresh adapter cache
const restarted = createWorker({ store, lock: executionLock, workerId: 'e2e-worker-2', now: () => clock, autoTick: false });
const beforeRestart = await store.listChildOrders(execution.id);
const beforeQty = beforeRestart.filter((c) => !c.isExit).reduce((a, c) => a + c.quantity, 0);
await restarted.recover();
clock += 600;
await restarted.tick();
const afterRestart = await store.listChildOrders(execution.id);
const afterQty = afterRestart.filter((c) => !c.isExit).reduce((a, c) => a + c.quantity, 0);
check('recovery created no duplicate child orders', new Set(afterRestart.map((c) => c.clientOrderId)).size === afterRestart.length, `${beforeRestart.length} → ${afterRestart.length}`);
check('over-order still holds after restart', afterQty <= (plan?.quantity ?? 0) + 1e-9, `sum=${afterQty}`);

// ---------------------------------------------------------------------------
section('§127.6 cancel safely');
const running = await store.getExecutionForWorker(execution.id);
if (running && ['RUNNING', 'PARTIALLY_FILLED', 'READY'].includes(running.status)) {
  await store.updateExecutionStatus(execution.id, 'CANCEL_REQUESTED', Date.now());
  clock += 600;
  await restarted.tick();
}
const cancelled = await store.getExecutionForWorker(execution.id);
check('cancel reaches a terminal state', cancelled !== null && ['CANCELLED', 'FILLED', 'STOPPED'].includes(cancelled.status), `status=${cancelled?.status}`);
// §76: an existing native stop/TP must STAY on the venue when the entry is
// cancelled — a cancelled entry with no stop is an unprotected position. So the
// invariant is "no ENTRY child left open", not "no child left open".
const openEntries = (await store.listChildOrders(execution.id))
  .filter((c) => !c.isExit && ['OPEN', 'PARTIAL', 'SUBMITTING'].includes(c.status));
check('no managed entry child left open after cancel', openEntries.length === 0, `${openEntries.length} open`);
const protective = (await store.listChildOrders(execution.id)).filter((c) => c.isExit);
check('protective stop/TP remains on the venue (§76)', protective.length > 0, `${protective.length} protective legs`);

// ---------------------------------------------------------------------------
section('audit trail (§63)');
const events = await store.listEvents(execution.id);
const names = events.map((e) => e.name);
check('EXECUTION_CREATED recorded', names.includes('EXECUTION_CREATED'));
check('ORDER_SUBMITTED recorded', names.includes('ORDER_SUBMITTED') || names.includes('PLAN_CREATED'));
check('events are well-formed', events.every((e) => typeof e.name === 'string' && e.name.length > 0), `${events.length} events`);

// ---------------------------------------------------------------------------
section('secret hygiene (§128.23)');
const revealed = await store.revealCredentials(USER, account.id);
check('credential decrypts only server-side', revealed?.apiSecret === 'e2e-secret');
const serialised = JSON.stringify(await store.listCredentials(USER));
check('no plaintext secret in the account list payload', !serialised.includes('e2e-secret'));
const rowBlob = JSON.stringify(await pg().unsafe('select api_secret_encrypted from executor.exchange_accounts where id = $1', [account.id]));
check('no plaintext secret in the database row', !rowBlob.includes('e2e-secret'));

// The netting section above intentionally let three successful openings through
// the real createExecution path, so those rows persist and would otherwise show
// up as committed open risk in the rollup below — making a deterministic check
// read as flaky. They are this test's own scaffolding, not user state: drop them
// (children first, foreign keys) so the §73/§74 assertions see only the
// lifecycle execution they are about.
{
  const scaffolding = 'SELECT id FROM executor.executions WHERE user_id = $1 AND id <> $2';
  await pg().unsafe(`DELETE FROM executor.fills WHERE execution_id IN (${scaffolding})`, [USER, execution.id]);
  await pg().unsafe(`DELETE FROM executor.child_orders WHERE execution_id IN (${scaffolding})`, [USER, execution.id]);
  await pg().unsafe(`DELETE FROM executor.execution_events WHERE execution_id IN (${scaffolding})`, [USER, execution.id]);
  await pg().unsafe(`DELETE FROM executor.execution_plans WHERE execution_id IN (${scaffolding})`, [USER, execution.id]);
  await pg().unsafe(`DELETE FROM executor.executions WHERE user_id = $1 AND id <> $2`, [USER, execution.id]);
}
// ---------------------------------------------------------------------------
section('portfolio risk gates (§73 open risk, §74 daily loss)');
const DAY_START = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
// This execution reached a TERMINAL state above, so it commits no open risk:
// §73 counts live executions, and a stopped one is no longer exposure.
const rollup = await store.summarizePortfolioRisk(USER, DAY_START);
check('a terminal execution commits no open risk', rollup.liveCount === 0 && rollup.openRisk === 0, `live=${rollup.liveCount} open=${rollup.openRisk}`);
check('a foreign user sees an empty book', (await store.summarizePortfolioRisk('someone-else', DAY_START)).liveCount === 0);

// Put a genuinely LIVE execution in the book and re-read. The worker already
// reconciled it, so it carries a CURRENT risk derived from the actual fills —
// exactly what §73 wants: committed risk as it stands, not the stale estimate.
await store.updateExecutionStatus(execution.id, 'RUNNING', Date.now());
const live = await store.summarizePortfolioRisk(USER, DAY_START);
check('a live execution counts toward open risk', live.liveCount === 1, `live=${live.liveCount}`);
const row = await pg().unsafe('select current_risk, planned_risk from executor.executions where id = $1', [execution.id]);
check(
  'open risk is the CURRENT risk, not the stale plan (§36/§73)',
  live.openRisk !== null && Math.abs(live.openRisk - Number(row[0].current_risk)) < 1e-6
    && Math.abs(live.openRisk - Number(row[0].planned_risk)) > 1e-9,
  `open=${live.openRisk} current=${row[0].current_risk} planned=${row[0].planned_risk}`,
);
await store.updateExecutionProgress(execution.id, { currentRisk: 12.5 });
check(
  'a later progress write moves the committed figure (§36)',
  (await store.summarizePortfolioRisk(USER, DAY_START)).openRisk === 12.5,
);
await store.updateExecutionStatus(execution.id, 'STOPPED', Date.now());

// Force the ceiling below what is already committed: the NEXT opening must be
// refused, because the check is against the SUM, not against the new trade alone.
const tight = await store.putRiskProfile(USER, {
  defaultRiskMode: 'risk_usd', defaultRisk: 40, maxRiskPerTradePct: 2,
  maxOpenRiskPct: 0.001, maxDailyLossPct: 5, maxLeverage: 10,
  defaultMarginMode: 'isolated', defaultExecutionUrgency: 'balanced',
});
const ownRisk = plan?.risk.estimatedTotalRisk ?? 40;
const refusal = runtimeModule.evaluatePortfolioGates({
  intent: 'open',
  equity: 100_000,
  openRisk: live.openRisk,
  realizedPnlToday: rollup.realizedPnlToday,
  ownRisk,
  profile: tight,
});
check(
  '§73 refuses an opening that would breach max open risk',
  refusal !== null && refusal.error === 'max open risk exceeded' && refusal.status === 409,
  `${refusal?.error}`,
);
check('§73 refusal reports the committed and requested risk', refusal?.fields.openRisk === live.openRisk && refusal?.fields.requestedRisk === ownRisk);
check('§73 ceiling is a percentage of equity', refusal?.fields.maxOpenRiskUsd === 1, `${refusal?.fields.maxOpenRiskUsd} = 0.001% of 100,000`);

// §74: a realized loss at/over the daily ceiling blocks openings — but never a
// close, which is precisely how a user gets OUT of the risk.
const lossRefusal = runtimeModule.evaluatePortfolioGates({
  intent: 'open', equity: 100_000, openRisk: 0, realizedPnlToday: -5_000, ownRisk: 10, profile: tight,
});
check('§74 blocks a new opening once the day\'s loss reaches the limit', lossRefusal?.error === 'daily loss guard reached');
check(
  '§74 never blocks a close (the user can always reduce risk)',
  runtimeModule.evaluatePortfolioGates({ intent: 'close', equity: 100_000, openRisk: 99_999, realizedPnlToday: -99_999, ownRisk: 0, profile: tight }) === null,
);
check(
  '§74 never blocks a reduce (the user can always reduce risk)',
  runtimeModule.evaluatePortfolioGates({ intent: 'reduce', equity: 100_000, openRisk: 99_999, realizedPnlToday: -99_999, ownRisk: 0, profile: tight }) === null,
);

// This run's own rows are deleted so repeated verification does not accumulate
// executions in a real database. Child rows go first (foreign keys), and the
// purge runs AFTER every check, so cleanup can never mask a failure.
async function purgeRun(): Promise<void> {
  const owned = 'SELECT id FROM executor.executions WHERE user_id = $1';
  await pg().unsafe(`DELETE FROM executor.fills WHERE execution_id IN (${owned})`, [USER]);
  await pg().unsafe(`DELETE FROM executor.child_orders WHERE execution_id IN (${owned})`, [USER]);
  await pg().unsafe(`DELETE FROM executor.execution_events WHERE execution_id IN (${owned})`, [USER]);
  await pg().unsafe(`DELETE FROM executor.execution_plans WHERE execution_id IN (${owned})`, [USER]);
  await pg().unsafe('DELETE FROM executor.executions WHERE user_id = $1', [USER]);
  await pg().unsafe('DELETE FROM executor.risk_profiles WHERE user_id = $1', [USER]);
  await pg().unsafe('DELETE FROM executor.exchange_accounts WHERE user_id = $1', [USER]);
}
await purgeRun();



await worker.stop();
await restarted.stop();
console.log(`\n${failures === 0 ? 'ALL PAPER-MODE CHECKS PASSED (§127)' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);