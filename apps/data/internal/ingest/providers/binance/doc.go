// Package binance is the Binance provider adapter: canonical ingest jobs for
// spot/perp OHLCV klines, funding rate, open interest and 24h tickers, and the
// upserts the first rows of each fetch imply (venue, instruments, provider
// symbols, assets for quoted units).
//
// Endpoints (public, keyless):
//
//	spot klines   GET https://api.binance.com/api/v3/klines
//	perp klines   GET https://fapi.binance.com/fapi/v1/klines
//	funding       GET https://fapi.binance.com/fapi/v1/fundingRate
//	oi            GET https://fapi.binance.com/fapi/v1/openInterest
//	oi history    GET https://fapi.binance.com/futures/data/openInterestHist
//	tickers       GET https://api.binance.com/api/v3/ticker/24hr
//
// Wire shapes are array-of-arrays of strings (klines), arrays of objects with
// string numbers (funding/oi), and objects (ticker). Every fetch is ONE
// attempt: the engine owns retries; a transport/shape failure here is a typed
// HardError and nothing is written.
//
// TLS posture: the client is httpx.NewClient — the SAME shared transport the
// research families use (TLS >= 1.2, HTTP/2, ProxyFromEnvironment). The
// live "x509: certificate is valid for intern..." failure measured in the
// field is upstream interception that serves a certificate for a hostname
// api.binance.com does not match; verification stays ON (the repo ships no
// InsecureSkipVerify anywhere), so such a body fails as a transport HardError
// and the engine's breaker owns it — it is never worked around in client code.
package binance
