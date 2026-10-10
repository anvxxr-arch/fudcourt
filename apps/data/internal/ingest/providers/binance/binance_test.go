package binance

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
	ohlcv  int
	fund   int
	oi     int
	quotes int
	assets int
	venues int
	instr  int
	provS  int
	err    error
}

func (w *spyWriter) UpsertAssets(ctx context.Context, rows []canon.Asset) (int, error) {
	w.assets += len(rows)
	return len(rows), w.err
}

func (w *spyWriter) UpsertChains(ctx context.Context, rows []canon.Chain) (int, error) {
	return 0, w.err
}

func (w *spyWriter) UpsertVenues(ctx context.Context, rows []canon.Venue) (int, error) {
	w.venues += len(rows)
	return len(rows), w.err
}

func (w *spyWriter) UpsertInstruments(ctx context.Context, rows []canon.Instrument) (int, error) {
	w.instr += len(rows)
	return len(rows), w.err
}

func (w *spyWriter) UpsertProtocols(ctx context.Context, rows []canon.Protocol) (int, error) {
	return 0, w.err
}

func (w *spyWriter) UpsertSeries(ctx context.Context, rows []canon.SeriesMeta) (int, error) {
	return 0, w.err
}

func (w *spyWriter) UpsertProviderSymbols(ctx context.Context, rows []canon.ProviderSymbol) (int, error) {
	w.provS += len(rows)
	return len(rows), w.err
}

func (w *spyWriter) WriteOhlcv(ctx context.Context, rows []canon.Ohlcv) (int, int, error) {
	if w.err != nil {
		return 0, 0, w.err
	}
	w.ohlcv += len(rows)
	return len(rows), 0, nil
}

func (w *spyWriter) WriteTrades(ctx context.Context, rows []canon.Trade) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteQuotes(ctx context.Context, rows []canon.Quote) (int, int, error) {
	if w.err != nil {
		return 0, 0, w.err
	}
	w.quotes += len(rows)
	return len(rows), 0, nil
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
	if w.err != nil {
		return 0, 0, w.err
	}
	w.fund += len(rows)
	return len(rows), 0, nil
}

func (w *spyWriter) WriteOpenInterest(ctx context.Context, rows []canon.OpenInterest) (int, int, error) {
	if w.err != nil {
		return 0, 0, w.err
	}
	w.oi += len(rows)
	return len(rows), 0, nil
}

func (w *spyWriter) WritePools(ctx context.Context, rows []canon.Pool) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteArticles(ctx context.Context, rows []canon.Article) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WritePredictionMarkets(ctx context.Context, rows []canon.PredictionMarket) (int, int, error) {
	return 0, 0, w.err
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

// Fixtures trimmed from the real endpoints (shape-true, values real).
const klinesFixture = `[
 ["1697049600000","27945.01","27956.00","27853.11","27945.01","3.566","99829.86","1697049659999","0","0","0","0","0","0"]
]`

const fundingFixture = `[
 {"symbol":"BTCUSDT","fundingTime":1697049600000,"fundingRate":"0.00010000","markPrice":"27945.01"}
]`

const oiSnapshotFixture = `{"symbol":"BTCUSDT","openInterest":"10659.309","time":1533270900000}`

const oiHistFixture = `[
 {"symbol":"BTCUSDT","sumOpenInterest":"20493.63","sumOpenInterestValue":"1570570874.07","timestamp":1583127900000}
]`

const tickerOneFixture = `{"symbol":"BTCUSDT","priceChange":"-95.13","priceChangePercent":"-0.34",
 "lastPrice":"27945.01","bidPrice":"27944.00","askPrice":"27945.01","bidQty":"1.2","askQty":"0.5",
 "volume":"123456.7","quoteVolume":"3456789000.12","closeTime":1697049659999}`

const tickerErrFixture = `{"code":-1121,"msg":"Invalid symbol."}`

func TestKlinesSpotMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: klinesFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "binance", Dataset: "ohlcv", Subject: "spot:BTCUSDT", Mode: "poll"}
	res, err := (&fetcher{dataset: "ohlcv", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("klines: %v", err)
	}
	if w.ohlcv != 1 || res.RowsWritten != 1 {
		t.Fatalf("ohlcv rows: %d/%d", w.ohlcv, res.RowsWritten)
	}
	if len(fd.seen) != 1 || !strings.HasPrefix(fd.seen[0], "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m") {
		t.Fatalf("url: %v", fd.seen)
	}
}

func TestKlinesPerpUsesFapi(t *testing.T) {
	fd := &fakeDoer{status: 200, body: klinesFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "binance", Dataset: "ohlcv", Subject: "linear_perp:BTCUSDT", Mode: "poll"}
	if _, err := (&fetcher{dataset: "ohlcv", client: c}).Fetch(context.Background(), job, w); err != nil {
		t.Fatalf("perp klines: %v", err)
	}
	if !strings.HasPrefix(fd.seen[0], "https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT") {
		t.Fatalf("perp url: %s", fd.seen[0])
	}
}

func TestFundingMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: fundingFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "binance", Dataset: "funding", Subject: "BTCUSDT", Mode: "poll"}
	res, err := (&fetcher{dataset: "funding", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("funding: %v", err)
	}
	if w.fund != 1 || res.RowsWritten != 1 {
		t.Fatalf("funding rows: %d/%d", w.fund, res.RowsWritten)
	}
	if !strings.HasPrefix(fd.seen[0], "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT") {
		t.Fatalf("funding url: %s", fd.seen[0])
	}
}

func TestOpenInterestSnapshotAndHist(t *testing.T) {
	fd := &fakeDoer{status: 200, body: oiSnapshotFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "binance", Dataset: "open-interest", Subject: "BTCUSDT", Mode: "poll"}
	if _, err := (&fetcher{dataset: "open-interest", client: c}).Fetch(context.Background(), job, w); err != nil {
		t.Fatalf("oi snapshot: %v", err)
	}
	if w.oi != 1 {
		t.Fatalf("oi rows: %d", w.oi)
	}
	if !strings.HasPrefix(fd.seen[0], "https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT") {
		t.Fatalf("oi url: %s", fd.seen[0])
	}

	// backfill mode reads the hist endpoint.
	fd2 := &fakeDoer{status: 200, body: oiHistFixture}
	c2 := newClient(fd2, 0)
	job2 := ingest.Job{Provider: "binance", Dataset: "open-interest", Subject: "BTCUSDT", Mode: "backfill"}
	if _, err := (&fetcher{dataset: "open-interest", client: c2}).Fetch(context.Background(), job2, &spyWriter{}); err != nil {
		t.Fatalf("oi hist: %v", err)
	}
	if !strings.HasPrefix(fd2.seen[0], "https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=5m") {
		t.Fatalf("oi hist url: %s", fd2.seen[0])
	}
}

func TestTickerSingleSymbol(t *testing.T) {
	fd := &fakeDoer{status: 200, body: tickerOneFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "binance", Dataset: "ticker", Subject: "BTCUSDT", Mode: "poll"}
	res, err := (&fetcher{dataset: "ticker", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("ticker: %v", err)
	}
	if w.quotes != 1 || res.RowsWritten != 1 {
		t.Fatalf("quote rows: %d/%d", w.quotes, res.RowsWritten)
	}
	if !strings.HasPrefix(fd.seen[0], "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT") {
		t.Fatalf("ticker url: %s", fd.seen[0])
	}
}

func TestErrorEnvelopeIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 400, body: tickerErrFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "binance", Dataset: "ticker", Subject: "NOPE", Mode: "poll"}
	_, err := (&fetcher{dataset: "ticker", client: c}).Fetch(context.Background(), job, w)
	he, ok := err.(*HardError)
	if !ok {
		t.Fatalf("want HardError, got %T: %v", err, err)
	}
	if he.Kind != "api-error" || he.Status != 400 {
		t.Fatalf("HardError = %+v", he)
	}
	if w.quotes != 0 {
		t.Fatalf("rows written on error: %d", w.quotes)
	}
}

func TestShapeMismatchIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `[[1,2,3]]`} // kline row too short
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "binance", Dataset: "ohlcv", Subject: "spot:BTCUSDT", Mode: "poll"}
	_, err := (&fetcher{dataset: "ohlcv", client: c}).Fetch(context.Background(), job, w)
	if _, ok := err.(*HardError); !ok {
		t.Fatalf("want HardError, got %T: %v", err, err)
	}
	if w.ohlcv != 0 {
		t.Fatalf("rows written on shape error: %d", w.ohlcv)
	}
}

func TestNonJSONIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `<html>blocked</html>`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "binance", Dataset: "funding", Subject: "BTCUSDT", Mode: "poll"}
	_, err := (&fetcher{dataset: "funding", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestInstrumentIDsDeterministic(t *testing.T) {
	// The same natural key must mint the same id across calls (MintID parity).
	a := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: "binance", MarketType: "linear_perp", Base: "BTC", Quote: "USDT",
	}))
	b := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: "binance", MarketType: "linear_perp", Base: "BTC", Quote: "USDT",
	}))
	if a != b || a == "" {
		t.Fatalf("id drift: %q vs %q", a, b)
	}
	if !strings.HasPrefix(a, "instrument:") {
		t.Fatalf("id prefix: %q", a)
	}
}

func TestJobsRegistered(t *testing.T) {
	m := NewModule(nil)
	if m.Provider() != "binance" {
		t.Fatalf("provider: %s", m.Provider())
	}
	fetchers := m.Fetchers()
	for _, ds := range []string{"ohlcv", "funding", "open-interest", "ticker", "trades", "depth"} {
		if _, ok := fetchers[ds]; !ok {
			t.Fatalf("missing fetcher %s", ds)
		}
	}
	jobs := m.Jobs()
	if len(jobs) == 0 {
		t.Fatalf("no jobs registered")
	}
	var ohlcvPoll, funding5, oi5 bool
	for _, j := range jobs {
		if j.Provider != "binance" || !j.Enabled {
			t.Fatalf("job spec: %+v", j)
		}
		switch {
		case j.Dataset == "ohlcv" && j.Schedule == time.Minute:
			ohlcvPoll = true
		case j.Dataset == "funding" && j.Schedule == 5*time.Minute:
			funding5 = true
		case j.Dataset == "open-interest" && j.Schedule == 5*time.Minute:
			oi5 = true
		}
	}
	if !ohlcvPoll || !funding5 || !oi5 {
		t.Fatalf("seed jobs wrong: %+v", jobs)
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
