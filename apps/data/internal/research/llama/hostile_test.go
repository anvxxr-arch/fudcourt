package llama

// Turn-3 QA hostile-HTTP suite: the behaviours this family's fetch path had
// never proven — a slow upstream bounded by the caller's context, a cancelled
// context, a body past the 16 MiB cap, and a 429 whose Retry-After header is
// deliberately unheeded (single attempt is the whole rate-limit policy).
// Status/shape/transport/cache/single-flight paths are already proven in
// shape_test.go. The family allowlists its three URLs inside Fetch
// (fetch.go:272), so hostile upstreams are injected as Doers behind the
// REAL upstream URL rather than httptest servers. Deterministic, no network.

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// ctxBlockDoer blocks until the request context ends, then returns its error —
// the shape of a slowloris upstream as the client experiences it.
type ctxBlockDoer struct {
	calls int
}

func (d *ctxBlockDoer) Do(req *http.Request) (*http.Response, error) {
	d.calls++
	<-req.Context().Done()
	return nil, req.Context().Err()
}

// A slow upstream is bounded by the caller's context: the fetch ends when the
// deadline ends, with a transport-kind *HardError and exactly one attempt.
func TestHostileSlowUpstreamIsBoundedByContext(t *testing.T) {
	d := &ctxBlockDoer{}
	f, err := New(Options{Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, _, _, ferr := f.Fetch(ctx, UpstreamURL("chains"))
	elapsed := time.Since(start)
	he, ok := IsHardError(ferr)
	if !ok {
		t.Fatalf("slow upstream: err = %v, want *HardError", ferr)
	}
	if he.Kind != "transport" {
		t.Errorf("slow upstream: kind = %q, want transport", he.Kind)
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
	_, _, _, ferr := f.Fetch(ctx, UpstreamURL("chains"))
	if _, ok := IsHardError(ferr); !ok {
		t.Fatalf("cancelled ctx: err = %v, want *HardError", ferr)
	}
	if time.Since(start) > time.Second {
		t.Errorf("cancelled ctx: fetch outlived the cancel (%v)", time.Since(start))
	}
}

// A body streamed past the 16 MiB cap is cut, not buffered: the read ends
// within bounds and the truncated JSON fails the list check loudly.
func TestHostileHugeBodyIsBounded(t *testing.T) {
	// > 16 MiB of valid-JSON-so-far array rows with no closing bracket: the
	// cap cuts mid-row, so decode must fail loudly instead of shipping rows.
	huge := `[` + strings.Repeat(`{"name":"x","tvl":1},`, 1<<21) // ~38 MiB
	d := &staticBodyDoer{body: huge}
	f, err := New(Options{Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	start := time.Now()
	_, total, _, ferr := f.Fetch(context.Background(), UpstreamURL("chains"))
	if elapsed := time.Since(start); elapsed > 8*time.Second {
		t.Errorf("huge body: fetch took %v, want bounded", elapsed)
	}
	he, ok := IsHardError(ferr)
	if !ok {
		t.Fatalf("huge body: err = nil (total=%d), truncated JSON must fail loudly", total)
	}
	if he.Kind != "non-json" && he.Kind != "not-a-list" {
		t.Errorf("huge body: kind = %q, want non-json or not-a-list", he.Kind)
	}
}

// A 429 is exactly ONE upstream attempt: the Retry-After header is deliberately
// unheeded — backing off is the caller's job, and an in-process sleep would
// turn one slow upstream into a stuck handler.
func TestHostile429WithRetryAfterIsSingleAttempt(t *testing.T) {
	d := &fakeDoer{
		code: map[string]int{UpstreamURL("chains"): 429},
		body: map[string]string{UpstreamURL("chains"): "slow down"},
	}
	wrapped := &headerDoer{inner: d, headers: http.Header{"Retry-After": []string{"120"}}}
	f, err := New(Options{Client: wrapped})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	start := time.Now()
	_, _, _, ferr := f.Fetch(context.Background(), UpstreamURL("chains"))
	he, ok := IsHardError(ferr)
	if !ok {
		t.Fatalf("429: err = %v, want *HardError", ferr)
	}
	if he.Kind != "rate-limit" {
		t.Errorf("429: kind = %q, want rate-limit", he.Kind)
	}
	if n := d.calls[UpstreamURL("chains")]; n != 1 {
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
