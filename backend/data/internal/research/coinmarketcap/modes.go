package coinmarketcap

import (
	"fmt"
	"strconv"
	"strings"
)

// Modes is the CoinMarketCap mode table in declaration order. The array ships
// verbatim in the 400 unknown-mode body, so the order is part of the contract.
//
// Every mode here is a KEYLESS surface: the same bytes the coinmarketcap.com
// dashboard renders, fetched with no credential at all. The documented
// pro-api.coinmarketcap.com host is deliberately NOT wired — it needs a
// human-issued `X-CMC_PRO_API_KEY`, so it is a different product with different
// coverage and rate limits, not an alternative transport for these modes.
//
// Each mode was probed live and kept only if it returned real, non-empty data.
// The four that survived:
//
//	listing      /cryptocurrency/listing            ranked coin list, paginated
//	global       /global-metrics/quotes/latest      market-wide dominance/supply
//	marketPairs  /cryptocurrency/market-pairs/latest per-exchange pairs for one coin
//	exchanges    /exchange/listing                  ranked exchange list, paginated
var Modes = []string{"listing", "global", "marketPairs", "exchanges"}

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
	ParamMode  = "mode"
	ParamStart = "start"
	ParamLimit = "limit"
	ParamSlug  = "slug"
	ParamFresh = "fresh"
)

// Pagination bounds. These are LOCAL, not upstream's, and they are local for a
// measured reason — the same class of reason the coinank `interval` allowlist
// exists for. CoinMarketCap does not reject a bad `limit`; it ANSWERS one:
//
//	limit=0      -> HTTP 200, {"data":{"cryptoCurrencyList":[],"totalCount":"8138"}},
//	                status.error_code="0"  (a SUCCESS carrying an EMPTY list)
//	limit=abc    -> HTTP 200, status.error_code="500" "The system is busy, ..."
//	limit=-1     -> HTTP 200, status.error_code="500" "The system is busy, ..."
//	limit=99999  -> HTTP 200, 9,643,042 bytes
//
// The first row is the hazard: `limit=0` is indistinguishable from "this market
// has no coins" unless the caller is told. A pass-through endpoint would render
// it as a confident empty board. Anything outside [MinLimit, MaxLimit] is
// therefore a local 400 and never reaches upstream, and `start` is bounded the
// same way so an absurd page number is refused rather than silently answered
// with an empty list.
const (
	// DefaultLimit is what the dashboard's own list view requests. Measured:
	// limit=100 returns 145,315 bytes — the page size the site itself renders.
	DefaultLimit = 100
	// MaxLimit bounds one page at 1,000 rows (~1.33 MB measured). The fetcher's
	// body cap would bound a pathological frame anyway; this bound is about
	// refusing an unbounded request at the door, not about memory.
	MaxLimit = 1000
	// MinLimit is the smallest meaningful page. limit=0 is the empty-list trap.
	MinLimit = 1

	// DefaultStart is page 1.
	DefaultStart = 1
	// MaxStart bounds `start` so an out-of-range page is refused locally rather
	// than answered with an empty list that looks like a real page.
	MaxStart = 100000
)

// UpstreamURL is the canonical upstream URL of a mode. `slug` is only read by
// mode=marketPairs; `start`/`limit` by the paginated modes.
//
// Every path here was probed live before it was wired. Those that answered
// HTTP 404 or the `status.error_code != "0"` refusal envelope were dropped
// rather than shipped — see docs/architecture/coinmarketcap-data-types.md for
// the probe matrix.
func UpstreamURL(mode, slug string, start, limit int) string {
	switch mode {
	case "global":
		return Base + "/global-metrics/quotes/latest"
	case "marketPairs":
		return Base + "/cryptocurrency/market-pairs/latest?slug=" + slug +
			"&start=" + strconv.Itoa(start) + "&limit=" + strconv.Itoa(limit)
	case "exchanges":
		return Base + "/exchange/listing?start=" + strconv.Itoa(start) +
			"&limit=" + strconv.Itoa(limit)
	case "listing":
		fallthrough
	default:
		return Base + "/cryptocurrency/listing?start=" + strconv.Itoa(start) +
			"&limit=" + strconv.Itoa(limit)
	}
}

// arrayPath is the JSON pointer (dotted) to the row array inside `data` for a
// mode, or "" when the payload is an object. It drives the row count that
// becomes `upstreamCount` — a count is reported only when upstream published an
// array, never invented for an object.
func arrayPath(mode string) string {
	switch mode {
	case "listing":
		return "cryptoCurrencyList"
	case "exchanges":
		return "exchanges"
	case "marketPairs":
		return "marketPairs"
	default: // global
		return ""
	}
}

// ArrayPath is the exported accessor (the verifier reads the same path the
// adapter does, so the two cannot disagree about where the rows live).
func ArrayPath(mode string) string { return arrayPath(mode) }

// accepts is the param scoping matrix: which query params a mode accepts.
// `fresh` is accepted everywhere (it is request policy, not mode data).
//
// `start`/`limit` are accepted only by the paginated modes; `slug` only by
// marketPairs. An unknown param — or a known param sent to the wrong mode — is
// a 400 unexpected-param, never silently ignored. This matters more here than
// for coinank: CoinMarketCap IGNORES an unrecognised query param outright
// (measured: `?bogus=1` returns the ordinary listing), so a pass-through that
// accepted anything would report success for a request it did not honour.
var accepts = map[string]map[string]bool{
	"listing":     {ParamMode: true, ParamStart: true, ParamLimit: true, ParamFresh: true},
	"global":      {ParamMode: true, ParamFresh: true},
	"marketPairs": {ParamMode: true, ParamSlug: true, ParamStart: true, ParamLimit: true, ParamFresh: true},
	"exchanges":   {ParamMode: true, ParamStart: true, ParamLimit: true, ParamFresh: true},
}

// Accepts reports whether mode accepts the query param p.
func Accepts(mode, p string) bool { return accepts[mode][p] }

// Error strings that are part of the wire contract (tests assert them verbatim).
const (
	ErrUnknownMode  = "unknown mode"
	ErrInvalidParam = "invalid param"
	ErrUnexpected   = "unexpected param"
	// ErrUpstream is returned when CoinMarketCap answers with its own refusal
	// envelope (status.error_code != "0"). It is 502, not 200-with-nothing: the
	// caller gets upstream's message, and no table is invented.
	ErrUpstream = "upstream refused"
)

// DetailLimitInvalid is a var, not a const: it interpolates the bounds so the
// 400 body names the accepted range instead of making the caller guess.
var DetailLimitInvalid = fmt.Sprintf(
	"limit must be an integer in [%d,%d] (CoinMarketCap answers limit=0 with a "+
		"success envelope carrying an empty list, so it is rejected locally, never sent)",
	MinLimit, MaxLimit)

// DetailStartInvalid is the matching detail for `start`.
var DetailStartInvalid = fmt.Sprintf(
	"start must be an integer in [%d,%d]", DefaultStart, MaxStart)

// UnexpectedParamDetail is the detail for a param a mode does not accept.
func UnexpectedParamDetail(param, mode string) string {
	return fmt.Sprintf("%s is not valid for mode=%s", param, mode)
}

// MissingSlugDetail is the detail for marketPairs without a slug. Upstream
// would answer this with error_code "400" and a raw validation string; refusing
// locally names the fix instead.
const MissingSlugDetail = "slug is required for mode=marketPairs"

// ValidSlug reports whether s is a plausible CMC coin slug. CMC slugs are
// lowercase alphanumerics and hyphens (e.g. "bitcoin", "coinmarketcap-20-index").
// The check is intentionally permissive: its job is to refuse obvious junk
// (spaces, path characters, an empty string) before it becomes part of a URL,
// not to be an authority on which slugs exist. A slug that passes but is
// unknown upstream surfaces as a 502 carrying upstream's own message.
func ValidSlug(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '-':
		default:
			return false
		}
	}
	return true
}

// ParseStart validates and defaults `start`.
func ParseStart(raw string) (int, bool) {
	if strings.TrimSpace(raw) == "" {
		return DefaultStart, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < DefaultStart || n > MaxStart {
		return 0, false
	}
	return n, true
}

// ParseLimit validates and defaults `limit`.
func ParseLimit(raw string) (int, bool) {
	if strings.TrimSpace(raw) == "" {
		return DefaultLimit, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < MinLimit || n > MaxLimit {
		return 0, false
	}
	return n, true
}
