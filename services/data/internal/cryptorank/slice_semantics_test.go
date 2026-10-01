package cryptorank_test

// Guards for interpolations whose truthiness/nullish semantics are easy to
// confound, plus the rwaasset slice path that reaches them.
//
// The distinction that matters:
//
//	`total ? ... : ''`   TRUTHY   -> 0 renders the empty string
//	`count ?? '?'`       NULLISH  -> 0 renders "0"
//	`x ?? fallback`      NULLISH  -> "" would render "", but asStr() maps "" to
//	                                nil so a "" never reaches the helper

import (
	"encoding/json"
	"github.com/anvxxr-arch/fudcourt/services/data/internal/cryptorank"
	"strings"
	"testing"
)

func envelopeSlice(t *testing.T, mode string, pp map[string]interface{}, opts cryptorank.Opts) string {
	t.Helper()
	env, err := cryptorank.Envelope(mode, &cryptorank.HelperOut{
		OK: true, Route: "html", FetchedAt: 1790000000, Cache: "MISS", PageProps: pp,
	}, opts)
	if err != nil {
		t.Fatalf("%s: envelope refused: %v", mode, err)
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	s, _ := m["slice"].(string)
	return s
}

// ofTotal is `(total ? ` of N upstream (...)` : ”)`: a ZERO total must render
// the empty clause, not " of 0 upstream (...)". TS measured in node:
// `0 ? "T" : ""` === "".
func TestSliceOmitsZeroTotal(t *testing.T) {
	lpRows := []interface{}{map[string]interface{}{"key": "gno-land", "name": "Gno Land", "symbol": "GNO"}}
	cases := []struct {
		name    string
		mode    string
		pp      map[string]interface{}
		opts    cryptorank.Opts
		wantNot string
		want    string
	}{
		{
			name: "launchpool total=0",
			mode: "launchpool",
			pp: map[string]interface{}{
				"fallbackData": map[string]interface{}{"data": lpRows, "total": float64(0)},
			},
			opts:    cryptorank.Opts{Key: "past"},
			wantNot: " of 0 upstream",
			want: "past launchpool events — 1 rows shown; windows are upstream ISO dates, " +
				"null = not announced (em-dash)",
		},
		{
			name: "launchpool total=527",
			mode: "launchpool",
			pp: map[string]interface{}{
				"fallbackData": map[string]interface{}{"data": lpRows, "total": float64(527)},
			},
			opts: cryptorank.Opts{Key: "past"},
			want: "past launchpool events — 1 rows shown of 527 upstream " +
				"(SSR ships page 1 only; upstream ignores ?page=); windows are upstream ISO dates, " +
				"null = not announced (em-dash)",
		},
		{
			name: "launchpool total missing",
			mode: "launchpool",
			pp: map[string]interface{}{
				"fallbackData": map[string]interface{}{"data": lpRows},
			},
			opts:    cryptorank.Opts{Key: "past"},
			wantNot: " of 0 upstream",
			want: "past launchpool events — 1 rows shown; windows are upstream ISO dates, " +
				"null = not announced (em-dash)",
		},
		{
			name: "nodesale total=0",
			mode: "nodesale",
			pp: map[string]interface{}{
				"initialData": map[string]interface{}{"data": []interface{}{
					map[string]interface{}{"key": "fuse", "name": "Fuse", "symbol": "FUSE"},
				}, "total": float64(0)},
			},
			opts:    cryptorank.Opts{Key: "past"},
			wantNot: " of 0 upstream",
			want: "past node sales — 1 rows shown; node prices are upstream tier ranges in USD " +
				"(never market price); windows null = not announced (em-dash)",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := envelopeSlice(t, tc.mode, tc.pp, tc.opts)
			if tc.wantNot != "" && strings.Contains(got, tc.wantNot) {
				t.Errorf("slice %q must not contain %q", got, tc.wantNot)
			}
			if got != tc.want {
				t.Errorf("slice:\n got %q\nwant %q", got, tc.want)
			}
		})
	}
}

// countOrQ is `count ?? '?'` (NULLISH), so it must still print a zero total as
// "0" -- the deliberate mirror image of ofTotal above. Both shapes are asserted
// so nobody "unifies" the two helpers.
func TestSliceCountOrQPrintsZeroTotal(t *testing.T) {
	pp := map[string]interface{}{
		"fallbackEcosystems": map[string]interface{}{
			"data":  []interface{}{map[string]interface{}{"key": "eth", "name": "Ethereum"}},
			"count": float64(0),
		},
	}
	got := envelopeSlice(t, "ecosystems", pp, cryptorank.Opts{})
	if !strings.Contains(got, "1 of 0 ecosystems") {
		t.Errorf("count ?? '?' must print 0, got %q", got)
	}
	// Missing count -> '?'.
	pp["fallbackEcosystems"] = map[string]interface{}{
		"data": []interface{}{map[string]interface{}{"key": "eth", "name": "Ethereum"}},
	}
	if got := envelopeSlice(t, "ecosystems", pp, cryptorank.Opts{}); !strings.Contains(got, "1 of ? ecosystems") {
		t.Errorf("missing count must render '?', got %q", got)
	}
}

// dash is only reachable with a nil pointer: asStr("") is null (measured in
// node), and both rwaasset call sites read an asStr() result. Prove the whole
// path: an upstream "" must behave exactly like a missing field, i.e. the
// fallback text, and never produce an empty fragment in the slice.
func TestRwaAssetSliceFallbacksAreNullish(t *testing.T) {
	asset := func(quoteUpdatedAt, marketState interface{}) map[string]interface{} {
		return map[string]interface{}{
			"assetFallback": map[string]interface{}{
				"data": map[string]interface{}{
					"slug": "wendy-s", "ticker": "WEN", "type": "stock",
					"quoteUpdatedAt": quoteUpdatedAt, "marketState": marketState,
				},
			},
		}
	}
	const fallback = "asset detail 'WEN' — upstream quote at unknown time (marketState ?); " +
		"exchange/sector = upstream metadata"
	cases := []struct {
		name string
		pp   map[string]interface{}
		want string
	}{
		// asStr("") -> null, so `?? fallback` yields the fallback text. This is
		// the measurement that settles it: TS never sees "" here.
		{"empty strings", asset("", ""), fallback},
		{"nulls", asset(nil, nil), fallback},
		{"missing keys", asset(nil, nil), fallback},
		{"real values", asset("2026-09-28T10:00:00.000Z", "OPEN"),
			"asset detail 'WEN' — upstream quote at 2026-09-28T10:00:00.000Z (marketState OPEN); " +
				"exchange/sector = upstream metadata"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := envelopeSlice(t, "rwaasset", tc.pp, cryptorank.Opts{Key: "stocks/wendy-s"})
			if got != tc.want {
				t.Errorf("slice:\n got %q\nwant %q", got, tc.want)
			}
		})
	}
}

// The shared value helpers: nullish (`??`) vs truthy (`?`) must not be
// conflated, and asStr must keep mapping "" to nil (which is what makes dash's
// "" branch unreachable).
func TestDashSemantics(t *testing.T) {
	// asStr("") is null -> the fallback IS used, via the nil branch.
	env, err := cryptorank.Envelope("rwaasset", &cryptorank.HelperOut{
		OK: true, FetchedAt: 1790000000, Cache: "MISS",
		PageProps: map[string]interface{}{
			"assetFallback": map[string]interface{}{"data": map[string]interface{}{
				"slug": "x-s", "ticker": "X", "quoteUpdatedAt": "",
			}},
		},
	}, cryptorank.Opts{Key: "stocks/x-s"})
	if err != nil {
		t.Fatal(err)
	}
	if env.RwaAsset.QuoteUpdatedAt != nil {
		t.Errorf("asStr(\"\") must map to nil, got %q", *env.RwaAsset.QuoteUpdatedAt)
	}
	if env.Slice == nil || !strings.Contains(*env.Slice, "unknown time") {
		t.Errorf("expected the fallback text, got %v", env.Slice)
	}
	// A non-nil pointer whose value is "" would be the only way to observe the
	// "" branch, and asStr cannot produce one.
	shape := cryptorank.ShapeRwaAsset(map[string]interface{}{"quoteUpdatedAt": ""}, "stocks/x-s")
	if shape.QuoteUpdatedAt != nil {
		t.Error("ShapeRwaAsset must not fabricate a pointer to an empty string")
	}
}

// Upstream moved /all-coins-list from a bare `pageProps.coins` array to a
// wrapper (`{"coins":{"data":[...],"total":N}}`). Reading only the bare form
// shipped `count:0` with HTTP 200 -- a silent empty envelope, the exact failure
// the contract forbids -- so both shapes must resolve to the same rows.
func TestCoinsAcceptsWrappedAndBarePayloads(t *testing.T) {
	rows := []interface{}{
		map[string]interface{}{"key": "bitcoin", "name": "Bitcoin", "symbol": "BTC"},
		map[string]interface{}{"key": "ethereum", "name": "Ethereum", "symbol": "ETH"},
	}
	cases := []struct {
		name string
		pp   map[string]interface{}
	}{
		{"wrapped", map[string]interface{}{"coins": map[string]interface{}{"data": rows, "total": float64(100)}}},
		{"bare", map[string]interface{}{"coins": rows}},
	}
	for _, tc := range cases {
		env, err := cryptorank.Envelope("coins", &cryptorank.HelperOut{
			OK: true, Route: "html", FetchedAt: 1790000000, Cache: "MISS", PageProps: tc.pp,
		}, cryptorank.Opts{})
		if err != nil {
			t.Fatalf("%s: envelope refused: %v", tc.name, err)
		}
		if env.Count != 2 || len(env.Rows) != 2 {
			t.Errorf("%s: count=%d rows=%d, want 2/2", tc.name, env.Count, len(env.Rows))
		}
	}
}
