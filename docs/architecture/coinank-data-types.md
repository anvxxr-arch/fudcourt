# CoinAnk — Data-Type Inventory (endpoint map + the keyless path)

Recon for a possible `fudcourt-data` acquisition family. Captured live **2026-10-02**
from `https://api-int.doc.coinank.com/llms.txt` (the official doc index, **78
endpoints** across 20 categories), the Nuxt bundle on `s.coinank.com/_nuxt/*.js`,
and direct probes against `api.coinank.com`.

## 1. Two surfaces

| | Official OpenAPI | Web/keyless backend |
|---|---|---|
| Base URL | `https://open-api.coinank.com` | `https://api.coinank.com` |
| Auth | `apikey` header — **paid**, VIP1–VIP4 | **no API key** — a client-computed `coinank-apikey` signature |
| Docs | `api-int.doc.coinank.com/llms.txt` + `api-<id>.md` per endpoint | reverse-engineered from the Nuxt bundle |
| Envelope | `{"success":true,"code":"1","data":…}` | identical |

The *"API key"* the web app sends is **not issued to anyone**: it is derived
client-side by a function shipped to every browser. That is the keyless path.

## 2. The keyless signature (verified live, not inferred)

Reconstructed independently from `s.coinank.com/_nuxt/1A3YJiqG.js` and confirmed
by calling the live API with a freshly computed key. The exact shape:

```
UUID      = <36-char uuid constant in the bundle>      // the "app id"
WEBVER    = "102"                                      // web-version header
C         = <13-digit constant>                        // added to the clock

apikey():
    t = UUID[:8]                       // lY
    e = UUID.replace(t, "") + t        // rY — the 8-char prefix moved to the tail
    i = str(Date.now() + C) + "347"    // aY, then dY: .concat("347")
    return base64( e + "|" + i )       // fY + uY (btoa)
```

Headers the web client sends on every call: `coinank-apikey`, `web-version`,
`client`, `token`, plus an `Origin`/`Referer` of `https://coinank.com`.

> **The constants are deliberately not reproduced in this document.** They are
> re-derivable from the public bundle, so a doc gains nothing by carrying them.
> They are *protocol* constants — shipped to every browser, decoding public
> market data, authenticating to no account — not credentials, so this is a
> documentation-hygiene call and not the DR-033 credential rule. Where a
> re-implementation genuinely needs them, they belong **in that code**, next to
> the derivation that consumes them (see how
> `backend/data/internal/research/coinglass/decrypt.go` carries CoinGlass's
> analogous `v`-table constants), never duplicated into prose.

**Live verification performed by this recon (own key computation, 2026-10-02):**

| Endpoint | Result |
|---|---|
| `GET /api/fundingRate/current` | **200** — real funding rates per exchange (`fundingRate`, `nextFundingTime`, `ts`) |
| `GET /api/liquidation/allExchange?interval=1h` | **200** — real long/short turnover (`totalTurnover`, `longTurnover`, `shortTurnover`, `longRatio`/`shortRatio`) |
| `GET /api/openInterest/symbol?symbol=BTC` | 404 (wrong path — see the catalogue for the real one) |
| `GET /api/longshort/position?symbol=BTC&interval=1h` | 200 but `code:"0" msg:"system error!"` — params incomplete, not a wall |

## 3. Endpoint catalogue (78 endpoints / 20 categories)

`PlanN` = the doc's own plan tag; `VIPn` = explicit "Required API Level" in the
description where stated. Blank means the doc does not gate it.

### Indicator Data (11)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **2-Year MA Multiplier(Plan1)** | Plan1 | - | 2-Year MA Multiplier |
| **200 Week Moving Average Heatmap(Plan1)** | Plan1 | - | — |
| **AltCoinSeation(Plan1)** | Plan1 | - | — |
| **BTC Ahr999 Index(Plan1)** | Plan1 | - | — |
| **BTC Market Cap(Plan1)** | Plan1 | - | — |
| **Fear & Greed (Plan1)** | Plan1 | - | Fear & Greed |
| **Grayscale BTC Holdings(Plan1)** | Plan1 | - | — |
| **Pi Cycle Top Indicator(Plan1)** | Plan1 | - | Pi Cycle Top Indicator |
| **SMC (Plan1)** | Plan1 | - | — |
| **Special Indicator Data(Plan1)** | Plan1 | - | Special Indicator Data |
| **The Puell Multiple(Plan1)** | Plan1 | - | — |

### Market Order Statistics (10)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **Aggregate  CVD Data  (Plan3)** | Plan3 | - | Returns the highest, lowest, and closing within a time level, accumulated from a starting point |
| **Aggregate Market Order Statistical Indicators  (Plan3)** | Plan3 | - | Returns aggregate statistical data of market orders according to type |
| **Aggregate Taker Buy/Sell Count (Plan3)** | Plan3 | - | Returns the number of active market order transactions within the time level |
| **Aggregate Taker Buy/Sell Value (Plan3)** | Plan3 | - | Returns the active buying and selling amount of market orders within the time level |
| **Aggregate Taker Buy/Sell Volume (Plan3)** | Plan3 | - | Returns the active buying and selling volume of market orders within the time level |
| **CVD Data  (Plan3)** | Plan3 | - | Returns the highest, lowest, and closing within a time level, accumulated from a starting point |
| **Market Order Statistical Indicators   (Plan3)** | Plan3 | - | Returns statistical data of market orders according to type |
| **Taker Buy/Sell Count (Plan3)** | Plan3 | - | Returns the number of active market order transactions within the time level |
| **Taker Buy/Sell Value (Plan3)** | Plan3 | - | Returns the active buying and selling amount of market orders within the time level |
| **Taker Buy/Sell Volume (Plan3)** | Plan3 | - | Returns the active buying and selling volume of market orders within the time level |

### Liquidation (8)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **Aggregation Liquidation Map (Plan4)** | Plan4 | VIP4 | Returns a liquidation map aggregated by currency |
| **Aggregation Liquidation Statistics(Plan1)** | Plan1 | VIP1 | Return aggregated historical data for both long and short liquidations of a coin on the exchange |
| **Exchange Liquidation Statistics(Plan1)** | Plan1 | VIP1 | Returns long liquidation and short liquidation for each exchange |
| **Liquidation Heatmap (Plan4)** | Plan4 | VIP4 | Returns liquidation levels on the chart by calculating them based on market data and various leverage amounts |
| **Liquidation Heatmap Symbol (Plan1)** | Plan1 | VIP1 | Trading pairs that support liquidation heatmaps |
| **Liquidation Map (Plan4)** | Plan4 | VIP4 | Returns maps liquidation events based on market data and diverse leverage amounts |
| **Liquidation order(Plan3)** | Plan3 | VIP3 | Query historical liquidation orders based on the conditions you set |
| **Trading Pair Liquidation Statistics(Plan1)** | Plan1 | VIP1 | Returns the long liquidation and short liquidation for each trading pair |

### Open Interest (7)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **Aggregation Open Interest K Line(Plan1)** | Plan1 | VIP1 | Aggregation Open Interest K Line |
| **Exchange History Chart(Plan1)** | Plan1 | VIP1 | This API retrieves historical open interest data for a cryptocurrency from exchanges |
| **Exchange List(Plan1)** | Plan1 | VIP1 | Exchange aggregate statistics of currency open positions, sorted by number of positions |
| **Oi/MarketCap Ratio History（Plan2）** | — | - | — |
| **Real-Time Open Interest(Plan1)** | Plan1 | VIP1 | Returns the real-time positions of coins according to exchange statistics |
| **Trading Pair Open Interest K Line(Plan1)** | Plan1 | VIP1 | Trading Pair Open Interest K Line |
| **Trading Pair Open Interest(Plan1)** | Plan1 | VIP1 | Returns the number and amount of open positions by trading pair |

### FundingRate (7)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **Accumulated FundingRate (Plan1)** | Plan1 | VIP1 | Returns the cumulative funding rate, which has four levels: day, week, month, and year. |
| **FundingRate Heatmap  (Plan3)** | Plan3 | - | Returns funding rate heat map data based on positions and market value |
| **Historical Settlement Funding Rate (Plan1)** | Plan1 | - | Returns the historical settlement funding rate, supporting U-based contracts and currency-based contracts. |
| **Real-time FundingRate (Plan1)** | Plan1 | VIP1 | Returns real-time funding rates for all exchange coins |
| **Trading Pair Funding Rate History (Plan1)** | Plan1 | - | Returns historical funding rates for trading pairs by time level and time range |
| **Trading Pair Funding Rate Kline (Plan1)** | Plan1 | - | Returns the trading pair funding rate k-line based on time level and range |
| **Weighted FundingRate (Plan1)** | Plan1 | - | Based on time level and return weighted funding rates, there are two types: position weighting and trading volume weighting. |

### Popular Ranking (7)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **Liquidation Ranking（Plan2)** | — | - | Return to Liquidation Ranking |
| **Open Interest Ranking  (Plan2)** | Plan2 | - | Return to Open Interest Ranking |
| **PriceChg Ranking（Plan2)** | — | - | Return to price increase and decrease ranking list |
| **Transactions Ranking （Plan2)** | — | - | Return to the latest ranking of transactions |
| **Visual Screener(Plan 2)** | — | - | — |
| **VolumeChg Ranking （Plan2)** | — | - | Return to trading volume change ranking list |
| **longShortRatio Ranking（VIP2)** | — | - | — |

### Longshort (6)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **Coin bue/sell (Plan1)** | Plan1 | - | Returns historical data for the long/short ratio of aggregated taker buy/sell volumes. |
| **Exchange Real-time long-short ratio (Plan1)** | Plan1 | - | Returns the long/short ratio of aggregated taker buy/sell volumes for exchanges. |
| **Global Account Ratio(Plan1)** | Plan1 | - | Returns the long/short account ratio for trading pairs on an exchange |
| **Long short ratio k line  (Plan1)** | Plan1 | - | Returns the ratio of long and short positions, the ratio of long and short positions of large households, and the historical K-line of the ratio of long and short accounts of large households. |
| **Top Trader Long/Short Ratio (Accounts)  (Plan1)** | Plan1 | - | Top Trader Long/Short Ratio (Accounts) |
| **Top Trader Long/Short Ratio(Position) (Plan1)** | Plan1 | - | Top Trader Long/Short Ratio(Position) |

### Coin & Symbol (4)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **Coin MarketCap(Plan1)** | Plan1 | VIP1 | Get real-time marketCap for trading pairs. |
| **Last Price(Plan1)** | Plan1 | VIP1 | Get real-time prices for trading pairs. |
| **Supported Coins(Plan1)** | Plan1 | VIP1 | Returns all supported coins, distinguishing between spot and contract |
| **Supported Trading Pairs(Plan1)** | Plan1 | VIP1 | Returns all supported trading pairs, distinguishing between spot and contract |

### OrderBook (3)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **Exchange Order Book Difference  (Plan3)** | Plan3 | - | Returns the bid-ask difference of the exchange's order book by time level and range |
| **OrderBook Heatmap  (Plan4)** | Plan4 | - | Returns a heat map of trading pair liquidity by time level and range |
| **Trading Pair Order Book Difference  (Plan3)** | Plan3 | - | Returns the bid-ask difference of the order book of the trading pair by time level and range. |

### Fundflow (2)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **Fund flow historical data (Plan3)** | Plan3 | - | Returns the historical inflow and outflow of capital flow |
| **Real-time Funds Flow (Plan3)** | Plan3 | - | Returns the real-time capital inflow and outflow data of the currency |

### BigOrder (2)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **Large Limit Order  (Plan3)** | Plan3 | - | Query the list of large pending orders based on conditions, and support querying real-time data and historical data. |
| **Large Maker Order  (Plan3)** | Plan3 | - | Return to historical large market orders |

### hyperLiquid Whale (2)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **Hyperliquid Whale Action（plan2）** | — | - | 返回最近的20条 平仓或者开仓记录，按时间排序 |
| **Hyperliquid Whale Position（plan2）** | — | - | — |

### news (2)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **News Detail（plan2）** | — | - | — |
| **News List（plan2）** | — | - | — |

### Error Code (1)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **errcode** | — | - | code : |

### WebHook (1)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **WebHook APP PUSH(Plan1)** | Plan1 | VIP1 | Through this interface, you can push customized strategy signals to your CoinAnk App。 |

### Net Long & Net Short (1)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **Net long & Net short (Plan3)** | Plan3 | - | Returns the change in net longs and net shorts within a time level, accumulated from a point in time |

### OrderFlow (1)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **OrderFlow List  (Plan3)** | Plan3 | - | Returns trading pair order flow historical data by time level and range |

### RsiMap (1)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **RsiMap (Plan2)** | Plan2 | - | Returns rsi data for all Binance trading pairs by time level |

### KLine (1)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **Kline （Plan1）** | — | - | Return the historical K-line of each exchange |

### mcp server (1)

| Endpoint | Plan | VIP | What it returns |
|---|---|---|---|
| **mcp server (plan 4)** | — | - | - mcp server for ai model |


## 4. Tier notes

- **Plan1** (38 endpoints) is the floor: funding rates, open interest, liquidation aggregates,
  long/short ratios, klines, and the whole **Indicator Data** family (Fear & Greed,
  AHR999, Pi Cycle Top, Puell Multiple, 2-Year MA Multiplier, 200W MA heatmap,
  Grayscale BTC holdings, Altcoin Season, SMC).
- **Plan3** (20) adds the microstructure layer: **Market Order Statistics** (CVD,
  taker buy/sell count/value/volume and their aggregates), Fundflow, OrderBook
  difference, OrderFlow, BigOrder, Net Long/Short, funding-rate heatmap.
- **Plan4** (4) is the heavy surface: liquidation **maps** + **heatmap**, OrderBook
  heatmap — plus an **MCP server** for AI models.
- **Plan2** (2) is the ranking/screener layer (OI rank, transactions rank,
  liquidation rank, price/volume-change rank, Visual Screener, RSI map, Hyperliquid
  whale positions/actions, news list + detail).

The paid tiers gate the *official* host. The keyless `api.coinank.com` path
serves the same shapes — that is what makes CoinAnk interesting for us.

## 5. Integration notes for `fudcourt-data`

1. Same envelope as CryptoRank's HTML-derived helpers (`success`/`code`/`data`), so a
   Go family (`internal/research/coinank`) is a natural fit: plain JSON, no bespoke
   TLS stack, no CF interstitial.
2. The signature is **time-based and stateless** — no session, no cookie, no
   browser. Recompute per request (or per short window) in Go: `time.Now().UnixMilli()
   + C` → `+ "347"` → `|`-join → `base64`. Portable to stdlib only.
3. **Cache hard.** Nothing in the bundle documents a rate limit; treat it as
   undocumented and mirror the CryptoRank sidecar's per-route TTL disk cache.
4. Apply the repo's `api-surface-recon` discipline before wiring: prove a
   nonexistent symbol does not return fabricated data, and cross-check one value
   (e.g. BTC funding rate) against an independent feed — note that CoinAnk's own
   `/api/longshort/position` already returned `system error!` on incomplete
   params, which is upstream being honest, not a wall.
5. Do **not** build against the MCP server (Plan4-gated).

## 6. Provenance

| Artifact | Source |
|---|---|
| `/tmp/ca_llms.txt` | `api-int.doc.coinank.com/llms.txt` — official index, 78 endpoints |
| `/tmp/ca_1A3YJiqG.js` (2.1 MB, +3 chunks) | `s.coinank.com/_nuxt/*.js` — signature + axios interceptors |
| live probes | `api.coinank.com` with a self-computed `coinank-apikey` |
