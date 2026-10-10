package llama

import (
	"context"
	"encoding/json"
	"sort"
	"time"
)

// This file is the wire shape: the envelope, the three row types, the number
// ordering every mode depends on, and the Service that ties a Fetcher to the
// mode semantics.
//
// # Tag discipline (the house rule, from internal/research/cryptorank/types.go)
//
// `undefined` in TS means "absent from JSON.stringify" and maps to *T +
// `omitempty`; `| null` is a present null and must NOT be omitted. The TS llama
// route emits protocol keys whose value is `r.k ?? null` — a PRESENT null for
// every missing key — so the ten protocol keys are all present-null here, never
// omitted. See LlamaProtocol.

// LlamaChain is one row of mode=chains. It is deliberately NOT projected: the
// TS route returns each upstream object raw (`rows = [...json].sort(...)`),
// because a chain row is small (its own fields are name/chainId/tokenSymbol/
// gecko_id/tvl/cmcId plus upstream's extras) and 467 of them fit in 64KB, while
// a projection would be a second, drifting description of upstream's schema.
// The measured 2026-09-29 body carries: gecko_id, gasTokenGeckoId, tvl,
// tokenSymbol, cmcId, name, chainId. Declaring them keeps the JSON key set
// upstream-shaped while still being a Go type — but a row upstream does NOT know
// must still ship, so the Service decodes rows as maps and hands them over as
// RawMessage; this struct exists for the UI's typing mirror and for tests.
type LlamaChain struct {
	Name        string  `json:"name"`
	TVL         float64 `json:"tvl"`
	TokenSymbol string  `json:"tokenSymbol,omitempty"`
	GeckoID     string  `json:"gecko_id,omitempty"`
	ChainID     int     `json:"chainId,omitempty"`
}

// LlamaProtocol is one row of mode=protocols — EXACTLY ten keys, the TS
// route's projection, in its three-step null policy:
//
//   - `category … logo` are `any` with a present null: the route wrote
//     `r.k ?? null`, so a missing key and a null key are the SAME wire value
//     (`null`) and the key is always present. `any` is required, not lazy: a
//     typed field would have to invent a zero value for a number upstream may
//     send as a string.
//   - `chains` is always an array (a non-array upstream value becomes `[]`).
//   - `name`/`slug` are the row's identity and are not nulled.
//
// The projection exists because the full 8.9MB body carries dozens of fields
// per protocol (audits, oracles, parentProtocol, referralUrl, …) and the board
// table renders ten. Nothing else is dropped silently: `derived` says the body
// was trimmed and `upstreamTotal` says how much of it there is.
type LlamaProtocol struct {
	Name     string `json:"name"`
	Slug     string `json:"slug"`
	Category any    `json:"category"`
	TVL      any    `json:"tvl"`
	Change1d any    `json:"change_1d"`
	Change7d any    `json:"change_7d"`
	MCap     any    `json:"mcap"`
	Chains   []any  `json:"chains"`
	URL      any    `json:"url"`
	Logo     any    `json:"logo"`
}

// LlamaHistoricalPoint is one row of mode=historical: `{date, tvl}`, the two
// fields the chart needs. Named for lib/llama.ts's interface of the same name.
//
// The zero values carry the nullness the TS route's `r.date ?? null` produced:
// Date == 0 -> null, TVL == nil -> null.
type LlamaHistoricalPoint struct {
	Date int64 `json:"-"`
	// DateValue is the wire `date` (nil when upstream had no date, which then
	// serialises as null).
	DateValue any `json:"date"`
	TVL       any `json:"tvl"`
}

// LlamaEnvelope is the response envelope. `derived` and `upstreamTotal` are the
// honest-by-construction pair: both are ALWAYS present (never omitempty),
// because a consumer that has to guess whether a body was transformed would be
// reading an ambiguous payload.
type LlamaEnvelope struct {
	Kind          string            `json:"kind"`
	Rows          []json.RawMessage `json:"rows"`
	Upstream      string            `json:"upstream"`
	FetchedAt     int64             `json:"fetchedAt"`
	UpstreamTotal int               `json:"upstreamTotal"`
	Derived       string            `json:"derived"`
	// Cache is the X-Cache value, carried here because the handler owns the
	// HEADER and the shaper owns the knowledge. It is NOT part of the wire
	// envelope (the TS route put it in a header too), hence `json:"-"`: a cache
	// mark inside the body would be a second, drift-prone spelling of the same
	// fact scripts/verify-llama.py already reads from the header.
	Cache string `json:"-"`
}

// Now is the injected clock (tests pin fetchedAt).
var Now = func() int64 { return time.Now().Unix() }

// Service ties a Fetcher to the mode semantics.
type Service struct{ F *Fetcher }

// EnvelopeParams carries the already-validated per-mode parameters. The
// handler validates every query value before calling: the Service never
// parses strings, so a bad value cannot reach the cache key or upstream.
type EnvelopeParams struct {
	Top      int
	Days     int
	Chain    string
	Protocol string
	Coins    string
}

// Envelope builds the response for one already-validated (mode, params).
//
// It is the port of the TS route's body-building half: fetch by UPSTREAM URL
// (so the trims share one cache entry), then sort/slice/map. Every failure
// is returned as an error — the handler maps it to the frozen body and never
// substitutes an empty payload. The legacy (mode, top, days) form is kept as
// a thin wrapper so the original three modes read unchanged.
func (s *Service) Envelope(ctx context.Context, mode string, top, days int) (LlamaEnvelope, error) {
	return s.EnvelopeWith(ctx, mode, EnvelopeParams{Top: top, Days: days})
}

// EnvelopeWith builds the response for a mode with its full parameter set.
func (s *Service) EnvelopeWith(ctx context.Context, mode string, p EnvelopeParams) (LlamaEnvelope, error) {
	url := UpstreamURL(mode)
	if mode == "chainHistory" || mode == "tvl" || mode == "prices" {
		url = UpstreamURLFor(mode, p.Chain, p.Protocol, p.Coins)
	}
	raw, total, info, err := s.F.Fetch(ctx, url)
	if err != nil {
		return LlamaEnvelope{}, err
	}
	// Rows and the sorted projection come from the Fetcher's memoized entry
	// when the body is warm (the HIT path): decoding and re-sorting the 8.9MB
	// /protocols body on every request is the cost the entry exists to avoid.
	// On a MISS (or when the fetcher does not memoize), extract and sort once
	// here — the result is the same shape served either way.
	rows, sorted, ok := s.F.ShapedByURL(url)
	if !ok {
		var exErr error
		rows, sorted, exErr = extractAndSort(raw, url)
		if exErr != nil {
			// Unreachable via Fetcher (fetch already proved the body is the
			// shape its URL promises); kept so a second BodyFetcher
			// implementation cannot ship a half-parsed payload.
			return LlamaEnvelope{}, &HardError{Kind: "non-json", URL: url, Detail: "cached body is not servable: " + exErr.Error()}
		}
	}
	env := LlamaEnvelope{
		Kind:          mode,
		Upstream:      url,
		FetchedAt:     info.FetchedAt,
		UpstreamTotal: total,
		Cache:         info.Cache,
	}
	switch mode {
	case "chains":
		env.Rows = sorted
		env.Derived = DerivedChains
	case "protocols":
		env.Rows = projectProtocols(Take(sorted, p.Top))
		env.Derived = DerivedProtocols(p.Top, total)
	case "chainHistory":
		env.Rows = projectHistorical(Tail(rows, p.Days))
		env.Derived = DerivedChainHistory(p.Chain, p.Days, total)
	case "tvl":
		env.Rows = projectTVL(rows, p.Protocol)
		env.Derived = DerivedTVL(p.Protocol)
	case "prices":
		env.Rows = sorted
		env.Derived = DerivedPrices(len(sorted), total)
	case "stablecoins":
		env.Rows = projectStablecoins(Take(sorted, p.Top))
		env.Derived = DerivedStablecoins(p.Top, total)
	case "dexs":
		env.Rows = projectDexFees(Take(sorted, p.Top))
		env.Derived = DerivedDexs(p.Top, total)
	case "fees":
		env.Rows = projectDexFees(Take(sorted, p.Top))
		env.Derived = DerivedFees(p.Top, total)
	case "yields":
		env.Rows = projectYields(Take(sorted, p.Top))
		env.Derived = DerivedYields(p.Top, total)
	default:
		env.Rows = projectHistorical(Tail(rows, p.Days))
		env.Derived = DerivedHistorical(p.Days, total)
	}
	return env, nil
}

// SortByTVLDesc orders rows by tvl descending, returning a NEW slice (the
// caller's array is never reordered in place: a cached body's decoded copy is
// shared with nothing, but keeping the helper total makes the next reader's
// reasoning local).
//
// The missing-tvl rule is the TS comparator's, verbatim:
//
//	(b.tvl ?? -1) - (a.tvl ?? -1)
//
// i.e. a row whose tvl is absent or null sorts as -1 — BELOW every real row,
// which is where the measured 1238 null-tvl protocols live anyway (at the tail
// of upstream's own order). A null is therefore never treated as 0 (which would
// place "unknown TVL" above a chain with $0.5k) and never dropped.
//
// Ties keep upstream's relative order (sort.SliceStable): a tie is not
// information this family may invent an order for.
func SortByTVLDesc(rows []json.RawMessage) []json.RawMessage {
	out := make([]json.RawMessage, len(rows))
	copy(out, rows)
	sort.SliceStable(out, func(i, j int) bool {
		return tvlOf(out[i]) > tvlOf(out[j])
	})
	return out
}

// tvlOf reads a row's numeric tvl, or -1 when it is missing/null/non-numeric.
func tvlOf(raw json.RawMessage) float64 {
	// A cheap targeted decode: the sort compares ~8.4k rows and a full map
	// decode of the 8.9MB body per comparison would be ~70MB of garbage. The
	// TVLValue helper is the map-based reader the shaper uses for the rows it
	// actually transforms.
	var probe struct {
		TVL *float64 `json:"tvl"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.TVL == nil {
		return -1
	}
	return *probe.TVL
}

// Take returns the first n rows (n <= 0 -> every row, the TS slice(0, top)
// behaviour is guarded by the handler's 1..200 validation).
func Take(rows []json.RawMessage, n int) []json.RawMessage {
	if n <= 0 || n > len(rows) {
		return rows
	}
	return rows[:n]
}

// Tail returns the last n rows (n <= 0 -> none).
func Tail(rows []json.RawMessage, n int) []json.RawMessage {
	if n <= 0 {
		return nil
	}
	if n > len(rows) {
		return rows
	}
	return rows[len(rows)-n:]
}

// projectProtocols maps a head onto exactly the ten wire keys.
func projectProtocols(rows []json.RawMessage) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(rows))
	for _, r := range rows {
		var m map[string]any
		if err := json.Unmarshal(r, &m); err != nil {
			// Cannot happen for a row of an array we just decoded; skipping it
			// silently would drop a row without saying so, so the row is kept
			// with its identity fields empty rather than vanished.
			m = map[string]any{}
		}
		p := LlamaProtocol{
			Name:     str(m["name"]),
			Slug:     str(m["slug"]),
			Category: nullOf(m["category"]),
			TVL:      nullOf(m["tvl"]),
			Change1d: nullOf(m["change_1d"]),
			Change7d: nullOf(m["change_7d"]),
			MCap:     nullOf(m["mcap"]),
			Chains:   arrayOf(m["chains"]),
			URL:      nullOf(m["url"]),
			Logo:     nullOf(m["logo"]),
		}
		b, err := json.Marshal(p)
		if err != nil {
			continue
		}
		out = append(out, b)
	}
	return out
}

// projectHistorical maps points onto `{date, tvl}`.
func projectHistorical(rows []json.RawMessage) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(rows))
	for _, r := range rows {
		var m map[string]any
		if err := json.Unmarshal(r, &m); err != nil {
			m = map[string]any{}
		}
		p := LlamaHistoricalPoint{DateValue: nullOf(m["date"]), TVL: nullOf(m["tvl"])}
		b, err := json.Marshal(p)
		if err != nil {
			continue
		}
		out = append(out, b)
	}
	return out
}

// LlamaTVL is one row of mode=tvl: the protocol slug plus its current TVL.
// Upstream serves a bare number, so the slug is the row's identity — without
// it a cached row could not say whose TVL it is.
type LlamaTVL struct {
	Protocol string `json:"protocol"`
	TVL      any    `json:"tvl"`
}

// projectTVL maps the one synthesized {tvl} row onto {protocol, tvl}.
func projectTVL(rows []json.RawMessage, protocol string) []json.RawMessage {
	var tvl any
	if len(rows) > 0 {
		var m map[string]any
		if err := json.Unmarshal(rows[0], &m); err == nil {
			tvl = nullOf(m["tvl"])
		}
	}
	b, err := json.Marshal(LlamaTVL{Protocol: protocol, TVL: tvl})
	if err != nil {
		return nil
	}
	return []json.RawMessage{b}
}

// LlamaStablecoin is one row of mode=stablecoins: identity plus the
// circulating supply in pegged USD and the venue's own price. The upstream
// `circulating` object ({peggedUSD, ...}) is flattened to its peggedUSD
// number: the board renders one supply figure, and the per-peg breakdown is
// not a second number the row must carry.
type LlamaStablecoin struct {
	ID          any `json:"id"`
	Name        string `json:"name"`
	Symbol      string `json:"symbol"`
	Circulating any `json:"circulating"`
	Price       any `json:"price"`
}

// projectStablecoins maps peggedAssets rows onto the five wire keys.
func projectStablecoins(rows []json.RawMessage) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(rows))
	for _, r := range rows {
		var m map[string]any
		if err := json.Unmarshal(r, &m); err != nil {
			m = map[string]any{}
		}
		var circulating any
		if inner, ok := m["circulating"].(map[string]any); ok {
			circulating = nullOf(inner["peggedUSD"])
		}
		p := LlamaStablecoin{
			ID:          nullOf(m["id"]),
			Name:        str(m["name"]),
			Symbol:      str(m["symbol"]),
			Circulating: circulating,
			Price:       nullOf(m["price"]),
		}
		b, err := json.Marshal(p)
		if err != nil {
			continue
		}
		out = append(out, b)
	}
	return out
}

// LlamaDexFee is one row of mode=dexs and mode=fees: identity plus the two
// totals the board ranks by. Both upstreams serve a `protocols` array with
// the same core keys, so one projection serves both modes.
type LlamaDexFee struct {
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	Total24h    any    `json:"total24h"`
	TotalAllTime any   `json:"totalAllTime"`
	Chains      []any  `json:"chains"`
}

// projectDexFees maps dex/fee protocol rows onto the five wire keys.
func projectDexFees(rows []json.RawMessage) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(rows))
	for _, r := range rows {
		var m map[string]any
		if err := json.Unmarshal(r, &m); err != nil {
			m = map[string]any{}
		}
		p := LlamaDexFee{
			Name:         str(m["name"]),
			Slug:         str(m["slug"]),
			Total24h:     nullOf(m["total24h"]),
			TotalAllTime: nullOf(m["totalAllTime"]),
			Chains:       arrayOf(m["chains"]),
		}
		b, err := json.Marshal(p)
		if err != nil {
			continue
		}
		out = append(out, b)
	}
	return out
}

// LlamaYield is one row of mode=yields: the pool id plus the chain, project,
// symbol, USD TVL and APY legs the board renders.
type LlamaYield struct {
	Pool      string `json:"pool"`
	Chain     string `json:"chain"`
	Project   string `json:"project"`
	Symbol    string `json:"symbol"`
	TVLUsd    any    `json:"tvlUsd"`
	APY       any    `json:"apy"`
	APYBase   any    `json:"apyBase"`
	APYReward any    `json:"apyReward"`
}

// projectYields maps yields data rows onto the eight wire keys.
func projectYields(rows []json.RawMessage) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(rows))
	for _, r := range rows {
		var m map[string]any
		if err := json.Unmarshal(r, &m); err != nil {
			m = map[string]any{}
		}
		p := LlamaYield{
			Pool:      str(m["pool"]),
			Chain:     str(m["chain"]),
			Project:   str(m["project"]),
			Symbol:    str(m["symbol"]),
			TVLUsd:    nullOf(m["tvlUsd"]),
			APY:       nullOf(m["apy"]),
			APYBase:   nullOf(m["apyBase"]),
			APYReward: nullOf(m["apyReward"]),
		}
		b, err := json.Marshal(p)
		if err != nil {
			continue
		}
		out = append(out, b)
	}
	return out
}

// extractAndSort is the Service-side twin of the Fetcher's shapeRows: the
// same extract + sort over a body the fetcher did not memoize. One
// implementation would be ideal; two exist because the Fetcher owns its entry
// type and the Service must serve even when the fetcher hands it raw bytes.
func extractAndSort(raw, url string) (rows, sorted []json.RawMessage, err error) {
	rows, err = extractRows(raw, url)
	if err != nil {
		return nil, nil, err
	}
	return rows, sortRows(rows, url), nil
}

// str is the TS `r.name` read: a non-string becomes "", never a formatted
// number. `name`/`slug` are the projection's identity and are the only two keys
// the route did NOT null-coalesce.
func str(v any) string {
	s, _ := v.(string)
	return s
}

// nullOf is the TS `r.k ?? null`: JSON null and a missing key both become the
// Go nil (a present `null` on the wire), while `0` and `false` survive as real
// values — `??` only fires on null/undefined, never on a falsy number.
func nullOf(v any) any {
	if v == nil {
		return nil
	}
	return v
}

// arrayOf is the TS `Array.isArray(r.chains) ? r.chains : []`: a non-array (or
// absent) value becomes an EMPTY array, never null, so a consumer can always
// map over it.
func arrayOf(v any) []any {
	a, ok := v.([]any)
	if !ok {
		return []any{}
	}
	return a
}
