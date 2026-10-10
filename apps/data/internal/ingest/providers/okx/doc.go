// Package okx is the OKX provider adapter: canonical ingest jobs for
// spot/perp candlesticks, funding rate, open interest and 24h tickers, and
// the upserts the first rows of each fetch imply (venue, instruments,
// provider symbols).
//
// Endpoints (public, keyless):
//
//	candles  GET https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1m
//	funding  GET https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT
//	oi       GET https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP
//	tickers  GET https://www.okx.com/api/v5/market/tickers?instType=SPOT
//	listing  GET https://www.okx.com/api/v5/public/instruments?instType=SPOT
//	         (SPOT rows pair via baseCcy/quoteCcy; SWAP rows split the instId,
//	         BTC-USDT-SWAP -> BTC/USDT with settleCcy USDT)
//
// Wire shapes are envelope objects {"code":"0","data":[...]} whose payloads
// are arrays of objects with STRING numbers and ms-string timestamps — the
// candles payload is an array of arrays of strings, newest row first. Every
// fetch is ONE attempt: the engine owns retries; a transport/shape failure
// here is a typed HardError and nothing is written.
package okx
