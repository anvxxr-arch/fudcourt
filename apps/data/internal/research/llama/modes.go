// Package llama is the DeFiLlama (api.llama.fi) read family: the mode table, the
// plain net/http fetcher with a per-process TTL cache + single-flight, and the
// JSON envelope. It is the Go side of apps/web/app/api/llama/route.ts, which is
// now a verbatim proxy to it -- exactly as DR-005 did for cryptorank and DR-006
// for khala.
//
// # Why ONE package and four files
//
// Same argument as internal/research/khala's: the family has ONE artifact (a TS route +
// its lib/llama.ts type surface), so modes/fetch/shape are a reading aid, not a
// compatibility boundary. There is no second implementation to stay compatible
// with and no independent oracle to keep the pieces apart for.
//
// # Upstream facts (probed live; lib/llama.ts records the same numbers)
//
//	GET /v2/chains             -> list[467], UNSORTED by tvl, 64KB
//	GET /protocols             -> list[8411], tvl desc, 8.9MB
//	                              (1238 of them carry tvl=null, at the tail)
//	GET /v2/historicalChainTvl -> list[3290] {date,tvl}, OLDEST-first, 122KB
//	GET /protocol/{slug}       -> 29.7MB for ONE protocol -> deliberately not a
//	                              mode: it would ship 18x the 8.9MB body the
//	                              protocols mode already trims, for one row.
//	GET /v2/historicalChainTvl/{chain} -> per-chain history, OLDEST-first
//	GET /tvl/{protocol}        -> ONE NUMBER, the protocol's current TVL
//	GET /prices/current/{coins} (coins.llama.fi) -> {"coins":{...}} object
//	GET /stablecoins?includePrices=true (stablecoins.llama.fi)
//	                           -> {"peggedAssets":[...]}
//	GET /overview/dexs?...     -> {"protocols":[...],...}
//	GET /overview/fees?...     -> {"protocols":[...],...}
//	GET /pools (yields.llama.fi) -> {"data":[...]}
//
// # Honest-by-construction (house rule: the wire says what was done)
//
//   - `top` / `days` are OUR params, so they are validated strictly (integer in
//     range, else 400) and NEVER clamped. They never reach upstream.
//   - chains arrives unsorted and is re-sorted, protocols is one 8.9MB body
//     trimmed to a head, historical is a tail. None of the three bodies may
//     pretend to be upstream verbatim, so each carries `derived` naming the
//     transform and `upstreamTotal` naming the FULL upstream array length.
//   - a non-2xx / non-JSON / non-list upstream keeps its REAL status, never a
//     fake 200 and never a substituted payload.
//
// # Caching
//
// The TS route went through lib/rate-limit.ts (min-gap + 15s TTL +
// single-flight). This side owns that now: an in-memory per-process cache with
// per-mode TTLs (TTLFor -- the three original modes keep the 15s window,
// FUDCOURT_DATA_LLAMA_TTL overrides the fallback in main.go) plus
// single-flight per URL, keyed on the UPSTREAM URL, so `top=3` and `top=7`
// share one 8.9MB fetch. It is bounded by an LRU at maxEntries (100): the
// parameterized modes take one entry per distinct chain, protocol or coin-set,
// so a fixed three-key map can no longer hold the family (see fetch.go's
// evictIfFull and the Stats ceiling test).
package llama

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

const (
	// Base is the DeFiLlama API origin: public, keyless, GET-only. There is no
	// write endpoint to gate, which is why this family needs no disabled-mode
	// refusal -- cryptorank's data-integrity refusal has no analogue here.
	Base = "https://api.llama.fi"
	// CoinsBase is the DeFiLlama coins origin: the per-coin spot prices the
	// reconciler already reads for portfolio valuation.
	CoinsBase = "https://coins.llama.fi"
	// StableBase is the DeFiLlama stablecoins origin.
	StableBase = "https://stablecoins.llama.fi"
	// YieldsBase is the DeFiLlama yields origin.
	YieldsBase = "https://yields.llama.fi"
	// The three original upstream reads, verbatim from the TS route's upstreamPath.
	PathChains     = "/v2/chains"
	PathProtocols  = "/protocols"
	PathHistorical = "/v2/historicalChainTvl"
	// The four new fixed upstream reads.
	PathStablecoins = "/stablecoins?includePrices=true"
	PathDexs        = "/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true"
	PathFees        = "/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true"
	PathYields      = "/pools"
	// PrefixChainHistory prefixes the per-chain history read: the escaped
	// chain name is appended.
	PrefixChainHistory = "/v2/historicalChainTvl/"
	// PrefixTVL prefixes the per-protocol TVL read: the escaped slug is
	// appended.
	PrefixTVL = "/tvl/"
	// PrefixPrices prefixes the per-coin price read on the coins host: the
	// escaped comma-separated coin list is appended.
	PrefixPrices = "/prices/current/"
)

// Modes is the mode table in declaration order. The array ships verbatim in the
// 400 unknown-mode detail, so the order is part of the contract.
var Modes = []string{"chains", "protocols", "historical", "chainHistory", "tvl", "prices", "stablecoins", "dexs", "fees", "yields"}

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

// Path is the upstream path of a fixed mode. The parameterized modes
// (chainHistory, tvl, prices) have no single path -- callers build their URL
// with UpstreamURLFor -- and report "" here; callers refuse an unknown mode
// before consulting this.
func Path(mode string) string {
	switch mode {
	case "chains":
		return PathChains
	case "protocols":
		return PathProtocols
	case "stablecoins":
		return PathStablecoins
	case "dexs":
		return PathDexs
	case "fees":
		return PathFees
	case "yields":
		return PathYields
	case "historical":
		return PathHistorical
	case "chainHistory", "tvl", "prices":
		return ""
	}
	return PathHistorical
}

// UpstreamURL is the canonical upstream URL of a fixed mode: the envelope's
// `upstream` and the URL the cache is keyed on. Parameterized modes must use
// UpstreamURLFor.
func UpstreamURL(mode string) string {
	switch mode {
	case "stablecoins":
		return StableBase + PathStablecoins
	case "yields":
		return YieldsBase + PathYields
	}
	return Base + Path(mode)
}

// UpstreamURLFor builds the canonical upstream URL of a parameterized mode,
// escaping the caller-supplied segment. Callers validate the segment with the
// Parse* validator before calling: the escaping is defence in depth, not the
// validation.
func UpstreamURLFor(mode, chain, protocol, coins string) string {
	switch mode {
	case "chainHistory":
		return Base + PrefixChainHistory + url.PathEscape(chain)
	case "tvl":
		return Base + PrefixTVL + url.PathEscape(protocol)
	case "prices":
		return CoinsBase + PrefixPrices + url.PathEscape(coins)
	}
	return UpstreamURL(mode)
}

// Param names. `top` trims the list-shaped modes, `days` tails the
// history-shaped ones; `chain` / `protocol` / `coins` select the upstream
// document of the parameterized modes.
const (
	ParamMode     = "mode"
	ParamTop      = "top"
	ParamDays     = "days"
	ParamChain    = "chain"
	ParamProtocol = "protocol"
	ParamCoins    = "coins"
)

// ParamSpec names ONE of our integer params: its wire name, the value an absent
// param takes, and the inclusive maximum.
type ParamSpec struct {
	Name    string
	Default int
	Max     int
}

// TopParam bounds mode=protocols' head: default 50, max 200.
//
// The cap is not a payload guard (a head is at most 200 rows either way); it is
// the largest slice of the 8.9MB body a caller may ask to be serialised, and
// 200 is what the board's table wants. Never clamped: 201 is a 400.
var TopParam = ParamSpec{Name: ParamTop, Default: 50, Max: 200}

// DaysParam bounds mode=historical's tail: default 365, max 3288.
//
// 3288 was "everything upstream has" when the family landed (history starts in
// 2017). Measured 2026-09-29 the list is 3290 points, i.e. upstream has already
// grown past the cap, and the cap stays: it is a FROZEN 400 boundary whose
// exact message consumers read, while `upstreamTotal` -- the real length, 3290
// -- is what tells a caller how much history actually exists. days=99999 is a
// 400, never a silent 3288.
var DaysParam = ParamSpec{Name: ParamDays, Default: 365, Max: 3288}

// Per-mode cache TTLs in seconds.
//
// The three original modes keep the 15s window the TS limiter used (the board
// fires them on mount and on every poll), so they are NOT listed here: they
// fall back to the caller's default. Each TTL below is keyed to how fast its
// series actually moves: a per-chain history point is daily, a protocol TVL
// moves by the block, spot prices by the minute, and the stablecoin/dex/fee/
// yield tables are slow aggregates.
const (
	ttlChainHistory = 3600
	ttlTVL          = 300
	ttlPrices       = 60
	ttlStablecoins  = 300
	ttlDexs         = 300
	ttlFees         = 900
	ttlYields       = 300
)

// TTLFor returns the cache TTL in seconds for an upstream URL. The three
// original modes (and any unknown URL) fall back to the caller's default --
// deliberately the SHORTER value, so a harness or self-test URL can never
// inherit the 1-hour chainHistory TTL by accident.
func TTLFor(rawURL string, fallback int) int {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fallback
	}
	host, path := u.Hostname(), u.Path
	if host == "stablecoins.llama.fi" && path == "/stablecoins" {
		return ttlStablecoins
	}
	if host == "yields.llama.fi" && path == "/pools" {
		return ttlYields
	}
	if host == "coins.llama.fi" && strings.HasPrefix(path, PrefixPrices) && len(path) > len(PrefixPrices) {
		return ttlPrices
	}
	if host != "api.llama.fi" {
		return fallback
	}
	switch path {
	case "/overview/dexs":
		return ttlDexs
	case "/overview/fees":
		return ttlFees
	}
	if strings.HasPrefix(path, PrefixChainHistory) && len(path) > len(PrefixChainHistory) {
		return ttlChainHistory
	}
	if strings.HasPrefix(path, PrefixTVL) && len(path) > len(PrefixTVL) {
		return ttlTVL
	}
	return fallback
}

// ParamError is a bad value for one of our own params: a 400 whose message the
// TS route wrote verbatim (scripts/verify-llama.py asserts the fragments "must
// be an integer" and "must be between 1 and <max>").
type ParamError struct{ Message string }

func (e *ParamError) Error() string { return e.Message }

// ParseParam validates one of our params out of a query.
//
// Strict, and never clamped:
//
//	absent             -> spec.Default   (URLSearchParams.get() === null)
//	empty / non-digits -> "<name> must be an integer, got '<raw>'" -- so `?top=`
//	                      is a 400, not the default: get() returns "" and the
//	                      TS /^\d+$/ test fails on it too
//	out of 1..spec.Max -> "<name> must be between 1 and <max>, got <v>"
//
// A param appears at most once in practice; like get(), the FIRST value wins.
// A digit string past int64 range is still "between" (the value IS out of
// range) and is echoed as the raw digits rather than through a lossy float
// round-trip.
func ParseParam(q url.Values, spec ParamSpec) (int, error) {
	vals, present := q[spec.Name]
	if !present {
		return spec.Default, nil
	}
	raw := vals[0]
	digits := raw != ""
	for i := range raw {
		if !digits {
			break
		}
		if raw[i] < '0' || raw[i] > '9' {
			digits = false
		}
	}
	if !digits {
		return 0, &ParamError{fmt.Sprintf("%s must be an integer, got '%s'", spec.Name, raw)}
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < 1 || v > spec.Max {
		got := raw // out of int64 range: the digits are the honest value
		if err == nil {
			got = strconv.Itoa(v)
		}
		return 0, &ParamError{fmt.Sprintf("%s must be between 1 and %d, got %s", spec.Name, spec.Max, got)}
	}
	return v, nil
}

// ParseChain validates mode=chainHistory's `chain`: required, 1..50 chars of
// [A-Za-z0-9 _-]. Strict, like ParseParam: anything else is a 400 naming the
// rule, never a silent substitution.
func ParseChain(raw string) (string, error) {
	if !isChainStr(raw) {
		return "", &ParamError{fmt.Sprintf("chain must be 1..50 chars of [A-Za-z0-9 _-], got '%s'", raw)}
	}
	return raw, nil
}

// ParseProtocol validates mode=tvl's `protocol`: required, 1..100 chars of
// [A-Za-z0-9-]. Upstream slugs are lowercase alphanumerics and dashes; the
// charset admits uppercase too rather than inventing a case rule upstream
// never stated.
func ParseProtocol(raw string) (string, error) {
	if !isProtocolStr(raw) {
		return "", &ParamError{fmt.Sprintf("protocol must be 1..100 chars of [A-Za-z0-9-], got '%s'", raw)}
	}
	return raw, nil
}

// ParseCoins validates mode=prices' `coins`: required, 1..20 comma-separated
// coins, each 1..100 chars of [A-Za-z0-9:._-]. The whole list is echoed back
// verbatim on success: the cache is keyed on the exact upstream URL, so the
// canonical spelling is the caller's own.
func ParseCoins(raw string) (string, error) {
	if !isCoinsStr(raw) {
		return "", &ParamError{fmt.Sprintf("coins must be 1..20 comma-separated coins of [A-Za-z0-9:._-], got '%s'", raw)}
	}
	return raw, nil
}

// isChainStr reports whether s is an admissible chain segment.
func isChainStr(s string) bool {
	if len(s) == 0 || len(s) > 50 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == ' ' || c == '_' || c == '-' {
			continue
		}
		return false
	}
	return true
}

// isProtocolStr reports whether s is an admissible protocol slug.
func isProtocolStr(s string) bool {
	if len(s) == 0 || len(s) > 100 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' {
			continue
		}
		return false
	}
	return true
}

// isCoinItem reports whether s is one admissible coin id.
func isCoinItem(s string) bool {
	if len(s) == 0 || len(s) > 100 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == ':' || c == '.' || c == '_' || c == '-' {
			continue
		}
		return false
	}
	return true
}

// isCoinsStr reports whether s is an admissible coin list: 1..20 items, each
// an admissible coin id. An empty item (a leading, trailing or doubled comma)
// is rejected: upstream would read it as an empty id, not as nothing.
func isCoinsStr(s string) bool {
	if s == "" {
		return false
	}
	items := strings.Split(s, ",")
	if len(items) > 20 {
		return false
	}
	for _, it := range items {
		if !isCoinItem(it) {
			return false
		}
	}
	return true
}

// UnknownModeError is a mode outside the table. The handler maps it to the
// 400 `{error: "unknown mode '<m>'", detail: "expected one of …"}`.
type UnknownModeError struct{ Mode string }

func (e *UnknownModeError) Error() string { return fmt.Sprintf("unknown mode '%s'", e.Mode) }

// UnknownModeDetail is that 400's `detail`, generated from the SAME table
// Known consults -- a message and a table that can drift apart is the one kind
// of drift a caller cannot detect from the outside.
func UnknownModeDetail() string { return "expected one of " + strings.Join(Modes, ", ") }

// DerivedChains is mode=chains' `derived`. Verbatim from the TS route: chains
// arrive UNSORTED (measured 2026-09-27: Moonbeam with $78k TVL was row 0) and
// the list is re-sorted over the FULL set, so nothing is dropped. The label
// says exactly that, and the board renders it.
const DerivedChains = "sorted by tvl desc (upstream sends unsorted)"

// DerivedProtocols is mode=protocols' `derived`: the head length AND the real
// upstream length, so a 5-row body can never be read as "DeFiLlama has 5
// protocols".
func DerivedProtocols(top, total int) string {
	return fmt.Sprintf("head %d of %d sorted by tvl desc (upstream body is 8.9MB, trimmed here)", top, total)
}

// DerivedHistorical is mode=historical's `derived`: the tail length, the real
// history length and the direction upstream publishes in.
func DerivedHistorical(days, total int) string {
	return fmt.Sprintf("last %d of %d days (upstream is oldest-first)", days, total)
}

// DerivedChainHistory is mode=chainHistory's `derived`: the tail length, the
// real history length, the chain, and the direction upstream publishes in.
func DerivedChainHistory(chain string, days, total int) string {
	return fmt.Sprintf("last %d of %d days for chain %s (upstream is oldest-first)", days, total, chain)
}

// DerivedTVL is mode=tvl's `derived`: the number IS upstream's verbatim body,
// so the label names the protocol rather than a transform.
func DerivedTVL(protocol string) string {
	return fmt.Sprintf("current tvl for protocol %s (upstream is a single number)", protocol)
}

// DerivedPrices is mode=prices' `derived`: how many of the requested coins
// upstream priced, so a partial map can never be read as full coverage.
func DerivedPrices(n, total int) string {
	return fmt.Sprintf("%d of %d coins (upstream is a coins object)", n, total)
}

// DerivedStablecoins is mode=stablecoins' `derived`: the head length AND the
// real peggedAssets length, ordered by circulating supply.
func DerivedStablecoins(top, total int) string {
	return fmt.Sprintf("head %d of %d sorted by circulating desc (upstream is a peggedAssets list)", top, total)
}

// DerivedDexs is mode=dexs' `derived`: the head length AND the real protocols
// length, ordered by 24h volume.
func DerivedDexs(top, total int) string {
	return fmt.Sprintf("head %d of %d dexes sorted by total24h desc (upstream is a protocols object)", top, total)
}

// DerivedFees is mode=fees' `derived`: the head length AND the real protocols
// length, ordered by 24h fees.
func DerivedFees(top, total int) string {
	return fmt.Sprintf("head %d of %d protocols sorted by total24h desc (upstream is a protocols object)", top, total)
}

// DerivedYields is mode=yields' `derived`: the head length AND the real data
// length, ordered by USD TVL.
func DerivedYields(top, total int) string {
	return fmt.Sprintf("head %d of %d sorted by tvlUsd desc (upstream is a data list)", top, total)
}
