package serve

// Benchmarks for the /api/data/* hot path: the HTTP envelope (JSON framing,
// which every response pays) and the read handlers end to end through the real
// middleware chain, measured against the in-memory fakeReader. No network, no
// database, no clock — the numbers are the CPU/alloc cost of the surface
// itself, not of Postgres.
//
// They exist so a change to the envelope, the limit/window parsing or the
// middleware chain can be priced before it ships (the objective's
// "benchmark-driven decisions" rule). Run:
//
//	go test ./apps/data/internal/ingest/serve/ -bench=. -benchmem

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// benchReader seeds a realistic row set: 1000 ohlcv bars (the default cap the
// /ohlcv handler can serve) and a small entity list.
func benchReader() *fakeReader {
	r := &fakeReader{}
	r.assets = make([]canon.Asset, 100)
	for i := range r.assets {
		r.assets[i] = canon.Asset{AssetID: fmt.Sprintf("asset:%d", i), Symbol: fmt.Sprintf("A%d", i), Kind: "crypto"}
	}
	r.ohlcv = make([]canon.Ohlcv, 1000)
	for i := range r.ohlcv {
		r.ohlcv[i] = canon.Ohlcv{
			InstrumentID: "instrument:btcusdt", VenueID: "venue:binance",
			Timeframe: "1d", O: 1, H: 2, L: 0.5, C: 1.5, Source: "binance",
		}
	}
	return r
}

func benchServer() http.Handler {
	return New(benchReader(), writerStore{&testWriter{}}, func() []ingest.Module { return nil }, nil)
}

func BenchmarkHandleList100(b *testing.B) {
	h := benchServer()
	b.ReportAllocs()
	for b.Loop() {
		req := httptest.NewRequest(http.MethodGet, "/api/data/assets?limit=100", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 200 {
			b.Fatalf("status %d", rec.Code)
		}
	}
}

func BenchmarkHandleOhlcv1000(b *testing.B) {
	h := benchServer()
	b.ReportAllocs()
	for b.Loop() {
		req := httptest.NewRequest(http.MethodGet, "/api/data/ohlcv?instrument=instrument:btcusdt&venue=venue:binance&timeframe=1d&limit=1000", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 200 {
			b.Fatalf("status %d", rec.Code)
		}
	}
}

// BenchmarkHandleNotFound prices the 404 path (envelope + middleware + mux
// fallthrough), the most common response an unauthenticated prober sees.
func BenchmarkHandleNotFound(b *testing.B) {
	h := benchServer()
	b.ReportAllocs()
	for b.Loop() {
		req := httptest.NewRequest(http.MethodGet, "/api/data/nope", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
	}
}

func BenchmarkLimitParam(b *testing.B) {
	req := httptest.NewRequest(http.MethodGet, "/api/data/assets?limit=250", nil)
	b.ReportAllocs()
	for b.Loop() {
		if _, err := limitParam(req); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkWindowParse(b *testing.B) {
	req := httptest.NewRequest(http.MethodGet, "/api/data/timeseries?start=2026-01-01T00:00:00Z&end=2026-02-01", nil)
	b.ReportAllocs()
	for b.Loop() {
		if _, _, err := window(req); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkRequestIDGeneration prices the per-request correlation id (the
// middleware every request pays).
func BenchmarkRequestIDGeneration(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		if newRequestID() == "" {
			b.Fatal("empty id")
		}
	}
}
