# Product Requirements Document

## FUDCourt CEX Executor

**Status:** Draft v1.0
**Project:** FUDCourt
**Product:** CEX Executor
**Initial Markets:** Spot + USDT-M / Linear Perpetual Futures
**Initial Exchanges:** Binance, Bybit, MEXC
**Custody Model:** Non-custodial / BYOK
**Primary Interface:** FUDCourt Web App + Internal API
**PRD Path:** `docs/prd/cex-executor.md`

---

# 1. Executive Summary

FUDCourt CEX Executor adalah execution layer untuk centralized exchanges yang memberikan metode eksekusi, position sizing, dan risk management yang lebih fleksibel dibandingkan fitur native CEX.

User menghubungkan akun exchange menggunakan API key milik mereka sendiri. Dana tetap berada di exchange masing-masing dan FUDCourt tidak melakukan custody.

Alih-alih hanya meminta user memilih:

- market atau limit;
- quantity;
- leverage;

CEX Executor memungkinkan user mendefinisikan **hasil atau risiko yang diinginkan**.

Contoh:

> Saya ingin LONG BTC di sekitar $100,000, stop-loss $98,000, dan hanya ingin merisikokan $25.

Executor akan menghitung:

- maximum position size;
- notional;
- quantity;
- estimated fee;
- estimated slippage;
- required margin;
- leverage yang memungkinkan;
- liquidation safety;
- child orders;
- metode execution.

Sebaliknya user dapat menentukan:

> Saya ingin profit $100 jika BTC bergerak dari entry $100,000 menuju TP $105,000.

Executor menghitung position size dan margin yang dibutuhkan.

Selain position sizing, Executor menyediakan synthetic execution methods seperti:

- TWAP;
- Adaptive TWAP;
- Iceberg;
- Scale In;
- Scale Out;
- Chase Limit;
- synthetic OCO;
- dynamic risk reconciliation.

Dengan demikian CEX hanya menjadi **execution venue**, sedangkan decision logic berada di FUDCourt.

---

# 2. Product Vision

Membuat layer universal antara trader dan centralized exchange.

```text
Trader Intent
     │
     ▼
Risk / Outcome Definition
     │
     ▼
FUDCourt Risk Engine
     │
     ▼
Execution Planner
     │
     ▼
Execution Strategy
     │
     ▼
Exchange Adapter
     │
     ▼
Binance / Bybit / MEXC / Future CEX
```

User menentukan:

```text
Apa yang ingin dilakukan?
Berapa risiko yang diterima?
Berapa profit yang ditargetkan?
Bagaimana posisi ingin dieksekusi?
```

FUDCourt menentukan:

```text
Berapa quantity?
Berapa notional?
Berapa margin?
Berapa leverage?
Apakah trade valid?
Bagaimana memecah order?
Kapan order dikirim?
Kapan execution harus dihentikan?
```

---

# 3. Product Positioning

CEX Executor bukan:

- exchange;
- wallet;
- copy trading platform;
- signal provider;
- trading strategy provider;
- market prediction engine.

CEX Executor adalah:

> **Risk-aware execution infrastructure for centralized exchanges.**

Core value proposition:

```text
Define Risk → Define Outcome → Execute Intelligently
```

---

# 4. Goals

## 4.1 Primary Goals

### G1 — Unified Exchange Execution

User dapat menghubungkan beberapa exchange dan menggunakan interface execution yang sama.

Initial:

```text
Binance
Bybit
MEXC
```

Future:

```text
OKX
Bitget
Gate
KuCoin
Hyperliquid CEX-like adapter
Others
```

---

### G2 — Risk-Based Position Sizing

User dapat menentukan risiko berdasarkan:

```text
Fixed USD
Percentage of account
```

Contoh:

```text
Risk = $25
```

atau:

```text
Risk = 1% Futures Equity
```

Executor menghitung quantity secara otomatis.

---

### G3 — Profit-Based Position Sizing

User dapat menentukan:

```text
Entry
Take Profit
Desired Profit
```

Executor menghitung quantity dan exposure yang diperlukan.

---

### G4 — Automatic Margin & Leverage

Untuk futures, user tidak diwajibkan menentukan margin terlebih dahulu.

Flow:

```text
Risk
 ↓
Position Size
 ↓
Notional
 ↓
Leverage
 ↓
Margin
```

Leverage dapat berupa:

```text
Manual
Auto Safe
```

---

### G5 — Synthetic Execution Algorithms

Executor menyediakan metode yang tidak tersedia atau tidak konsisten pada masing-masing CEX.

Initial:

```text
Market
Limit
TWAP
Adaptive TWAP
Iceberg
Scale In
Scale Out
Chase Limit
```

---

### G6 — Dynamic Risk Enforcement

Execution algorithm tidak boleh melewati maximum risk user.

Risk merupakan **hard constraint**.

---

# 5. Non-Goals

MVP tidak bertujuan menyediakan:

- prediction AI;
- automatic trading signals;
- arbitrage strategy;
- market making engine;
- portfolio optimizer;
- copy trading;
- social trading;
- custody;
- withdrawal;
- deposit handling;
- fiat on-ramp;
- options execution;
- inverse futures;
- portfolio rebalancing otomatis;
- autonomous AI trader.

Semua fitur tersebut dapat dikembangkan sebagai module terpisah nantinya.

---

# 6. Core Product Principle

## Risk First

Traditional exchange:

```text
Margin
+
Leverage
=
Position
```

FUDCourt Executor:

```text
Risk
+
Stop
+
Entry
=
Position Size
```

baru:

```text
Position Size
+
Leverage Policy
=
Required Margin
```

---

# 7. Terminology

| Variable | Meaning |
|---|---|
| `E` | Entry price |
| `S` | Stop-loss price |
| `T` | Take-profit price |
| `Q` | Asset quantity |
| `N` | Position notional |
| `R` | Maximum risk |
| `P` | Target profit |
| `L` | Leverage |
| `M` | Initial margin |
| `F` | Estimated fees |
| `SLP` | Estimated slippage |
| `Equity` | Selected account equity |
| `RiskPct` | Risk percentage |

---

# 8. Core Position Sizing

## 8.1 Risk USD

Linear instrument:

```text
Q = RiskBudget / abs(Entry - Stop)
```

Notional:

```text
N = Q × Entry
```

Example:

```text
BTC Entry = $100,000
Stop      = $98,000
Risk      = $20
```

Distance:

```text
$2,000 / BTC
```

Quantity:

```text
20 / 2000
= 0.01 BTC
```

Notional:

```text
0.01 × 100,000
= $1,000
```

---

# 9. Percentage Risk

User dapat memilih:

```text
Risk = 1%
```

Risk budget:

```text
RiskBudget = SelectedEquity × RiskPct
```

Example:

```text
Futures Equity = $5,000
Risk = 1%
```

maka:

```text
RiskBudget = $50
```

Position sizing selanjutnya identik dengan Fixed USD Risk.

---

# 10. Risk Basis

Percentage risk harus memiliki source balance yang eksplisit.

Supported:

```text
Spot Available Balance
Spot Equity
Futures Available Balance
Futures Equity
Total Exchange Equity
Selected Asset Equity
Custom Reference Balance
```

Default:

```text
Spot trade
→ Spot Available Balance

Futures trade
→ Futures Equity
```

---

# 11. Risk vs Allocation

UI tidak boleh mencampur:

```text
Risk %
```

dengan:

```text
Allocation %
```

Risk berarti:

> Berapa banyak yang boleh hilang ketika SL terkena.

Allocation berarti:

> Berapa banyak modal yang ingin digunakan.

Example:

```text
Account = $10,000

Allocation = 20%
→ $2,000 capital

Risk = 1%
→ $100 maximum allowed loss
```

Keduanya merupakan konsep berbeda.

---

# 12. Supported Sizing Modes

## Risk-Oriented

```text
RISK_USD
RISK_PERCENT
```

## Capital-Oriented

```text
ALLOCATION_USD
ALLOCATION_PERCENT
NOTIONAL_USD
FIXED_QUANTITY
FIXED_MARGIN
```

## Outcome-Oriented

```text
TARGET_PROFIT_USD
TARGET_PROFIT_PERCENT
```

---

# 13. Target Profit Sizing

Jika:

```text
Entry = E
Target = T
Desired Profit = P
```

maka:

```text
Q = P / abs(T - E)
```

Example:

```text
BTC Entry = $100,000
TP        = $105,000
Profit    = $50
```

Quantity:

```text
50 / 5000
= 0.01 BTC
```

Notional:

```text
$1,000
```

---

# 14. Risk + Profit Constraint

User dapat memasukkan sekaligus:

```text
Entry
SL
TP
Maximum Risk
Target Profit
```

Executor harus melakukan constraint validation.

Example:

```text
Entry = 100
SL    = 95
TP    = 110

Risk = $20
Profit Target = $100
```

Risk-derived quantity:

```text
20 / 5
= 4 units
```

Profit:

```text
4 × 10
= $40
```

Maka requirement:

```text
Max Loss = $20
Target Profit = $100
```

tidak dapat dipenuhi bersamaan.

Executor mengembalikan:

```text
Requested

Max Loss       $20
Target Profit  $100

Possible using current SL/TP

Max Loss       $20
Profit         $40
```

atau:

```text
To achieve $100 target

Required Risk ≈ $50
```

---

# 15. Constraint Solver

Long-term core engine harus diperlakukan sebagai constraint solver.

Known variables dapat berupa kombinasi:

```text
Entry
Stop
Take Profit
Quantity
Risk
Profit
Margin
Notional
Leverage
Balance
```

Unknown variables dihitung oleh engine.

Example:

```text
Known:

Entry     = $100
TP        = $120
Profit    = $200
Margin    = $250
```

Derived:

```text
Quantity

200 / 20
= 10
```

Notional:

```text
10 × 100
= $1,000
```

Leverage:

```text
1000 / 250
= 4x
```

Result:

```text
Quantity  10
Notional  $1,000
Margin    $250
Leverage  4x
```

---

# 16. Spot Trading

Spot tidak memiliki liquidation atau leverage pada normal spot market.

Flow:

```text
Balance
 ↓
Risk Budget
 ↓
Entry
 ↓
Stop
 ↓
Quantity
 ↓
Required Capital
```

Example:

```text
Balance = $2,500
Risk    = 1%
Entry   = $100
SL      = $95
```

Risk budget:

```text
$25
```

Quantity:

```text
25 / 5
= 5
```

Required capital:

```text
5 × 100
= $500
```

Executor membeli:

```text
5 units / $500
```

bukan 100% balance.

---

# 17. Futures Trading

Futures menambahkan:

```text
leverage
margin
liquidation
maintenance margin
funding
position mode
margin mode
```

Flow:

```text
Risk Budget
 ↓
Quantity
 ↓
Notional
 ↓
Leverage Policy
 ↓
Initial Margin
 ↓
Liquidation Validation
 ↓
Execution
```

---

# 18. Leverage Modes

## 18.1 Manual Leverage

User menentukan:

```text
1x
2x
5x
10x
20x
...
```

Executor memvalidasi:

```text
exchange max leverage
symbol leverage tier
minimum margin
liquidation distance
available balance
```

---

# 19. Auto Leverage

Auto leverage memilih leverage berdasarkan constraints.

Input:

```text
Position notional
Available balance
SL
Liquidation policy
Maximum leverage
Margin policy
Exchange risk tier
```

Possible policy:

```text
AUTO_SAFE
AUTO_BALANCED
AUTO_CAPITAL_EFFICIENT
```

MVP cukup:

```text
AUTO_SAFE
```

---

# 20. Liquidation Safety

Auto leverage tidak boleh hanya mencari margin minimum.

Constraint utama:

```text
Liquidation harus berada di luar Stop Loss
+
Safety Buffer
```

Untuk LONG:

```text
LiqPrice < StopPrice
```

Untuk SHORT:

```text
LiqPrice > StopPrice
```

Dengan optional safety:

```text
Minimum Liquidation Distance
Minimum SL-to-Liq Buffer
```

Example:

```text
Entry       $100
SL          $95
Required buffer = 20% dari stop distance
```

Stop distance:

```text
$5
```

Additional buffer:

```text
$1
```

Target liquidation:

```text
<= $94
```

---

# 21. Exchange-Specific Liquidation

Production liquidation calculation harus berasal dari:

```text
exchange formulas
maintenance margin bracket
position size
margin mode
account configuration
fees
```

Executor tidak boleh mengandalkan formula leverage sederhana untuk final validation.

Approximation hanya boleh digunakan untuk preview ketika exchange data belum tersedia.

---

# 22. Fee-Aware Risk

Risk sizing production harus mempertimbangkan:

```text
entry fee
exit fee
estimated slippage
safety reserve
```

Basic:

```text
PriceRisk = Q × abs(E - S)
```

Total:

```text
TotalRisk =
PriceRisk
+ EntryFee
+ ExitFee
+ EstimatedSlippage
+ SafetyReserve
```

Constraint:

```text
TotalRisk <= UserRiskBudget
```

---

# 23. Risk Budget Breakdown

Example:

```text
Maximum Risk      $25.00

Price Risk        $22.30
Entry Fee          $0.85
Exit Fee           $0.85
Slippage Budget    $0.75
Safety Reserve     $0.25
────────────────────────
Total             $25.00
```

---

# 24. Execution Architecture

```text
┌────────────────────────────┐
│          Client            │
│ Web / API / Bot / CLI      │
└──────────────┬─────────────┘
               │
               ▼
┌────────────────────────────┐
│      Intent Validator      │
└──────────────┬─────────────┘
               │
               ▼
┌────────────────────────────┐
│       Risk Engine          │
│                            │
│ sizing                     │
│ constraints                │
│ leverage                   │
│ margin                     │
│ liquidation               │
│ fees                       │
└──────────────┬─────────────┘
               │
               ▼
┌────────────────────────────┐
│     Execution Planner      │
└──────────────┬─────────────┘
               │
               ▼
┌────────────────────────────┐
│     Execution Engine       │
│                            │
│ TWAP                       │
│ Adaptive TWAP              │
│ Iceberg                    │
│ Scale                      │
│ Chase                      │
└──────────────┬─────────────┘
               │
               ▼
┌────────────────────────────┐
│      Order Manager         │
└──────────────┬─────────────┘
               │
               ▼
┌────────────────────────────┐
│     Exchange Adapter       │
└───────┬────────┬───────────┘
        │        │
        ▼        ▼
   Binance    Bybit     MEXC
```

---

# 25. Execution Algorithms

MVP:

```text
MARKET
LIMIT
TWAP
ADAPTIVE_TWAP
ICEBERG
CHASE_LIMIT
SCALE_IN
SCALE_OUT
```

Future:

```text
VWAP
POV
Implementation Shortfall
Arrival Price
Liquidity Seeking
Smart Maker
Market Sweep
Opportunistic
Hybrid Strategies
```

---

# 26. Market Execution

Immediately place market order.

Configuration:

```text
maxSlippage
maxSpread
maxNotional
```

Before execution:

```text
estimate market impact
validate orderbook depth
validate risk
```

---

# 27. Limit Execution

Input:

```text
price
quantity
timeInForce
postOnly
reduceOnly
```

Supported normalized TIF:

```text
GTC
IOC
FOK
```

Adapter determines actual exchange support.

---

# 28. TWAP

TWAP splits total quantity over time.

Input:

```text
totalQuantity
duration
numberOfSlices
interval
randomization
priceConstraint
```

Example:

```text
Total quantity = 1 BTC
Duration       = 60 minutes
Slices         = 20
```

Naive:

```text
0.05 BTC / 3 minutes
```

Executor should optionally randomize:

```text
0.043
0.052
0.047
0.058
...
```

Intervals may also receive bounded jitter.

---

# 29. TWAP Configuration

```ts
interface TwapConfig {
  durationMs: number

  slices?: number

  intervalMs?: number

  quantityJitterPct?: number

  intervalJitterPct?: number

  priceLimit?: number

  orderType:
    | "market"
    | "limit"
    | "maker"

  maxSlippageBps?: number

  maxSpreadBps?: number
}
```

---

# 30. Adaptive TWAP

Adaptive TWAP modifies slice behavior based on market conditions.

Signals:

```text
spread
orderbook liquidity
volatility
market volume
price drift
remaining quantity
remaining duration
previous fill quality
slippage
```

Example:

```text
high liquidity
→ increase slice

wide spread
→ reduce slice

favorable price movement
→ increase participation

unfavorable price movement
→ reduce aggression

execution behind schedule
→ increase aggression
```

Risk constraints tetap memiliki prioritas tertinggi.

---

# 31. Iceberg

User menentukan:

```text
total quantity
visible quantity range
price behavior
```

Executor repeatedly places child orders.

Example:

```text
Total:
10 BTC

Displayed:
0.2–0.5 BTC
```

Optional:

```text
random size
random delay
price re-pegging
maker-only
```

---

# 32. Chase Limit

Executor mempertahankan limit order dekat best bid/ask.

Example LONG:

```text
Best bid = 100
Best ask = 100.1
```

Strategy dapat:

```text
place 100
```

Jika bid berubah:

```text
100.2
```

executor:

```text
cancel 100
replace 100.2
```

Controls:

```text
max chase distance
max replacements
minimum replacement interval
post-only
timeout
market fallback
```

---

# 33. Scale In

Position dibangun pada beberapa level.

Example:

```text
25% @ 100
25% @ 98
25% @ 96
25% @ 94
```

Sizing dapat berupa:

```text
equal
weighted
custom
```

Critical:

Risk engine harus menghitung total maximum risk semua potential fills.

---

# 34. Scale Out

Example:

```text
TP1 25%
TP2 25%
TP3 25%
TP4 25%
```

Possible configurations:

```text
fixed targets
RR targets
percentage move
custom levels
```

---

# 35. Execution Urgency

Simplified UX:

```text
Passive
Balanced
Aggressive
Immediate
```

Internal parameters dapat mempengaruhi:

```text
post-only preference
order offset
reprice interval
child order size
market fallback
participation
timeout
```

---

# 36. Dynamic Risk Reconciliation

Ini merupakan core requirement.

Planned entry sering berbeda dengan actual fill.

Example:

```text
Estimated entry = $100,000

Actual fills:
$100,050
$100,200
$100,400
```

Average entry berubah.

Setelah setiap fill:

```text
receive fill
 ↓
update average entry
 ↓
recalculate current risk
 ↓
recalculate remaining risk budget
 ↓
resize remaining execution
```

---

# 37. Hard Risk Constraint

Jika:

```text
Risk budget = $50
```

maka final projected risk tidak boleh menjadi:

```text
$51
```

tanpa explicit override.

If remaining execution causes projected risk to exceed limit:

```text
RESIZE
```

atau:

```text
PAUSE
```

atau:

```text
STOP
```

berdasarkan configured policy.

Default:

```text
RESIZE_THEN_STOP
```

---

# 38. Stop-Loss Requirement

Untuk `RISK_USD` dan `RISK_PERCENT`, Stop Loss wajib tersedia sebelum membuka position kecuali user explicitly menggunakan alternate risk model.

Default:

```text
No SL
→ Cannot calculate bounded position risk
```

Maka UI harus menolak risk-based sizing tanpa SL.

---

# 39. Synthetic Stop Management

Executor dapat menyediakan stop walaupun exchange behavior berbeda.

Modes:

```text
NATIVE
SYNTHETIC
HYBRID
```

Prefer:

```text
Native exchange stop
```

jika tersedia dan compatible.

Synthetic stop dapat digunakan untuk advanced cases.

---

# 40. Synthetic OCO

Executor dapat menjaga:

```text
TP
+
SL
```

Jika TP filled:

```text
cancel SL
```

Jika SL filled:

```text
cancel TP
```

Partial fills harus ditangani.

Remaining exit quantity harus selalu sama dengan remaining open position.

---

# 41. Position Reconciliation

Executor harus selalu mempertimbangkan exchange sebagai source of truth untuk:

```text
actual position
actual fills
actual balance
actual open orders
```

Internal database menyimpan execution state tetapi tidak boleh menganggap state internal selalu benar.

Periodic reconciliation wajib tersedia.

---

# 42. Exchange Model

Setiap user dapat memiliki beberapa account.

Example:

```text
User

├── Binance Main
├── Binance Trading
├── Bybit Main
└── MEXC Alt
```

---

# 43. BYOK Credential Model

User membawa:

```text
API Key
API Secret
optional passphrase
```

FUDCourt tidak pernah meminta:

```text
withdrawal permission
```

Recommended permissions:

```text
Read
Spot Trading
Futures Trading
```

Withdrawal permission harus dianggap unsupported dan undesirable.

---

# 44. Credential Security

API secret:

```text
never plaintext at rest
never returned to frontend
never logged
never exposed in errors
```

Required:

```text
application-level encryption
envelope encryption
key rotation support
per-credential nonce
audit log
credential revocation
```

Recommended internal storage:

```text
AES-256-GCM encrypted payload
+
master encryption key outside PostgreSQL
```

---

# 45. Credential Database Shape

```text
exchange_credentials

id
user_id
exchange
label
api_key_encrypted
api_secret_encrypted
passphrase_encrypted
permissions
created_at
updated_at
last_used_at
revoked_at
```

Actual key naming can follow repository convention.

---

# 46. API Key Validation

On connection:

```text
1. decrypt credential
2. call account endpoint
3. detect permissions
4. detect account type
5. fetch balances
6. detect supported capabilities
7. persist metadata
```

Return:

```text
Connected

Exchange:
Binance

Permissions:
Read ✓
Spot Trade ✓
Futures Trade ✓
Withdraw ✕

Status:
Healthy
```

---

# 47. Credential Health

States:

```text
ACTIVE
INVALID
EXPIRED
PERMISSION_ERROR
RATE_LIMITED
REVOKED
UNKNOWN
```

---

# 48. Exchange Adapter Interface

```ts
interface ExchangeAdapter {
  validateCredentials(): Promise<AccountMetadata>

  getBalances(): Promise<Balance[]>

  getAccountEquity(): Promise<AccountEquity>

  getMarkets(): Promise<Market[]>

  getTicker(
    symbol: string
  ): Promise<Ticker>

  getOrderBook(
    symbol: string,
    depth?: number
  ): Promise<OrderBook>

  getPositions(): Promise<Position[]>

  getOpenOrders(
    symbol?: string
  ): Promise<Order[]>

  placeOrder(
    order: NormalizedOrder
  ): Promise<OrderResult>

  cancelOrder(
    orderId: string,
    symbol: string
  ): Promise<void>

  amendOrder?(
    order: AmendOrderRequest
  ): Promise<OrderResult>

  setLeverage?(
    symbol: string,
    leverage: number
  ): Promise<void>

  setMarginMode?(
    symbol: string,
    mode: MarginMode
  ): Promise<void>

  getLeverageBrackets?(
    symbol: string
  ): Promise<LeverageBracket[]>

  getFundingRate?(
    symbol: string
  ): Promise<FundingRate>

  getFees(
    symbol: string
  ): Promise<FeeSchedule>
}
```

---

# 49. Normalized Symbols

Exchange symbol differences harus dinormalisasi.

Internal identifier:

```text
BTC/USDT
ETH/USDT
SOL/USDT
```

plus:

```text
marketType = spot
marketType = linear_perp
```

Internal unique key:

```text
binance:linear_perp:BTC/USDT
```

---

# 50. Exchange Capability Registry

Each venue maintains capability metadata.

```ts
interface ExchangeCapabilities {
  spot: boolean
  linearPerpetual: boolean

  marginModes: {
    cross: boolean
    isolated: boolean
  }

  hedgeMode: boolean

  orderTypes: {
    market: boolean
    limit: boolean
    stop: boolean
    stopLimit: boolean
    trailing: boolean
    postOnly: boolean
  }

  nativeFeatures: {
    iceberg: boolean
    twap: boolean
    oco: boolean
  }
}
```

Synthetic engine tidak bergantung pada native availability.

---

# 51. Normalized Execution Request

```ts
interface ExecutionRequest {
  accountId: string

  symbol: string

  marketType:
    | "spot"
    | "linear_perp"

  side:
    | "buy"
    | "sell"

  intent:
    | "open"
    | "close"
    | "reduce"

  entry: EntryDefinition

  stopLoss?: PriceDefinition

  takeProfits?: TakeProfitDefinition[]

  sizing: SizingDefinition

  leverage?: LeverageDefinition

  marginMode?: "cross" | "isolated"

  execution: ExecutionDefinition

  constraints?: ExecutionConstraints
}
```

---

# 52. Sizing Definition

```ts
type SizingDefinition =
  | {
      mode: "risk_usd"
      value: number
    }

  | {
      mode: "risk_percent"
      value: number
      balanceBasis: BalanceBasis
    }

  | {
      mode: "allocation_usd"
      value: number
    }

  | {
      mode: "allocation_percent"
      value: number
      balanceBasis: BalanceBasis
    }

  | {
      mode: "notional_usd"
      value: number
    }

  | {
      mode: "fixed_quantity"
      value: number
    }

  | {
      mode: "target_profit_usd"
      value: number
    }

  | {
      mode: "target_profit_percent"
      value: number
      balanceBasis: BalanceBasis
    }
```

---

# 53. Leverage Definition

```ts
type LeverageDefinition =
  | {
      mode: "manual"
      leverage: number
    }

  | {
      mode: "auto_safe"

      maxLeverage?: number

      liquidationBufferPct?: number

      maxMarginPct?: number
    }
```

---

# 54. Execution Definition

```ts
type ExecutionDefinition =
  | {
      type: "market"
    }

  | {
      type: "limit"
      price: number
      postOnly?: boolean
    }

  | {
      type: "twap"
      durationMs: number
      slices?: number
    }

  | {
      type: "adaptive_twap"
      durationMs: number
      urgency: ExecutionUrgency
    }

  | {
      type: "iceberg"
      visibleQuantity: number
    }

  | {
      type: "chase_limit"
      urgency: ExecutionUrgency
    }

  | {
      type: "scale_in"
      levels: ScaleLevel[]
    }

  | {
      type: "scale_out"
      levels: ScaleLevel[]
    }
```

---

# 55. Execution Constraints

```ts
interface ExecutionConstraints {
  maxSlippageBps?: number

  maxSpreadBps?: number

  maxPrice?: number

  minPrice?: number

  maxDurationMs?: number

  makerOnly?: boolean

  allowMarketFallback?: boolean

  cancelIfRiskExceeded?: boolean

  stopIfDisconnected?: boolean
}
```

---

# 56. Execution Plan

Risk engine does not send orders directly.

It produces:

```text
ExecutionPlan
```

Example:

```json
{
  "symbol": "BTC/USDT",
  "side": "buy",

  "quantity": 0.0125,
  "notional": 1250,

  "estimatedEntry": 100000,

  "risk": {
    "budget": 25,
    "estimatedTotalRisk": 24.81,
    "priceRisk": 22.9,
    "estimatedFees": 1.21,
    "slippageBudget": 0.7
  },

  "leverage": {
    "mode": "auto_safe",
    "selected": 10
  },

  "margin": {
    "estimatedInitial": 125
  },

  "execution": {
    "strategy": "adaptive_twap",
    "durationMs": 1800000,
    "estimatedSlices": 12
  }
}
```

---

# 57. Execution Lifecycle

```text
DRAFT
 ↓
CALCULATED
 ↓
VALIDATED
 ↓
READY
 ↓
RUNNING
 ↓
PARTIALLY_FILLED
 ↓
FILLED
```

Alternative states:

```text
PAUSED
CANCEL_REQUESTED
CANCELLED
FAILED
RISK_STOPPED
EXPIRED
RECONCILING
```

---

# 58. Child Order Lifecycle

```text
PLANNED
SUBMITTING
OPEN
PARTIAL
FILLED
CANCELLING
CANCELLED
REJECTED
EXPIRED
UNKNOWN
```

---

# 59. Database Model

Core tables:

```text
exchange_accounts
exchange_credentials
exchange_capabilities

executions
execution_plans
execution_events

child_orders
fills

positions_snapshots
balance_snapshots

risk_profiles
risk_events

market_metadata
symbol_metadata

audit_logs
```

---

# 60. Executions Table

Conceptual fields:

```text
executions

id
user_id
account_id
exchange
symbol
market_type
side
intent

status

sizing_mode
sizing_value

risk_budget
risk_basis

entry_definition
stop_definition
take_profit_definition

execution_strategy
execution_config

planned_quantity
planned_notional

actual_quantity
actual_notional
average_fill_price

estimated_fees
actual_fees

planned_risk
current_risk

created_at
started_at
completed_at
cancelled_at
```

JSONB may be used for strategy-specific config.

---

# 61. Child Orders Table

```text
child_orders

id
execution_id

exchange_order_id
client_order_id

symbol
side
type

price
quantity
filled_quantity

status

submitted_at
updated_at
filled_at
```

---

# 62. Fill Model

```text
fills

id
execution_id
child_order_id

exchange_trade_id

price
quantity
quote_quantity
fee
fee_asset

timestamp
```

Deduplicate using exchange trade ID + account.

---

# 63. Event-Sourced Execution History

Critical execution transitions should also generate immutable events.

Example:

```text
EXECUTION_CREATED
RISK_CALCULATED
PLAN_CREATED
EXECUTION_STARTED

ORDER_SUBMITTED
ORDER_PARTIALLY_FILLED
ORDER_FILLED
ORDER_CANCELLED

RISK_RECALCULATED
PLAN_RESIZED

EXECUTION_PAUSED
EXECUTION_RESUMED
EXECUTION_COMPLETED
EXECUTION_FAILED
```

This greatly simplifies debugging and audit.

---

# 64. Valkey / Redis Role

Valkey should be used for hot and ephemeral state:

```text
distributed locks
rate limits
execution scheduler
market snapshots
short-lived orderbook data
API nonce coordination
worker leases
execution heartbeat
idempotency keys
WebSocket fan-out
```

PostgreSQL remains authoritative persistent state.

---

# 65. Distributed Locking

Only one worker may control an execution at a time.

Example lock:

```text
execution:{executionId}:lock
```

With:

```text
lease TTL
heartbeat
worker ID
```

This prevents duplicated orders after worker races.

---

# 66. Idempotency

Every order placement must have unique client-generated ID.

Example:

```text
fud_{executionId}_{sequence}
```

Retries must not accidentally create duplicate exposure.

---

# 67. Scheduler

Execution scheduler is required for:

```text
TWAP
Iceberg delays
Scale orders
Timeouts
Chase Limit
retries
reconciliation
```

Scheduler should not depend on frontend connection.

Closing browser must not stop active execution.

---

# 68. Worker Architecture

Recommended:

```text
Execution API
     │
     ▼
Execution Queue
     │
     ▼
Execution Workers
     │
     ├── Binance Adapter
     ├── Bybit Adapter
     └── MEXC Adapter
```

Worker responsibilities:

```text
fetch state
place orders
monitor fills
recalculate risk
schedule next child
reconcile position
publish events
```

---

# 69. Market Data

Execution strategies need:

```text
ticker
best bid
best ask
orderbook
recent trades
instrument metadata
```

Initial system may consume each exchange's native WebSocket/API.

Normalized market snapshot:

```ts
interface MarketSnapshot {
  symbol: string

  bid: number
  ask: number
  mid: number

  spreadBps: number

  last: number

  timestamp: number
}
```

---

# 70. Instrument Metadata

Per symbol:

```text
tick size
step size
minimum quantity
maximum quantity
minimum notional
maximum notional
max leverage
margin tiers
contract multiplier
base asset
quote asset
settlement asset
```

Every calculated order must be rounded according to instrument constraints.

---

# 71. Rounding Engine

Never rely on normal JavaScript floating-point rounding for monetary correctness.

Introduce:

```text
Decimal arithmetic
```

Core calculations must use decimal/fixed-point library.

Example:

```text
BTC step = 0.001
```

Quantity:

```text
0.012583
```

must normalize according to strategy and risk direction.

For risk safety:

```text
round quantity DOWN
```

rather than up.

---

# 72. Portfolio Risk Profiles

User can define account-level safety rules.

Example:

```text
Risk per trade       1%
Max open risk        3%
Max daily loss       5%
Max futures exposure 50%
Max leverage         10x
```

---

# 73. Open Risk

Each active trade contributes:

```text
distance to SL
×
remaining position
+
expected exit costs
```

Total:

```text
Portfolio Open Risk =
Σ individual position risk
```

New execution must respect account limits.

---

# 74. Daily Loss Guard

Optional profile:

```text
Daily max realized loss = 5%
```

If reached:

```text
block new opening executions
```

Closing/reducing risk remains allowed.

---

# 75. Emergency Controls

User needs:

```text
Pause Execution
Cancel Execution
Cancel Open Child Orders
Close Position
Cancel All Orders
Emergency Stop
```

Emergency Stop:

```text
stop all strategies
cancel managed open orders
prevent new managed entry orders
```

Should not blindly close positions unless user explicitly requests close.

---

# 76. Disconnect Behavior

If worker loses exchange connectivity:

```text
stop creating new child orders
mark strategy degraded
retry connection
reconcile state before resume
```

Existing native SL should remain on exchange whenever possible.

This is another reason native protective stop should be preferred over synthetic-only SL.

---

# 77. API Rate Limits

Each adapter should expose normalized rate-limit information.

Rate limiter dimensions may include:

```text
exchange
account
endpoint group
IP
order rate
request weight
```

Rate-limit exhaustion must never cause uncontrolled retries.

---

# 78. Retry Policy

Safe retries:

```text
GET market/account state
GET order status
cancel status check
```

Order submission requires idempotency.

Retry categories:

```text
network retryable
rate limited
exchange overload
invalid order
permission error
insufficient balance
fatal
unknown
```

---

# 79. Pre-Trade Validation

Before execution:

```text
credential healthy
symbol supported
market active
balance sufficient
risk valid
quantity valid
notional valid
leverage valid
margin valid
SL valid
TP valid
exchange permissions valid
rate limit capacity valid
```

---

# 80. Preview / Dry Run

Every execution should first support Preview.

Example output:

```text
BTCUSDT
LONG
Bybit Perpetual

Entry Estimate
$100,000

Stop
$98,000

Risk
1% of $5,000
= $50

Position
0.0244 BTC

Notional
$2,440

Leverage
Auto Safe → 8x

Required Margin
≈ $305

Estimated Fees
$2.18

Expected Loss @ SL
-$49.72

TP
$106,000

Expected Profit
+$146.40

R:R
2.94

Execution
Adaptive TWAP

Duration
30 minutes
```

User confirms execution after preview.

---

# 81. UI Information Architecture

Proposed route:

```text
/app/executor
```

or following existing route convention:

```text
/executor
```

Pages:

```text
/executor
/executor/new
/executor/[id]
/executor/history
/executor/accounts
/executor/settings
```

---

# 82. New Execution UI

Main form:

```text
Account
Market
Symbol
Side

Entry
Stop Loss
Take Profit

Sizing Mode
Sizing Value

Leverage Mode

Execution Method

Advanced Constraints
```

Live preview shown on right/underneath.

---

# 83. Primary Trade Composer

Example:

```text
┌──────────────────────────────────────┐
│ BTC / USDT                           │
│ Binance Futures                      │
├──────────────────────────────────────┤
│ LONG                                 │
│                                      │
│ Entry          Market                │
│ Stop           $98,000               │
│ TP             $106,000              │
│                                      │
│ Sizing         Risk %                │
│ Risk           1.00%                 │
│ Basis          Futures Equity        │
│                                      │
│ Leverage       Auto Safe             │
│                                      │
│ Execution      Adaptive TWAP         │
│ Duration       30m                   │
│                                      │
│             Preview                  │
└──────────────────────────────────────┘
```

---

# 84. Risk Preview

Always visible:

```text
Account Equity
Risk Budget
Quantity
Notional
Margin
Leverage

Estimated Fees
Estimated Slippage

Loss @ SL
Profit @ TP
Risk/Reward

Liquidation Price
SL → Liquidation Buffer
```

---

# 85. Active Execution Screen

Show:

```text
progress
elapsed time
remaining time
planned quantity
filled quantity
remaining quantity
average fill
slippage
fees
current risk
remaining risk budget
child orders
fills
strategy status
```

---

# 86. Execution Progress Example

```text
Adaptive TWAP

██████████████░░░░░░ 67%

Filled
0.0167 / 0.025 BTC

Average
$100,142

Planned Risk
$50.00

Current Projected Risk
$47.83

Remaining Risk Budget
$2.17

Elapsed
20m 14s

Remaining
9m 46s
```

---

# 87. Exchange Accounts UI

Route:

```text
/executor/accounts
```

User sees:

```text
Binance Main
Connected
Spot ✓
Futures ✓
Last sync 5s ago

Bybit Trading
Connected
Spot ✓
Futures ✓

MEXC
Credential Error
```

Actions:

```text
Connect
Test
Rename
Disable
Rotate
Delete
```

Secret itself never displayed again.

---

# 88. Risk Settings UI

Global defaults:

```text
Default risk           1%
Maximum risk/trade     2%
Max total open risk    5%
Max leverage           10x
Default margin mode    Isolated
Default execution      Balanced
```

Per-account overrides allowed later.

---

# 89. Spot-Specific Rules

For Spot:

```text
No liquidation
No leverage
No futures margin mode
```

Risk calculation relies on:

```text
entry
SL
quantity
fees
```

Sell-side opening should not be allowed unless venue/account supports margin/short product explicitly.

---

# 90. Futures-Specific Rules

Must handle:

```text
one-way mode
hedge mode
cross
isolated
reduce-only
position side
leverage tier
maintenance margin
```

Normalized model should support these even if MVP UI initially simplifies them.

---

# 91. Position Mode

Normalized:

```text
ONE_WAY
HEDGE
```

For hedge:

```text
LONG
SHORT
```

must be treated separately.

---

# 92. Margin Mode

```text
ISOLATED
CROSS
```

MVP default recommendation at product level:

```text
ISOLATED
```

but user may select supported mode.

Risk calculation must still recognize cross margin account state.

---

# 93. Existing Position Handling

Before opening execution:

Executor checks whether user already has position.

Possible policy:

```text
ADD
REPLACE
REDUCE
REJECT
```

MVP:

```text
ADD
REJECT
```

depending on explicit intent.

No accidental position netting.

---

# 94. Manual Trading Outside FUDCourt

Users may manually modify account from exchange UI while execution is active.

Therefore:

```text
position changed externally
order cancelled externally
leverage changed externally
margin changed externally
```

must be detected.

Execution then performs reconciliation.

Possible state:

```text
EXTERNAL_STATE_CHANGE
```

Strategy may pause until safe state is determined.

---

# 95. Source of Truth

Hierarchy:

```text
Exchange
= monetary truth

PostgreSQL
= execution history / intended state

Valkey
= ephemeral runtime state
```

Never reverse this hierarchy.

---

# 96. WebSocket Event Handling

Prefer realtime exchange events for:

```text
orders
fills
positions
balances
```

REST polling remains fallback and reconciliation mechanism.

---

# 97. API Layer

Suggested namespace:

```text
/api/executor/*
```

Core endpoints:

```text
POST /accounts
GET  /accounts
GET  /accounts/:id
POST /accounts/:id/test
DELETE /accounts/:id

POST /preview

POST /executions
GET  /executions
GET  /executions/:id

POST /executions/:id/start
POST /executions/:id/pause
POST /executions/:id/resume
POST /executions/:id/cancel

GET /executions/:id/orders
GET /executions/:id/fills
GET /executions/:id/events
```

---

# 98. Preview API

```text
POST /api/executor/preview
```

does not create external order.

Responsibilities:

```text
validate request
fetch account equity
fetch market data
calculate sizing
estimate fees
estimate slippage
calculate leverage
calculate margin
calculate liquidation
create execution plan preview
```

---

# 99. Execution Creation

```text
POST /api/executor/executions
```

should create immutable snapshot of important inputs:

```text
balance snapshot
market snapshot
fees
instrument metadata
risk config
execution config
```

This allows later audit.

---

# 100. Server-Side Only Execution

Exchange secrets and order submission must never happen directly from browser.

Required flow:

```text
Browser
 ↓
FUDCourt Backend
 ↓
Execution Worker
 ↓
Exchange API
```

Never:

```text
Browser
 ↓
Exchange Secret
 ↓
Exchange
```

---

# 101. Repository Architecture

Recommended layout inside FUDCourt monorepo:

```text
fudcourt/
│
├── apps/
│   ├── web/
│   │   └── src/
│   │       └── routes/
│   │           └── executor/
│   │
│   └── executor-worker/
│
├── packages/
│   ├── executor-core/
│   │
│   ├── risk-engine/
│   │
│   ├── execution-engine/
│   │
│   ├── exchange-core/
│   │
│   ├── exchange-binance/
│   │
│   ├── exchange-bybit/
│   │
│   ├── exchange-mexc/
│   │
│   └── market-types/
│
├── docs/
│   └── prd/
│       └── cex-executor.md
│
└── migrations/
```

Adapt naming to existing monorepo tooling.

> **As-built note (2026-10-01, docs-reality pass).** The block above is this PRD's *proposal*
> ("recommended layout … adapt naming"), not a description of the tree. The tree that landed is:
> `apps/executor/internal/{core/{execution,orders,planner,risk,sizing},strategies,exchanges/{binance,bybit,mexc,paper},runtime/{worker,idempotency},platform/{lock,decimal,credentials},repository}`
> plus the TS parity oracle still in `apps/web/src/platform/executor/`. See
> `docs/architecture/executor.md` for the module map and `docs/records/archive/final-review.md` §1 for
> the repo tree.

---

# 102. Core Package Boundaries

## `risk-engine`

Contains pure deterministic calculations.

No:

```text
HTTP
database
exchange API
frontend
```

Input → calculation → output.

This package should be highly unit-tested.

---

## `execution-engine`

Contains strategy planning:

```text
TWAP
Adaptive TWAP
Iceberg
Chase
Scale
```

Does not store credentials.

---

## `exchange-core`

Contains:

```text
adapter interfaces
normalized models
capabilities
common errors
symbol mapping
```

---

## Exchange Packages

```text
exchange-binance
exchange-bybit
exchange-mexc
```

Responsible only for translating normalized requests to venue-specific behavior.

---

## `executor-worker`

Runtime orchestrator:

```text
scheduler
locks
execution state machine
order monitoring
risk reconciliation
retries
recovery
```

---

# 103. Core Risk Engine API

Example:

```ts
calculateRiskPosition({
  side,
  entry,
  stop,
  riskBudget,
  feeModel,
  slippageModel,
  instrument
})
```

Result:

```ts
{
  quantity,
  notional,

  priceRisk,
  estimatedFees,
  estimatedSlippage,
  totalRisk
}
```

---

# 104. Profit Solver API

```ts
calculateProfitPosition({
  side,
  entry,
  target,
  desiredProfit,
  feeModel,
  instrument
})
```

---

# 105. Constraint Solver API

Future-friendly:

```ts
solvePosition({
  known: {
    entry,
    stop,
    target,
    risk,
    profit,
    margin,
    leverage
  }
})
```

returns:

```text
solved values
unsatisfied constraints
conflicts
warnings
```

---

# 106. Risk Engine Invariants

Must always hold:

```text
quantity >= 0

notional >= 0

risk >= 0

rounded quantity
<=
unrounded safe quantity

risk after rounding
<=
risk budget
```

For auto leverage:

```text
selected leverage
<=
user max leverage

selected leverage
<=
exchange max leverage
```

---

# 107. Execution Engine Invariants

```text
Σ child quantities
<= target quantity

filled + remaining
≈ target quantity

reduce-only orders
<= open position

strategy may never exceed risk-approved quantity
```

---

# 108. Security Requirements

Critical requirements:

```text
No withdrawal capability required

Secrets encrypted at rest

Secrets unavailable to frontend

Sensitive values redacted from logs

Per-user authorization

Execution endpoints require authenticated user

Account ownership checked server-side

Rate limiting

CSRF protection where relevant

Idempotent order submission

Audit logging

Secret rotation

Kill switch
```

---

# 109. Logging

Allowed:

```text
exchange
account ID
execution ID
symbol
order ID
status
latency
error code
```

Forbidden:

```text
API secret
full API key
signed payload
authentication headers
```

API keys shown only partially:

```text
abc...xyz
```

---

# 110. Audit Log

Record:

```text
credential connected
credential tested
credential revoked

execution created
execution started
execution paused
execution resumed
execution cancelled

order submitted
order cancelled

risk override
emergency stop
```

---

# 111. Observability

Metrics:

```text
execution success rate
order rejection rate
fill rate
average execution latency
average slippage
strategy completion rate
exchange API latency
exchange errors
rate limit events
reconciliation mismatch
risk stop events
```

---

# 112. Strategy Metrics

For TWAP/Adaptive TWAP:

```text
arrival price
average execution price
VWAP benchmark
slippage bps
completion %
elapsed %
maker %
taker %
fees
```

---

# 113. Failure Scenarios

System must handle:

```text
exchange downtime
REST timeout
WebSocket disconnect
worker crash
database restart
Valkey restart
API credential revoked
insufficient margin
order rejection
partial fill
price gap
SL trigger during entry
user manual intervention
symbol halted
rate limit
duplicate event
delayed event
```

---

# 114. Worker Crash Recovery

After restart:

```text
load RUNNING executions
 ↓
acquire execution lock
 ↓
fetch exchange orders
 ↓
fetch exchange positions
 ↓
reconcile fills
 ↓
recalculate risk
 ↓
resume safe strategies
```

Never blindly continue from stale local state.

---

# 115. SL Trigger During Entry

Important scenario.

Example:

```text
TWAP still 40% complete
market hits Stop Loss
```

Behavior:

```text
stop remaining entry
cancel entry child orders
execute protective close if required
cancel incompatible TP
mark execution stopped
```

No additional entry may occur after invalidation.

---

# 116. Gap Risk

Risk budget is not a guaranteed maximum loss during:

```text
market gaps
exchange outages
extreme slippage
liquidation
network failure
```

UI should describe calculated risk as:

```text
Estimated risk to configured stop
```

not guaranteed maximum possible loss.

---

# 117. Risk Override

Advanced users may override warning.

Example:

```text
Projected risk:
$52

Budget:
$50
```

Default:

```text
BLOCK
```

Optional future:

```text
Allow override
```

Override requires explicit action and audit log.

MVP can simply block.

---

# 118. Paper / Simulation Mode

Highly recommended before live launch.

Execution modes:

```text
PREVIEW
PAPER
LIVE
```

Paper mode uses realtime market data but does not place external orders.

Useful for:

```text
strategy testing
risk validation
UI validation
execution debugging
```

---

# 119. User Risk Profile

Example:

```json
{
  "defaultRiskMode": "risk_percent",
  "defaultRisk": 1,

  "maxRiskPerTradePct": 2,
  "maxOpenRiskPct": 5,

  "maxLeverage": 10,

  "defaultMarginMode": "isolated",

  "defaultExecutionUrgency": "balanced"
}
```

---

# 120. Notifications

Events suitable for notification:

```text
execution started
execution completed
execution paused
execution failed

SL triggered
TP filled

risk limit reached
credential invalid
exchange disconnected
```

Channels can integrate with existing FUDCourt notification infrastructure later.

---

# 121. MVP Scope

## Exchange

```text
Binance
Bybit
MEXC
```

## Markets

```text
Spot
Linear / USDT perpetual
```

## Sizing

```text
Risk USD
Risk %
Allocation USD
Allocation %
Fixed quantity
Notional
Target Profit USD
```

## Futures

```text
Manual leverage
Auto Safe leverage
Isolated margin
Cross margin where supported
```

## Execution

```text
Market
Limit
TWAP
Adaptive TWAP
Iceberg
Chase Limit
Scale In
Scale Out
```

## Protection

```text
SL
TP
multiple TP
synthetic OCO
dynamic risk reconciliation
```

---

# 122. MVP Exclusions

Not required for first release:

```text
inverse perpetual
coin-margined futures
options
margin spot
portfolio margin
VWAP
POV
market making
cross-exchange smart order routing
automated signals
AI trade selection
copy trading
```

---

# 123. Development Phases

## Phase 0 — Foundation

Deliver:

```text
normalized types
decimal arithmetic
instrument metadata
exchange adapter interface
risk engine
unit tests
```

No live trading yet.

---

## Phase 1 — Preview Engine

Implement:

```text
risk USD
risk %
position sizing
target profit sizing
margin
manual leverage
fee estimates
risk preview
```

Output only.

No external order placement.

---

## Phase 2 — Binance Live Adapter

Implement:

```text
account connection
balances
markets
ticker
orderbook
positions
place order
cancel order
fills
WebSocket updates
```

Market + Limit only.

---

## Phase 3 — Execution Runtime

Implement:

```text
execution worker
state machine
locks
scheduler
recovery
reconciliation
events
```

---

## Phase 4 — TWAP

Implement:

```text
TWAP
randomization
risk reconciliation
partial fill handling
pause/resume/cancel
```

---

## Phase 5 — Bybit + MEXC

Add adapters using common interfaces.

No risk/execution engine rewrite should be necessary.

---

## Phase 6 — Advanced Execution

Implement:

```text
Adaptive TWAP
Iceberg
Chase Limit
Scale In
Scale Out
```

---

## Phase 7 — Auto Leverage

Add:

```text
exchange leverage tiers
liquidation calculation
auto safe selection
margin optimization
```

---

## Phase 8 — Portfolio Risk

Add:

```text
max risk/trade
open risk
daily loss guard
total exposure
account risk profiles
```

---

# 124. Testing Strategy

Risk engine needs exhaustive unit testing.

Test:

```text
LONG
SHORT

risk USD
risk %

different stop distances

fees
slippage

rounding

minimum notional

tiny quantities

large quantities

invalid SL

target profit

margin

leverage constraints
```

---

# 125. Property-Based Tests

Useful invariants:

```text
increasing risk budget
must never reduce safe quantity

moving SL closer
must never reduce theoretical quantity

moving SL further away
must never increase safe quantity

safe rounded quantity
must never exceed risk budget
```

---

# 126. Exchange Adapter Tests

Each adapter should pass common compliance suite.

Example:

```text
AdapterContractTest
```

validates:

```text
normalize symbol
fetch ticker
fetch balance
place order
cancel order
parse fills
map errors
respect precision
```

---

# 127. Paper Mode Acceptance Criteria

Paper execution must:

```text
create execution
calculate sizing
schedule child orders
simulate fills
recalculate average entry
update risk
complete TWAP
cancel safely
recover after worker restart
```

---

# 128. MVP Acceptance Criteria

MVP dianggap usable ketika:

1. User dapat menghubungkan API key Binance, Bybit, dan MEXC tanpa withdrawal permission.

2. User dapat melihat Spot dan Futures balances.

3. User dapat memilih Spot atau linear perpetual.

4. User dapat memilih Risk USD.

5. User dapat memilih Risk % terhadap futures/spot equity.

6. Executor dapat menghitung safe position quantity.

7. Executor dapat menghitung estimated fees dan slippage allowance.

8. Executor dapat preview expected loss pada SL.

9. Futures dapat menggunakan manual leverage.

10. Futures dapat menggunakan Auto Safe leverage.

11. User dapat menjalankan Market execution.

12. User dapat menjalankan Limit execution.

13. User dapat menjalankan TWAP.

14. TWAP dapat bertahan setelah browser ditutup.

15. Partial fills tidak menyebabkan over-order.

16. Dynamic risk reconciliation bekerja setelah setiap fill.

17. Executor menghentikan tambahan exposure jika risk budget akan terlewati.

18. Stop-loss dapat melindungi active position.

19. User dapat pause execution.

20. User dapat cancel execution.

21. Worker restart dapat reconcile execution tanpa duplicate order.

22. User dapat melihat complete execution history.

23. Tidak ada plaintext API secret di database, frontend, maupun log.

---

# 129. Performance Requirements

Initial targets:

```text
Risk calculation
< 10 ms local compute

Preview API
< 500 ms excluding slow exchange response

Internal execution decision
< 100 ms

Realtime fill processing
< 500 ms target after event receipt
```

CEX Executor tidak ditargetkan sebagai HFT engine.

Correctness dan safety lebih penting daripada microsecond latency.

---

# 130. Scalability

Architecture should eventually support:

```text
10k+ users
multiple accounts/user
thousands of concurrent executions
multiple workers
horizontal scaling
```

Execution ownership is distributed using locks.

Strategies must avoid relying on process memory as authoritative state.

---

# 131. Future Opportunities

Once core execution is stable:

```text
cross-exchange executor

smart venue selection

best execution routing

VWAP / POV

portfolio hedging

automatic rebalancing

funding-aware execution

basis trading executor

arbitrage execution

API / SDK

Discord execution interface

Telegram execution interface

TradingView webhook execution

n8n integration

AI execution assistant
```

AI may translate natural language intent:

```text
"Long BTC, risk 0.5%, stop 2% below,
entry via TWAP over 20 minutes."
```

into an `ExecutionRequest`.

Risk engine remains deterministic.

---

# 132. Product Moat

The valuable layer is not exchange connectivity itself.

Exchange connectivity is commodity infrastructure.

Potential moat:

```text
unified risk model

constraint-based position sizing

dynamic risk reconciliation

exchange-independent execution algorithms

execution quality analytics

portfolio-wide risk controls

reliable multi-exchange abstraction

execution history and observability
```

---

# 133. Final Product Definition

FUDCourt CEX Executor allows a trader to say:

> I want to risk this much.

or:

> I want to make this much if my target is reached.

and separately:

> Execute this position using this method.

The platform determines:

```text
position size
quantity
notional
margin
leverage
liquidation safety
fees
risk
child orders
execution timing
```

while funds remain inside the user's own exchange account.

The core invariant of the product is:

> **Execution strategy may optimize execution, but it may never silently violate the user's configured risk constraints.**
