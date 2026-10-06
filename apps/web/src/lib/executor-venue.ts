/**
 * executor-venue.ts — VENUE half of the FUDCourt CEX Executor response
 * contract (PRD §25–§37, §48). Split from `./executor-response`: the engine
 * (deterministic strategy planning + lifecycle) lives in
 * `./executor-engine`; the exchange-adapter surfaces plus `ExecutorError`
 * are defined ONLY here.
 *
 * This file re-exports `./executor-engine` so ALL existing `@/lib/executor`
 * importers keep working unchanged. Request-side shapes are imported as
 * types from `./executor-request` (one direction only — request never
 * imports response). Consumers import `@/lib/executor` (the barrel), never
 * this path directly.
 */
import type {
  ChildOrderStatus,
  CredentialHealth,
  ErrorCategory,
  ExchangeId,
  FeeSchedule,
  LeverageBracket,
  MarginMode,
  Market,
  MarketType,
  OrderBook,
  Side,
  Ticker,
  TimeInForce,
} from './executor-request';

export * from './executor-engine';

// ---------------------------------------------------------------------------
// Exchange adapter contract (PRD §48) — implemented in `backend/workers/executor/internal/exchanges`.
// ---------------------------------------------------------------------------

export interface AccountPermissions {
  /** Verified by probe: the credential can read account state. */
  read: boolean;
  /**
   * Trading flags as REPORTED by the venue's key-restriction endpoint where one
   * exists (Binance apiRestrictions, Bybit query-api); `null` = the venue does
   * not report it (e.g. MEXC) — never inferred, never faked (house rule).
   */
  spotTrade: boolean | null;
  futuresTrade: boolean | null;
  /**
   * MUST be false or null in effect: FUDCourt NEVER requests or uses withdrawal
   * capability (PRD §43). `null` = unknown (venue silent); `true` would mean the
   * USER granted it on the key — the UI must render that as a warning.
   */
  withdraw: boolean | null;
}

export interface AccountMetadata {
  exchange: ExchangeId;
  label: string | null;
  accountType: string | null;
  permissions: AccountPermissions;
  health: CredentialHealth;
  /** Partial key display only: `abc...xyz` (PRD §109). */
  apiKeyMasked: string | null;
  raw?: unknown;
}

export interface Balance {
  asset: string;
  free: number;
  used: number;
  total: number;
}

export interface AccountEquity {
  spotEquity: number | null;
  futuresEquity: number | null;
  totalEquity: number | null;
  /** Per-asset free/used totals as returned by the venue. */
  balances: Balance[];
  timestamp: number;
}

export interface Position {
  symbol: string;
  marketType: MarketType;
  side: Side;
  /** Signed quantity: positive long, negative short in one-way mode. */
  quantity: number;
  entryPrice: number;
  leverage: number | null;
  marginMode: MarginMode | null;
  liquidationPrice: number | null;
  positionSide: 'long' | 'short' | 'net';
  timestamp: number;
}

export interface Order {
  orderId: string;
  clientOrderId: string | null;
  symbol: string;
  side: Side;
  type: string;
  price: number | null;
  stopPrice: number | null;
  quantity: number;
  filledQuantity: number;
  status: ChildOrderStatus;
  timeInForce: TimeInForce | null;
  reduceOnly: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NormalizedOrder {
  /** Idempotency id (PRD §66). The adapter MUST send this as the client order id. */
  clientOrderId: string;
  symbol: string;
  marketType: MarketType;
  side: Side;
  type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'stop_market';
  quantity: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: TimeInForce;
  postOnly?: boolean;
  reduceOnly?: boolean;
  positionSide?: 'long' | 'short' | 'net';
}

export interface OrderResult {
  orderId: string;
  clientOrderId: string;
  status: ChildOrderStatus;
  filledQuantity: number;
  averagePrice: number | null;
  raw?: unknown;
}

export interface AmendOrderRequest {
  orderId: string;
  symbol: string;
  price?: number;
  quantity?: number;
  clientOrderId?: string;
}

export interface Fill {
  tradeId: string;
  orderId: string;
  clientOrderId: string | null;
  symbol: string;
  side: Side;
  price: number;
  quantity: number;
  quoteQuantity: number;
  fee: number;
  feeAsset: string;
  timestamp: number;
}

export interface FundingRate {
  symbol: string;
  rate: number;
  nextFundingTime: number | null;
  timestamp: number;
}

export interface ExchangeCapabilities {
  spot: boolean;
  linearPerpetual: boolean;
  marginModes: { cross: boolean; isolated: boolean };
  hedgeMode: boolean;
  orderTypes: {
    market: boolean;
    limit: boolean;
    stop: boolean;
    stopLimit: boolean;
    trailing: boolean;
    postOnly: boolean;
  };
  nativeFeatures: { iceberg: boolean; twap: boolean; oco: boolean };
  /** True when `fetchLeverageBrackets` returns real tiers. */
  leverageBrackets: boolean;
}

/**
 * The normalized adapter interface (PRD §48). Live adapters are ccxt-backed
 * (DR-020: one unified translation layer per venue, raw REST escape hatch where
 * ccxt lacks a capability); `PaperExchangeAdapter` implements the SAME interface
 * with a simulated matcher so the worker drives paper and live identically.
 */
export interface ExchangeAdapter {
  validateCredentials(): Promise<AccountMetadata>;
  getBalances(): Promise<Balance[]>;
  getAccountEquity(): Promise<AccountEquity>;
  getMarkets(): Promise<Market[]>;
  getTicker(symbol: string): Promise<Ticker>;
  getOrderBook(symbol: string, depth?: number): Promise<OrderBook>;
  getPositions(): Promise<Position[]>;
  getOpenOrders(symbol?: string): Promise<Order[]>;
  placeOrder(order: NormalizedOrder): Promise<OrderResult>;
  cancelOrder(orderId: string, symbol: string): Promise<void>;
  amendOrder?(order: AmendOrderRequest): Promise<OrderResult>;
  setLeverage?(symbol: string, leverage: number): Promise<void>;
  setMarginMode?(symbol: string, mode: MarginMode): Promise<void>;
  getLeverageBrackets?(symbol: string): Promise<LeverageBracket[]>;
  getFundingRate?(symbol: string): Promise<FundingRate>;
  getFees(symbol: string): Promise<FeeSchedule>;
  /** Fills for an order, or all recent fills when orderId is omitted (PRD §62). */
  getFills?(symbol: string, orderId?: string): Promise<Fill[]>;
  /** Normalized error taxonomy for the retry policy (PRD §78). */
  capabilities(): ExchangeCapabilities;
}

/** Error every adapter maps its failures into (PRD §78). */
export interface ExecutorError {
  category: ErrorCategory;
  message: string;
  /** Venue code when the exchange supplied one. */
  exchangeCode: string | null;
  retryable: boolean;
  raw?: unknown;
}
