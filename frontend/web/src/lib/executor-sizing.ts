/**
 * executor-sizing.ts — sizing, balance-basis, and fee/slippage model shapes
 * (PRD §10, §12, §22, §52). Split from `./executor-request`: `BalanceBasis`,
 * `BalanceSnapshot`, `FeeModel`, `FeeSchedule`, `SlippageModel`,
 * `SizingDefinition`, and `SizingMode` are defined ONLY here —
 * `executor-request.ts` and the `@/lib/executor` barrel re-export, never redefine.
 */

// ---------------------------------------------------------------------------
// Balance basis (PRD §10) — percentage sizing MUST name its source explicitly.
// ---------------------------------------------------------------------------

export type BalanceBasis =
  | 'spot_available'
  | 'spot_equity'
  | 'futures_available'
  | 'futures_equity'
  | 'total_exchange_equity'
  | 'asset_equity'
  | 'custom';

/** A resolved balance view, as returned by `resolveBalanceBasis`. */
export interface BalanceSnapshot {
  spotAvailable: number | null;
  spotEquity: number | null;
  futuresAvailable: number | null;
  futuresEquity: number | null;
  totalExchangeEquity: number | null;
  /** Present only for `asset_equity`: the base-asset holding value in quote terms. */
  assetEquity?: number | null;
  /** Present only for `custom`: the caller-supplied reference balance. */
  custom?: number | null;
}

// ---------------------------------------------------------------------------
// Fees / risk models (PRD §22)
// ---------------------------------------------------------------------------

export interface FeeModel {
  /** Basis points of notional, e.g. 5 = 0.05%. */
  makerBps: number;
  takerBps: number;
}

export interface FeeSchedule {
  symbol: string;
  makerBps: number;
  takerBps: number;
}

export interface SlippageModel {
  /** Estimated slippage in bps of notional, priced into the risk budget. */
  slippageBps: number;
  /**
   * Safety reserve as a fraction of PRICE RISK (0.01 = 1% of `priceRisk`).
   * Proportional to price risk — not to the budget — so every sizing formula
   * stays linear in quantity and closed-form solvable, and `projectedRisk` on
   * fills is computable without knowing the original budget.
   */
  safetyReservePct: number;
}

// ---------------------------------------------------------------------------
// Sizing (PRD §12, §52) — risk-oriented, capital-oriented, outcome-oriented.
// ---------------------------------------------------------------------------

export type SizingDefinition =
  | { mode: 'risk_usd'; value: number }
  | { mode: 'risk_percent'; value: number; balanceBasis: BalanceBasis }
  | { mode: 'allocation_usd'; value: number }
  | { mode: 'allocation_percent'; value: number; balanceBasis: BalanceBasis }
  | { mode: 'notional_usd'; value: number }
  | { mode: 'fixed_quantity'; value: number }
  | { mode: 'fixed_margin'; value: number }
  | { mode: 'target_profit_usd'; value: number }
  /** Desired profit as % of the named balance basis (interpretation recorded in DR-020). */
  | { mode: 'target_profit_percent'; value: number; balanceBasis: BalanceBasis };

export type SizingMode = SizingDefinition['mode'];
