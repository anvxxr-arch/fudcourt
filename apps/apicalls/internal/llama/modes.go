// Package llama is the DeFiLlama (api.llama.fi) read family: the mode table, the
// plain net/http fetcher with a per-process TTL cache + single-flight, and the
// JSON envelope. It is the Go side of apps/web/app/api/llama/route.ts, which is
// now a verbatim proxy to it -- exactly as DR-005 did for cryptorank and DR-006
// for khala.
//
// # Why ONE package and four files
//
// Same argument as internal/khala's: the family has ONE artifact (a TS route +
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
// single-flight). This side owns that now: an in-memory per-process TTL cache
// (default 15s, APICALLS_LLAMA_TTL overrides it in main.go) plus single-flight
// per URL, keyed on the UPSTREAM URL, so `top=3` and `top=7` share one 8.9MB
// fetch. It is bounded BY CONSTRUCTION at the three URLs AllowedURL admits:
// there is no eviction policy because there is nothing that can grow (see
// fetch.go's Stats.Entries test).
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
	// The three upstream reads, verbatim from the TS route's upstreamPath.
	PathChains     = "/v2/chains"
	PathProtocols  = "/protocols"
	PathHistorical = "/v2/historicalChainTvl"
)

// Modes is the mode table in declaration order. The array ships verbatim in the
// 400 unknown-mode detail, so the order is part of the contract.
var Modes = []string{"chains", "protocols", "historical"}

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

// Path is the upstream path of a mode. Only the three table entries have one;
// callers refuse an unknown mode before consulting this.
func Path(mode string) string {
	switch mode {
	case "chains":
		return PathChains
	case "protocols":
		return PathProtocols
	}
	return PathHistorical
}

// UpstreamURL is the canonical upstream URL of a mode: the envelope's
// `upstream` and the URL the cache is keyed on.
func UpstreamURL(mode string) string { return Base + Path(mode) }

// Param names. `top` is a mode=protocols param, `days` a mode=historical one;
// mode=chains has none (it serves the full list, so a trim request would have
// nothing to trim -- see Service.Envelope).
const (
	ParamMode = "mode"
	ParamTop  = "top"
	ParamDays = "days"
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
	for i := 0; i < len(raw) && digits; i++ {
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
