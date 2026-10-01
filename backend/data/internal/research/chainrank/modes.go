// Package chainrank is the chainrank.fyi read family: the mode table, the plain
// net/http fetcher with a per-process TTL cache + single-flight, and the JSON
// envelope. It is the Go side of apps/web/app/api/chainrank/route.ts, which is
// now a verbatim proxy to it -- exactly as DR-005 did for cryptorank, DR-006 for
// khala, DR-009 for llama and DR-012 for news. This port is DR-013.
//
// # Why ONE package and three files
//
// Same argument as internal/research/{khala,llama,news}: the family has ONE artifact (a
// TS route + its lib/chainrank.ts type surface), so modes/fetch/shape are a
// reading aid, not a compatibility boundary.
//
// # Upstream facts (reverse-engineered 2026-09-27; the TS route recorded the same)
//
//	GET /api/stats                    -> {online, totalClicks, listings,
//	                                     totalUsdCents, topUsdCents, claimTopCents}
//	GET /api/listings?page&pageSize   -> {rows[], page, pageSize, total, totalPages}
//	POST /api/click|presence|claim/*|upload -> WRITES, deliberately NOT proxied
//
// # Honest-by-construction (house rule: the wire says what was done)
//
//   - `page`/`pageSize` are relayed UNTOUCHED. Upstream silently clamps page<1
//     to 1 and caps pageSize at 200; re-clamping locally would make our response
//     indistinguishable from upstream's own answer while actually being our
//     guess. Relayed verbatim, the clamping in the body is upstream's, and
//     `upstream` names the exact URL that produced it.
//   - a non-2xx or non-JSON upstream is reported with its REAL status, never
//     smoothed into 200 with empty data.
//   - a shape that does not carry the fields the board renders is a loud 502:
//     the board must not receive `{}` dressed as a stats envelope.
//
// # Cache
//
// The TS route went through lib/rate-limit.ts (min-gap + TTL + single-flight,
// keyed on the upstream URL, which INCLUDES the pagination query). This side
// owns that now: an in-memory per-process TTL cache keyed on the full upstream
// URL, so `pageSize=7` and `pageSize=50` are separate entries -- which is
// correct here (unlike llama/news) because the query genuinely selects a
// different slice of upstream's data rather than a local trim of one document.
package chainrank

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

const (
	// Base is the chainrank.fyi origin. robots.txt disallows /api/ to crawlers
	// and this is a low-volume read-only relay, identified as such by UA+From.
	Base = "https://www.chainrank.fyi"
	// The two read endpoints, verbatim from the TS route.
	PathStats    = "/api/stats"
	PathListings = "/api/listings"
)

// Modes is the mode table in declaration order. The array ships verbatim in the
// 400 unknown-mode `detail`, so the order is part of the contract.
var Modes = []string{"stats", "listings"}

// ModeCount is the number of modes (healthz prints it).
var ModeCount = len(Modes)

// DefaultMode is the mode used when `mode` is absent (the TS route's `|| 'stats'`).
const DefaultMode = "stats"

var known = func() map[string]bool {
	m := make(map[string]bool, len(Modes))
	for _, s := range Modes {
		m[s] = true
	}
	return m
}()

// Known reports whether mode is in the table.
func Known(mode string) bool { return known[mode] }

// Param names. Both are relayed to upstream untouched; they are OUR params only
// in the sense that we choose not to interpret them.
const (
	ParamMode     = "mode"
	ParamPage     = "page"
	ParamPageSize = "pageSize"
)

// UpstreamURL builds the canonical upstream URL of a request. The pagination
// query is appended for listings EXACTLY as received (that is the whole
// relay-verbatim rule), so the URL doubles as the cache key and as the
// envelope's `upstream`.
//
// A param sent to the wrong mode is dropped, exactly as the TS route dropped it
// (it built the query only in the listings branch): `stats&page=2` must not
// produce a stats URL carrying a page.
func UpstreamURL(mode string, q url.Values) string {
	if mode != "listings" {
		return Base + PathStats
	}
	relayed := url.Values{}
	// A fixed key order keeps the URL (and therefore the cache key) canonical
	// regardless of the order the caller happened to send them in: `?page=1&pageSize=5`
	// and `?pageSize=5&page=1` must be ONE cache entry, not two.
	for _, k := range []string{ParamPage, ParamPageSize} {
		if vals, ok := q[k]; ok {
			relayed.Set(k, vals[0])
		}
	}
	if len(relayed) == 0 {
		return Base + PathListings
	}
	return Base + PathListings + "?" + relayed.Encode()
}

// UnknownModeError is a mode outside the table. The handler maps it to the
// 400 `{error: "unknown mode '<m>'", detail: "expected one of …"}`.
type UnknownModeError struct{ Mode string }

func (e *UnknownModeError) Error() string {
	return fmt.Sprintf("unknown mode '%s'", e.Mode)
}

// UnknownModeDetail is that 400's `detail`, generated from the SAME table Known
// consults -- a message and a table that can drift apart is the one kind of
// drift a caller cannot detect from the outside.
func UnknownModeDetail() string { return "expected one of " + strings.Join(Modes, ", ") }

// ShapeError is an upstream 200 whose body does not carry the fields the board
// renders. It is the family's version of "empty upstream ≠ valid answer": a
// stats envelope missing `online` must not reach the board as `undefined`.
type ShapeError struct{ Detail string }

func (e *ShapeError) Error() string { return e.Detail }

// Itoa is a tiny local helper so the shape checks do not pull strconv into a
// file that reads better without it.
func Itoa(n int) string { return strconv.Itoa(n) }
