// Package bybit is the Bybit provider adapter: canonical ingest jobs for
// spot/perp OHLCV klines, funding rate, open interest and 24h tickers, and
// the upserts the first rows of each fetch imply (venue, instruments,
// provider symbols).
//
// Endpoints (public, keyless, v5):
//
//	klines   GET https://api.bybit.com/v5/market/kline?category=spot|linear
//	funding  GET https://api.bybit.com/v5/market/funding/history
//	oi       GET https://api.bybit.com/v5/market/open-interest?intervalTime=5min
//	tickers  GET https://api.bybit.com/v5/market/tickers
//	listing  GET https://api.bybit.com/v5/market/instruments-info
//	         (a list row with no symbol or undecodable pair is counted
//	         rejected, never fatal)
//
// Wire shapes are envelope objects {"retCode":0,"result":{"list":[...]}} with
// string numbers and millisecond-epoch STRINGS throughout the result payloads.
// Every fetch is ONE attempt: the engine owns retries; a transport/shape
// failure here is a typed HardError and nothing is written.
package bybit
