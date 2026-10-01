/**
 * exchange.ts — ExchangeAdapter implementations (PRD §48–§50, §70, §77–§78,
 * §89–§92, §126) + PaperExchangeAdapter (PRD §118, §127).
 *
 * Invariants / risks:
 * - No order is ever sent unrounded: `placeOrder` rounds quantity DOWN to
 *   stepSize and price to tickSize before the venue sees it (PRD §70–§71).
 *   Rounding reuses `@/platform/executor/risk` (the one allowed import besides
 *   the frozen contract) so paper and live agree exactly with the risk engine.
 * - Error messages are sanitized before leaving this module: no apiKey,
 *   secret, passphrase, or signed payload may appear in an ExecutorError
 *   (PRD §109).
 * - ccxt is lazily required so the offline test suite (CommonJS `node --test`)
 *   can inject mock venues and never touches the network; a live adapter is
 *   config-only (PRD §78: the caller/worker owns retry cadence).
 */
import Decimal from 'decimal.js';
import type {
  AccountMetadata,
  AccountPermissions,
  AmendOrderRequest,
  Balance,
  ChildOrderStatus,
  DecryptedCredentials,
  ExchangeAdapter,
  ExchangeCapabilities,
  ExchangeId,
  ExecutorError,
  FeeSchedule,
  Fill,
  FundingRate,
  InstrumentMetadata,
  LeverageBracket,
  MarginMode,
  Market,
  MarketType,
  NormalizedOrder,
  Order,
  OrderBook,
  OrderResult,
  Position,
  Side,
  Ticker,
  TimeInForce,
} from './types';
import { maskApiKey, venueKey } from './types';
import { roundPrice, roundQuantityDown } from './risk';

// ---------------------------------------------------------------------------
// Lazy ccxt binding (CommonJS-safe; mirrors src/platform/db/mirror.ts)
// ---------------------------------------------------------------------------

/** Minimal structural view of a ccxt exchange — the surface this module uses. */
export interface CcxtLike {
  id?: string;
  has?: Record<string, boolean | 'emulated'>;
  checkRequiredCredentials?(credentials?: unknown): unknown;
  fetchMarkets(params?: unknown): Promise<unknown[]>;
  fetchBalance(params?: unknown): Promise<unknown>;
  fetchTicker(symbol: string, params?: unknown): Promise<unknown>;
  fetchOrderBook(symbol: string, limit?: number, params?: unknown): Promise<unknown>;
  fetchPositions(symbols?: string[], params?: unknown): Promise<unknown[]>;
  fetchOpenOrders(symbol?: string, since?: number, limit?: number, params?: unknown): Promise<unknown[]>;
  createOrder(symbol: string, type: string, side: string, amount: number, price?: number, params?: unknown): Promise<unknown>;
  cancelOrder(id: string, symbol?: string, params?: unknown): Promise<unknown>;
  editOrder?(id: string, symbol: string, type?: string, side?: string, amount?: number, price?: number, params?: unknown): Promise<unknown>;
  fetchMyTrades(symbol?: string, since?: number, limit?: number, params?: unknown): Promise<unknown[]>;
  fetchTradingFees(params?: unknown): Promise<unknown>;
  fetchTradingFee?(symbol: string, params?: unknown): Promise<unknown>;
  fetchMarketLeverageTiers?(symbol: string, params?: unknown): Promise<unknown[]>;
  fetchLeverageTiers?(symbols?: string[], params?: unknown): Promise<unknown>;
  setLeverage?(leverage: number, symbol?: string, params?: unknown): Promise<unknown>;
  setMarginMode?(marginMode: string, symbol?: string, params?: unknown): Promise<unknown>;
  fetchFundingRate?(symbol: string, params?: unknown): Promise<unknown>;
}

type CcxtModule = Record<string, unknown> & { errors?: Record<string, unknown> };

let ccxtModule: CcxtModule | null = null;
function ccxt(): CcxtModule {
  if (!ccxtModule) {
    // Lazy: importing this file must never require ccxt (offline suites inject `raw`).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ccxtModule = require('ccxt') as CcxtModule;
  }
  return ccxtModule;
}

// ---------------------------------------------------------------------------
// Symbol normalization (PRD §49)
// ---------------------------------------------------------------------------

/** Internal `BTC/USDT` → ccxt unified: `BTC/USDT` (spot) / `BTC/USDT:USDT` (linear_perp). */
export function toVenueSymbol(symbol: string, marketType: MarketType): string {
  if (marketType === 'spot') return symbol;
  if (symbol.includes(':')) return symbol;
  return `${symbol}:USDT`;
}

/** ccxt unified → internal `BASE/QUOTE`; `BTC/USDT:USDT` → `BTC/USDT`. */
export function fromVenueSymbol(venueSymbol: string): string {
  return venueSymbol.split(':')[0];
}

// ---------------------------------------------------------------------------
// Error taxonomy (PRD §78) + sanitization (PRD §109)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(api[-_ ]?key|apikey)\s*[=:]\s*("?)[^\s"',&]+\2?/gi, '$1=[REDACTED]'],
  [/(secret|passphrase|password)\s*[=:]\s*("?)[^\s"',&]+\2?/gi, '$1=[REDACTED]'],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Authorization=[REDACTED]'],
  [/\bX-MBX-APIKEY\s*[=:]\s*\S+/gi, 'X-MBX-APIKEY=[REDACTED]'],
];

/** Strip anything credential-shaped from a message before it leaves the module. */
export function sanitizeErrorMessage(message: string): string {
  let out = message;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return sanitizeErrorMessage(err.message);
  return sanitizeErrorMessage(String(err));
}

function codeOf(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = err.code;
    if (typeof code === 'string' || typeof code === 'number') return String(code);
  }
  return null;
}

function classNameOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'constructor' in err) {
    const ctor: unknown = err.constructor;
    if (typeof ctor === 'function' && 'name' in ctor && typeof ctor.name === 'string') return ctor.name;
  }
  return '';
}

/**
 * ccxt error classes → ErrorCategory (PRD §78). `retryable` is strictly the
 * taxonomy's retry set: only network_retryable / rate_limited / exchange_overload.
 */
export function mapError(err: unknown): ExecutorError {
  const message = messageOf(err);
  const exchangeCode = codeOf(err);
  // Match on class name (works for injected mocks and for instances from the
  // lazily-bound ccxt module alike) with prototype-chain fallback for subclasses.
  const name = classNameOf(err);
  const match = (clsName: string): boolean => {
    if (name === clsName) return true;
    const ctor: unknown = ccxtModule?.errors?.[clsName];
    return typeof ctor === 'function' && err instanceof ctor;
  };

  const finish = (category: ExecutorError['category'], retryable: boolean, note?: string): ExecutorError => ({
    category,
    message: note ? `${note}: ${message}` : message,
    exchangeCode,
    retryable,
    raw: err,
  });

  if (match('RateLimitExceeded')) return finish('rate_limited', true);
  if (match('DDoSProtection')) return finish('exchange_overload', true);
  if (match('ExchangeNotAvailable') || match('RequestTimeout')) return finish('network_retryable', true);
  if (match('NetworkError')) return finish('network_retryable', true);
  if (match('InsufficientFunds')) return finish('insufficient_balance', false);
  if (match('AuthenticationError') || match('PermissionDenied')) {
    return finish('permission_error', false, 'credential health implication: review API key permissions');
  }
  if (match('InvalidOrder') || match('ArgumentsRequired') || match('BadRequest')) return finish('invalid_order', false);
  return finish('unknown', false);
}

/** Never throw a raw vendor error out of an adapter (PRD §78). */
function toExecutorError(err: unknown): ExecutorError {
  return mapError(err);
}

function fail(err: unknown): never {
  throw toExecutorError(err);
}

// ---------------------------------------------------------------------------
// Precision helpers (PRD §70–§71)
// ---------------------------------------------------------------------------

const dec = (v: number | string): Decimal => new Decimal(v);

/** Decimal string of a positive step/tick, or null when the venue supplied none. */
function stepOf(metadata: InstrumentMetadata): Decimal | null {
  return metadata.stepSize > 0 ? dec(metadata.stepSize) : null;
}
function tickOf(metadata: InstrumentMetadata): Decimal | null {
  return metadata.tickSize > 0 ? dec(metadata.tickSize) : null;
}

/** Instrument metadata cache key: venue identity + market type + normalized symbol. */
function metaKey(exchange: ExchangeId, marketType: MarketType, symbol: string): string {
  return `${exchange}:${marketType}:${symbol}`;
}

// ---------------------------------------------------------------------------
// Unified-shape accessors (tolerant of both `null` and missing fields)
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;
const asDict = (v: unknown): Dict => (typeof v === 'object' && v !== null ? (v as Dict) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function numOrThrow(v: unknown, field: string): number {
  const n = num(v);
  if (n === null) throw new Error(`malformed venue payload: ${field} is not a number`);
  return n;
}

// ---------------------------------------------------------------------------
// Live adapter (ccxt-backed; LIVESERVER CONFIG ONLY — no retry loop, PRD §78)
// ---------------------------------------------------------------------------

export interface CreateAdapterOptions {
  exchange: ExchangeId;
  marketType: MarketType;
  credentials: DecryptedCredentials;
  /** Pre-built ccxt-like instance (tests + raw escape hatch). */
  raw?: unknown;
}

class CcxtExchangeAdapter implements ExchangeAdapter {
  readonly exchange: ExchangeId;
  readonly marketType: MarketType;
  private readonly venue: CcxtLike;
  private readonly apiKeyMasked: string | null;
  /** Metadata per normalized symbol (PRD §70) — built from `fetchMarkets`. */
  private metaCache: Map<string, InstrumentMetadata> | null = null;

  constructor(opts: CreateAdapterOptions, venue: CcxtLike) {
    this.exchange = opts.exchange;
    this.marketType = opts.marketType;
    this.venue = venue;
    this.apiKeyMasked = opts.credentials.apiKey ? maskApiKey(opts.credentials.apiKey) : null;
  }

  capabilities(): ExchangeCapabilities {
    return EXCHANGE_CAPABILITIES[this.exchange];
  }

  private vSym(symbol: string): string {
    return toVenueSymbol(symbol, this.marketType);
  }

  private storeMeta(metadata: InstrumentMetadata): InstrumentMetadata {
    if (!this.metaCache) this.metaCache = new Map();
    this.metaCache.set(venueKey(this.exchange, this.marketType, metadata.symbol), metadata);
    return metadata;
  }

  private cachedMeta(symbol: string): InstrumentMetadata | null {
    return this.metaCache?.get(venueKey(this.exchange, this.marketType, symbol)) ?? null;
  }

  /** Metadata for a symbol; loads markets on demand (accepts internal or venue form). */
  async getMetadata(symbol: string): Promise<InstrumentMetadata> {
    const internal = fromVenueSymbol(symbol);
    const cached = this.cachedMeta(internal);
    if (cached) return cached;
    const markets = await this.getMarkets();
    const found = markets.find((m) => m.symbol === internal && m.marketType === this.marketType);
    if (!found) throw mapError(new Error(`symbol not supported: ${internal} (${this.marketType})`));
    return found.metadata;
  }

  async validateCredentials(): Promise<AccountMetadata> {
    try {
      if (typeof this.venue.checkRequiredCredentials === 'function') this.venue.checkRequiredCredentials();
      // A cheap authenticated read proves read permission (PRD §46).
      await this.venue.fetchBalance();
      const permissions: AccountPermissions = { read: true, spotTrade: true, futuresTrade: true, withdraw: false };
      return {
        exchange: this.exchange,
        label: null,
        accountType: this.marketType === 'spot' ? 'spot' : 'linear_perp',
        permissions,
        health: 'ACTIVE',
        apiKeyMasked: this.apiKeyMasked,
      };
    } catch (err) {
      const mapped = mapError(err);
      void ((): never => { throw mapped; })();
      const health = mapped.category === 'permission_error' ? 'PERMISSION_ERROR' : mapped.category === 'rate_limited' ? 'RATE_LIMITED' : 'INVALID';
      throw { ...mapped, message: mapped.message };
    }
  }

  async getBalances(): Promise<Balance[]> {
    try {
      const raw = asDict(await this.venue.fetchBalance());
      const out: Balance[] = [];
      for (const [asset, value] of Object.entries(raw)) {
        if (asset === 'info' || asset === 'timestamp' || asset === 'datetime' || asset === 'free' || asset === 'used' || asset === 'total') continue;
        const entry = asDict(value);
        const free = num(entry.free) ?? 0;
        const used = num(entry.used) ?? 0;
        const total = num(entry.total) ?? free + used;
        if (free === 0 && used === 0 && total === 0) continue;
        out.push({ asset, free, used, total });
      }
      // Also honor flat `{ free, used, total }` maps (mock + some venues).
      const freeMap = asDict(raw.free);
      for (const [asset, freeValue] of Object.entries(freeMap)) {
        const used = num(asDict(raw.used)[asset]) ?? 0;
        const total = num(asDict(raw.total)[asset]) ?? numOrThrow(freeValue, `free.${asset}`) + used;
        if (!out.some((b) => b.asset === asset)) out.push({ asset, free: numOrThrow(freeValue, `free.${asset}`), used, total });
      }
      return out;
    } catch (err) {
      return fail(err);
    }
  }

  async getAccountEquity() {
    try {
      const balances = await this.getBalances();
      // Per-account-type equity (PRD §10): unknown side stays null — never 0.
      const inType = this.marketType === 'spot'
        ? balances.filter((b) => b.asset !== 'USDT' || true)
        : balances;
      const equityOf = (list: Balance[]): number | null => (list.length ? list.reduce((a, b) => a + b.total, 0) : null);
      const typeEquity = equityOf(inType);
      return {
        spotEquity: this.marketType === 'spot' ? typeEquity : null,
        futuresEquity: this.marketType === 'linear_perp' ? typeEquity : null,
        totalEquity: typeEquity,
        balances,
        timestamp: Date.now(),
      };
    } catch (err) {
      return fail(err);
    }
  }

  async getMarkets(): Promise<Market[]> {
    try {
      const rawMarkets = (await this.venue.fetchMarkets()) as unknown[];
      const out: Market[] = [];
      for (const raw of rawMarkets) {
        const m = asDict(raw);
        const vSymbol = str(m.symbol);
        if (!vSymbol) continue;
        const swapish = m.swap === true || m.contract === true || str(m.type) === 'swap' || str(m.type) === 'future';
        const marketType: MarketType = swapish ? 'linear_perp' : 'spot';
        if (marketType !== this.marketType) continue;
        const symbol = fromVenueSymbol(vSymbol);
        const baseAsset = str(m.base) ?? symbol.split('/')[0];
        const quoteAsset = str(m.quote) ?? symbol.split('/')[1] ?? '';
        const limits = asDict(m.limits);
        const amountLimits = asDict(limits.amount);
        const priceLimits = asDict(limits.price);
        const costLimits = asDict(limits.cost);
        const precision = asDict(m.precision);
        // ccxt 4.x precision is decimal-places or step size depending on
        // `precisionMode`; a positive `step`-style value < 1 is a step size.
        const toStep = (p: unknown): number => {
          const v = num(p);
          if (v === null) return 0;
          return v > 0 && v < 1 ? v : Math.pow(10, -v);
        };
        const metadata = this.storeMeta({
          symbol,
          marketType,
          exchange: this.exchange,
          baseAsset,
          quoteAsset,
          settlementAsset: marketType === 'linear_perp' ? (str(m.settle) ?? quoteAsset) : baseAsset,
          tickSize: toStep(precision.price),
          stepSize: toStep(precision.amount),
          minQuantity: num(amountLimits.min),
          maxQuantity: num(amountLimits.max),
          minNotional: num(costLimits.min),
          maxNotional: num(costLimits.max),
          contractMultiplier: num(m.contractSize) ?? 1,
          maxLeverage: num(m.leverage ?? undefined),
          maintenanceMarginRate: null,
          leverageBrackets: [],
        });
        out.push({ symbol, marketType, active: m.active !== false, metadata });
      }
      return out;
    } catch (err) {
      return fail(err);
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    try {
      const raw = asDict(await this.venue.fetchTicker(this.vSym(symbol)));
      return {
        symbol: fromVenueSymbol(str(raw.symbol) ?? this.vSym(symbol)),
        bid: num(raw.bid),
        ask: num(raw.ask),
        last: num(raw.last),
        timestamp: num(raw.timestamp) ?? Date.now(),
      };
    } catch (err) {
      return fail(err);
    }
  }

  async getOrderBook(symbol: string, depth?: number): Promise<OrderBook> {
    try {
      const raw = asDict(await this.venue.fetchOrderBook(this.vSym(symbol), depth));
      const level = (pair: unknown): { price: number; quantity: number } => {
        const arr = Array.isArray(pair) ? pair : [];
        return { price: numOrThrow(arr[0], 'book price'), quantity: numOrThrow(arr[1], 'book qty') };
      };
      return {
        symbol: fromVenueSymbol(symbol),
        bids: (Array.isArray(raw.bids) ? raw.bids : []).map(level),
        asks: (Array.isArray(raw.asks) ? raw.asks : []).map(level),
        timestamp: num(raw.timestamp) ?? Date.now(),
      };
    } catch (err) {
      return fail(err);
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const rawList = (await this.venue.fetchPositions()) as unknown[];
      const out: Position[] = [];
      for (const raw of rawList) {
        const p = asDict(raw);
        const vSymbol = str(p.symbol);
        if (!vSymbol) continue;
        const contracts = num(p.contracts) ?? num(p.amount);
      const signed = num(p.side) === -1 ? -(contracts ?? 0) : (num(p.contracts) ?? num(p.amount) ?? 0);
        const side = str(p.side);
        const quantity = side === 'short' ? -Math.abs(signed) : Math.abs(signed);
        if (quantity === 0) continue;
        out.push({
          symbol: fromVenueSymbol(vSymbol),
          marketType: this.marketType,
          side: quantity >= 0 ? 'buy' : 'sell',
          quantity,
          entryPrice: num(p.entryPrice) ?? 0,
          leverage: num(p.leverage),
          marginMode: (str(p.marginMode) as MarginMode | null) ?? null,
          liquidationPrice: num(p.liquidationPrice),
          positionSide: 'net',
          timestamp: num(p.timestamp) ?? Date.now(),
        });
      }
      return out;
    } catch (err) {
      return fail(err);
    }
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    try {
      const rawList = (await this.venue.fetchOpenOrders(symbol ? this.vSym(symbol) : undefined)) as unknown[];
      return rawList.map((raw) => this.mapOrder(raw));
    } catch (err) {
      return fail(err);
    }
  }

  private mapOrder(raw: unknown): Order {
    const o = asDict(raw);
    const created = num(o.timestamp) ?? Date.now();
    const updated = num(o.lastTradeTimestamp) ?? created;
    return {
      orderId: str(o.id) ?? '',
      clientOrderId: str(o.clientOrderId),
      symbol: fromVenueSymbol(str(o.symbol) ?? ''),
      side: str(o.side) === 'sell' ? 'sell' : 'buy',
      type: str(o.type) ?? 'market',
      price: num(o.price),
      stopPrice: num(o.stopPrice),
      quantity: numOrThrow(o.amount, 'order.amount'),
      filledQuantity: num(o.filled) ?? 0,
      status: mapOrderStatus(str(o.status)),
      timeInForce: (str(o.timeInForce) as TimeInForce | null) ?? null,
      reduceOnly: o.reduceOnly === true,
      createdAt: created,
      updatedAt: updated,
    };
  }

  async placeOrder(order: NormalizedOrder): Promise<OrderResult> {
    try {
      const metadata = await this.getMetadata(order.symbol);
      // PRD §70–§71: never send an unrounded quantity (risk-safe: DOWN) or price.
      const quantity = roundQuantityDown(order.quantity, metadata);
      if (!(quantity > 0)) throw mapError(new Error('quantity rounds to zero at step size'));
      const price = order.price !== undefined ? roundPrice(order.price, metadata) : undefined;
      const type = order.type === 'limit' ? 'limit' : order.type === 'market' ? 'market' : order.type === 'stop_limit' ? 'limit' : 'market';
      const params: Dict = { clientOrderId: order.clientOrderId };
      if (order.reduceOnly) params.reduceOnly = true;
      if (order.positionSide && order.positionSide !== 'net') params.positionSide = order.positionSide;
      if (order.postOnly) params.postOnly = true;
      if (order.timeInForce && order.timeInForce !== 'GTC') params.timeInForce = order.timeInForce;
      if (order.stopPrice !== undefined) params.triggerPrice = order.stopPrice;
      const raw = await this.venue.createOrder(this.vSym(order.symbol), type, order.side, quantity, price, params);
      const o = asDict(raw);
      return {
        orderId: str(o.id) ?? '',
        // The venue echoes our idempotency id; fall back to the sent one (PRD §66).
        clientOrderId: str(o.clientOrderId) ?? order.clientOrderId,
        status: mapOrderStatus(str(o.status)),
        filledQuantity: num(o.filled) ?? 0,
        averagePrice: num(o.average),
        raw,
      };
    } catch (err) {
      return fail(err);
    }
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    try {
      await this.venue.cancelOrder(orderId, this.vSym(symbol));
    } catch (err) {
      return fail(err);
    }
  }

  async amendOrder(order: AmendOrderRequest): Promise<OrderResult> {
    if (typeof this.venue.editOrder !== 'function') throw mapError(new Error('amend not supported by this venue'));
    try {
      const metadata = await this.getMetadata(order.symbol);
      const amount = order.quantity !== undefined ? roundQuantityDown(order.quantity, metadata) : undefined;
      const price = order.price !== undefined ? roundPrice(order.price, metadata) : undefined;
      const raw = await this.venue.editOrder!(order.orderId, this.vSym(order.symbol), undefined, undefined, amount, price);
      const o = asDict(raw);
      return {
        orderId: str(o.id) ?? order.orderId,
        clientOrderId: str(o.clientOrderId) ?? order.clientOrderId ?? '',
        status: mapOrderStatus(str(o.status)),
        filledQuantity: num(o.filled) ?? 0,
        averagePrice: num(o.average),
        raw,
      };
    } catch (err) {
      return fail(err);
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (typeof this.venue.setLeverage !== 'function') throw mapError(new Error('setLeverage not supported by this venue'));
    try {
      await this.venue.setLeverage(leverage, this.vSym(symbol));
    } catch (err) {
      return fail(err);
    }
  }

  async setMarginMode(symbol: string, mode: MarginMode): Promise<void> {
    if (typeof this.venue.setMarginMode !== 'function') throw mapError(new Error('setMarginMode not supported by this venue'));
    try {
      await this.venue.setMarginMode(mode, this.vSym(symbol));
    } catch (err) {
      return fail(err);
    }
  }

  /**
   * Leverage tiers via ccxt `fetchMarketLeverageTiers` (the `fetchLeverageBrackets`
   * name exists only in our contract). Unsupported venues return [] — never
   * fabricated tiers (PRD §50).
   */
  async getLeverageBrackets(symbol: string): Promise<LeverageBracket[]> {
    if (typeof this.venue.fetchMarketLeverageTiers !== 'function') return [];
    try {
      const tiers = (await this.venue.fetchMarketLeverageTiers(this.vSym(symbol))) as unknown[];
      return tiers.map((raw) => {
        const t = asDict(raw);
        return {
          maxNotional: num(t.maxNotional),
          maxLeverage: num(t.maxLeverage) ?? 1,
          maintenanceMarginRate: num(t.maintenanceMarginRate) ?? 0,
        };
      });
    } catch {
      return [];
    }
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    if (typeof this.venue.fetchFundingRate !== 'function') throw mapError(new Error('funding rate not supported by this venue'));
    try {
      const raw = asDict(await this.venue.fetchFundingRate!(this.vSym(symbol)));
      return {
        symbol: fromVenueSymbol(symbol),
        rate: numOrThrow(raw.fundingRate, 'fundingRate'),
        nextFundingTime: num(raw.fundingTimestamp),
        timestamp: num(raw.timestamp) ?? Date.now(),
      };
    } catch (err) {
      return fail(err);
    }
  }

  async getFees(symbol: string): Promise<FeeSchedule> {
    try {
      let raw: Dict = {};
      if (typeof this.venue.fetchTradingFee === 'function') {
        raw = asDict(await this.venue.fetchTradingFee!(this.vSym(symbol)));
      } else {
        const all = asDict(await this.venue.fetchTradingFees());
        raw = asDict(all[this.vSym(symbol)]);
      }
      const maker = num(raw.maker);
      const taker = num(raw.taker);
      // ccxt fee rates are fractions (0.001 = 0.1%); our unit is bps.
      return {
        symbol: fromVenueSymbol(symbol),
        makerBps: maker !== null ? maker * 1e4 : 0,
        takerBps: taker !== null ? taker * 1e4 : 0,
      };
    } catch (err) {
      return fail(err);
    }
  }

  async getFills(symbol: string, orderId?: string): Promise<Fill[]> {
    try {
      const rawList = (await this.venue.fetchMyTrades(this.vSym(symbol))) as unknown[];
      const out: Fill[] = [];
      for (const raw of rawList) {
        const t = asDict(raw);
        const o = asDict(t.order);
        const tradeOrderId = str(t.order) ?? str(o.id) ?? '';
        if (orderId && tradeOrderId !== orderId) continue;
        const fee = asDict(t.fee);
        out.push({
          tradeId: str(t.id) ?? '',
          orderId: tradeOrderId,
          clientOrderId: str(t.clientOrderId) ?? null,
          symbol: fromVenueSymbol(str(t.symbol) ?? this.vSym(symbol)),
          side: str(t.side) === 'sell' ? 'sell' : 'buy',
          price: numOrThrow(t.price, 'trade.price'),
          quantity: numOrThrow(t.amount, 'trade.amount'),
          quoteQuantity: num(t.cost) ?? numOrThrow(t.price, 'trade.price') * numOrThrow(t.amount, 'trade.amount'),
          fee: num(fee.cost) ?? 0,
          feeAsset: str(fee.currency) ?? 'USDT',
          timestamp: num(t.timestamp) ?? Date.now(),
        });
      }
      return out;
    } catch (err) {
      return fail(err);
    }
  }
}

function mapOrderStatus(status: string | null): ChildOrderStatus {
  switch (status) {
    case 'open':
      return 'OPEN';
    case 'closed':
      return 'FILLED';
    case 'canceled':
    case 'cancelled':
      return 'CANCELLED';
    case 'rejected':
      return 'REJECTED';
    case 'expired':
      return 'EXPIRED';
    default:
      return 'UNKNOWN';
  }
}


/**
 * ccxt-backed live adapter (PRD §48). `raw` injects a pre-built ccxt-like
 * instance (tests + escape hatch); otherwise `new ccxt.<id>` is constructed
 * with the decrypted credentials — config only, NO retry loop (PRD §78).
 */
export function createAdapter(opts: CreateAdapterOptions): ExchangeAdapter {
  if (opts.raw !== undefined && opts.raw !== null) {
    return new CcxtExchangeAdapter(opts, opts.raw as CcxtLike);
  }
  const CtorName = opts.marketType === 'spot' ? opts.exchange : `${opts.exchange}usdm`;
  const ctor = (ccxt() as unknown as Record<string, new (cfg: Dict) => CcxtLike>)[CtorName]
    ?? (ccxt() as unknown as Record<string, new (cfg: Dict) => CcxtLike>)[opts.exchange];
  if (typeof ctor !== 'function') throw new Error(`unsupported venue: ${CtorName}`);
  const venue = new ctor({
    apiKey: opts.credentials.apiKey,
    secret: opts.credentials.apiSecret,
    password: opts.credentials.passphrase ?? undefined,
    enableRateLimit: true,
  });
  return new CcxtExchangeAdapter(opts, venue);
}

// ---------------------------------------------------------------------------
// Capability registry (PRD §50) — static, honest, per venue + product class.
// ---------------------------------------------------------------------------

const UNSUPPORTED_BRACKETS_NOTE =
  'leverageBrackets=false: ccxt 4.5.x exposes no fetchLeverageBrackets/fetchMarketLeverageTiers tier feed here; getLeverageBrackets returns [] rather than fake tiers.';

export const EXCHANGE_CAPABILITIES: Record<ExchangeId, ExchangeCapabilities> = {
  // binance (spot via `ccxt.binance`, perps via `ccxt.binanceusdm`):
  // iceberg: true via createOrder params.icebergQty (raw param passthrough);
  // twap: false — no native TWAP in ccxt for binance (synthetic engine owns it, PRD §28);
  // oco: true via binance OCO endpoint surfaced through createOrder params;
  // trailing: true via params.trailingPercent/triggerPrice trailing types;
  // leverageBrackets: true — `fetchMarketLeverageTiers` (emulated over
  // fapiPrivateGetLeverageBracket) returns real BRACKET tiers on binanceusdm.
  binance: {
    spot: true,
    linearPerpetual: true,
    marginModes: { cross: true, isolated: true },
    hedgeMode: true,
    orderTypes: { market: true, limit: true, stop: true, stopLimit: true, trailing: true, postOnly: true },
    nativeFeatures: { iceberg: true, twap: false, oco: true },
    leverageBrackets: true,
  },
  // bybit: hedgeMode true (positionIdx 1/2 via params.positionIdx);
  // iceberg/twap/oco not exposed through ccxt unified API → false (synthetic, PRD §28/§40);
  // trailing: true via params.triggerPrice + trailing callback params on bybit;
  // leverageBrackets: true — `fetchMarketLeverageTiers` is native on bybit (risk-limit tiers).
  bybit: {
    spot: true,
    linearPerpetual: true,
    marginModes: { cross: true, isolated: true },
    hedgeMode: true,
    orderTypes: { market: true, limit: true, stop: true, stopLimit: true, trailing: true, postOnly: true },
    nativeFeatures: { iceberg: false, twap: false, oco: false },
    leverageBrackets: true,
  },
  // mexc: hedgeMode false — mexc contract accounts are one-way only in ccxt 4.5.x
  // (no positionSide/hedge params surface); trailing false — trigger orders only;
  // iceberg/twap/oco: no unified ccxt support → false;
  // leverageBrackets: false — see UNSUPPORTED_BRACKETS_NOTE; getLeverageBrackets
  // probes at runtime and returns [] (never fake tiers).
  mexc: {
    spot: true,
    linearPerpetual: true,
    marginModes: { cross: true, isolated: true },
    hedgeMode: false,
    orderTypes: { market: true, limit: true, stop: true, stopLimit: true, trailing: false, postOnly: true },
    nativeFeatures: { iceberg: false, twap: false, oco: false },
    leverageBrackets: false,
  },
};
void UNSUPPORTED_BRACKETS_NOTE;

// ---------------------------------------------------------------------------
// PaperExchangeAdapter (PRD §118, §127) — FIRST-CLASS ExchangeAdapter.
// Simulated matcher with partial fills driven by market snapshots. State is
// in-memory per instance; persistence belongs to the worker (PRD §64).
// ---------------------------------------------------------------------------

export interface PaperMarketData {
  getTicker(symbol: string): Promise<Ticker>;
  getOrderBook(symbol: string, depth?: number): Promise<OrderBook>;
  getMarkets(): Promise<Market[]>;
}

export interface PaperExchangeOptions {
  marketData: Pick<ExchangeAdapter, 'getTicker' | 'getOrderBook' | 'getMarkets'>;
  initialBalances?: Balance[];
  seed?: number;
  /** Fraction of an order filled per matching pass (default 0.4 → 2-3 calls). */
  fillRate?: number;
  /** Market-order slippage in bps applied on top of ask/bid (default 5). */
  slippageBps?: number;
  exchange?: ExchangeId;
  marketType?: MarketType;
}

interface PaperOrderState {
  order: Order;
  /** Remaining unfilled quantity. */
  remaining: number;
  stopPrice: number | null;
}

const PAPER_TAKER_FEE_BPS = 5;
const PAPER_MAKER_FEE_BPS = 2;

export class PaperExchangeAdapter implements ExchangeAdapter {
  private readonly marketData: PaperMarketData;
  private readonly balances = new Map<string, Balance>();
  private readonly orders = new Map<string, PaperOrderState>();
  private readonly fills: Fill[] = [];
  /** One-way signed position per normalized symbol. */
  private readonly positions = new Map<string, Position>();
  private readonly fillRate: number;
  private readonly slippageBps: number;
  private readonly exchangeId: ExchangeId;
  private readonly marketType: MarketType;
  private seq = 0;
  private rngState: number;
  private lastPrice = new Map<string, number>();

  constructor(opts: PaperExchangeOptions) {
    this.marketData = opts.marketData;
    this.fillRate = opts.fillRate ?? 0.4;
    this.slippageBps = opts.slippageBps ?? 5;
    this.exchangeId = opts.exchange ?? 'binance';
    this.marketType = opts.marketType ?? 'spot';
    this.rngState = (opts.seed ?? 42) >>> 0 || 1;
    for (const b of opts.initialBalances ?? []) this.balances.set(b.asset, { ...b });
    if (!this.balances.has('USDT')) this.balances.set('USDT', { asset: 'USDT', free: 10_000, used: 0, total: 10_000 });
  }

  private rand(): number {
    // xorshift32: deterministic per seed.
    let x = this.rngState;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    this.rngState = x;
    return x / 0xffffffff;
  }

  capabilities(): ExchangeCapabilities {
    return EXCHANGE_CAPABILITIES[this.exchangeId];
  }

  async validateCredentials(): Promise<AccountMetadata> {
    return {
      exchange: this.exchangeId,
      label: 'paper',
      accountType: 'paper',
      permissions: { read: true, spotTrade: true, futuresTrade: true, withdraw: false },
      health: 'ACTIVE',
      apiKeyMasked: null,
    };
  }

  async getBalances(): Promise<Balance[]> {
    return [...this.balances.values()].map((b) => ({ ...b }));
  }

  async getAccountEquity() {
    const balances = await this.getBalances();
    const total = balances.reduce((a, b) => a + b.total, 0);
    return {
      spotEquity: this.marketType === 'spot' ? total : null,
      futuresEquity: this.marketType === 'linear_perp' ? total : null,
      totalEquity: total,
      balances,
      timestamp: Date.now(),
    };
  }

  async getMarkets(): Promise<Market[]> {
    return this.marketData.getMarkets();
  }

  async getTicker(symbol: string): Promise<Ticker> {
    return this.marketData.getTicker(symbol);
  }

  async getOrderBook(symbol: string, depth?: number): Promise<OrderBook> {
    return this.marketData.getOrderBook(symbol, depth);
  }

  async getPositions(): Promise<Position[]> {
    return [...this.positions.values()].filter((p) => p.quantity !== 0).map((p) => ({ ...p }));
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    return [...this.orders.values()]
      .filter((o) => !symbol || o.order.symbol === symbol)
      .map((o) => ({ ...o.order, filledQuantity: o.order.filledQuantity, quantity: o.order.quantity }));
  }

  async getFees(symbol: string): Promise<FeeSchedule> {
    return { symbol, makerBps: PAPER_MAKER_FEE_BPS, takerBps: PAPER_TAKER_FEE_BPS };
  }

  async getLeverageBrackets(): Promise<LeverageBracket[]> {
    return [];
  }

  async placeOrder(order: NormalizedOrder): Promise<OrderResult> {
    const markets = await this.marketData.getMarkets();
    const market = markets.find((m) => m.symbol === fromVenueSymbol(order.symbol));
    if (!market) throw mapError(new Error(`symbol not supported: ${order.symbol}`));
    const metadata = market.metadata;
    const quantity = roundQuantityDown(order.quantity, metadata);
    if (!(quantity > 0)) throw mapError(new Error('quantity rounds to zero at step size'));
    const price = order.price !== undefined ? roundPrice(order.price, metadata) : undefined;

    const id = `paper_order_${++this.seq}`;
    const now = Date.now();
    const open: PaperOrderState = {
      order: {
        orderId: id,
        clientOrderId: order.clientOrderId,
        symbol: fromVenueSymbol(order.symbol),
        side: order.side,
        type: order.type,
        price: price ?? null,
        stopPrice: order.stopPrice ?? null,
        quantity,
        filledQuantity: 0,
        status: 'OPEN',
        timeInForce: order.timeInForce ?? 'GTC',
        reduceOnly: order.reduceOnly ?? false,
        createdAt: now,
        updatedAt: now,
      },
      remaining: quantity,
      stopPrice: order.stopPrice ?? null,
    };
    this.orders.set(id, open);

    const ticker = await this.marketData.getTicker(order.symbol);
    this.lastPrice.set(open.order.symbol, ticker.last ?? ticker.bid ?? ticker.ask ?? price ?? 0);

    // Market orders begin filling immediately (in fillRate chunks across passes);
    // limit/stop orders wait for the price cross below.
    if (order.type === 'market') this.matchOrder(open);
    else this.matchOrder(open); // limit fills here if already marketable

    return {
      orderId: id,
      clientOrderId: order.clientOrderId,
      status: open.order.status,
      filledQuantity: open.order.filledQuantity,
      averagePrice: this.averageFillPrice(id),
      raw: { paper: true },
    };
  }

  async cancelOrder(orderId: string, _symbol: string): Promise<void> {
    const state = this.orders.get(orderId);
    if (!state) throw mapError(new Error(`order not found: ${orderId}`));
    if (state.order.status === 'FILLED' || state.order.status === 'CANCELLED') {
      if (state.order.status === 'FILLED') throw mapError(new Error(`order already filled: ${orderId}`));
      return;
    }
    state.order.status = 'CANCELLED';
    state.order.updatedAt = Date.now();
    this.orders.delete(orderId);
  }

  async amendOrder(req: AmendOrderRequest): Promise<OrderResult> {
    const state = this.orders.get(req.orderId);
    if (!state) throw mapError(new Error(`order not found: ${req.orderId}`));
    const metadata = (await this.getMetadata(state.order.symbol));
    if (req.price !== undefined) state.order.price = roundPrice(req.price, metadata);
    if (req.quantity !== undefined) {
      const total = roundQuantityDown(req.quantity, metadata);
      state.order.quantity = total;
      state.remaining = Math.max(0, total - state.order.filledQuantity);
    }
    state.order.updatedAt = Date.now();
    this.matchOrder(state);
    return {
      orderId: state.order.orderId,
      clientOrderId: state.order.clientOrderId ?? req.clientOrderId ?? '',
      status: state.order.status,
      filledQuantity: state.order.filledQuantity,
      averagePrice: this.averageFillPrice(state.order.orderId),
      raw: { paper: true },
    };
  }

  async getMetadata(symbol: string): Promise<InstrumentMetadata> {
    const markets = await this.marketData.getMarkets();
    const market = markets.find((m) => m.symbol === fromVenueSymbol(symbol));
    if (!market) throw mapError(new Error(`symbol not supported: ${symbol}`));
    return market.metadata;
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    return { symbol: fromVenueSymbol(symbol), rate: 0, nextFundingTime: null, timestamp: Date.now() };
  }

  async getFills(symbol?: string, orderId?: string): Promise<Fill[]> {
    return this.fills.filter((f) => (!symbol || f.symbol === fromVenueSymbol(symbol)) && (!orderId || f.orderId === orderId));
  }

  /** One matching pass over all open orders; called by place/amend and `match()`. */
  async match(): Promise<void> {
    // Refresh marks first so limit crosses see the latest price.
    for (const state of [...this.orders.values()]) {
      const ticker = await this.marketData.getTicker(toVenueSymbol(state.order.symbol, this.marketType));
      const last = ticker.last ?? ticker.bid ?? ticker.ask;
      if (last !== null && last !== undefined) this.lastPrice.set(state.order.symbol, last);
      this.matchOrder(state);
    }
  }

  private averageFillPrice(orderId: string): number | null {
    const fills = this.fills.filter((f) => f.orderId === orderId);
    if (!fills.length) return null;
    const qty = fills.reduce((a, f) => a + f.quantity, 0);
    return qty > 0 ? fills.reduce((a, f) => a + f.price * f.quantity, 0) / qty : null;
  }

  private matchOrder(state: PaperOrderState): void {
    if (state.order.status !== 'OPEN' && state.order.status !== 'PARTIAL') return;
    const isMarket = state.order.type === 'market';
    const last = this.lastPrice.get(state.order.symbol) ?? 0;
    // Limit buy fills when last <= price; limit sell when last >= price (PRD §27).
    const crossed = isMarket
      || (state.order.side === 'buy' ? last <= (state.order.price ?? Infinity) : last >= (state.order.price ?? -Infinity));
    if (!crossed) return;

    const chunk = Math.min(state.remaining, state.order.quantity * this.fillRate);
    // Step-safe chunk: floor to 1e-12 to avoid dust tails; final pass fills remainder.
    const fillQty = state.remaining - chunk < 1e-12 ? state.remaining : chunk;
    if (fillQty <= 0) return;
    const slip = isMarket ? (this.slippageBps / 1e4) * (state.order.side === 'buy' ? 1 : -1) : 0;
    const fillPrice = isMarket
      ? (last || state.order.price || 0) * (1 + slip)
      : state.order.price ?? last;

    this.settle(state, fillQty, fillPrice, isMarket ? PAPER_TAKER_FEE_BPS : PAPER_MAKER_FEE_BPS);
  }

  private settle(state: PaperOrderState, qty: number, price: number, feeBps: number): void {
    const symbol = state.order.symbol;
    const [base, quote] = symbol.split('/');
    const notional = qty * price;
    const fee = (notional * feeBps) / 1e4;
    const side = state.order.side;

    // Balances: spot trades base vs quote; linear settles quote only.
    const quoteBal = this.balances.get('USDT') ?? { asset: 'USDT', free: 0, used: 0, total: 0 };
    const baseBal = this.balances.get(base) ?? { asset: base, free: 0, used: 0, total: 0 };
    if (this.marketType === 'spot') {
      if (side === 'buy') {
        quoteBal.free -= notional + fee;
        baseBal.free += qty;
      } else {
        baseBal.free -= qty;
        quoteBal.free += notional - fee;
      }
    } else {
      quoteBal.free += side === 'buy' ? -(notional + fee) * 0 + -(fee) + (this.pnlDelta(symbol, side, qty, price)) : -(fee) + this.pnlDelta(symbol, side, qty, price);
    }
    quoteBal.total = quoteBal.free + quoteBal.used;
    baseBal.total = baseBal.free + baseBal.used;
    this.balances.set('USDT', quoteBal);
    this.balances.set(base, baseBal);

    // One-way position update.
    const pos = this.positions.get(symbol) ?? {
      symbol, marketType: this.marketType, side: 'buy' as Side, quantity: 0, entryPrice: 0,
      leverage: null, marginMode: null, liquidationPrice: null, positionSide: 'net' as const, timestamp: 0,
    };
    const signed = side === 'buy' ? qty : -qty;
    const newQty = pos.quantity + signed;
    if (pos.quantity === 0 || Math.sign(pos.quantity) === Math.sign(signed)) {
      pos.entryPrice = (Math.abs(pos.quantity) * pos.entryPrice + qty * price) / (Math.abs(pos.quantity) + qty);
    } else if (newQty === 0) {
      pos.entryPrice = 0;
    } else if (Math.sign(newQty) !== Math.sign(pos.quantity)) {
      pos.entryPrice = price;
    }
    pos.quantity = newQty;
    pos.side = newQty >= 0 ? 'buy' : 'sell';
    pos.timestamp = Date.now();
    this.positions.set(symbol, pos);

    state.order.filledQuantity += qty;
    state.remaining -= qty;
    state.order.status = state.remaining <= 1e-12 ? 'FILLED' : 'PARTIAL';
    state.order.updatedAt = Date.now();

    this.fills.push({
      tradeId: `paper_trade_${++this.seq}`,
      orderId: state.order.orderId,
      clientOrderId: state.order.clientOrderId,
      symbol,
      side,
      price,
      quantity: qty,
      quoteQuantity: notional,
      fee,
      feeAsset: 'USDT',
      timestamp: Date.now(),
    });
  }

  /** Realized PnL delta of a linear fill (quote-settled); margin is not modeled. */
  private pnlDelta(symbol: string, side: Side, qty: number, price: number): number {
    const pos = this.positions.get(symbol);
    if (!pos || pos.quantity === 0) return 0;
    const signed = side === 'buy' ? qty : -qty;
    if (Math.sign(signed) === Math.sign(pos.quantity)) return 0;
    const closing = Math.min(qty, Math.abs(pos.quantity));
    return (price - pos.entryPrice) * closing * (pos.quantity > 0 ? 1 : -1);
  }
}
