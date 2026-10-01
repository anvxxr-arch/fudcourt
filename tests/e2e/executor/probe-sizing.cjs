// Throwaway probe: why do the min-notional and rounding warnings not appear?
const { planExecution } = require('@/platform/executor/plan');
const INSTRUMENT = {
  symbol: 'BTC/USDT', marketType: 'linear_perp', exchange: 'binance', baseAsset: 'BTC',
  quoteAsset: 'USDT', settlementAsset: 'USDT', tickSize: 0.01, stepSize: 0.0001,
  minQuantity: 0.0001, maxQuantity: null, minNotional: 5, maxNotional: null,
  contractMultiplier: 1, maxLeverage: 125, maintenanceMarginRate: 0.004, leverageBrackets: [],
};
const SNAPSHOT = { symbol: 'BTC/USDT', bid: 99995, ask: 100005, mid: 100000, spreadBps: 1, last: 100000, timestamp: 1760000000000 };
const BALANCES = { spotAvailable: 2500, spotEquity: 2600, futuresAvailable: 4800, futuresEquity: 5000, totalExchangeEquity: 7500 };
const profile = { defaultRiskMode: 'risk_percent', defaultRisk: 1, maxRiskPerTradePct: 2, maxOpenRiskPct: 5, maxLeverage: 10, defaultMarginMode: 'isolated', defaultExecutionUrgency: 'balanced' };
function run(label, over) {
  const out = planExecution({
    request: Object.assign({
      accountId: 'a', symbol: 'BTC/USDT', marketType: 'linear_perp', side: 'buy', intent: 'open',
      entry: { type: 'limit', price: 100000 }, stopLoss: { price: 98000 }, takeProfits: [{ price: 106000 }],
      sizing: { mode: 'risk_usd', value: 20 }, leverage: { mode: 'manual', leverage: 5 },
      execution: { type: 'limit', price: 100000 },
    }, over.request),
    snapshot: SNAPSHOT, exchange: 'binance',
    instrument: Object.assign({}, INSTRUMENT, over.instrument),
    feeModel: { makerBps: 0, takerBps: 0 }, slippageModel: { slippageBps: 0, safetyReservePct: 0 },
    balances: BALANCES, riskProfile: profile,
  });
  console.log('===', label);
  console.log('errors', out.errors);
  console.log('qty', out.plan && out.plan.quantity, 'notional', out.plan && out.plan.notional, 'totalRisk', out.plan && out.plan.risk.estimatedTotalRisk);
  console.log('warnings', out.preview && out.preview.warnings);
}
run('min-notional risk 2 step .001', { instrument: { stepSize: 0.001, minNotional: 500 }, request: { sizing: { mode: 'risk_usd', value: 2 } } });
run('rounding risk 25 step .001', { instrument: { stepSize: 0.001 }, request: { sizing: { mode: 'risk_usd', value: 25 } } });
