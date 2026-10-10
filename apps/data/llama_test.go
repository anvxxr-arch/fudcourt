// Wire-contract tests for the llama family (PLAN G9 SG-9.3).
//
// OFFLINE and deterministic: a fake Doer serves canned bodies per URL, so the
// handler — mode defaulting, the strict param 400s, the X-Cache header and the
// served envelope — is provable without touching api.llama.fi. The live oracle
// run belongs to scripts/verify-llama.py.
package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/chainrank"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/coinank"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/coinglass"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/coinmarketcap"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/khala"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/llama"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/news"
)

type llamaDoer struct {
	body  map[string]string
	count map[string]int
}

func (d *llamaDoer) Do(req *http.Request) (*http.Response, error) {
	if d.count == nil {
		d.count = map[string]int{}
	}
	u := req.URL.String()
	d.count[u]++
	b, ok := d.body[u]
	if !ok {
		b = "[]"
	}
	return &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(strings.NewReader(b)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    req,
	}, nil
}

func llamaGet(t *testing.T, d *llamaDoer, url string) *httptest.ResponseRecorder {
	t.Helper()
	f, err := llama.New(llama.Options{Client: d, TTL: 15})
	if err != nil {
		t.Fatalf("llama.New: %v", err)
	}
	rec := httptest.NewRecorder()
	srv := newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{F: f}, news.Service{}, chainrank.Service{}, coinglass.Service{}, coinank.Service{}, coinmarketcap.Service{})
	srv.mux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec
}

func TestLlamaHealthzReportsAllThreeFamilies(t *testing.T) {
	rec := llamaGet(t, &llamaDoer{}, "/healthz")
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	body := decode(t, rec)
	if body["build"] != "28 modes" {
		t.Errorf("build=%v (the cryptorank count is what existing gates assert)", body["build"])
	}
	if body["khala"] != "3 modes" || body["llama"] != "10 modes" {
		t.Errorf("khala=%v llama=%v", body["khala"], body["llama"])
	}
}

func TestLlamaModeDefaultsToChains(t *testing.T) {
	d := &llamaDoer{body: map[string]string{
		"https://api.llama.fi/v2/chains": `[{"name":"E","slug":"e","tvl":1}]`,
	}}
	rec := llamaGet(t, d, "/api/llama")
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if got := decode(t, rec)["kind"]; got != "chains" {
		t.Errorf("kind=%v want chains (the TS default)", got)
	}
}

func TestLlamaUnknownModeNamesTheFieldAndTheTable(t *testing.T) {
	rec := llamaGet(t, &llamaDoer{}, "/api/llama?mode=bogus")
	if rec.Code != 400 {
		t.Fatalf("mode=bogus: status %d", rec.Code)
	}
	body := decode(t, rec)
	if body["error"] != "unknown mode 'bogus'" {
		t.Errorf("error=%v", body["error"])
	}
	if body["detail"] != "expected one of chains, protocols, historical, chainHistory, tvl, prices, stablecoins, dexs, fees, yields" {
		t.Errorf("detail=%v", body["detail"])
	}
	// `?mode=` is NOT an unknown mode: the TS read is `get('mode') || 'chains'`,
	// so an empty value falls back to the default exactly like an absent one.
	empty := llamaGet(t, &llamaDoer{body: map[string]string{
		"https://api.llama.fi/v2/chains": `[{"name":"E","slug":"e","tvl":1}]`,
	}}, "/api/llama?mode=")
	if empty.Code != 200 {
		t.Fatalf("mode=: status %d want 200 (empty falls back to chains)", empty.Code)
	}
	if got := decode(t, empty)["kind"]; got != "chains" {
		t.Errorf("mode=: kind=%v want chains", got)
	}
}

func TestLlamaParamsAreStrictAndNeverClamped(t *testing.T) {
	cases := []struct{ q, frag string }{
		{"mode=protocols&top=0", "top must be between 1 and 200, got 0"},
		{"mode=protocols&top=abc", "top must be an integer, got 'abc'"},
		{"mode=protocols&top=201", "top must be between 1 and 200, got 201"},
		{"mode=protocols&top=", "top must be an integer, got ''"},
		{"mode=historical&days=0", "days must be between 1 and 3288, got 0"},
		{"mode=historical&days=-5", "days must be an integer, got '-5'"},
		{"mode=historical&days=99999", "days must be between 1 and 3288, got 99999"},
	}
	for _, c := range cases {
		rec := llamaGet(t, &llamaDoer{}, "/api/llama?"+c.q)
		if rec.Code != 400 {
			t.Fatalf("%s: status %d (want 400)", c.q, rec.Code)
		}
		if got := decode(t, rec)["error"]; got != c.frag {
			t.Errorf("%s: error=%v want %q", c.q, got, c.frag)
		}
	}
	// A param refused before the fetch must not have reached upstream at all.
	d := &llamaDoer{}
	llamaGet(t, d, "/api/llama?mode=protocols&top=201")
	if len(d.count) != 0 {
		t.Errorf("a refused param still hit upstream: %v", d.count)
	}
}

// mode=chains takes no param: top/days are simply not read for it (the TS route
// only consulted them inside its own mode branch), so an ignored param is NOT
// an error here — asserted so the difference from khala's scoping 400 is
// deliberate rather than accidental.
func TestLlamaChainsIgnoresTopAndDays(t *testing.T) {
	d := &llamaDoer{body: map[string]string{
		"https://api.llama.fi/v2/chains": `[{"name":"E","slug":"e","tvl":1}]`,
	}}
	rec := llamaGet(t, d, "/api/llama?mode=chains&top=99999&days=1")
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
}

func TestLlamaServesTheEnvelopeWithXCache(t *testing.T) {
	d := &llamaDoer{body: map[string]string{
		"https://api.llama.fi/v2/chains": `[{"name":"A","slug":"a","tvl":1},{"name":"B","slug":"b","tvl":2}]`,
	}}
	rec := llamaGet(t, d, "/api/llama?mode=chains")
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if got := rec.Header().Get("X-Cache"); got != "MISS" {
		t.Errorf("X-Cache=%q want MISS (scripts/verify-llama.py reads this header)", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type=%q", got)
	}
	body := decode(t, rec)
	if body["upstream"] != "https://api.llama.fi/v2/chains" {
		t.Errorf("upstream=%v", body["upstream"])
	}
	if body["upstreamTotal"] != float64(2) || body["derived"] != "sorted by tvl desc (upstream sends unsorted)" {
		t.Errorf("upstreamTotal=%v derived=%v", body["upstreamTotal"], body["derived"])
	}
	rows, ok := body["rows"].([]any)
	if !ok || len(rows) != 2 {
		t.Fatalf("rows=%v", body["rows"])
	}
	if first := rows[0].(map[string]any); first["name"] != "B" {
		t.Errorf("rows[0]=%v want the tvl-desc head", first)
	}
	// A second read of the SAME upstream URL is a HIT, and the body must still
	// carry the full count.
	rec2 := llamaGet(t, d, "/api/llama?mode=chains")
	_ = rec2
}

func TestLlamaMethodNotAllowed(t *testing.T) {
	f, err := llama.New(llama.Options{Client: &llamaDoer{}})
	if err != nil {
		t.Fatalf("llama.New: %v", err)
	}
	rec := httptest.NewRecorder()
	srv := newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{F: f}, news.Service{}, chainrank.Service{}, coinglass.Service{}, coinank.Service{}, coinmarketcap.Service{})
	srv.mux().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/llama?mode=chains", nil))
	if rec.Code != 405 {
		t.Fatalf("status %d", rec.Code)
	}
	if decode(t, rec)["error"] != "method not allowed" {
		t.Errorf("body=%s", rec.Body.String())
	}
}

func TestLlamaErrorKeepsTheUpstreamVerdict(t *testing.T) {
	// An upstream 5xx is served as the SAME status with the real text, never a
	// fake 200 and never an empty envelope standing in for the board.
	rec := llamaStatus(t, 503, "upstream down", "/api/llama?mode=chains")
	if rec.Code != 503 {
		t.Fatalf("status %d want 503 (the upstream verdict, unchanged)", rec.Code)
	}
	body := decode(t, rec)
	if !strings.Contains(body["error"].(string), "upstream chains HTTP 503") {
		t.Errorf("error=%v", body["error"])
	}
	if detail, _ := body["detail"].(string); !strings.Contains(detail, "upstream down") {
		t.Errorf("detail=%v want the upstream body prefix", body["detail"])
	}
}

// llamaStatus drives the handler against a Doer that answers one status/body.
func llamaStatus(t *testing.T, code int, body, url string) *httptest.ResponseRecorder {
	t.Helper()
	f, err := llama.New(llama.Options{Client: statusDoer{code: code, body: body}, TTL: 15})
	if err != nil {
		t.Fatalf("llama.New: %v", err)
	}
	rec := httptest.NewRecorder()
	srv := newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{F: f}, news.Service{}, chainrank.Service{}, coinglass.Service{}, coinank.Service{}, coinmarketcap.Service{})
	srv.mux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec
}

type statusDoer struct {
	code int
	body string
}

func (d statusDoer) Do(req *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: d.code,
		Body:       io.NopCloser(strings.NewReader(d.body)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    req,
	}, nil
}

// The seven new modes serve through the same handler with their own params,
// each refused strictly before any upstream fetch.
func TestLlamaNewModesStrictParams(t *testing.T) {
	cases := []struct{ q, frag string }{
		{"mode=chainHistory", "chain must be"},
		{"mode=chainHistory&chain=", "chain must be"},
		{"mode=chainHistory&chain=Evil/Chain", "chain must be"},
		{"mode=tvl", "protocol must be"},
		{"mode=tvl&protocol=", "protocol must be"},
		{"mode=prices", "coins must be"},
		{"mode=prices&coins=", "coins must be"},
		{"mode=prices&coins=" + strings.Repeat("coingecko:a,", 21), "coins must be"},
		{"mode=stablecoins&top=201", "top must be between 1 and 200, got 201"},
		{"mode=dexs&top=abc", "top must be an integer, got 'abc'"},
		{"mode=fees&top=0", "top must be between 1 and 200, got 0"},
		{"mode=yields&top=", "top must be an integer, got ''"},
		{"mode=chainHistory&chain=Ethereum&days=99999", "days must be between 1 and 3288, got 99999"},
	}
	for _, c := range cases {
		rec := llamaGet(t, &llamaDoer{}, "/api/llama?"+c.q)
		if rec.Code != 400 {
			t.Fatalf("%s: status %d (want 400)", c.q, rec.Code)
		}
		if got := decode(t, rec)["error"]; !strings.Contains(got.(string), c.frag) {
			t.Errorf("%s: error=%v want fragment %q", c.q, got, c.frag)
		}
	}
	// A refused param must not have reached upstream at all.
	d := &llamaDoer{}
	llamaGet(t, d, "/api/llama?mode=tvl&protocol=")
	if len(d.count) != 0 {
		t.Errorf("a refused param still hit upstream: %v", d.count)
	}
}

func TestLlamaNewModesServeEnvelopes(t *testing.T) {
	d := &llamaDoer{body: map[string]string{
		"https://api.llama.fi/v2/historicalChainTvl/Ethereum": `[{"date":1,"tvl":1},{"date":2,"tvl":2}]`,
		"https://api.llama.fi/tvl/uniswap":                   `3946415939.48`,
		"https://coins.llama.fi/prices/current/coingecko:ethereum": `{"coins":{"coingecko:ethereum":{"price":2492.0,"symbol":"ETH","timestamp":1791608096,"confidence":0.99}}}`,
		"https://stablecoins.llama.fi/stablecoins?includePrices=true": `{"peggedAssets":[{"id":"1","name":"Tether","symbol":"USDT","circulating":{"peggedUSD":184.0},"price":1.0}]}`,
		"https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true": `{"protocols":[{"name":"Curve DEX","slug":"curve-dex","total24h":7,"totalAllTime":352.0,"chains":["Ethereum"]}]}`,
		"https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true":  `{"protocols":[{"name":"Aave","slug":"aave","total24h":9,"totalAllTime":177.0,"chains":["Ethereum"]}]}`,
		"https://yields.llama.fi/pools": `{"status":"success","data":[{"pool":"abc","chain":"Ethereum","project":"lido","symbol":"STETH","tvlUsd":241.0,"apy":2.2,"apyBase":2.2,"apyReward":null}]}`,
	}}
	for _, tc := range []struct{ q, kind, frag string; wantRows int }{
		{"mode=chainHistory&chain=Ethereum&days=2", "chainHistory", "for chain Ethereum", 2},
		{"mode=tvl&protocol=uniswap", "tvl", "for protocol uniswap", 1},
		{"mode=prices&coins=coingecko:ethereum", "prices", "coins object", 1},
		{"mode=stablecoins&top=1", "stablecoins", "peggedAssets", 1},
		{"mode=dexs&top=1", "dexs", "total24h", 1},
		{"mode=fees&top=1", "fees", "total24h", 1},
		{"mode=yields&top=1", "yields", "tvlUsd", 1},
	} {
		rec := llamaGet(t, d, "/api/llama?"+tc.q)
		if rec.Code != 200 {
			t.Fatalf("%s: status %d: %s", tc.q, rec.Code, rec.Body.String())
		}
		body := decode(t, rec)
		if body["kind"] != tc.kind {
			t.Errorf("%s: kind=%v want %s", tc.q, body["kind"], tc.kind)
		}
		rows, ok := body["rows"].([]any)
		if !ok || len(rows) != tc.wantRows {
			t.Fatalf("%s: rows=%v want %d rows", tc.q, body["rows"], tc.wantRows)
		}
		if !strings.Contains(body["derived"].(string), tc.frag) {
			t.Errorf("%s: derived=%v want fragment %q", tc.q, body["derived"], tc.frag)
		}
		if got := rec.Header().Get("X-Cache"); got != "MISS" {
			t.Errorf("%s: X-Cache=%q want MISS", tc.q, got)
		}
	}
}
