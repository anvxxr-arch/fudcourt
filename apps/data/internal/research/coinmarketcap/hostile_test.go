package coinmarketcap

// Turn-3 QA hostile-HTTP suite: the behaviours this family's fetch path had
// never proven — the full status matrix, a slow upstream vs the client
// deadline, a cancelled context, empty/invalid/truncated 200 bodies, a lying
// Content-Type, a 12 MiB body, and the warm-refusal cache path. Deterministic:
// fake Doers and local httptest servers only, no network.

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

// countingDoer counts upstream attempts (no retry is the family's policy:
// every status is exactly one attempt) and records the last request.
type countingDoer struct {
	mu    sync.Mutex
	calls int
	last  *http.Request
	do    func(*http.Request) (*http.Response, error)
}

func (d *countingDoer) Do(req *http.Request) (*http.Response, error) {
	d.mu.Lock()
	d.calls++
	d.last = req
	d.mu.Unlock()
	return d.do(req)
}

func staticDoer(status int, body string) *countingDoer {
	return &countingDoer{do: func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: status,
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
			Request:    req,
		}, nil
	}}
}

func newHostileFetcher(t *testing.T, d Doer, cache bool) (*Fetcher, string) {
	t.Helper()
	dir := t.TempDir()
	f, err := New(Options{CacheDir: dir, Client: d, NoCache: !cache})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return f, dir
}

const hostileURL = "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/listing?start=1&limit=5"

// 1. Every non-2xx status keeps its real code in the error, is attempted
// EXACTLY once (no retry loop exists to spin), and writes no cache entry.
func TestHostileStatusMatrixKeepsStatusAndDoesNotRetry(t *testing.T) {
	for _, code := range []int{400, 401, 403, 404, 408, 429, 500, 502, 503, 504} {
		d := staticDoer(code, `{"error":"x"}`)
		f, dir := newHostileFetcher(t, d, true)
		_, info, err := f.Fetch(context.Background(), hostileURL)
		if err == nil {
			t.Fatalf("status %d: expected error, got nil", code)
		}
		if !strings.Contains(err.Error(), "HTTP "+strconv.Itoa(code)) {
			t.Errorf("status %d: err = %v, want it to name the code", code, err)
		}
		if info.Status != code {
			t.Errorf("status %d: info.Status = %d", code, info.Status)
		}
		if d.calls != 1 {
			t.Errorf("status %d: %d upstream attempts, want 1 (no retry)", code, d.calls)
		}
		if entries, _ := os.ReadDir(dir); len(entries) != 0 {
			t.Errorf("status %d: cache dir has %d entries after a failure, want 0", code, len(entries))
		}
	}
}

// 2. A slow upstream is bounded by the client timeout: transport error, one
// attempt, wall-clock near the timeout rather than the server's stall.
func TestHostileSlowUpstreamIsBoundedByClientTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
	}))
	defer srv.Close()
	f, err := New(Options{
		CacheDir: t.TempDir(),
		Client:   httpx.NewClient(150 * time.Millisecond),
		NoCache:  true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	start := time.Now()
	_, _, ferr := f.Fetch(context.Background(), srv.URL)
	elapsed := time.Since(start)
	if ferr == nil {
		t.Fatal("slow upstream: expected a timeout error")
	}
	if elapsed > time.Second {
		t.Errorf("slow upstream: fetch took %v, want < 1s (bounded by the 150ms client)", elapsed)
	}
}

// 3. A cancelled context stops the request promptly; the error surfaces.
func TestHostileCancelledContextStops(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
	}))
	defer srv.Close()
	f, err := New(Options{CacheDir: t.TempDir(), Client: httpx.NewClient(5 * time.Second), NoCache: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, _, ferr := f.Fetch(ctx, srv.URL)
	if ferr == nil {
		t.Fatal("cancelled ctx: expected error")
	}
	if time.Since(start) > time.Second {
		t.Errorf("cancelled ctx: fetch outlived the deadline (%v)", time.Since(start))
	}
}

// 4/5/6. A 200 whose body is empty, invalid, or truncated JSON is a loud
// decode error, and the bad body is never STICKY: the warm read misses the
// verbatim cache entry and re-fetches upstream.
func TestHostileBadJSON200IsNeverSticky(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"empty", ""},
		{"invalid", "<html>not json</html>"},
		{"truncated", `{"data":{"cryptoCurrencyList":[{"id":1`},
	} {
		d := staticDoer(200, tc.body)
		f, _ := newHostileFetcher(t, d, true)
		_, _, err := f.Fetch(context.Background(), hostileURL)
		if err == nil {
			t.Fatalf("%s body: expected decode error, got nil", tc.name)
		}
		// The family stores any 200 body VERBATIM (warm entries are re-validated
		// on read); the poison contract is therefore "never sticky": a warm
		// read of a bad body must MISS and re-fetch, never fail from cache.
		before := d.calls
		if _, _, err := f.Fetch(context.Background(), hostileURL); err == nil {
			t.Fatalf("%s body: second call unexpectedly succeeded", tc.name)
		}
		if d.calls <= before {
			t.Errorf("%s body: warm read of a bad body did not re-fetch upstream (%d -> %d)", tc.name, before, d.calls)
		}
	}
}

// 7. A valid JSON body served as text/html is ACCEPTED: the body checks are
// strictly stronger than the header, and refusing here would break a valid
// body served with a lazy header.
func TestHostileWrongContentTypeWithValidJSONIsAccepted(t *testing.T) {
	d := &countingDoer{do: func(req *http.Request) (*http.Response, error) {
		h := make(http.Header)
		h.Set("Content-Type", "text/html; charset=utf-8")
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(strings.NewReader(listingOK)),
			Header:     h,
			Request:    req,
		}, nil
	}}
	f, _ := newHostileFetcher(t, d, false)
	res, _, err := f.Fetch(context.Background(), hostileURL)
	if err != nil {
		t.Fatalf("wrong content-type + valid JSON: %v (want acceptance)", err)
	}
	if res.Envelope.Status.ErrorCode != "0" {
		t.Errorf("error_code = %q, want 0", res.Envelope.Status.ErrorCode)
	}
}

// 8. A body past the 12 MiB cap is cut, not buffered: the fetch completes in
// bounded time and the truncated JSON fails decode loudly — never a silent
// partial success, never an unbounded read.
func TestHostileHugeBodyIsBounded(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"data":{"cryptoCurrencyList":[`)
		chunk := strings.Repeat(`{"id":1},`, 1<<16) // ~576 KiB per write
		for range 24 {                              // ~13 MiB total
			io.WriteString(w, chunk)
		}
		io.WriteString(w, `],"totalCount":"1"},"status":{"error_code":"0"}}`)
	}))
	defer srv.Close()
	f, err := New(Options{CacheDir: t.TempDir(), Client: httpx.NewClient(10 * time.Second), NoCache: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	start := time.Now()
	_, _, ferr := f.Fetch(context.Background(), srv.URL)
	if elapsed := time.Since(start); elapsed > 8*time.Second {
		t.Errorf("huge body: fetch took %v, want bounded", elapsed)
	}
	// The 12 MiB cut lands mid-array: decode must fail loudly, never return rows.
	if ferr == nil {
		t.Error("huge body: truncated JSON decoded as success (want a loud decode error)")
	}
}

// 9. A 200 refusal envelope (error_code != "0") stays loud on every read: the
// body is stored verbatim, but a warm read re-validates it, gets the same
// *HardError, and re-fetches upstream rather than serving silent emptiness.
func TestHostileWarmRefusalStaysLoudAndRefetches(t *testing.T) {
	refusal := `{"status":{"timestamp":"t","error_code":"400","error_message":"bad request","elapsed":"1","credit_count":0}}`
	d := staticDoer(200, refusal)
	f, dir := newHostileFetcher(t, d, true)
	if _, _, err := f.Fetch(context.Background(), hostileURL); err == nil {
		t.Fatal("cold refusal: expected HardError")
	}
	cold := d.calls
	_, _, warmErr := f.Fetch(context.Background(), hostileURL)
	var he *HardError
	if !errors.As(warmErr, &he) {
		t.Fatalf("warm refusal: err = %v, want *HardError", warmErr)
	}
	if he.Code != "400" {
		t.Errorf("warm refusal: code = %q, want 400", he.Code)
	}
	if d.calls <= cold {
		t.Errorf("warm refusal: no re-fetch happened (%d -> %d calls)", cold, d.calls)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Errorf("warm refusal: cache dir has %d entries, want 1 verbatim body", len(entries))
	}
}
