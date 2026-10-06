package coinank

import (
	"fmt"
	"strings"
)

// Modes is the CoinAnk mode table in declaration order. The array ships verbatim
// in the 400 unknown-mode body, so the order is part of the contract.
//
// Every mode here is a KEYLESS surface: the same bytes the coinank.com dashboard
// renders, fetched with a client-computed signature and no issued key. The
// documented open-api.coinank.com host is deliberately NOT wired — it needs a
// human-issued apikey, so it is a different product with different coverage, not
// an alternative transport for these modes.
//
// Each mode was probed live and kept only if it returned real, non-empty data.
// The five that survived:
//
//	fundingRate  /api/fundingRate/current     882 symbols x per-exchange maps
//	liquidation  /api/liquidation/allExchange  per-exchange liquidation turnover
//	longShort    /api/longshort/all            long/short ratios across exchanges
//	etf          /api/etf/etfInflow            daily spot-ETF creations/redemptions
//	whales       /api/hyper/topPosition        Hyperliquid top positions by size
var Modes = []string{"fundingRate", "liquidation", "longShort", "etf", "whales"}

// ModeCount is the number of modes (healthz prints it).
var ModeCount = len(Modes)

var known = func() map[string]bool {
	m := make(map[string]bool, len(Modes))
	for _, s := range Modes {
		m[s] = true
	}
	return m
}()

// Known reports whether mode is in the table.
func Known(mode string) bool { return known[mode] }

// Param names.
const (
	ParamMode     = "mode"
	ParamInterval = "interval"
	ParamFresh    = "fresh"
)

// Intervals is the set of `interval` values mode=liquidation accepts, in the
// order the 400 body lists them.
//
// This list is an ALLOWLIST because CoinAnk does not reject a bad interval — it
// ANSWERS one. Measured against /api/liquidation/allExchange:
//
//	1h  2152 B  totalTurnover=13445415.70746236
//	2h  2170 B  totalTurnover=42391373.87610192
//	4h  2172 B  totalTurnover=49901139.80508106
//	6h  2205 B  totalTurnover=84090740.22172257
//	12h 2229 B  totalTurnover=228610815.61932257
//	1d  2236 B  totalTurnover=323287725.1442189
//	8h / 24h / 7d / 30d / 1H / "bogus"   1636 B  totalTurnover=0
//
// The last row is the hazard: an unsupported interval returns HTTP 200, the same
// 10-exchange row set, and `totalTurnover: 0` on every row. Nothing in the
// response distinguishes "no liquidations" from "I did not understand you", so a
// pass-through endpoint would render a confident table of zeros. Anything
// outside this list is therefore a local 400 and never reaches upstream.
var Intervals = []string{"1h", "2h", "4h", "6h", "12h", "1d"}

var intervalOK = func() map[string]bool {
	m := make(map[string]bool, len(Intervals))
	for _, s := range Intervals {
		m[s] = true
	}
	return m
}()

// ValidInterval reports whether iv is an accepted liquidation interval.
func ValidInterval(iv string) bool { return intervalOK[iv] }

// DefaultInterval is what the dashboard's own default resolves to. Measured: an
// omitted interval and interval=1h return byte-identical bodies, so 1h IS the
// upstream default. The fetcher still sends it explicitly — sending nothing and
// relying on an undocumented upstream default is a behaviour nobody can see in
// the request, and upstream is free to change it silently.
const DefaultInterval = "1h"

// UpstreamURL is the canonical upstream URL of a mode. `interval` is only read by
// mode=liquidation.
//
// Every path here was probed live before it was wired. Those that answered with
// `success:false / "system error!"` (a missing required param we do not have) or
// HTTP 404 were dropped rather than shipped — see
// docs/architecture/coinank-data-types.md for the probe matrix.
func UpstreamURL(mode, interval string) string {
	switch mode {
	case "liquidation":
		if interval == "" {
			interval = DefaultInterval
		}
		return Base + "/api/liquidation/allExchange?interval=" + interval
	case "longShort":
		return Base + "/api/longshort/all"
	case "etf":
		return Base + "/api/etf/etfInflow"
	case "whales":
		return Base + "/api/hyper/topPosition"
	case "fundingRate":
		fallthrough
	default:
		return Base + "/api/fundingRate/current"
	}
}

// accepts is the param scoping matrix: which query params a mode accepts.
// `fresh` is accepted everywhere (it is request policy, not mode data).
var accepts = map[string]map[string]bool{
	"fundingRate": {ParamMode: true, ParamFresh: true},
	"liquidation": {ParamMode: true, ParamInterval: true, ParamFresh: true},
	"longShort":   {ParamMode: true, ParamFresh: true},
	"etf":         {ParamMode: true, ParamFresh: true},
	"whales":      {ParamMode: true, ParamFresh: true},
}

// Accepts reports whether mode accepts the query param p. An unknown param (or a
// known param sent to the wrong mode) is a 400 unexpected-param, never silently
// ignored.
//
// Two params were deliberately NOT given an accept row after measuring that
// upstream ignores them, because exposing a no-op param is a lie about what the
// request does:
//
//	symbol / baseCoin on fundingRate/current -> byte-identical 1,851,245 B body,
//	  still 882 rows. It does not filter. (The mode returns the whole table.)
//	pageNum / pageSize on hyper/topPosition -> identical body hash for
//	  pageNum=1&pageSize=5 and pageNum=2&pageSize=5. The 50 rows returned are
//	  whatever upstream decides, and the pagination object it ships
//	  ({current:1,total:1484,pageSize:50}) is not driven by our request.
func Accepts(mode, p string) bool { return accepts[mode][p] }

// Error strings that are part of the wire contract (tests assert them verbatim).
const (
	ErrUnknownMode  = "unknown mode"
	ErrInvalidParam = "invalid param"
	ErrUnexpected   = "unexpected param"
	// ErrUpstream is returned when CoinAnk answers with its own refusal envelope
	// (success:false). It is 502, not 200-with-nothing: the caller gets
	// upstream's message, and no table is invented.
	ErrUpstream = "upstream refused"
)

// DetailIntervalInvalid is a var, not a const: it interpolates the allowlist so
// the 400 body names the accepted values instead of making the caller guess.
var DetailIntervalInvalid = "interval must be one of " + strings.Join(Intervals, ", ") +
	" (CoinAnk answers an unsupported interval with an all-zero table, so it is rejected locally, never sent)"

// UnexpectedParamDetail is the detail for a param a mode does not accept.
func UnexpectedParamDetail(param, mode string) string {
	return fmt.Sprintf("%s is not valid for mode=%s", param, mode)
}
