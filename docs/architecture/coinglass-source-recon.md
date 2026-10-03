# CoinGlass — Data-Type Recon (for the `fudcourt-data` sidecar)

Recon of **coinglass.com** done 2026-10-02. Two distinct surfaces, measured live:

1. **Official REST API V4** — `open-api-v4.coinglass.com`, **requires `CG-API-KEY`**, plain JSON.
2. **Internal site API** — `capi.coinglass.com` / `fapi.coinglass.com`, **no key**, responses
   **AES-128-ECB + gzip encrypted** (key delivered in response headers). This is the
   keyless path the sidecar can use.

Category map comes from the official docs repo
(`github.com/coinglass-official/coinglass-api-docs`, walked locally). Endpoint paths and
example fields are quoted verbatim from that repo's `rest/**/*.md`. Internal-host catalog
comes from `github.com/ArchdevilForge/coinglass-decrypt` (webpack-recovered) and was
**re-verified live** during this recon (decryption succeeded — see §5).

---

## 1. Official REST API V4 (`open-api-v4.coinglass.com`)

- **Base**: `https://open-api-v4.coinglass.com` — append the path from the tables below.
- **Auth**: header `CG-API-KEY: <key>`. Missing/invalid → `401`.
- **Response envelope**: `{"code":"0","msg":"success","data": <…>}` (string `"0"` = OK;
  error codes mirror HTTP: `400/401/404/405/408/422/429/500`).
- **Key gating (live)**: a keyless GET returns **HTTP 200** with
  `{"code":"401","msg":"API key missing."}` — the host is *not* bot-walled, it just wants a key.
- **Rate-limit headers**: `API-KEY-MAX-LIMIT` (per-minute cap), `API-KEY-USE-LIMIT` (current use).
- **Plans** (per-endpoint availability): Hobbyist / Startup / Standard / Professional /
  Enterprise. Many endpoints gate *interval granularity* by tier (e.g. OI history:
  `>=4h` on Hobbyist, `>=30m` on Startup, no limit on Standard+). Check each doc page's
  "Available on the following API plans" table before promising a tier.
- **Key issuance**: `https://www.coinglass.com/account` (dashboard) — human login step.

### 1.1 Category → endpoint catalogue (official V4)

**Futures — Trading Market**
`/api/futures/supported-coins`, `/api/futures/supported-exchanges`,
`/api/futures/supported-exchange-pairs`, `/api/futures/coins-markets`,
`/api/futures/pairs-markets`, `/api/futures/coins-price-change`,
`/api/futures/price/history`, `/api/futures/delisted-exchange-pairs`,
`/api/futures/exchange-list` (Exchange Rank)

**Futures — Open Interest**
`/api/futures/open-interest/history`,
`/api/futures/open-interest/aggregated-history`,
`/api/futures/open-interest/aggregated-stablecoin-history`,
`/api/futures/open-interest/aggregated-coin-margin-history`,
`/api/futures/open-interest/exchange-list`,
`/api/futures/open-interest/exchange-history-chart`

**Futures — Funding Rate**
`/api/futures/funding-rate/history`, `/api/futures/funding-rate/oi-weight-history`,
`/api/futures/funding-rate/vol-weight-history`, `/api/futures/funding-rate/exchange-list`,
`/api/futures/funding-rate/accumulated-exchange-list`, `/api/futures/funding-rate/arbitrage`

**Futures — Long-Short Ratio**
`/api/futures/global-long-short-account-ratio/history`,
`/api/futures/top-long-short-account-ratio/history`,
`/api/futures/top-long-short-position-ratio/history`,
`/api/futures/taker-buy-sell-volume/exchange-list`, `/api/futures/v2/net-position/history`,
`/api/futures/net-position/history`

**Futures — Liquidation**
`/api/futures/liquidation/history`, `/api/futures/liquidation/aggregated-history`,
`/api/futures/liquidation/coin-list`, `/api/futures/liquidation/exchange-list`,
`/api/futures/liquidation/order`, `/api/futures/liquidation/heatmap/model1|model2|model3`,
`/api/futures/liquidation/aggregated-heatmap/model1|model2|model3`,
`/api/futures/liquidation/map`, `/api/futures/liquidation/aggregated-map`,
`/api/futures/liquidation/max-pain`

**Futures — Order Book**
`/api/futures/orderbook/ask-bids-history`, `/api/futures/orderbook/aggregated-ask-bids-history`,
`/api/futures/orderbook/history` (heatmap), `/api/futures/orderbook/large-limit-order`,
`/api/futures/orderbook/large-limit-order-history`

**Futures — Hyperliquid Positions**
`/api/hyperliquid/whale-alert`, `/api/hyperliquid/whale-position`, `/api/hyperliquid/position`,
`/api/hyperliquid/user-position`, `/api/hyperliquid/wallet/position-distribution`,
`/api/hyperliquid/wallet/pnl-distribution`

**Futures — Taker Buy/Sell**
`/api/futures/taker-buy-sell-volume/history`, `/api/futures/v2/taker-buy-sell-volume/history`,
`/api/futures/volume/footprint-history`, `/api/futures/cvd/history`,
`/api/futures/aggregated-cvd/history`

**Spots — Trading Market**
`/api/spot/supported-coins`, `/api/spot/supported-exchange-pairs`, `/api/spot/coins-markets`,
`/api/spot/pairs-markets`, `/api/spot/price/history`

**Spots — Order Book**
`/api/spot/orderbook/ask-bids-history`, `/api/spot/orderbook/aggregated-ask-bids-history`,
`/api/spot/orderbook/history`, `/api/spot/orderbook/large-limit-order`,
`/api/spot/orderbook/large-limit-order-history`

**Spots — Taker Buy/Sell**
`/api/spot/taker-buy-sell-volume/history`, `/api/spot/volume/footprint-history`,
`/api/spot/cvd/history`, `/api/spot/aggregated-cvd/history`

**Options**
`/api/option/max-pain`, `/api/option/info`, `/api/option/exchange-oi-history`,
`/api/option/exchange-vol-history`

**On-Chain — Exchange data**
`/api/exchange/assets`, `/api/exchange/balance/list`, `/api/exchange/balance/chart`

**On-Chain — Transactions**
`/api/exchange/chain/tx/list`, `/api/chain/v2/whale-transfer`

**On-Chain — Token**
`/api/coin/unlock-list`, `/api/coin/vesting`

**ETF — Bitcoin**
`/api/etf/bitcoin/list`, `/api/hk-etf/bitcoin/flow-history`,
`/api/etf/bitcoin/net-assets/history`, `/api/etf/bitcoin/flow-history`,
`/api/etf/bitcoin/premium-discount/history`, `/api/etf/bitcoin/history`,
`/api/etf/bitcoin/price/history`, `/api/etf/bitcoin/detail`

**ETF — Ethereum / Solana / XRP / Grayscale**
`/api/etf/ethereum/{list,net-assets/history,flow-history}`,
`/api/etf/solana/flow-history`, `/api/etf/xrp/flow-history`,
`/api/grayscale/holdings-list`, `/api/grayscale/premium-history`

**Indic — Futures**
`/api/futures/rsi/list`, `/api/futures/indicators/{rsi,ma,ema,boll,macd}`,
`/api/futures/basis/history`, `/api/futures/whale-index/history`,
`/api/futures/cgdi-index/history`, `/api/futures/cdri-index/history`

**Indic — Spots**
`/api/coinbase-premium-index`, `/api/bitfinex-margin-long-short`,
`/api/borrow-interest-rate/history`

**Indic — Other** (~30 endpoints under `/api/index/`)
`/api/index/ahr999`, `/api/index/bull-market-peak-indicator`, `/api/index/puell-multiple`,
`/api/index/stock-flow`, `/api/index/pi-cycle-indicator`, `/api/index/golden-ratio-multiplier`,
`/api/index/bitcoin/profitable-days`, `/api/index/bitcoin/rainbow-chart`,
`/api/index/fear-greed-history`, `/api/index/stableCoin-marketCap-history`,
`/api/index/bitcoin/bubble-index`, `/api/index/2-year-ma-multiplier`,
`/api/index/200-week-moving-average-heatmap`, `/api/index/altcoin-season`,
`/api/index/bitcoin-sth-sopr|bitcoin-lth-sopr`, `/api/index/bitcoin-sth-realized-price|bitcoin-lth-realized-price`,
`/api/index/bitcoin-short-term-holder-supply|bitcoin-long-term-holder-supply`,
`/api/index/bitcoin-rhodl-ratio`, `/api/index/bitcoin-reserve-risk`,
`/api/index/bitcoin-active-addresses`, `/api/index/bitcoin-new-addresses`,
`/api/index/bitcoin-net-unrealized-profit-loss`, `/api/index/bitcoin-correlation`,
`/api/index/bitcoin-macro-oscillator`, `/api/index/option-vs-futures-oi-ratio`,
`/api/index/bitcoin-vs-global-m2-growth`, `/api/index/bitcoin-vs-us-m2-growth`,
`/api/index/bitcoin-dominance`, `/api/exchange_assets_transparency/list`,
`/api/futures_spot_volume_ratio`

**Other**
`/api/calendar/economic-data` (Financial Calendar), `/api/article/list` (News)

**WebSocket**: documented in the repo's `web-socket-api.md` (real-time streams; same host family).

### 1.2 Example fields (verbatim from docs)

| Category | Example field shape |
|---|---|
| OI history `/api/futures/open-interest/history` | `{time, open, high, low, close}` (strings) |
| Funding exchange list | `{symbol, stablecoin_margin_list:[{exchange, funding_rate_interval, funding_rate, next_funding_time}], token_margin_list:[…]}` |
| Global L/S ratio | `{time, global_account_long_percent, global_account_short_percent, global_account_long_short_ratio}` |
| Liquidation pair history | `{time, long_liquidation_usd, short_liquidation_usd}` |
| ETF flows history (BTC) | `{timestamp, flow_usd, price_usd, etf_flows:[{etf_ticker, flow_usd}]}` |
| Options max pain | `{date, call_open_interest, put_open_interest, call_open_interest_market_value, put_open_interest_market_value, max_pain_price, call_open_interest_notional, put_open_interest_notional}` |
| RSI list | `{symbol, rsi_15m, price_change_percent_15m, rsi_1h, rsi_4h, rsi_12h, rsi_24h, rsi_1w, current_price}` |
| Exchange assets | `{wallet_address, balance, balance_usd, symbol, assets_name, price}` |
| Token unlock list | `{symbol, name, price, market_cap, total_supply, circulating_supply, fully_diluted_valuation, total_locked, total_unlocked, next_unlock_date, next_unlock_tokens, next_unlock_of_circulating, next_unlock_of_supply}` |
| News `/api/article/list` | `{article_picture, article_title, article_content, source_name, source_website_logo, article_release_time, article_description}` |
| Economic data | `{calendar_name, country_code, country_name, data_effect, forecast_value, previous_value, revised_previous_value, published_value, publish_timestamp, importance_level(1-3), has_exact_publish_time}` |

---

## 2. Internal site API (`capi.coinglass.com`, `fapi.coinglass.com`) — keyless

The site frontend calls these; **no API key** is needed, but the JSON body is encrypted.

- **Hosts**: `capi.coinglass.com` (main), `fapi.coinglass.com` (treasury/kline/coin-community).
- **Required request headers**: `encryption: true`, `language: en`,
  `cache-ts-v2: <epoch_ms>`, `Origin: https://www.coinglass.com`,
  `Referer: https://www.coinglass.com/`, a browser `User-Agent`.
- **Response envelope**: `{"code":"0","msg":"success","data":"<base64 ciphertext>"}` plus
  response headers `v`, `user`, `ev`, `encryption: true`.

### 2.1 Internal endpoint catalog (highlights; ~136 live encrypted + 16 plain)

| Group | Endpoints |
|---|---|
| Spot | `/api/spot/rsi/list?pageSize&pageNum`, `/api/spot/coin/markets`, `/api/spot/coin/info`, `/api/spot/coin/outIn`, `/api/spot/pricePerformance`, `/api/spot/marketCap/data`, `/api/spot/support/coin` |
| Futures | `/api/futures/home/statistics`, `/api/futures/liquidation/chart`, `/api/futures/liquidation/today`, `/api/futures/liquidation/maxOrder`, `/api/futures/longShortRate`, `/api/futures/bigOrder`, `/api/futures/data/distribution`, `/api/futures/v2/coins/markets`, `/api/futures/vol/chart`, `/api/futures/select/coins/tickers` |
| Funding Rate | `/api/fundingRate/list`, `/api/fundingRate/rank`, `/api/fundingRate/avg`, `/api/fundingRate/flow`, `/api/fundingRate/coin/detail`, `/api/fundingRate/arbitrage-list` |
| Open Interest | `/api/openInterest/statistics`, `/api/openInterest/info`, `/api/openInterest/oiVolRadio` |
| Options | `/api/option/statistics`, `/api/option/top/oi`, `/api/option/top/vol`, `/api/option/strike_pain`, `/api/option/netPremiumStrikeHeatmap` |
| ETF | `/api/etf/overview`, `/api/etf/flow`, `/api/etf/bito`, `/api/etf/history/chart` |
| Indices | `/api/index/cgdi`, `/api/index/cgri`, `/api/index/pi`, `/api/index/rsiMap`, `/api/index/v2/ahr999`, `/api/index/puellMultiple`, `/api/escape/index/{altCoinSeason,bitcoinDominance,nupl,rhodlRatio,mayerMultiple,…}` (12) |
| Hyperliquid | `/api/hyperliquid/vaults`, `/api/hyperliquid/topPosition`, `/api/hyperliquid/address/symbol/group`, `/api/hyperliquid/position/user/count` |
| Grayscale | `/api/grayscaleOpenInterest`, `/api/grayscale/shareholders`, `/api/grayscale/eft/gbtc/history` |
| Macro | `/api/economic/calendar/{data,event,activities}` |
| Market/TradFi/Stock | `/api/marketHistory`, `/api/bitcoinTreasuries`, `/api/bull_market_peak_indicator`, `/api/tradfi/overview`, `/api/stock/list` |
| Coins/Tickers | `/api/coin/search`, `/api/coin/liquidation`, `/api/coin/unlock/list`, `/api/select/coins/tickers` |
| Home | `/api/home/v2/coinMarkets`, `/api/home/card{2,4}` |

- **57 endpoints** exist but return empty `success` (need a session or extra params).
- **~80 legacy `/api/block/*`, `/api/block/mining/*`, `/api/block/defi/*`, `/api/overview/*`
  are DEAD (404)** — CoinGlass removed on-chain/mining/defi routes. Do not wire them.
- **Special (non-encrypted)**: `capi.coinglass.com/liquidity-heatmap/api/liquidity/v3/heatmap`
  and `.../v4/heatmap` (v4 needs an auth token in the POST body).
- **Plain-JSON**: `/api/support/symbol` (v2 variant is encrypted).

---

## 3. Anti-bot / protection (measured live 2026-10-02)

| Host | Layer | Measured |
|---|---|---|
| `www.coinglass.com` | Next.js + nginx behind **AWS CloudFront** | HTTP/2 200, `x-nextjs-cache`, `server: nginx`, `via: …cloudfront.net`. **No Cloudflare, no Turnstile, no `cf-mitigated` header** from this IP. CSP `frame-ancestors 'self'`; `x-frame-options: SAMEORIGIN`. |
| `open-api-v4.coinglass.com` | CloudFront + API-key gate | HTTP 200 body `{"code":"401","msg":"API key missing."}` without key. No bot wall. |
| `capi.coinglass.com` | nginx + **AES payload encryption** | HTTP 200; `access-control-allow-origin: *`; headers `v`, `user`, `ev`, `encryption: true`. `server: nginx`, `x-cache: Miss from cloudfront`. |
| `fapi.coinglass.com` | same encryption scheme | treasury/kline/coin-community routes. |

**The real "anti-bot" is the response encryption, not a WAF/CAPTCHA.** There is no
Cloudflare/Turnstile to solve on the data hosts. Gating is: (a) `CG-API-KEY` on the
official host, (b) the `user`/`v` header key-delivery + AES decryption on the internal host.

### 3.1 Decryption scheme (keyless)

Two-round `AES-128-ECB` + gzip. `Key0` is derived from the `v` response header and
**rotates**; the actual body key is recovered from the `user` header:

```
Key0 = base64(by_v(v))[:16]
  v=0 → request header cache-ts-v2      v=1 → url_path
  v=2 → response header time            v=55/66/77 → legacy constants
plain_key = gunzip( AES-128-ECB-decrypt(user_token, Key0) )   # 16-char hex
json      = gunzip( AES-128-ECB-decrypt(ciphertext, plain_key) )
```

Legacy constants (webpack module 12471): `v55=170b070da9654622`,
`v66=d6537d845a964081`, `v77=863f08689c97435b`.

> **Correction to the decrypt repo's README**: it claims "all endpoints use `v=1`
> (universal since 2025)". Live checks today returned **`v=66`, `v=55`, `v=55`** on three
> different endpoints — `v` still rotates across `{0,1,2,55,66,77}`. Any Go re-implementation
> must implement the **full** `v` table, not assume `v=1`.

---

## 4. Rate limits

- Official V4: per-plan, surfaced via `API-KEY-MAX-LIMIT` / `API-KEY-USE-LIMIT`; `429` on exceed.
- Internal capi/fapi: no documented limit; treat as undocumented — cache + sequential warm
  (mirror the CryptoRank sidecar's per-route TTL disk cache).

---

## 5. Live verification performed (this recon)

Installed `pycryptodome` in a scratch venv and ran the decrypt repo against the live hosts:

| Endpoint | Header `v` | Result |
|---|---|---|
| `GET capi/api/futures/home/statistics` | **66** | ✅ decrypted: `{volH24Chain, shortRate, oiH24Chain, openInterest:152457063529, longRate, lqH24Chain, liquidationH24VolUsd, liquidationH24Num, volUsd}` |
| `GET capi/api/openInterest/info?symbol=BTC` | **55** | ✅ decrypted: list `[{symbol:'BTC', openInterest, openInterestAmountByCoinMargin, openInterestAmountByStableCoinMargin, h1VolChangePercent, h4OIChangePe…}]` |
| `GET capi/api/fundingRate/list?pageSize=2` | **55** | ✅ decrypted: list `[{symbol:'BTC', name:'Bitcoin', logo, stableCoin:[{exName:'Binance', exchangeLogo, …}]}]` |
| `GET open-api-v4/api/futures/supported-coins` (no key) | — | `{"code":"401","msg":"API key missing."}` |

Egress IP: `200` reachability confirmed (all hosts reachable from this box).

---

## 6. Integration notes for `fudcourt-data`

1. **Prefer the keyless `capi`/`fapi` path** for volume — it needs no key and no browser;
   only AES-ECB decryption (portable to Go stdlib `crypto/aes` + `compress/gzip`).
2. Implement the **full `v` table {0,1,2,55,66,77}**; re-read `v` per response (it rotates
   per endpoint / daily).
3. Send browser-like headers (`encryption`, `language`, `cache-ts-v2`, `Origin`, `Referer`, UA).
4. **Do not wire** the ~80 dead `/api/block/*` and `/api/overview/*` routes (404).
5. The official V4 host is the **cleaner, documented** option (real fields, plan tiers) but
   needs a human-issued `CG-API-KEY`; the dashboard is behind a login. Treat key issuance as
   a human step, not an automation target.
6. Re-run the decoy/parity gates (per the repo's `api-surface-recon` discipline) before
   shipping any `capi` mode: verify a nonexistent symbol does not return fabricated data and
   cross-check one value against an independent feed.

## 7. Go implementation (SHIPPED in `backend/data/internal/research/coinglass`)

The keyless `capi` path is wired into the sidecar as the sixth research family:
`/api/coinglass?mode=<statistics|openInterest|fundingRate|markets>`, all four
modes keyless, unit `fudcourt-data` on `:3101`.

| File | Role |
|---|---|
| `decrypt.go` | Key0 derivation, AES-128-ECB (two layers), PKCS#7, gzip, envelope |
| `fetch.go` | plain `net/http` + per-URL disk cache under `~/.cache/fudcourt-data/coinglass` |
| `modes.go` | 4-mode table, param scoping matrix, symbol validation |
| `shape.go` | `CgEnvelope` (provenance-first), `Service` |
| `decrypt_test.go` | every `v` branch pinned against recorded fixtures |
| `live_test.go` | `COINGLASS_LIVE=1` live probes (never cached) |

**The cache stores the RAW encrypted body plus the `v`/`user` headers, not the
decrypted JSON.** A cache that stored plaintext would make a rotated `v` or a
broken key derivation invisible on every warm read — the family would fail only
on a cold start, in production. With the raw body cached, a warm hit re-runs the
full two-layer decryption, so a `v`-table bug fails identically warm and cold.

### 7.1 Two endpoints that did NOT survive the probe

Both were in the §2.1 catalogue and neither is wired, because the live probe
that every shaper here requires says so:

| Candidate | Live result | Disposition |
|---|---|---|
| `/api/fundingRate/current` | **HTTP 404** (`{"status":404,"path":"/api/fundingRate/current"}`) | not CoinGlass's spelling — that is **CoinAnk's** endpoint (`coinank-data-types.md`); dropped |
| `/api/fundingRate/list` | 200, but `success:false` `code:"40001"` "Required Integer parameter `pageNum` is not present" | real, but param-gated; `/api/fundingRate/rank` is the no-param equivalent, so it is what ships |

`/api/fundingRate/rank` returns `{min:[50], max:[50]}` — the 50 most extreme
negative and positive funding rates — which is the useful form of the same data
without inventing a pagination contract we do not control.

### 7.2 `v` rotation, confirmed in one shot

Four concurrent requests to the shipped route returned **`v=66`, `v=77`,
`v=55`, `v=66`** — all three legacy constants live, within a single second, on
four different modes. This is the strongest available refutation of the public
tool's "v=1 is universal since 2025" claim, and it is why `X-CG-Cipher` is a
response header: an unfamiliar value there is a rotated slot announcing itself
before it becomes a padding error.

### 7.3 What is deliberately NOT wired

- The official `open-api-v4` host (§1) — needs a human-issued `CG-API-KEY`.
  Different product, different coverage; not an alternative transport.
- `/api/support/symbol` and the `liquidity-heatmap` routes — plain / special
  bodies, no decryptor needed; add them only when a consumer exists.
- The ~80 dead `/api/block/*` and `/api/overview/*` routes (404).
- The 57 catalogue endpoints that answer an empty `success` without a session.

---

## 8. Sources

- Official docs repo: `github.com/coinglass-official/coinglass-api-docs` (walked locally, 2026-10-02).
  Docs site: `https://docs.coinglass.com/reference/endpoint-overview`.
- Internal catalog + decryption: `github.com/ArchdevilForge/coinglass-decrypt`.
- Live probes: `capi.coinglass.com`, `open-api-v4.coinglass.com`, `www.coinglass.com` (2026-10-02).
