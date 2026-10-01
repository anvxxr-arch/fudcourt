// Package news is the Cointelegraph RSS read family: the feed table, the plain
// net/http fetcher with a per-process TTL cache + single-flight, the RSS parser
// and the JSON envelope. It is the Go side of apps/web/app/api/news/route.ts,
// which is now a verbatim proxy to it -- exactly as DR-005 did for cryptorank,
// DR-006 for khala and DR-009 for llama (this port is DR-012).
//
// # Why ONE package and four files
//
// Same argument as internal/research/khala's and internal/research/llama's: the family has ONE
// artifact (a TS route), so modes/fetch/parse/shape are a reading aid, not a
// compatibility boundary. There is one upstream document (one RSS feed), so the
// parse and the shape belong to the same package the mode table does.
//
// # Upstream facts (probed live 2026-09-29; the TS route recorded the same ones)
//
//	GET https://cointelegraph.com/rss -> 200 text/xml, ~340KB, ONE <channel>
//	  with ~30-100 <item> elements, each carrying title/link/description/
//	  pubDate and (sometimes) a <media:content url="…"> image.
//	The feed is public and keyless and never challenged a non-browser client,
//	so no browser-TLS stack is needed (contrast internal/research/cryptorank).
//
// # Honest-by-construction (house rule: the wire says what was done)
//
//   - `source` and `limit` are OUR params: validated strictly (400) and NEVER
//     clamped or coerced. The TS route this replaces used to silently coerce
//     both (unknown source -> empty 200, limit via Math.min, non-numeric ->
//     NaN slice -> empty page); that silent-lie behaviour is deliberately NOT
//     ported -- the strict 400s already replaced it in the TS route and
//     scripts/verify-news.py asserts the fragments verbatim.
//   - an empty feed is a LOUD 502, never an honest-looking empty list.
//   - a non-2xx upstream keeps its REAL status, never a fake 200.
//
// # Caching
//
// The TS route went through lib/rate-limit.ts (min-gap + 15s TTL +
// single-flight, keyed by query URL). This side owns that now: an in-memory
// per-process TTL cache keyed on the FEED URL -- not on the request query --
// so `limit=5` and `limit=30` share one fetch of the 340KB document, and the
// trim happens after the cache. The cache is bounded BY CONSTRUCTION at the
// feed table's size (one URL per source), so there is no eviction policy for
// the same reason internal/research/llama has none.
package news

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

const (
	// Base is the feed origin. One source today; the table shape is kept so a
	// second feed is a table row rather than a second code path.
	Base = "https://cointelegraph.com"
	// PathRSS is the only implemented feed. Named (not inlined) so the response
	// can label the source it actually read.
	PathRSS = "/rss"
)

// Source is one feed entry: the wire `source` param value, the label the
// envelope carries, and the upstream URL.
type Source struct {
	// Name is the `source` query value and the row's `source` field.
	Name string
	// Label is the envelope's `source` label: the outlet's display name. It is
	// deliberately separate from Name: the TS route's rows say "Cointelegraph"
	// while the param says "cointelegraph", and scripts/verify-news.py asserts
	// exactly that pair.
	Label string
	// URL is the feed URL.
	URL string
}

// Sources is the feed table in declaration order: the array ships verbatim in
// the 400 unknown-source `detail`, so the order is part of the contract.
var Sources = []Source{
	{Name: "cointelegraph", Label: "Cointelegraph", URL: Base + PathRSS},
}

// SourceCount is the number of feeds (healthz prints the mode count).
var SourceCount = len(Sources)

// DefaultSource is the feed used when `source` is absent (the TS route's
// `?? 'cointelegraph'`).
const DefaultSource = "cointelegraph"

// Lookup finds a feed by its wire name.
func Lookup(name string) (Source, bool) {
	for _, s := range Sources {
		if s.Name == name {
			return s, true
		}
	}
	return Source{}, false
}

// Known reports whether name is in the feed table.
func Known(name string) bool {
	_, ok := Lookup(name)
	return ok
}

// SourceNames is the table's wire names in declaration order.
func SourceNames() []string {
	out := make([]string, 0, len(Sources))
	for _, s := range Sources {
		out = append(out, s.Name)
	}
	return out
}

// Param names.
const (
	ParamSource = "source"
	ParamLimit  = "limit"
)

// Limit bounds. The TS route's LIMIT_MIN/LIMIT_MAX, verbatim: the default 30 is
// the feed's own typical length, and 100 is the largest page the board ever
// asks for. Never clamped: 0 and 101 are 400s.
const (
	LimitDefault = 30
	LimitMin     = 1
	LimitMax     = 100
)

// ParamError is a bad value for one of our own params: a 400 whose message the
// TS route wrote verbatim (scripts/verify-news.py asserts the fragments "must
// be an integer" and "must be between 1 and 100").
type ParamError struct{ Message string }

func (e *ParamError) Error() string { return e.Message }

// UnknownSourceError is a `source` outside the table. The handler maps it to
// the 400 `{error: "unknown source '<s>'", detail: "expected one of …"}`.
type UnknownSourceError struct{ Source string }

func (e *UnknownSourceError) Error() string {
	return fmt.Sprintf("unknown source '%s'", e.Source)
}

// UnknownSourceDetail is that 400's `detail`, generated from the SAME table
// Lookup consults -- a message and a table that can drift apart is the one kind
// of drift a caller cannot detect from the outside.
func UnknownSourceDetail() string {
	return "expected one of " + strings.Join(SourceNames(), ", ")
}

// ParseSource validates the `source` param: absent takes DefaultSource, and an
// unknown value is an error rather than an empty feed.
func ParseSource(q url.Values) (Source, error) {
	vals, present := q[ParamSource]
	if !present {
		s, _ := Lookup(DefaultSource)
		return s, nil
	}
	raw := vals[0]
	s, ok := Lookup(raw)
	if !ok {
		return Source{}, &UnknownSourceError{Source: raw}
	}
	return s, nil
}

// ParseLimit validates the `limit` param.
//
// Strict, and never clamped:
//
//	absent             -> LimitDefault   (URLSearchParams.get() === null)
//	empty / non-digits -> "limit must be an integer, got '<raw>'" -- so `?limit=`
//	                      is a 400, not the default: get() returns "" and the
//	                      TS /^\d+$/ test fails on it too
//	out of 1..LimitMax -> "limit must be between 1 and 100, got <v>"
//
// A digit string past int64 range is still "between" (the value IS out of
// range) and is echoed as the raw digits rather than through a lossy float
// round-trip.
func ParseLimit(q url.Values) (int, error) {
	vals, present := q[ParamLimit]
	if !present {
		return LimitDefault, nil
	}
	raw := vals[0]
	digits := raw != ""
	for i := 0; i < len(raw) && digits; i++ {
		if raw[i] < '0' || raw[i] > '9' {
			digits = false
		}
	}
	if !digits {
		return 0, &ParamError{fmt.Sprintf("limit must be an integer, got '%s'", raw)}
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < LimitMin || v > LimitMax {
		got := raw // out of int64 range: the digits are the honest value
		if err == nil {
			got = strconv.Itoa(v)
		}
		return 0, &ParamError{fmt.Sprintf("limit must be between %d and %d, got %s", LimitMin, LimitMax, got)}
	}
	return v, nil
}

// labelOf maps a feed URL back to its display label. It is the inverse of the
// table lookup and exists so the parser can stamp rows without the caller
// threading a second value through the cache (a HIT serves rows whose label was
// fixed when the bytes were parsed).
func labelOf(url string) string {
	for _, s := range Sources {
		if s.URL == url {
			return s.Label
		}
	}
	return ""
}
