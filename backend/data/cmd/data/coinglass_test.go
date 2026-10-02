package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/chainrank"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/coinglass"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/khala"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/llama"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/news"
)

// cgFixtureDir is the family's recorded testdata, reused here so the handler
// tests exercise the REAL decryptor over REAL captured bytes rather than a
// hand-made double.
const cgFixtureDir = "../../internal/research/coinglass/testdata"

// cgDoer serves a recorded fixture instead of the network.
type cgDoer struct {
	fixture string // fixture name WITHOUT extension, e.g. "real-statistics"
	status  int
	// refusal, when set, is returned as an unencrypted body (upstream's own
	// success:false envelope).
	refusal string
}

func (d cgDoer) Do(req *http.Request) (*http.Response, error) {
	h := http.Header{}
	var body []byte
	if d.refusal != "" {
		body = []byte(d.refusal)
	} else {
		b, err := os.ReadFile(filepath.Join(cgFixtureDir, d.fixture+".body"))
		if err != nil {
			return nil, err
		}
		metaRaw, err := os.ReadFile(filepath.Join(cgFixtureDir, d.fixture+".meta.json"))
		if err != nil {
			return nil, err
		}
		var meta struct {
			V, User, Time, CacheTS string
		}
		if err := json.Unmarshal(metaRaw, &meta); err != nil {
			return nil, err
		}
		h.Set("v", meta.V)
		h.Set("user", meta.User)
		if meta.Time != "" {
			h.Set("time", meta.Time)
		}
		body = b
	}
	status := d.status
	if status == 0 {
		status = 200
	}
	return &http.Response{
		StatusCode: status,
		Header:     h,
		Body:       io.NopCloser(strings.NewReader(string(body))),
	}, nil
}

// cgServer builds a server whose coinglass family reads a fixture.
func cgServer(t *testing.T, d cgDoer) http.Handler {
	t.Helper()
	f, err := coinglass.New(coinglass.Options{
		Client:   d,
		CacheDir: t.TempDir(),
		NoCache:  true,
	})
	if err != nil {
		t.Fatalf("coinglass.New: %v", err)
	}
	return newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{}, news.Service{}, chainrank.Service{}, coinglass.Service{F: f}).mux()
}

func cgGet(t *testing.T, h http.Handler, url string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec
}

// TestCoinglassStatistics: the happy path, over a REAL recorded encrypted body
// (v=66). It asserts the decrypted payload actually reached the wire — a
// decoder that silently produced nothing would fail here, which is the point.
func TestCoinglassStatistics(t *testing.T) {
	h := cgServer(t, cgDoer{fixture: "real-statistics"})
	rec := cgGet(t, h, "/api/coinglass?mode=statistics")
	if rec.Code != 200 {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-CG-Cipher"); got != "66" {
		t.Fatalf("X-CG-Cipher = %q, want 66", got)
	}
	if got := rec.Header().Get("X-CG-Cache"); got != "MISS" {
		t.Fatalf("X-CG-Cache = %q, want MISS", got)
	}
	var env struct {
		Kind      string         `json:"kind"`
		Encrypted bool           `json:"encrypted"`
		Cipher    string         `json:"cipher"`
		Data      map[string]any `json:"data"`
		Derived   string         `json:"derived"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("envelope: %v", err)
	}
	if env.Kind != "statistics" || !env.Encrypted || env.Cipher != "66" {
		t.Fatalf("envelope head wrong: %+v", env)
	}
	oi, ok := env.Data["openInterest"].(float64)
	if !ok || oi <= 0 {
		t.Fatalf("data.openInterest = %v, want a positive number (empty payload?)", env.Data["openInterest"])
	}
	if !strings.Contains(env.Derived, "v=66") {
		t.Fatalf("derived should name the cipher: %q", env.Derived)
	}
}

// TestCoinglassOpenInterestArray: an array payload sets upstreamCount, and a
// wrong symbol must never be clamped into a valid one.
func TestCoinglassOpenInterestArray(t *testing.T) {
	h := cgServer(t, cgDoer{fixture: "real-openinterest"})
	rec := cgGet(t, h, "/api/coinglass?mode=openInterest&symbol=BTC")
	if rec.Code != 200 {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var env struct {
		UpstreamCount *int             `json:"upstreamCount"`
		Data          []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("envelope: %v", err)
	}
	if env.UpstreamCount == nil || *env.UpstreamCount == 0 {
		t.Fatalf("upstreamCount = %v, want a positive count", env.UpstreamCount)
	}
	if len(env.Data) != *env.UpstreamCount {
		t.Fatalf("data has %d rows but upstreamCount = %d", len(env.Data), *env.UpstreamCount)
	}
}

// TestCoinglassValidation pins the local 400s. Every one is a REFUSAL: none of
// these values may be clamped, defaulted or ignored.
func TestCoinglassValidation(t *testing.T) {
	h := cgServer(t, cgDoer{fixture: "real-statistics"})
	cases := []struct {
		name     string
		url      string
		wantCode int
		wantErr  string
	}{
		{"no mode", "/api/coinglass", 400, coinglass.ErrUnknownMode},
		{"unknown mode", "/api/coinglass?mode=bogus", 400, coinglass.ErrUnknownMode},
		{"symbol missing", "/api/coinglass?mode=openInterest", 400, coinglass.ErrMissingParam},
		{"symbol lowercase (never clamped)", "/api/coinglass?mode=openInterest&symbol=btc", 400, coinglass.ErrInvalidParam},
		{"symbol with a space", "/api/coinglass?mode=openInterest&symbol=BTC%20ETH", 400, coinglass.ErrInvalidParam},
		{"unscoped param", "/api/coinglass?mode=statistics&symbol=BTC", 400, coinglass.ErrUnexpected},
		{"unknown param", "/api/coinglass?mode=statistics&day=1", 400, coinglass.ErrUnexpected},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := cgGet(t, h, tc.url)
			if rec.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantCode, rec.Body.String())
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("body: %v", err)
			}
			if body["error"] != tc.wantErr {
				t.Fatalf("error = %v, want %q", body["error"], tc.wantErr)
			}
		})
	}

	// The unknown-mode body must ship the whole table so a caller can recover.
	rec := cgGet(t, h, "/api/coinglass?mode=bogus")
	var body struct {
		Modes []string `json:"modes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v", err)
	}
	if len(body.Modes) != coinglass.ModeCount {
		t.Fatalf("modes = %v, want %d entries", body.Modes, coinglass.ModeCount)
	}
}

// TestCoinglassUpstreamRefusalIs502: CoinGlass answering success:false is a
// REAL answer. It must reach the caller as a 502 carrying upstream's own
// message — never as a 200 whose data is empty.
func TestCoinglassUpstreamRefusalIs502(t *testing.T) {
	h := cgServer(t, cgDoer{refusal: `{"code":"40001","msg":"Required Integer parameter 'pageNum' is not present","success":false}`})
	rec := cgGet(t, h, "/api/coinglass?mode=fundingRate")
	if rec.Code != 502 {
		t.Fatalf("status = %d, want 502 (body %s)", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v", err)
	}
	if body["error"] != coinglass.ErrUpstream {
		t.Fatalf("error = %v, want %q", body["error"], coinglass.ErrUpstream)
	}
	if body["code"] != "40001" {
		t.Fatalf("code = %v, want 40001", body["code"])
	}
	if d, _ := body["detail"].(string); !strings.Contains(d, "pageNum") {
		t.Fatalf("upstream's message was lost: %v", body["detail"])
	}
}

// TestCoinglassMethodNotAllowed: the family is read-only.
func TestCoinglassMethodNotAllowed(t *testing.T) {
	h := cgServer(t, cgDoer{fixture: "real-statistics"})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/coinglass?mode=statistics", strings.NewReader("{}")))
	if rec.Code != 405 {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

// TestCoinglassHealthzNamesTheFamily: the family must be visible from one probe,
// and labelled keyless — that is its reason to exist.
func TestCoinglassHealthzNamesTheFamily(t *testing.T) {
	h := cgServer(t, cgDoer{fixture: "real-statistics"})
	rec := cgGet(t, h, "/healthz")
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("healthz: %v", err)
	}
	got, _ := body["coinglass"].(string)
	if !strings.Contains(got, "keyless") {
		t.Fatalf("healthz coinglass = %q, want it to say keyless", got)
	}
}
