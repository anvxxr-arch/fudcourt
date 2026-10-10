// Package coingecko is the CoinGecko provider adapter: canonical ingest jobs
// for the asset universe (markets pages), crypto market series (per-asset
// price / market cap / 24h volume observations), and global crypto aggregates.
//
// Endpoints (public, keyless, demo tier):
//
//	markets      GET https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=N
//	global       GET https://api.coingecko.com/api/v3/global
//	marketChart  GET https://api.coingecko.com/api/v3/coins/{id}/market_chart?vs_currency=usd&days=90
//
// Wire shapes are plain JSON (no error envelope): a top-level array of coin
// rows, {"data":{...}} for global, {"prices":[[ms,value],...],...} for
// market_chart. Non-2xx is a HardError; error bodies are HTML on rate limits.
// Every fetch is ONE attempt: the engine owns retries; a transport/shape
// failure here is a typed HardError and nothing is written.
package coingecko
