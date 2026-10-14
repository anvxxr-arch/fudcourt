package serve

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// blockingReader hangs every read until the context is cancelled, then reports
// the cancellation — the shape of a query that outlives storeTimeout.
type blockingReader struct{ fakeReader }

func (b *blockingReader) ListAssets(ctx context.Context, q canon.ListQuery) ([]canon.Asset, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// TestStoreTimeoutCancelsHungRead pins the reliability bound the `get` wrapper
// adds: a read that never answers is cancelled at storeTimeout and surfaces as
// the loud 503, instead of pinning a pool connection for the life of the
// request (eight of which would wedge the whole read surface).
func TestStoreTimeoutCancelsHungRead(t *testing.T) {
	h := New(&blockingReader{}, writerStore{&testWriter{}},
		func() []ingest.Module { return nil }, nil)

	// The bound is 15s in production; shrink the wall clock by cancelling the
	// REQUEST context, which is the parent of the store context the wrapper
	// derives. The point under test is that the wrapper's derived context is
	// what the handler waits on.
	start := time.Now()
	req := httptest.NewRequest(http.MethodGet, "/api/data/assets", nil)
	ctx, cancel := context.WithTimeout(req.Context(), 50*time.Millisecond)
	defer cancel()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req.WithContext(ctx))
	if time.Since(start) > 2*time.Second {
		t.Fatalf("read did not return promptly: %v", time.Since(start))
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("hung read = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
}

// counterReader records how many times a read ran, to prove the middleware
// chain does not double-dispatch.
type counterReader struct {
	fakeReader
	calls int
}

func (c *counterReader) ListAssets(ctx context.Context, q canon.ListQuery) ([]canon.Asset, error) {
	c.calls++
	return c.fakeReader.ListAssets(ctx, q)
}

func TestMiddlewareDispatchesOnce(t *testing.T) {
	r := &counterReader{}
	h := New(r, writerStore{&testWriter{}}, func() []ingest.Module { return nil }, nil)
	rec, _ := get(t, h, "/api/data/assets")
	if rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	if r.calls != 1 {
		t.Fatalf("reader called %d times, want 1", r.calls)
	}
}

// TestPanicBecomesLoudEnvelope pins the containment: a handler that panics
// answers the canonical 500 envelope with a correlation id, instead of
// dropping the connection with no body.
type panickingReader struct{ fakeReader }

func (p *panickingReader) ListAssets(context.Context, canon.ListQuery) ([]canon.Asset, error) {
	panic("boom: simulated store panic")
}

func TestPanicBecomesLoudEnvelope(t *testing.T) {
	h := New(&panickingReader{}, writerStore{&testWriter{}}, func() []ingest.Module { return nil }, nil)
	rec, body := get(t, h, "/api/data/assets")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("panic = %d, want 500", rec.Code)
	}
	errObj, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("error envelope missing: %v", body)
	}
	if errObj["code"] != "internal" {
		t.Fatalf("code = %v, want internal", errObj["code"])
	}
	if rec.Header().Get("X-Request-Id") == "" {
		t.Fatal("contained panic must still carry X-Request-Id")
	}
}

// TestErrorEnvelopeCarriesRequestID pins correlation on the refusal path.
func TestErrorEnvelopeCarriesRequestID(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.err = errors.New("store down")
	rec, body := get(t, h, "/api/data/assets")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d", rec.Code)
	}
	errObj, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("error envelope missing: %v", body)
	}
	if errObj["request_id"] == "" || errObj["request_id"] == nil {
		t.Fatalf("error envelope missing request_id: %v", errObj)
	}
	if rec.Header().Get("X-Request-Id") != errObj["request_id"] {
		t.Fatalf("header id %q != body id %v", rec.Header().Get("X-Request-Id"), errObj["request_id"])
	}
}

// TestInboundRequestIDAdopted pins that a well-formed caller id survives, and a
// malformed one is replaced (log-forging guard).
func TestInboundRequestIDAdopted(t *testing.T) {
	h, _, _ := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/data/assets", nil)
	req.Header.Set("X-Request-Id", "abc-123_ok")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("X-Request-Id"); got != "abc-123_ok" {
		t.Fatalf("adopted id = %q, want abc-123_ok", got)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/data/assets", nil)
	req.Header.Set("X-Request-Id", "bad id\nwith newline")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("X-Request-Id"); got == "bad id\nwith newline" || got == "" {
		t.Fatalf("malformed id = %q, want a generated replacement", got)
	}
}
