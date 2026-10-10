package okx

import (
	"context"
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
	instr  int
	provS  int
	err    error
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
	if w.err != nil {
		return 0, w.err
	}
	w.instr += len(rows)
	return len(rows), nil
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
	w.provS += len(rows)
	return len(rows), nil
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

// Fixtures trimmed from the real v5 endpoints (shape-true, values real).
const candlesFixture = `{"code":"0","msg":"","data":[
 ["1707163800000","42670.2","42690.5","42650.1","42680.3","1.23","52475.1","52475.1","0"],
 ["1707163200000","42630.1","42714","42554","42661","254.07","10843480.3","10843480.3","1"]
]}`

const fundingFixture = `{"code":"0","msg":"","data":[
 {"instId":"BTC-USDT-SWAP","instType":"SWAP","fundingRate":"0.0001","realizedRate":"0.0001","fundingTime":"1707163200000"}
]}`

const oiFixture = `{"code":"0","msg":"","data":[
 {"instId":"BTC-USDT-SWAP","instType":"SWAP","oi":"5754450","oiCcy":"5754.45","oiUsd":"237953549.4","ts":"1707163200000"}
]}`

const tickersFixture = `{"code":"0","msg":"","data":[
 {"instId":"BTC-USDT","last":"42661","bidPx":"42660.1","askPx":"42660.2","bidSz":"1.254","askSz":"0.971","vol24h":"7246.19","volCcy24h":"309814230.0","ts":"1707163200000"}
]}`

const instrumentsFixture = `{"code":"0","msg":"","data":[
 {"instId":"BTC-USDT","baseCcy":"BTC","quoteCcy":"USDT","state":"live"},
 {"instId":"ETH-USDT","baseCcy":"ETH","quoteCcy":"USDT","state":"live"}
]}`

const codeErrFixture = `{"code":"51001","msg":"Instrument ID does not exist","data":[]}`

func TestCandlesSpotMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: candlesFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "okx", Dataset: "ohlcv", Subject: "spot:BTC-USDT", Mode: "poll"}
	res, err := (&fetcher{dataset: "ohlcv", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("candles: %v", err)
	}
	// Two rows in, one written: the newest row has confirm "0" (still forming).
	if w.ohlcv != 1 || res.RowsWritten != 1 {
		t.Fatalf("ohlcv rows: %d/%d", w.ohlcv, res.RowsWritten)
	}
	if len(fd.seen) != 1 || !strings.HasPrefix(fd.seen[0], "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1m") {
		t.Fatalf("url: %v", fd.seen)
	}
	if !strings.Contains(fd.seen[0], "limit=300") {
		t.Fatalf("limit missing: %s", fd.seen[0])
	}
}

func TestCandlesPerpUsesSwapInstID(t *testing.T) {
	fd := &fakeDoer{status: 200, body: candlesFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "okx", Dataset: "ohlcv", Subject: "linear_perp:BTC-USDT", Mode: "poll"}
	if _, err := (&fetcher{dataset: "ohlcv", client: c}).Fetch(context.Background(), job, w); err != nil {
		t.Fatalf("perp candles: %v", err)
	}
	if !strings.HasPrefix(fd.seen[0], "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=1m") {
		t.Fatalf("perp url: %s", fd.seen[0])
	}
}

func TestFundingMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: fundingFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "okx", Dataset: "funding", Subject: "linear_perp:BTC-USDT", Mode: "poll"}
	res, err := (&fetcher{dataset: "funding", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("funding: %v", err)
	}
	if w.fund != 1 || res.RowsWritten != 1 {
		t.Fatalf("funding rows: %d/%d", w.fund, res.RowsWritten)
	}
	if !strings.HasPrefix(fd.seen[0], "https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP") {
		t.Fatalf("funding url: %s", fd.seen[0])
	}
}

func TestOpenInterestSnapshot(t *testing.T) {
	fd := &fakeDoer{status: 200, body: oiFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "okx", Dataset: "open-interest", Subject: "linear_perp:BTC-USDT", Mode: "poll"}
	if _, err := (&fetcher{dataset: "open-interest", client: c}).Fetch(context.Background(), job, w); err != nil {
		t.Fatalf("oi: %v", err)
	}
	if w.oi != 1 {
		t.Fatalf("oi rows: %d", w.oi)
	}
	if !strings.HasPrefix(fd.seen[0], "https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP") {
		t.Fatalf("oi url: %s", fd.seen[0])
	}
}

func TestOpenInterestMissingBothFieldsIsShapeError(t *testing.T) {
	// oi and oiUsd AND oiCcy all absent: nothing real to write (never-fake).
	fd := &fakeDoer{status: 200, body: `{"code":"0","data":[{"instId":"BTC-USDT-SWAP","instType":"SWAP","ts":"1707163200000"}]}`}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "okx", Dataset: "open-interest", Subject: "linear_perp:BTC-USDT", Mode: "poll"}
	_, err := (&fetcher{dataset: "open-interest", client: c}).Fetch(context.Background(), job, w)
	if _, ok := err.(*HardError); !ok {
		t.Fatalf("want HardError, got %T: %v", err, err)
	}
	if w.oi != 0 {
		t.Fatalf("rows written on shape error: %d", w.oi)
	}
}

func TestTickerRegistersProviderSymbols(t *testing.T) {
	fd := &fakeDoer{status: 200, body: tickersFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "okx", Dataset: "ticker", Subject: "spot:BTC-USDT", Mode: "poll"}
	res, err := (&fetcher{dataset: "ticker", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("ticker: %v", err)
	}
	if w.quotes != 1 || res.RowsWritten != 1 {
		t.Fatalf("quote rows: %d/%d", w.quotes, res.RowsWritten)
	}
	if w.provS != 1 {
		t.Fatalf("provider symbols: %d", w.provS)
	}
	if !strings.HasPrefix(fd.seen[0], "https://www.okx.com/api/v5/market/tickers?instType=SPOT&instId=BTC-USDT") {
		t.Fatalf("ticker url: %s", fd.seen[0])
	}
}

func TestTickerEmptySubjectFetchesWholeMarket(t *testing.T) {
	fd := &fakeDoer{status: 200, body: tickersFixture}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "okx", Dataset: "ticker", Subject: "", Mode: "poll"}
	if _, err := (&fetcher{dataset: "ticker", client: c}).Fetch(context.Background(), job, &spyWriter{}); err != nil {
		t.Fatalf("market tickers: %v", err)
	}
	if fd.seen[0] != "https://www.okx.com/api/v5/market/tickers?instType=SPOT" {
		t.Fatalf("market ticker url: %s", fd.seen[0])
	}
}

func TestInstrumentsUpserts(t *testing.T) {
	fd := &fakeDoer{status: 200, body: instrumentsFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "okx", Dataset: "instruments", Subject: "spot", Mode: "backfill"}
	res, err := (&fetcher{dataset: "instruments", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("instruments: %v", err)
	}
	if w.instr != 2 || res.RowsWritten != 2 {
		t.Fatalf("instrument rows: %d/%d", w.instr, res.RowsWritten)
	}
	if w.provS != 2 {
		t.Fatalf("provider symbols: %d", w.provS)
	}
	if !strings.HasPrefix(fd.seen[0], "https://www.okx.com/api/v5/public/instruments?instType=SPOT") {
		t.Fatalf("instruments url: %s", fd.seen[0])
	}
}

// TestInstrumentsPerpSplitsSwapInstID pins the SWAP mapping: the instruments
// rows carry ctValCcy/settleCcy (the contract currency), NOT the pair, so
// base/quote split off the instId (BTC-USDT-SWAP -> BTC/USDT) and settleCcy
// must agree.
func TestInstrumentsPerpSplitsSwapInstID(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `{"code":"0","msg":"","data":[
	 {"instId":"BTC-USDT-SWAP","instType":"SWAP","ctValCcy":"BTC","settleCcy":"USDT","state":"live"},
	 {"instId":"ETH-USDT-SWAP","instType":"SWAP","ctValCcy":"ETH","settleCcy":"USDT","state":"live"}
	]}`}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "okx", Dataset: "instruments", Subject: "linear_perp", Mode: "backfill"}
	res, err := (&fetcher{dataset: "instruments", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("instruments: %v", err)
	}
	if !strings.HasPrefix(fd.seen[0], "https://www.okx.com/api/v5/public/instruments?instType=SWAP") {
		t.Fatalf("instruments url: %s", fd.seen[0])
	}
	if w.instr != 2 || res.RowsWritten != 2 || res.RowsRejected != 0 {
		t.Fatalf("rows: %d/%d rejected %d", w.instr, res.RowsWritten, res.RowsRejected)
	}
}

// TestInstrumentsBadRowsCountedNotFatal pins the row policy: SPOT rows with a
// missing instId or an empty base/quote are counted rejected and the good
// rows still land; the whole dataset fails only when the envelope itself is
// malformed (that path is TestNonJSONIsHardError).
func TestInstrumentsBadRowsCountedNotFatal(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `{"code":"0","msg":"","data":[
	 {"instId":"","baseCcy":"BTC","quoteCcy":"USDT","state":"live"},
	 {"instId":"BTC-UNKNOWN","baseCcy":"","quoteCcy":"USDT","state":"live"},
	 {"instId":"BTC-USDT","baseCcy":"BTC","quoteCcy":"USDT","state":"live"}
	]}`}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "okx", Dataset: "instruments", Subject: "spot", Mode: "backfill"}
	res, err := (&fetcher{dataset: "instruments", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("bad rows must not hard-error: %v", err)
	}
	if res.RowsRejected != 2 || w.instr != 1 {
		t.Fatalf("rejected %d, written %d", res.RowsRejected, w.instr)
	}
}

// TestInstrumentsAllBadIsDatasetHardError pins the boundary: when EVERY row
// is rejected while the envelope decoded, the dataset fails as a shape
// HardError (the engine's breaker owns a drifted universe; it is not waved
// through as a quiet success). One bad row among good ones is still just a
// count — that path is TestInstrumentsBadRowsCountedNotFatal.
func TestInstrumentsAllBadIsDatasetHardError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `{"code":"0","msg":"","data":[
	 {"instId":"","baseCcy":"BTC","quoteCcy":"USDT","state":"live"}
	]}`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "okx", Dataset: "instruments", Subject: "spot", Mode: "backfill"}
	res, err := (&fetcher{dataset: "instruments", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError for an all-bad universe, got %v", err)
	}
	if res.RowsRejected != 0 || res.RowsWritten != 0 {
		t.Fatalf("result on error: %+v", res)
	}
}

func TestCodeErrorIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: codeErrFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "okx", Dataset: "ticker", Subject: "spot:NOPE-USDT", Mode: "poll"}
	_, err := (&fetcher{dataset: "ticker", client: c}).Fetch(context.Background(), job, w)
	he, ok := err.(*HardError)
	if !ok {
		t.Fatalf("want HardError, got %T: %v", err, err)
	}
	if he.Kind != "api-error" {
		t.Fatalf("HardError = %+v", he)
	}
	if w.quotes != 0 {
		t.Fatalf("rows written on error: %d", w.quotes)
	}
}

func TestNonJSONIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `<html>blocked</html>`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "okx", Dataset: "funding", Subject: "linear_perp:BTC-USDT", Mode: "poll"}
	_, err := (&fetcher{dataset: "funding", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestShapeMismatchIsHardError(t *testing.T) {
	// candle row too short.
	fd := &fakeDoer{status: 200, body: `{"code":"0","data":[["1707163200000","42630"]]}`}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "okx", Dataset: "ohlcv", Subject: "spot:BTC-USDT", Mode: "poll"}
	_, err := (&fetcher{dataset: "ohlcv", client: c}).Fetch(context.Background(), job, w)
	if _, ok := err.(*HardError); !ok {
		t.Fatalf("want HardError, got %T: %v", err, err)
	}
	if w.ohlcv != 0 {
		t.Fatalf("rows written on shape error: %d", w.ohlcv)
	}
}

func TestInstrumentIDsDeterministic(t *testing.T) {
	// The same natural key must mint the same id across calls (MintID parity).
	a := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: "okx", MarketType: "linear_perp", Base: "BTC", Quote: "USDT",
	}))
	b := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: "okx", MarketType: "linear_perp", Base: "BTC", Quote: "USDT",
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
	if m.Provider() != "okx" {
		t.Fatalf("provider: %s", m.Provider())
	}
	fetchers := m.Fetchers()
	for _, ds := range []string{"ohlcv", "funding", "open-interest", "ticker", "instruments"} {
		if _, ok := fetchers[ds]; !ok {
			t.Fatalf("missing fetcher %s", ds)
		}
	}
	jobs := m.Jobs()
	if len(jobs) == 0 {
		t.Fatalf("no jobs registered")
	}
	var ohlcv1m, funding5, oi5 bool
	for _, j := range jobs {
		if j.Provider != "okx" || !j.Enabled {
			t.Fatalf("job spec: %+v", j)
		}
		switch {
		case j.Dataset == "ohlcv" && j.Schedule == time.Minute:
			ohlcv1m = true
		case j.Dataset == "funding" && j.Schedule == 5*time.Minute:
			funding5 = true
		case j.Dataset == "open-interest" && j.Schedule == 5*time.Minute:
			oi5 = true
		}
	}
	if !ohlcv1m || !funding5 || !oi5 {
		t.Fatalf("seed jobs wrong: %+v", jobs)
	}
}
