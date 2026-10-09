package coinank

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// fakeDoer captures requests and replays a canned response. Every test below
// runs without touching the network: the live shape is pinned separately by
// live_test.go behind an env gate, so a schema change upstream cannot make the
// unit suite fail for a reason the unit suite cannot fix.
type fakeDoer struct {
	status  int
	body    string
	headers map[string]string
	reqs    []*http.Request
}

func (f *fakeDoer) Do(req *http.Request) (*http.Response, error) {
	f.reqs = append(f.reqs, req)
	h := http.Header{}
	for k, v := range f.headers {
		h.Set(k, v)
	}
	return &http.Response{
		StatusCode: f.status,
		Header:     h,
		Body:       io.NopCloser(strings.NewReader(f.body)),
	}, nil
}

// fundingBody is a 2-row fixture in the live fundingRate/current shape: each row
// is a symbol carrying per-exchange maps.
const fundingBody = `{"success":true,"code":"1","extCode":null,"msg":null,"data":[` +
	`{"symbol":"BTC","umap":{"Binance":{"baseCoin":"BTC","exchangeName":"Binance","fundingRate":0.0001,"nextFundingTime":1790985600000}},` +
	`"cmap":{"Binance":{"baseCoin":"BTC","exchangeName":"Binance","fundingRate":0.0001}},"follow":false},` +
	`{"symbol":"ETH","umap":{"Binance":{"baseCoin":"ETH","exchangeName":"Binance","fundingRate":-0.0002}},"cmap":{},"follow":true}` +
	`]}`

// refusalBody is upstream's ACTUAL refusal shape: HTTP 200, success:false.
const refusalBody = `{"success":false,"code":"0","extCode":null,"msg":"system error!","data":null}`

func newTestFetcher(t *testing.T, d Doer) *Fetcher {
	t.Helper()
	f, err := New(Options{CacheDir: t.TempDir(), Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return f
}

// TestFetchSendsSignedHeaders is the core contract: a request only succeeds
// because the computed signature is attached. Asserting the header equals
// Signature(now) (rather than merely being non-empty) ties the wire request to
// the algorithm in sign.go.
func TestFetchSendsSignedHeaders(t *testing.T) {
	d := &fakeDoer{status: 200, body: fundingBody}
	f := newTestFetcher(t, d)
	pinned := time.UnixMilli(1790969044000)
	f.now = func() time.Time { return pinned }

	res, info, err := f.Fetch(context.Background(), Base+"/api/fundingRate/current")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if info.Cache != "MISS" || info.Status != 200 {
		t.Errorf("CacheInfo = %+v, want MISS/200", info)
	}
	if !res.Envelope.Success {
		t.Error("envelope Success not parsed")
	}
	if len(d.reqs) != 1 {
		t.Fatalf("want 1 upstream request, got %d", len(d.reqs))
	}
	got := d.reqs[0].Header.Get("Coinank-Apikey")
	if want := Signature(1790969044000); got != want {
		t.Errorf("Coinank-Apikey\n got %s\nwant %s", got, want)
	}
	if d.reqs[0].Header.Get("Web-Version") != WebVersion {
		t.Errorf("web-version = %q, want %q", d.reqs[0].Header.Get("Web-Version"), WebVersion)
	}
	if _, ok := d.reqs[0].Header["Token"]; !ok {
		t.Error("token header absent; the dashboard always sends it (empty when anonymous)")
	}
}

// TestUpstreamRefusalIsAnError is the anti-silence test. CoinAnk answers
// "system error!" with HTTP 200, so a client that trusts the status code renders
// a refusal as an empty table. The refusal must arrive as an error carrying
// upstream's own code and message.
func TestUpstreamRefusalIsAnError(t *testing.T) {
	f := newTestFetcher(t, &fakeDoer{status: 200, body: refusalBody})
	_, _, err := f.Fetch(context.Background(), Base+"/api/news/getNewsList")
	if err == nil {
		t.Fatal("HTTP 200 with success:false must be an error, not an empty result")
	}
	var he *HardError
	if !errors.As(err, &he) {
		t.Fatalf("want *HardError, got %T: %v", err, err)
	}
	if he.Kind != "upstream" {
		t.Errorf("HardError.Kind = %q, want upstream", he.Kind)
	}
	if he.Code != "0" {
		t.Errorf("HardError.Code = %q, want 0 (upstream's own code, verbatim)", he.Code)
	}
	if !strings.Contains(he.Detail, "system error!") {
		t.Errorf("HardError.Detail must carry upstream's message, got %q", he.Detail)
	}
}

// TestRefusalIsNotCached: a refusal must not be written to disk, or a transient
// "system error!" would be replayed for the whole TTL after upstream recovered.
func TestRefusalIsNotCached(t *testing.T) {
	d := &fakeDoer{status: 200, body: refusalBody}
	f := newTestFetcher(t, d)
	url := Base + "/api/etf/etfInflow"
	if _, _, err := f.Fetch(context.Background(), url); err == nil {
		t.Fatal("expected refusal error")
	}
	d.body = `{"success":true,"code":"1","data":[{"date":"2026-10-01"}]}`
	res, info, err := f.Fetch(context.Background(), url)
	if err != nil {
		t.Fatalf("second fetch after recovery: %v", err)
	}
	if info.Cache != "MISS" {
		t.Errorf("partial/refused body was cached: Cache = %q, want MISS", info.Cache)
	}
	if !res.Envelope.Success {
		t.Error("recovered body not parsed")
	}
}

func TestFetchNonOKStatusIsAnError(t *testing.T) {
	f := newTestFetcher(t, &fakeDoer{status: 404, body: `not found`})
	_, info, err := f.Fetch(context.Background(), Base+"/api/instruments/oiRank")
	if err == nil {
		t.Fatal("HTTP 404 must be an error")
	}
	if info.Status != 404 {
		t.Errorf("CacheInfo.Status = %d, want 404", info.Status)
	}
	if !strings.Contains(err.Error(), "404") {
		t.Errorf("error should name the status: %v", err)
	}
}

func TestFetchMalformedJSONIsAnError(t *testing.T) {
	f := newTestFetcher(t, &fakeDoer{status: 200, body: `<html>gateway</html>`})
	if _, _, err := f.Fetch(context.Background(), Base+"/api/fundingRate/current"); err == nil {
		t.Fatal("non-JSON body must be an error")
	}
}

// TestCacheHitAndFreshBypass: a warm read replays the stored body WITHOUT a new
// upstream call, and fresh=1 must always re-request (it is how the live verifier
// avoids confirming its own stale data).
func TestCacheHitAndFreshBypass(t *testing.T) {
	d := &fakeDoer{status: 200, body: fundingBody}
	f := newTestFetcher(t, d)
	url := Base + "/api/longshort/all"

	if _, info, err := f.Fetch(context.Background(), url); err != nil || info.Cache != "MISS" {
		t.Fatalf("first fetch: info=%+v err=%v", info, err)
	}
	if _, info, err := f.Fetch(context.Background(), url); err != nil || info.Cache != "HIT" {
		t.Fatalf("second fetch should be a HIT: info=%+v err=%v", info, err)
	}
	if len(d.reqs) != 1 {
		t.Fatalf("a HIT must not call upstream; got %d requests", len(d.reqs))
	}
	if _, info, err := f.FetchFresh(context.Background(), url); err != nil || info.Cache != "MISS" {
		t.Fatalf("fresh must bypass the cache: info=%+v err=%v", info, err)
	}
	if len(d.reqs) != 2 {
		t.Fatalf("fresh must issue its own upstream request; got %d requests", len(d.reqs))
	}
	// Fresh re-signs, which is the only path that exercises the live signature.
	if a, b := d.reqs[0].Header.Get("Coinank-Apikey"), d.reqs[1].Header.Get("Coinank-Apikey"); a == "" || b == "" {
		t.Error("both requests must carry a signature")
	}
}

// TestCacheExpiresByTTL pins the PER-MODE TTL table: the fundingRate path
// carries a 300s TTL (was one flat 60s for every mode), and a URL no mode
// claims falls back to the fetcher-level TTL -- never to the longest per-mode
// value, which would let a harness URL ride a 1-hour entry.
func TestCacheExpiresByTTL(t *testing.T) {
	d := &fakeDoer{status: 200, body: fundingBody}
	f := newTestFetcher(t, d)
	f.ttl = 60
	base := time.UnixMilli(1790969044000)
	f.now = func() time.Time { return base }
	url := Base + "/api/fundingRate/current"
	if _, _, err := f.Fetch(context.Background(), url); err != nil {
		t.Fatalf("seed fetch: %v", err)
	}
	f.now = func() time.Time { return base.Add(61 * time.Second) }
	if _, info, _ := f.Fetch(context.Background(), url); info.Cache != "HIT" {
		t.Errorf("at t+61s within the 300s fundingRate TTL: Cache = %q, want HIT", info.Cache)
	}
	f.now = func() time.Time { return base.Add(301 * time.Second) }
	if _, info, _ := f.Fetch(context.Background(), url); info.Cache != "MISS" {
		t.Errorf("at t+301s past the 300s fundingRate TTL: Cache = %q, want MISS", info.Cache)
	}

	// An unclaimed URL expires at the fetcher-level TTL (60s here).
	unknown := Base + "/api/harness/selftest"
	f.now = func() time.Time { return base }
	if _, _, err := f.Fetch(context.Background(), unknown); err != nil {
		t.Fatalf("unknown-path seed: %v", err)
	}
	f.now = func() time.Time { return base.Add(61 * time.Second) }
	if _, info, _ := f.Fetch(context.Background(), unknown); info.Cache != "MISS" {
		t.Errorf("unknown path must expire at the fallback TTL: Cache = %q, want MISS", info.Cache)
	}
}

func TestNoCacheOptionDisablesDiskCache(t *testing.T) {
	d := &fakeDoer{status: 200, body: fundingBody}
	f, err := New(Options{CacheDir: t.TempDir(), Client: d, NoCache: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	url := Base + "/api/fundingRate/current"
	for i := 0; i < 2; i++ {
		if _, info, err := f.Fetch(context.Background(), url); err != nil || info.Cache != "MISS" {
			t.Fatalf("NoCache must never HIT: info=%+v err=%v", info, err)
		}
	}
	if len(d.reqs) != 2 {
		t.Errorf("NoCache issued %d requests, want 2", len(d.reqs))
	}
}

// TestResolveCacheDirPrecedence pins the env precedence, including that the
// family directory is a CHILD of the shared root. Two families sharing one
// directory would make an independent verification fetch self-confirming
// (apps/data/README.md).
func TestResolveCacheDirPrecedence(t *testing.T) {
	t.Setenv("FUDCOURT_DATA_COINANK_CACHE_DIR", "")
	t.Setenv("FUDCOURT_DATA_CACHE_DIR", "/srv/cache")
	if got, want := ResolveCacheDir(), "/srv/cache/coinank"; got != want {
		t.Errorf("ResolveCacheDir() = %q, want %q", got, want)
	}
	t.Setenv("FUDCOURT_DATA_COINANK_CACHE_DIR", "/custom/here")
	if got, want := ResolveCacheDir(), "/custom/here"; got != want {
		t.Errorf("explicit override: got %q, want %q", got, want)
	}
	// The coinglass family must resolve to a DIFFERENT directory.
	t.Setenv("FUDCOURT_DATA_COINANK_CACHE_DIR", "")
	if strings.HasSuffix(ResolveCacheDir(), "/coinglass") {
		t.Fatal("coinank resolved into the coinglass cache directory")
	}
}
