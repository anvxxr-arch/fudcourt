package coinmarketcap

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

// fakeDoer returns a canned response and records the last request, so the fetch
// path is exercised without touching the network.
type fakeDoer struct {
	status int
	body   string
	last   *http.Request
	calls  int
}

func (f *fakeDoer) Do(req *http.Request) (*http.Response, error) {
	f.calls++
	f.last = req
	return &http.Response{
		StatusCode: f.status,
		Body:       io.NopCloser(strings.NewReader(f.body)),
		Header:     make(http.Header),
	}, nil
}

func newTestFetcher(t *testing.T, d Doer) *Fetcher {
	t.Helper()
	f, err := New(Options{CacheDir: t.TempDir(), Client: d, NoCache: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return f
}

const listingOK = `{"data":{"cryptoCurrencyList":[{"id":1},{"id":2},{"id":3}],"totalCount":"8138"},"status":{"timestamp":"t","error_code":"0","error_message":"","elapsed":"1","credit_count":0}}`

func TestDecodeSuccess(t *testing.T) {
	res, err := Decode("http://x", []byte(listingOK))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if res.Envelope.Status.ErrorCode != "0" {
		t.Errorf("error_code = %q, want 0", res.Envelope.Status.ErrorCode)
	}
}

func TestDecodeRefusalIsError(t *testing.T) {
	// A 200 carrying error_code != "0" is a refusal, never an empty result.
	for _, tc := range []struct{ code, msg string }{
		{"400", `"\"value\" must contain at least one of [id, rwaId, slug, rwaSlug]"`},
		{"500", `"The system is busy, please try again later!"`},
	} {
		body := `{"status":{"timestamp":"t","error_code":"` + tc.code + `","error_message":` + tc.msg + `,"elapsed":"1","credit_count":0}}`
		_, err := Decode("http://x", []byte(body))
		var he *HardError
		if !errors.As(err, &he) {
			t.Fatalf("code %s: err = %v, want *HardError", tc.code, err)
		}
		if he.Kind != "upstream" || he.Code != tc.code {
			t.Errorf("code %s: got kind=%q code=%q", tc.code, he.Kind, he.Code)
		}
	}
}

func TestEnvelopeVerbatimAndCount(t *testing.T) {
	d := &fakeDoer{status: 200, body: listingOK}
	f := newTestFetcher(t, d)
	svc := Service{F: f}
	env, err := svc.Envelope(context.Background(), "listing", "", 1, 100, true)
	if err != nil {
		t.Fatalf("Envelope: %v", err)
	}
	if env.Kind != "listing" {
		t.Errorf("Kind = %q", env.Kind)
	}
	if env.UpstreamCount == nil || *env.UpstreamCount != 3 {
		t.Errorf("UpstreamCount = %v, want 3", env.UpstreamCount)
	}
	if env.Start == nil || *env.Start != 1 || env.Limit == nil || *env.Limit != 100 {
		t.Errorf("pagination echo = %v/%v, want 1/100", env.Start, env.Limit)
	}
	if !strings.Contains(env.Derived, "verbatim") {
		t.Errorf("Derived = %q, want it to say verbatim", env.Derived)
	}
	if env.Auth != AuthNote {
		t.Errorf("Auth = %q", env.Auth)
	}
	// The request carried no credential.
	if v := d.last.Header.Get("X-CMC_PRO_API_KEY"); v != "" {
		t.Errorf("unexpected API key header %q", v)
	}
}

func TestEnvelopeObjectModeHasNoCount(t *testing.T) {
	d := &fakeDoer{status: 200, body: `{"data":{"btcDominance":59.0},"status":{"error_code":"0"}}`}
	f := newTestFetcher(t, d)
	svc := Service{F: f}
	env, err := svc.Envelope(context.Background(), "global", "", 0, 0, true)
	if err != nil {
		t.Fatalf("Envelope: %v", err)
	}
	if env.UpstreamCount != nil {
		t.Errorf("UpstreamCount = %v, want nil for an object payload", *env.UpstreamCount)
	}
	if env.Start != nil || env.Limit != nil {
		t.Errorf("global must not echo pagination")
	}
}

func TestEnvelopeNullDataIsError(t *testing.T) {
	d := &fakeDoer{status: 200, body: `{"data":null,"status":{"error_code":"0"}}`}
	f := newTestFetcher(t, d)
	svc := Service{F: f}
	_, err := svc.Envelope(context.Background(), "listing", "", 1, 10, true)
	var he *HardError
	if !errors.As(err, &he) || he.Kind != "non-json" {
		t.Fatalf("err = %v, want non-json HardError", err)
	}
}

func TestEnvelopeMarketPairsEchoesSlug(t *testing.T) {
	d := &fakeDoer{status: 200, body: `{"data":{"marketPairs":[{"a":1}]},"status":{"error_code":"0"}}`}
	f := newTestFetcher(t, d)
	svc := Service{F: f}
	env, err := svc.Envelope(context.Background(), "marketPairs", "bitcoin", 1, 2, true)
	if err != nil {
		t.Fatalf("Envelope: %v", err)
	}
	if env.Slug != "bitcoin" {
		t.Errorf("Slug = %q, want bitcoin", env.Slug)
	}
	if !strings.Contains(env.Upstream, "slug=bitcoin") {
		t.Errorf("Upstream = %q, want it to carry slug=bitcoin", env.Upstream)
	}
}

func TestFetchHTTPError(t *testing.T) {
	d := &fakeDoer{status: 503, body: "nope"}
	f := newTestFetcher(t, d)
	_, _, err := f.Fetch(context.Background(), Base+"/x")
	if err == nil || !strings.Contains(err.Error(), "HTTP 503") {
		t.Fatalf("err = %v, want an HTTP 503 error", err)
	}
}

func TestCacheHitThenMiss(t *testing.T) {
	d := &fakeDoer{status: 200, body: listingOK}
	// Cache ENABLED (NoCache false) so the second call is a HIT.
	f, err := New(Options{CacheDir: t.TempDir(), Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	url := UpstreamURL("listing", "", 1, 100)
	if _, info, err := f.Fetch(context.Background(), url); err != nil || info.Cache != "MISS" {
		t.Fatalf("first fetch: info=%+v err=%v, want MISS", info, err)
	}
	if _, info, err := f.Fetch(context.Background(), url); err != nil || info.Cache != "HIT" {
		t.Fatalf("second fetch: info=%+v err=%v, want HIT", info, err)
	}
	if d.calls != 1 {
		t.Errorf("upstream calls = %d, want 1 (second served from cache)", d.calls)
	}
}

func TestFetchFreshBypassesCache(t *testing.T) {
	d := &fakeDoer{status: 200, body: listingOK}
	f, err := New(Options{CacheDir: t.TempDir(), Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	url := UpstreamURL("listing", "", 1, 100)
	_, _, _ = f.Fetch(context.Background(), url)
	_, info, err := f.FetchFresh(context.Background(), url)
	if err != nil || info.Cache != "MISS" {
		t.Fatalf("fresh fetch: info=%+v err=%v, want MISS", info, err)
	}
	if d.calls != 2 {
		t.Errorf("upstream calls = %d, want 2", d.calls)
	}
}
