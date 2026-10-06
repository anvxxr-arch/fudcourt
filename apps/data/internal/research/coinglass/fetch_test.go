package coinglass

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// countingDoer answers a canned body and counts calls, so a test can prove
// whether the disk cache was actually consulted or a live fetch happened.
type countingDoer struct {
	body  string
	calls int32
}

func (d *countingDoer) Do(*http.Request) (*http.Response, error) {
	atomic.AddInt32(&d.calls, 1)
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(d.body)),
	}, nil
}

func (d *countingDoer) callCount() int32 { return atomic.LoadInt32(&d.calls) }

// seed writes one warm Entry for rawURL, exactly as writeCache would.
func seed(t *testing.T, f *Fetcher, rawURL, body string) {
	t.Helper()
	e := Entry{URL: rawURL, Status: http.StatusOK, Body: body, CacheTS: "1", FetchedAt: time.Now().Unix()}
	b, err := json.Marshal(e)
	if err != nil {
		t.Fatalf("marshal entry: %v", err)
	}
	if err := os.WriteFile(f.pathFor(rawURL), b, 0o644); err != nil {
		t.Fatalf("seed cache: %v", err)
	}
}

func newTestFetcher(t *testing.T, d Doer) *Fetcher {
	t.Helper()
	f, err := New(Options{Client: d, CacheDir: t.TempDir()})
	if err != nil {
		t.Fatalf("coinglass.New: %v", err)
	}
	return f
}

const testURL = "https://capi.coinglass.com/api/futures/home/statistics"

// TestFetchWarmGoodBodyIsAHIT: a cached body that still decrypts is served from
// disk — the live transport must NOT be touched.
func TestFetchWarmGoodBodyIsAHIT(t *testing.T) {
	good := `{"code":"0","msg":"success","success":true,"data":{"openInterest":123}}`
	d := &countingDoer{body: good}
	f := newTestFetcher(t, d)
	seed(t, f, testURL, good)

	res, info, err := f.Fetch(context.Background(), testURL)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if info.Cache != "HIT" {
		t.Fatalf("Cache = %q, want HIT", info.Cache)
	}
	if got := d.callCount(); got != 0 {
		t.Fatalf("live Doer called %d times, want 0 — the warm entry was not used", got)
	}
	if res.Refused() {
		t.Fatalf("a good cached body reads as refused: %s", res.JSON)
	}
}

// TestFetchWarmRefusalIsAMissNotAStickyHit is the guard this family was missing.
// A cached refusal must NOT be served as a HIT: that would pin upstream's "no"
// to the disk for the whole TTL, so a recovered upstream would stay invisible.
// The read must be a MISS and re-fetch, returning the recovered body.
func TestFetchWarmRefusalIsAMissNotAStickyHit(t *testing.T) {
	recovered := `{"code":"0","msg":"success","success":true,"data":{"recovered":true}}`
	d := &countingDoer{body: recovered}
	f := newTestFetcher(t, d)
	// The exact refusal shape upstream answers a missing pageNum with.
	seed(t, f, testURL, `{"code":"40001","msg":"Required Integer parameter 'pageNum' is not present","success":false,"data":null}`)

	res, info, err := f.Fetch(context.Background(), testURL)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if info.Cache != "MISS" {
		t.Fatalf("Cache = %q, want MISS — a cached refusal must not be a sticky HIT", info.Cache)
	}
	if got := d.callCount(); got != 1 {
		t.Fatalf("live Doer called %d times, want 1 — the read must re-fetch past the refusal", got)
	}
	if res.Refused() {
		t.Fatalf("the re-fetched body still reads as refused: %s", res.JSON)
	}
	if !strings.Contains(string(res.JSON), "recovered") {
		t.Fatalf("Fetch returned %s, want the live recovered body", res.JSON)
	}
}

// TestFetchWarmUndecodableBodyIsAMiss: a cached body that no longer decrypts
// (here: an encrypted-looking `data` string with no v/user headers) is a MISS,
// not a hard failure — the live fetch re-derives and reports any real error.
func TestFetchWarmUndecodableBodyIsAMiss(t *testing.T) {
	good := `{"code":"0","msg":"success","success":true,"data":{"ok":1}}`
	d := &countingDoer{body: good}
	f := newTestFetcher(t, d)
	seed(t, f, testURL, `{"code":"0","msg":"success","success":true,"data":"QUFBQQ=="}`)

	res, info, err := f.Fetch(context.Background(), testURL)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if info.Cache != "MISS" {
		t.Fatalf("Cache = %q, want MISS — an undecodable warm entry must re-fetch", info.Cache)
	}
	if got := d.callCount(); got != 1 {
		t.Fatalf("live Doer called %d times, want 1", got)
	}
	if !strings.Contains(string(res.JSON), `"ok"`) {
		t.Fatalf("Fetch returned %s, want the live body", res.JSON)
	}
}
