// Package coinmetrics is the CoinMetrics Community provider adapter: keyless
// Bitcoin market data (price, market cap). Only metrics the community tier
// serves without a key are fetched — the catalog's "community": true flag is
// the gate. Realized-cap family metrics (CapRealUSD, NUPL) are NOT in the
// community tier (they answer HTTP 403 keylessly), so they are deliberately
// absent; the valuation charts that need them are a later phase.
//
// Wire shape: GET /v4/timeseries/asset-metrics answers {"data":[{"asset",
// "time", "<Metric>":"<decimal string>"}], "next_page_url":...}. Values are
// STRINGS; a non-numeric value is rejected, never zeroed.
package coinmetrics
