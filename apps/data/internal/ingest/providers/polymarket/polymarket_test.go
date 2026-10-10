package polymarket

import (
	"context"
	"crypto/tls"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// fakeDoer answers every request with a canned status+body and records the
// last URL (tests assert the endpoint+query shape).
type fakeDoer struct {
	status int
	body   string
	seen   []string
}

func (f *fakeDoer) Do(r *http.Request) (*http.Response, error) {
	f.seen = append(f.seen, r.URL.String())
	return &http.Response{
		StatusCode: f.status,
		Body:       newReadCloser(f.body),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    r,
	}, nil
}

// spyWriter counts the writes each dataset performs.
type spyWriter struct {
	markets int
	provSym int
	err     error
}

func (w *spyWriter) UpsertAssets(ctx context.Context, rows []canon.Asset) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertChains(ctx context.Context, rows []canon.Chain) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertVenues(ctx context.Context, rows []canon.Venue) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertInstruments(ctx context.Context, rows []canon.Instrument) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertProtocols(ctx context.Context, rows []canon.Protocol) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertSeries(ctx context.Context, rows []canon.SeriesMeta) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertProviderSymbols(ctx context.Context, rows []canon.ProviderSymbol) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.provSym += len(rows)
	return len(rows), nil
}
func (w *spyWriter) WriteOhlcv(ctx context.Context, rows []canon.Ohlcv) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteTrades(ctx context.Context, rows []canon.Trade) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteQuotes(ctx context.Context, rows []canon.Quote) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteOrderbook(ctx context.Context, rows []canon.OrderbookSnap) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteLiquidations(ctx context.Context, rows []canon.Liquidation) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteOptionQuotes(ctx context.Context, rows []canon.OptionQuote) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteObservations(ctx context.Context, rows []canon.Observation) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteFunding(ctx context.Context, rows []canon.FundingRate) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteOpenInterest(ctx context.Context, rows []canon.OpenInterest) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WritePools(ctx context.Context, rows []canon.Pool) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteArticles(ctx context.Context, rows []canon.Article) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WritePredictionMarkets(ctx context.Context, rows []canon.PredictionMarket) (int, int, error) {
	if w.err != nil {
		return 0, 0, w.err
	}
	w.markets += len(rows)
	return len(rows), 0, nil
}
func (w *spyWriter) WriteChainTVL(ctx context.Context, rows []canon.ChainTVL) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteProtocolTVL(ctx context.Context, rows []canon.ProtocolTVL) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteSupply(ctx context.Context, rows []canon.SupplySnapshot) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteMetric(ctx context.Context, seriesID string, points []canon.MetricPoint) (int, error) {
	return 0, w.err
}

// newReadCloser is a tiny io.ReadCloser over a string.
func newReadCloser(s string) ioReadCloser { return ioReadCloser{strings.NewReader(s)} }

type ioReadCloser struct{ *strings.Reader }

func (ioReadCloser) Close() error { return nil }

// Fixtures trimmed from the real Gamma endpoint (shape-true, values real).
// outcomes/outcomePrices are JSON-encoded strings on the wire — the shape
// this package exists to decode twice.
const marketsFixture = `[
 {"id":"559651",
  "question":"Xi Jinping out before 2027?",
  "outcomes":"[\"Yes\", \"No\"]",
  "outcomePrices":"[\"0.0305\", \"0.9695\"]",
  "liquidityNum":552332.11091,
  "volumeNum":14672210.308967989,
  "volume24hr":204249.61335300002,
  "endDate":"2027-01-01T04:59:00Z",
  "active":true,
  "closed":false},
 {"id":"12345",
  "question":"Will it snow in NYC on Dec 25?",
  "outcomes":"[\"Yes\", \"No\"]",
  "outcomePrices":"[\"0.25\",\"0.75\"]",
  "liquidityNum":1234.5,
  "volumeNum":0,
  "volume24hr":0,
  "endDate":"",
  "active":true,
  "closed":false},
 {"id":"999",
  "question":"Broken array market",
  "outcomes":"not-json",
  "outcomePrices":"[\"0.5\"]",
  "active":true,
  "closed":false}
]`

// captureWriter spies and keeps the rows for identity assertions.
type captureWriter struct {
	spyWriter
	markets []canon.PredictionMarket
	symbols []canon.ProviderSymbol
}

func (w *captureWriter) UpsertProviderSymbols(ctx context.Context, rows []canon.ProviderSymbol) (int, error) {
	w.symbols = append(w.symbols, rows...)
	return w.spyWriter.UpsertProviderSymbols(ctx, rows)
}
func (w *captureWriter) WritePredictionMarkets(ctx context.Context, rows []canon.PredictionMarket) (int, int, error) {
	w.markets = append(w.markets, rows...)
	return w.spyWriter.WritePredictionMarkets(ctx, rows)
}

func TestMarketsMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: marketsFixture}
	c := newClient(fd, 0)
	w := &captureWriter{}
	res, err := (&fetcher{dataset: "markets", client: c, maxPages: 1}).Fetch(context.Background(),
		ingest.Job{Provider: "polymarket", Dataset: "markets", Mode: "poll"}, w)
	if err != nil {
		t.Fatalf("markets: %v", err)
	}
	// Two well-formed rows; the not-json outcomes row is rejected.
	if res.RowsWritten != 2 || res.RowsRejected != 1 {
		t.Fatalf("rows: written %d rejected %d", res.RowsWritten, res.RowsRejected)
	}
	if len(w.markets) != 2 || w.provSym != 2 {
		t.Fatalf("markets %d symbols %d", len(w.markets), w.provSym)
	}
	if !strings.HasPrefix(fd.seen[0], "https://gamma-api.polymarket.com/markets?limit=100&offset=0&active=true&closed=false") {
		t.Fatalf("url: %s", fd.seen[0])
	}
	// The market id mints with the prediction kind over PredictKey.
	wantID := canon.MintID(canon.KindPrediction, canon.PredictKey("polymarket", "559651"))
	if w.markets[0].MarketID != wantID {
		t.Fatalf("market id %q, want %q", w.markets[0].MarketID, wantID)
	}
	if w.markets[0].MarketID[:len("prediction:")] != "prediction:" {
		t.Fatalf("market id %q does not carry the prediction prefix", w.markets[0].MarketID)
	}
	m := w.markets[0]
	if m.Question != "Xi Jinping out before 2027?" {
		t.Fatalf("question %q", m.Question)
	}
	if len(m.Outcomes) != 2 || m.Outcomes[0] != "Yes" || m.Outcomes[1] != "No" {
		t.Fatalf("outcomes %v", m.Outcomes)
	}
	if len(m.Prices) != 2 || m.Prices[0] != 0.0305 || m.Prices[1] != 0.9695 {
		t.Fatalf("prices %v", m.Prices)
	}
	if m.LiquidityUSD == nil || *m.LiquidityUSD != 552332.11091 {
		t.Fatalf("liquidity %v", m.LiquidityUSD)
	}
	// volume24hr carries the 24h figure; volumeNum is lifetime and maps
	// nowhere on the canon row.
	if m.Volume24hUSD == nil || *m.Volume24hUSD != 204249.61335300002 {
		t.Fatalf("volume24h %v", m.Volume24hUSD)
	}
	if m.EndDate == nil || !m.EndDate.Equal(time.Date(2027, 1, 1, 4, 59, 0, 0, time.UTC)) {
		t.Fatalf("end date %v", m.EndDate)
	}
	if m.ResolutionStatus != "active" {
		t.Fatalf("status %q", m.ResolutionStatus)
	}
	if m.Source != "polymarket" || m.RetrievedAt.IsZero() {
		t.Fatalf("source %q retrieved %v", m.Source, m.RetrievedAt)
	}
	// The second market has zero volume/liquidity fields at 0: nil, not 0.
	m2 := w.markets[1]
	if m2.LiquidityUSD == nil || *m2.LiquidityUSD != 1234.5 {
		t.Fatalf("m2 liquidity %v", m2.LiquidityUSD)
	}
	if m2.Volume24hUSD != nil {
		t.Fatalf("m2 volume should stay nil, got %v", *m2.Volume24hUSD)
	}
	if m2.EndDate != nil {
		t.Fatal("m2 end date should stay nil")
	}
	// Provider symbol pins (gamma id -> prediction id).
	if w.symbols[0].Provider != "polymarket" || w.symbols[0].ProviderSymb != "559651" ||
		w.symbols[0].Kind != "prediction" || w.symbols[0].CanonicalID != wantID {
		t.Fatalf("symbol %+v", w.symbols[0])
	}
	// Cursor resumes at the next offset.
	if got, ok := res.Next["offset"].(float64); !ok || got != 3 {
		t.Fatalf("next offset: %v", res.Next["offset"])
	}
}

func TestMarketsCursorResumesOffset(t *testing.T) {
	fd := &fakeDoer{status: 200, body: "[]"}
	c := newClient(fd, 0)
	job := ingest.Job{
		Provider: "polymarket", Dataset: "markets", Mode: "poll",
		Cursor: ingest.Cursor{"offset": float64(300)},
	}
	res, err := (&fetcher{dataset: "markets", client: c, maxPages: 1}).Fetch(context.Background(), job, &spyWriter{})
	if err != nil {
		t.Fatalf("markets: %v", err)
	}
	if !strings.HasPrefix(fd.seen[0], "https://gamma-api.polymarket.com/markets?limit=100&offset=300&active=true&closed=false") {
		t.Fatalf("url: %s", fd.seen[0])
	}
	if got, ok := res.Next["offset"].(float64); !ok || got != 300 {
		t.Fatalf("next offset: %v", res.Next["offset"])
	}
}

func TestStatusErrorIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 503, body: `{"error":"service unavailable"}`}
	c := newClient(fd, 0)
	_, err := (&fetcher{dataset: "markets", client: c, maxPages: 1}).Fetch(context.Background(),
		ingest.Job{Provider: "polymarket", Dataset: "markets"}, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" || he.Status != 503 {
		t.Fatalf("want status HardError, got %v", err)
	}
}

func TestNonJSONIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: "<html>nope</html>"}
	c := newClient(fd, 0)
	_, err := (&fetcher{dataset: "markets", client: c, maxPages: 1}).Fetch(context.Background(),
		ingest.Job{Provider: "polymarket", Dataset: "markets"}, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestUnknownDatasetIsHardError(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "[]"}, 0)
	_, err := (&fetcher{dataset: "nope", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "polymarket", Dataset: "nope"}, &spyWriter{})
	if err == nil {
		t.Fatal("unknown dataset must be a HardError")
	}
}

func TestJobsRegistered(t *testing.T) {
	m := NewModule(nil)
	if m.Provider() != "polymarket" {
		t.Fatalf("provider %q", m.Provider())
	}
	js := m.Jobs()
	if len(js) != 1 || js[0].Dataset != "markets" || js[0].Mode != "poll" || !js[0].Enabled {
		t.Fatalf("jobs: %+v", js)
	}
	if js[0].Schedule != 5*time.Minute {
		t.Fatalf("schedule %v", js[0].Schedule)
	}
	f := m.Fetchers()
	if len(f) != 1 {
		t.Fatalf("fetchers: %v", f)
	}
	if _, ok := f["markets"]; !ok {
		t.Fatal("no markets fetcher")
	}
}

// TestDefaultDoerIsSharedTunedTransport pins the TLS posture the live
// ingestion run depended on: a nil Doer must build on the SAME shared
// platform transport the research families use (TLS >= 1.2, HTTP/2-capable,
// proxy-from-environment) — the construction that reached api.llama.fi and
// api.coingecko.com successfully. No per-provider transport, no
// InsecureSkipVerify anywhere in the stack (the platform transport does not
// ship one; grep-proven), so a MITM certificate still fails verification and
// can never be silently accepted.
func TestDefaultDoerIsSharedTunedTransport(t *testing.T) {
	c := newClient(nil, 0)
	hc, ok := c.do.(*http.Client)
	if !ok {
		t.Fatalf("default Doer is %T, want *http.Client from httpx", c.do)
	}
	tr, ok := hc.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport is %T, want the shared *http.Transport", hc.Transport)
	}
	if tr.TLSClientConfig == nil || tr.TLSClientConfig.MinVersion != tls.VersionTLS12 {
		t.Errorf("TLSClientConfig.MinVersion = %v, want TLS 1.2", tr.TLSClientConfig)
	}
	if !tr.ForceAttemptHTTP2 {
		t.Error("ForceAttemptHTTP2 false: the HTTP/2 posture regressed")
	}
	if tr.TLSClientConfig != nil && tr.TLSClientConfig.InsecureSkipVerify {
		t.Error("InsecureSkipVerify set: verification must stay on")
	}
	if tr.Proxy == nil {
		t.Error("Proxy nil: the environment's proxy rules must apply as the research families see them")
	}
}
