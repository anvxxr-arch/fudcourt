package coinglass

import (
	"fmt"
	"regexp"
)

// Modes is the coinglass mode table in declaration order. The array ships
// verbatim in the 400 unknown-mode body, so the order is part of the contract.
//
// Every mode here is a KEYLESS surface: the same bytes the www.coinglass.com
// dashboard renders, fetched without a CG-API-KEY and decrypted with the scheme
// in decrypt.go. The official open-api-v4 host is deliberately NOT wired — it
// needs a human-issued key, so it is a different product with different
// coverage, not an alternative transport for these modes.
var Modes = []string{"statistics", "openInterest", "fundingRate", "markets"}

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
	ParamMode   = "mode"
	ParamSymbol = "symbol"
	ParamFresh  = "fresh"
)

// SymbolRe bounds a symbol. CoinGlass symbols are upper-case tickers (BTC, ETH,
// 1000PEPE, SHIB1000); the regex is deliberately wide on length and narrow on
// alphabet so a hostile value cannot reach upstream as a query-string fragment.
var SymbolRe = regexp.MustCompile(`^[A-Z0-9]{1,20}$`)

// ValidSymbol reports whether s is an acceptable symbol.
func ValidSymbol(s string) bool { return SymbolRe.MatchString(s) }

// SymbolURL is the canonical upstream for one symbol's open interest.
func SymbolURL(symbol string) string {
	return CapiBase + "/api/openInterest/info?symbol=" + symbol
}

// UpstreamURL is the canonical upstream URL of a mode. `symbol` is only read by
// mode=openInterest.
//
// Every path here was probed live before it was wired, and two did NOT survive
// that probe: `/api/fundingRate/current` and `/api/fundingRate/list` (the latter
// needs pageNum+pageSize). `/api/fundingRate/current` answers a real HTTP 404 --
// it is the COINANK spelling, not CoinGlass's -- and shipping it would have
// produced a mode that always 502s. `/api/fundingRate/rank` is CoinGlass's own
// no-param funding surface: the 50 most extreme negative and positive rates.
func UpstreamURL(mode, symbol string) string {
	switch mode {
	case "openInterest":
		return SymbolURL(symbol)
	case "fundingRate":
		return CapiBase + "/api/fundingRate/rank"
	case "markets":
		return CapiBase + "/api/futures/v2/coins/markets"
	default:
		return CapiBase + "/api/futures/home/statistics"
	}
}

// accepts is the param scoping matrix: which query params a mode accepts.
// `fresh` is accepted everywhere (it is request policy, not mode data).
var accepts = map[string]map[string]bool{
	"statistics":   {ParamMode: true, ParamFresh: true},
	"openInterest": {ParamMode: true, ParamSymbol: true, ParamFresh: true},
	"fundingRate":  {ParamMode: true, ParamFresh: true},
	"markets":      {ParamMode: true, ParamFresh: true},
}

// Accepts reports whether mode accepts the query param p. An unknown param (or a
// known param sent to the wrong mode) is a 400 unexpected-param, never silently
// ignored.
func Accepts(mode, p string) bool { return accepts[mode][p] }

// Error strings that are part of the wire contract (tests assert them verbatim).
const (
	ErrUnknownMode  = "unknown mode"
	ErrInvalidParam = "invalid param"
	ErrMissingParam = "missing param"
	ErrUnexpected   = "unexpected param"
	// ErrUpstream is returned when CoinGlass answers with its own refusal
	// envelope (success:false). It is 502, not 200-with-nothing: the caller
	// gets upstream's message, and no table is invented.
	ErrUpstream = "upstream refused"

	DetailSymbolRequired = "symbol is required for mode=openInterest (no default exists)"
	DetailSymbolInvalid  = "symbol must match ^[A-Z0-9]{1,20}$ (never clamped)"
)

// UnexpectedParamDetail is the detail for a param a mode does not accept.
func UnexpectedParamDetail(param, mode string) string {
	return fmt.Sprintf("%s is not valid for mode=%s", param, mode)
}
