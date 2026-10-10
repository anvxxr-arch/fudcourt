package chainrank

// Turn-3 QA hostile-HTTP suite: the behaviours this family's fetch path had
// never proven — a slow upstream bounded by the caller's context, a cancelled
// context, a body past the 4 MiB cap, and a 429 whose Retry-After header is
// deliberately unheeded. Status/shape/transport/gzip/single-flight are already
// proven in chainrank_test.go. Fetch allowlists its two URLs (fetch.go:218),
// so hostile upstreams are injected as Doers behind the REAL upstream URL.
// Deterministic, no network.

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// ctxBlockDoer blocks until the request context ends, then returns its error.
type ctxBlockDoer struct {
	calls int
}

func (d *ctxBlockDoer) Do(req *http.Request) (*http.Response, error) {
	d.calls++
	<-req.Context().Done()
	return nil, req.Context().Err()
}

func statsURL() string { return UpstreamURL("stats", url.Values{}) }

// A slow upstream is bounded by the caller's context: transport-kind error,
// one attempt, wall-clock near the deadline.
func TestHostileSlowUpstreamIsBoundedByContext(t *testing.T) {
	d := &ctxBlockDoer{}
	f, err := New(Options{Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, info, ferr := f.Fetch(ctx, "stats", statsURL())
	elapsed := time.Since(start)
	he, ok := IsHardError(ferr)
	if !ok {
		t.Fatalf("slow upstream: err = %v, want *HardError", ferr)
	}
	if he.Kind != "transport" {
		t.Errorf("slow upstream: kind = %q, want transport", he.Kind)
	}
	if info.Cache == "HIT" {
		t.Error("slow upstream: a failed fetch must never report a cache HIT")
	}
	if d.calls != 1 {
		t.Errorf("slow upstream: %d attempts, want 1", d.calls)
	}
	if elapsed > time.Second {
		t.Errorf("slow upstream: fetch took %v, want bounded by the 100ms context", elapsed)
	}
}

// A context cancelled mid-request stops promptly with a transport error.
func TestHostileCancelledContextStops(t *testing.T) {
	d := &ctxBlockDoer{}
	f, err := New(Options{Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	_, _, ferr := f.Fetch(ctx, "stats", statsURL())
	if _, ok := IsHardError(ferr); !ok {
		t.Fatalf("cancelled ctx: err = %v, want *HardError", ferr)
	}
	if time.Since(start) > time.Second {
		t.Errorf("cancelled ctx: fetch outlived the cancel (%v)", time.Since(start))
	}
}

// A body streamed past the 4 MiB cap is cut, not buffered: the read ends in
// bounded time and the truncated JSON fails loudly instead of shipping rows.
func TestHostileHugeBodyIsBounded(t *testing.T) {
	huge := `{"rows":[` + strings.Repeat(`{"id":"x","key":"k","kind":"handle"},`, 1<<17) // ~8.6 MiB
	d := &staticBodyDoer{body: huge}
	f, err := New(Options{Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	start := time.Now()
	_, _, ferr := f.Fetch(context.Background(), "listings", UpstreamURL("listings", url.Values{}))
	if elapsed := time.Since(start); elapsed > 8*time.Second {
		t.Errorf("huge body: fetch took %v, want bounded", elapsed)
	}
	if ferr == nil {
		t.Error("huge body: truncated JSON succeeded (want a loud failure)")
	}
}

// A 429 with a Retry-After header is exactly one upstream attempt.
func TestHostile429WithRetryAfterIsSingleAttempt(t *testing.T) {
	d := &fakeDoer{code: map[string]int{statsURL(): 429}}
	wrapped := &headerDoer{inner: d, headers: http.Header{"Retry-After": []string{"120"}}}
	f, err := New(Options{Client: wrapped})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	start := time.Now()
	_, _, ferr := f.Fetch(context.Background(), "stats", statsURL())
	he, ok := IsHardError(ferr)
	if !ok {
		t.Fatalf("429: err = %v, want *HardError", ferr)
	}
	if he.Kind != "rate-limit" {
		t.Errorf("429: kind = %q, want rate-limit", he.Kind)
	}
	if n := d.calls[statsURL()]; n != 1 {
		t.Errorf("429: %d upstream attempts, want 1", n)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("429: fetch slept %v — Retry-After must not be honoured in-process", elapsed)
	}
}

// staticBodyDoer serves one canned body for any request.
type staticBodyDoer struct {
	body string
}

func (d *staticBodyDoer) Do(req *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(strings.NewReader(d.body)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    req,
	}, nil
}

// headerDoer decorates a fakeDoer's responses with extra headers.
type headerDoer struct {
	inner   Doer
	headers http.Header
}

func (h *headerDoer) Do(req *http.Request) (*http.Response, error) {
	resp, err := h.inner.Do(req)
	if err != nil {
		return nil, err
	}
	for k, vs := range h.headers {
		for _, v := range vs {
			resp.Header.Add(k, v)
		}
	}
	return resp, nil
}
