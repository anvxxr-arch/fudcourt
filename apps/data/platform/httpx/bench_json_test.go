package httpx

// Measurement harness for the JSON response path. It exists to answer ONE
// question with numbers rather than intuition: should the data surface
// gzip-compress its bodies?
//
// Measured on a 1000-bar /ohlcv payload (the fattest read the platform serves):
//
//	identity      274,550 B   ~0.95 ms   (BenchmarkEncodeIdentity)
//	gzip BestSpeed 31,559 B   ~2.6 ms    (BenchmarkGzipBestSpeed)  = 8.7x smaller
//
// The decision RECORDED here: do NOT compress at this layer. The hop is
// loopback to the web tier (bandwidth is free), the parent request is already
// compressed by Cloudflare at the edge, and spending ~1.8 ms of p50 CPU to
// shrink a body nobody pays to move is a net loss. The figures live in the
// benchmark so a later change is compared against a real baseline, not a guess.
//
//	go test ./apps/data/platform/httpx/ -bench=. -benchmem

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"testing"
	"time"
)

type benchBar struct {
	InstrumentID string    `json:"instrument_id"`
	VenueID      string    `json:"venue_id"`
	Timeframe    string    `json:"timeframe"`
	OpenTime     time.Time `json:"open_time"`
	CloseTime    time.Time `json:"close_time"`
	O            float64   `json:"o"`
	H            float64   `json:"h"`
	L            float64   `json:"l"`
	C            float64   `json:"c"`
	VWAP         *float64  `json:"vwap"`
	Source       string    `json:"source"`
	RetrievedAt  time.Time `json:"retrieved_at"`
}

func benchPayload(n int) []byte {
	bars := make([]benchBar, n)
	for i := range bars {
		v := 1.5 + float64(i)*0.01
		bars[i] = benchBar{
			InstrumentID: "instrument:x", VenueID: "venue:binance", Timeframe: "1d",
			OpenTime:  time.Unix(1_700_000_000+int64(i)*86400, 0).UTC(),
			CloseTime: time.Unix(1_700_086_399+int64(i)*86400, 0).UTC(),
			O:         v, H: v * 1.01, L: v * 0.99, C: v * 1.002, VWAP: &v,
			Source: "binance", RetrievedAt: time.Unix(1_700_000_000, 0).UTC(),
		}
	}
	out, err := json.Marshal(map[string]any{"data": bars})
	if err != nil {
		panic(err)
	}
	return out
}

func BenchmarkEncodeIdentity(b *testing.B) {
	body := benchPayload(1000)
	b.ReportAllocs()
	b.SetBytes(int64(len(body)))
	for b.Loop() {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(map[string]any{"data": body}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkGzipBestSpeed(b *testing.B) {
	body := benchPayload(1000)
	b.ReportAllocs()
	b.SetBytes(int64(len(body)))
	for b.Loop() {
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
		if _, err := zw.Write(body); err != nil {
			b.Fatal(err)
		}
		if err := zw.Close(); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkGzipRatio reports the wire-size reduction for the two payload sizes
// the platform serves most (a default page and a capped 1000-row read).
func BenchmarkGzipRatio(b *testing.B) {
	for _, n := range []int{100, 1000} {
		body := benchPayload(n)
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
		_, _ = zw.Write(body)
		_ = zw.Close()
		b.Logf("rows=%d identity=%d gzip=%d ratio=%.2fx", n, len(body), buf.Len(),
			float64(len(body))/float64(buf.Len()))
	}
}
