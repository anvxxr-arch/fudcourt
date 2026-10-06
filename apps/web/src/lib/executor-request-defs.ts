/**
 * executor-request-defs.ts — request enums, instrument/market shapes, entry/exit
 * definitions, and `ExecutionRequest` (PRD §25, §35, §47, §49, §51, §54, §57,
 * §58, §63, §69, §70, §78, §91, §92). Split from `./executor-request`:
 * everything here is defined ONLY here — `executor-request.ts` and the
 * `@/lib/executor` barrel re-export, never redefine.
 */
import type { SizingDefinition } from './executor-sizing';

// ---------------------------------------------------------------------------
// Enumerations (PRD §25, §35, §47, §49, §57, §58, §63, §78, §91, §92)
// ---------------------------------------------------------------------------

/** Normalized market type. MVP = spot + USDT-margined linear perpetual only. */
export type MarketType = 'spot' | 'linear_perp';

/** Order side. Spot sell-open is refused outside explicit margin support (PRD §89). */
export type Side = 'buy' | 'sell';

/** What the user wants the order to do to the position. */
export type Intent = 'open' | 'close' | 'reduce';

/** Exchange identity. Keys in `exchange:*:*` venue keys (PRD §49). */
export type ExchangeId = 'binance' | 'bybit' | 'mexc';

/** Internal unique key: `${exchange}:${marketType}:${symbol}` (PRD §49). */
export type VenueKey = string;

/** Normalized time-in-force (PRD §27). The adapter maps to venue support. */
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';

/** Execution urgency (PRD §35). Maps to internal strategy aggressiveness. */
export type ExecutionUrgency = 'passive' | 'balanced' | 'aggressive' | 'immediate';

/** Leverage selection policy (PRD §19). MVP ships AUTO_SAFE only. */
export type LeverageMode = 'manual' | 'auto_safe';

/** Margin mode (PRD §92). Product default recommendation is ISOLATED. */
export type MarginMode = 'isolated' | 'cross';

/** Position mode (PRD §91). */
export type PositionMode = 'one_way' | 'hedge';

/** Child order lifecycle (PRD §58). */
export type ChildOrderStatus =
  | 'PLANNED'
  | 'SUBMITTING'
  | 'OPEN'
  | 'PARTIAL'
  | 'FILLED'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';

/** Credential health (PRD §47). */
export type CredentialHealth =
  | 'ACTIVE'
  | 'INVALID'
  | 'EXPIRED'
  | 'PERMISSION_ERROR'
  | 'RATE_LIMITED'
  | 'REVOKED'
  | 'UNKNOWN';

/** Retry taxonomy (PRD §78). Only `network_retryable`/`rate_limited`/`exchange_overload` may retry. */
export type ErrorCategory =
  | 'network_retryable'
  | 'rate_limited'
  | 'exchange_overload'
  | 'invalid_order'
  | 'permission_error'
  | 'insufficient_balance'
  | 'fatal'
  | 'unknown';

/** When projected risk exceeds the budget (PRD §37). Default RESIZE_THEN_STOP. */
export type RiskBreachPolicy = 'resize_then_stop' | 'pause' | 'stop';

/** Existing-position policy at open time (PRD §93). MVP: ADD and REJECT. */
export type ExistingPositionPolicy = 'add' | 'reject';

/** Execution mode (PRD §118). LIVE is fail-closed behind the kill switch. */
export type ExecutionMode = 'preview' | 'paper' | 'live';

/** How a protective stop is managed (PRD §39). Native preferred. */
export type StopMode = 'native' | 'synthetic' | 'hybrid';

/** Immutable event names (PRD §63). */
export type ExecutionEventName =
  | 'EXECUTION_CREATED'
  | 'RISK_CALCULATED'
  | 'PLAN_CREATED'
  | 'EXECUTION_STARTED'
  | 'ORDER_SUBMITTED'
  | 'ORDER_PARTIALLY_FILLED'
  | 'ORDER_FILLED'
  | 'ORDER_CANCELLED'
  | 'ORDER_REJECTED'
  | 'RISK_RECALCULATED'
  | 'PLAN_RESIZED'
  | 'EXECUTION_PAUSED'
  | 'EXECUTION_RESUMED'
  | 'EXECUTION_COMPLETED'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_RISK_STOPPED'
  | 'EXECUTION_CANCELLED'
  | 'RECONCILIATION_MISMATCH'
  | 'EXTERNAL_STATE_CHANGE';

// ---------------------------------------------------------------------------
// Instrument metadata (PRD §70) — every calculated order is rounded to this.
// ---------------------------------------------------------------------------

export interface InstrumentMetadata {
  /** Normalized symbol, e.g. `BTC/USDT`. */
  symbol: string;
  marketType: MarketType;
  exchange: ExchangeId;
  baseAsset: string;
  quoteAsset: string;
  settlementAsset: string;
  /** Price tick, e.g. 0.01. */
  tickSize: number;
  /** Quantity step, e.g. 0.001. */
  stepSize: number;
  minQuantity: number | null;
  maxQuantity: number | null;
  minNotional: number | null;
  maxNotional: number | null;
  /** Contract multiplier (linear USDT-M is 1). */
  contractMultiplier: number;
  maxLeverage: number | null;
  /** Maintenance margin rate for the approximation (PRD §21); null = unknown. */
  maintenanceMarginRate: number | null;
  /** Leverage tiers, ascending by notional (PRD §18). Empty when unknown. */
  leverageBrackets: LeverageBracket[];
}

export interface LeverageBracket {
  /** Max notional for this tier (inclusive). */
  maxNotional: number | null;
  maxLeverage: number;
  maintenanceMarginRate: number;
}

// ---------------------------------------------------------------------------
// Market data (PRD §69)
// ---------------------------------------------------------------------------

export interface MarketSnapshot {
  /** Normalized symbol. */
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  last: number;
  /** Unix milliseconds. */
  timestamp: number;
}

export interface Ticker {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  timestamp: number;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBook {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface Market {
  symbol: string;
  marketType: MarketType;
  active: boolean;
  metadata: InstrumentMetadata;
}

// ---------------------------------------------------------------------------
// Entry / exit definitions (PRD §51, §54)
// ---------------------------------------------------------------------------

export type EntryDefinition =
  | { type: 'market' }
  | { type: 'limit'; price: number; postOnly?: boolean };

export interface PriceDefinition {
  price: number;
}

export interface TakeProfitDefinition {
  price: number;
  /** Fraction of the position to close at this level (0..1). Absent = full close. */
  fraction?: number;
}

/** One scale level (PRD §33, §34). */
export interface ScaleLevel {
  price: number;
  /** Fraction of the total quantity (0..1). */
  fraction: number;
}

export type LeverageDefinition =
  | { mode: 'manual'; leverage: number }
  | {
      mode: 'auto_safe';
      /** Cap for the auto selection (PRD §19). */
      maxLeverage?: number;
      /** Required SL→liquidation buffer as fraction of stop distance (0.2 = 20%). */
      liquidationBufferPct?: number;
      /** Max fraction of available balance used as margin. */
      maxMarginPct?: number;
    };

/** TWAP configuration (PRD §29). */
export interface TwapConfig {
  durationMs: number;
  slices?: number;
  intervalMs?: number;
  quantityJitterPct?: number;
  intervalJitterPct?: number;
  priceLimit?: number;
  orderType: 'market' | 'limit' | 'maker';
  maxSlippageBps?: number;
  maxSpreadBps?: number;
}

export type ExecutionDefinition =
  | { type: 'market' }
  | { type: 'limit'; price: number; postOnly?: boolean }
  | { type: 'twap'; durationMs: number; slices?: number; intervalMs?: number; config?: TwapConfig }
  | { type: 'adaptive_twap'; durationMs: number; urgency: ExecutionUrgency; slices?: number; config?: TwapConfig }
  | { type: 'iceberg'; visibleQuantity: number }
  | {
      type: 'chase_limit';
      urgency: ExecutionUrgency;
      /** Cap on cancel/replace cycles before the strategy gives up (PRD §32). */
      maxReplacements?: number;
      /** Furthest the peg may travel from the arrival price before chasing stops. */
      maxChaseDistance?: number;
      /** Minimum gap between two cancel/replace cycles, so we do not thrash. */
      minReplacementIntervalMs?: number;
    }
  | { type: 'scale_in'; levels: ScaleLevel[] }
  | { type: 'scale_out'; levels: ScaleLevel[] };

export type ExecutionStrategy =
  | 'market'
  | 'limit'
  | 'twap'
  | 'adaptive_twap'
  | 'iceberg'
  | 'chase_limit'
  | 'scale_in'
  | 'scale_out';

export interface ExecutionConstraints {
  maxSlippageBps?: number;
  maxSpreadBps?: number;
  maxPrice?: number;
  minPrice?: number;
  maxDurationMs?: number;
  makerOnly?: boolean;
  allowMarketFallback?: boolean;
  cancelIfRiskExceeded?: boolean;
  stopIfDisconnected?: boolean;
}

// ---------------------------------------------------------------------------
// Execution request (PRD §51) — the normalized client intent.
// ---------------------------------------------------------------------------

export interface ExecutionRequest {
  accountId: string;
  /** Normalized symbol, e.g. `BTC/USDT`. */
  symbol: string;
  marketType: MarketType;
  side: Side;
  intent: Intent;
  entry: EntryDefinition;
  stopLoss?: PriceDefinition;
  takeProfits?: TakeProfitDefinition[];
  sizing: SizingDefinition;
  leverage?: LeverageDefinition;
  marginMode?: MarginMode;
  execution: ExecutionDefinition;
  constraints?: ExecutionConstraints;
  /** Risk breach behavior (PRD §37). Default `resize_then_stop`. */
  riskPolicy?: RiskBreachPolicy;
  /** Existing-position handling (PRD §93). Default `reject` on `open`. */
  existingPositionPolicy?: ExistingPositionPolicy;
  /** Execution mode (PRD §118). Default from server config, never trusted from the client alone. */
  mode?: ExecutionMode;
  /**
   * PRD §14 combined constraint: desired profit bound (quote currency) validated
   * TOGETHER with the risk bound. Optional — when present alongside risk sizing
   * the planner returns a `risk_vs_profit` conflict if both cannot hold.
   */
  targetProfit?: number;
  /**
   * PRD §14 combined constraint: maximum-loss bound (quote currency), validated
   * together with `targetProfit` or with outcome-oriented sizing.
   */
  maxRisk?: number;
}
