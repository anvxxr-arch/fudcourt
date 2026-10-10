package bybit

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

// Fixtures trimmed from the real v5 endpoints (shape-true, values real):
// every result payload is wrapped in {"list":[...]}; kline rows are arrays of
// string numbers ([openTimeMs, open, high, low, close, volume, turnover]).
const klineFixture = `{"retCode":0,"retMsg":"OK","result":{"category":"spot","symbol":"BTCUSDT","list":[["1707163200000","42630","42714","42554","42661","2541.073","108434803.5"]]}}`

const fundingFixture = `{"retCode":0,"retMsg":"OK","result":{"category":"linear","list":[{"symbol":"BTCUSDT","fundingRate":"0.0001","fundingRateTimestamp":"1707163200000"}]}}`

const oiFixture = `{"retCode":0,"retMsg":"OK","result":{"category":"linear","symbol":"BTCUSDT","list":[{"symbol":"BTCUSDT","openInterest":"275.391","timestamp":"1707163200000"}]}}`

const tickersFixture = `{"retCode":0,"retMsg":"OK","result":{"category":"spot","list":[{"symbol":"BTCUSDT","bid1Price":"42660.10","bid1Size":"1.254","ask1Price":"42660.20","ask1Size":"0.971","lastPrice":"42660.19","volume24h":"7246.19","turnover24h":"309814230.0"}]}}`

const instrumentsFixture = `{"retCode":0,"retMsg":"OK","result":{"category":"spot","list":[{"symbol":"BTCUSDT","baseCoin":"BTC","quoteCoin":"USDT","status":"Trading"},{"symbol":"ETHUSDT","baseCoin":"ETH","quoteCoin":"USDT","status":"Trading"}]}}`

const retCodeErrFixture = `{"retCode":10001,"retMsg":"params error","result":{}}`

const klineShortFixture = `{"retCode":0,"retMsg":"OK","result":{"list":[["1707163200000","42630"]]}}`

func TestKlinesSpotMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: klineFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "bybit", Dataset: "ohlcv", Subject: "spot:BTCUSDT", Mode: "poll"}
	res, err := (&fetcher{dataset: "ohlcv", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("klines: %v", err)
	}
	if w.ohlcv != 1 || res.RowsWritten != 1 {
		t.Fatalf("ohlcv rows: %d/%d", w.ohlcv, res.RowsWritten)
	}
	if len(fd.seen) != 1 || !strings.HasPrefix(fd.seen[0], "https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=1") {
		t.Fatalf("url: %v", fd.seen)
	}
	if !strings.Contains(fd.seen[0], "limit=1000") {
		t.Fatalf("limit missing: %s", fd.seen[0])
	}
}

func TestKlinesPerpUsesLinearCategory(t *testing.T) {
	fd := &fakeDoer{status: 200, body: klineFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "bybit", Dataset: "ohlcv", Subject: "linear_perp:BTCUSDT", Mode: "poll"}
	if _, err := (&fetcher{dataset: "ohlcv", client: c}).Fetch(context.Background(), job, w); err != nil {
		t.Fatalf("perp klines: %v", err)
	}
	if !strings.HasPrefix(fd.seen[0], "https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=1") {
		t.Fatalf("perp url: %s", fd.seen[0])
	}
}

func TestKlinesWindowCursors(t *testing.T) {
	fd := &fakeDoer{status: 200, body: klineFixture}
	c := newClient(fd, 0)
	job := ingest.Job{
		Provider: "bybit", Dataset: "ohlcv", Subject: "spot:BTCUSDT", Mode: "backfill",
		Cursor: ingest.Cursor{"start": int64(1707163200000), "end": int64(1707249600000)},
	}
	if _, err := (&fetcher{dataset: "ohlcv", client: c}).Fetch(context.Background(), job, &spyWriter{}); err != nil {
		t.Fatalf("windowed klines: %v", err)
	}
	if !strings.Contains(fd.seen[0], "start=1707163200000") || !strings.Contains(fd.seen[0], "end=1707249600000") {
		t.Fatalf("window params: %s", fd.seen[0])
	}
}

func TestFundingMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: fundingFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "bybit", Dataset: "funding", Subject: "BTCUSDT", Mode: "poll"}
	res, err := (&fetcher{dataset: "funding", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("funding: %v", err)
	}
	if w.fund != 1 || res.RowsWritten != 1 {
		t.Fatalf("funding rows: %d/%d", w.fund, res.RowsWritten)
	}
	if !strings.HasPrefix(fd.seen[0], "https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT") {
		t.Fatalf("funding url: %s", fd.seen[0])
	}
}

func TestOpenInterestUsesFiveMinInterval(t *testing.T) {
	fd := &fakeDoer{status: 200, body: oiFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "bybit", Dataset: "open-interest", Subject: "BTCUSDT", Mode: "poll"}
	if _, err := (&fetcher{dataset: "open-interest", client: c}).Fetch(context.Background(), job, w); err != nil {
		t.Fatalf("oi: %v", err)
	}
	if w.oi != 1 {
		t.Fatalf("oi rows: %d", w.oi)
	}
	if !strings.HasPrefix(fd.seen[0], "https://api.bybit.com/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=5min") {
		t.Fatalf("oi url: %s", fd.seen[0])
	}
}

func TestTickerSingleSymbolRegistersProviderSymbols(t *testing.T) {
	fd := &fakeDoer{status: 200, body: tickersFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "bybit", Dataset: "ticker", Subject: "spot:BTCUSDT", Mode: "poll"}
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
	if !strings.HasPrefix(fd.seen[0], "https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT") {
		t.Fatalf("ticker url: %s", fd.seen[0])
	}
}

func TestInstrumentsUpserts(t *testing.T) {
	fd := &fakeDoer{status: 200, body: instrumentsFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "bybit", Dataset: "instruments", Subject: "spot", Mode: "backfill"}
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
	if !strings.HasPrefix(fd.seen[0], "https://api.bybit.com/v5/market/instruments-info?category=spot") {
		t.Fatalf("instruments url: %s", fd.seen[0])
	}
}

// TestInstrumentsBadRowsCountedNotFatal pins the row policy: a list entry
// with a missing symbol or an undecodable pair is counted rejected and the
// good rows still land; the whole dataset fails only when the envelope
// itself is malformed (that path is TestNonJSONIsHardError).
func TestInstrumentsBadRowsCountedNotFatal(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `{"retCode":0,"retMsg":"OK","result":{"category":"spot","list":[
	 {"symbol":"","baseCoin":"BTC","quoteCoin":"USDT","status":"Trading"},
	 {"symbol":"NOPE","baseCoin":"","quoteCoin":"USDT","status":"Trading"},
	 {"symbol":"BTCUSDT","baseCoin":"BTC","quoteCoin":"USDT","status":"Trading"}
	]}}`}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "bybit", Dataset: "instruments", Subject: "spot", Mode: "backfill"}
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
	fd := &fakeDoer{status: 200, body: `{"retCode":0,"retMsg":"OK","result":{"category":"spot","list":[
	 {"symbol":"","baseCoin":"BTC","quoteCoin":"USDT","status":"Trading"}
	]}}`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "bybit", Dataset: "instruments", Subject: "spot", Mode: "backfill"}
	res, err := (&fetcher{dataset: "instruments", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError for an all-bad universe, got %v", err)
	}
	if res.RowsRejected != 0 || res.RowsWritten != 0 {
		t.Fatalf("result on error: %+v", res)
	}
}

func TestRetCodeErrorIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: retCodeErrFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "bybit", Dataset: "ticker", Subject: "spot:NOPE", Mode: "poll"}
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
	job := ingest.Job{Provider: "bybit", Dataset: "funding", Subject: "BTCUSDT", Mode: "poll"}
	_, err := (&fetcher{dataset: "funding", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestShapeMismatchIsHardError(t *testing.T) {
	// kline row too short (inside the real envelope shape).
	fd := &fakeDoer{status: 200, body: klineShortFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "bybit", Dataset: "ohlcv", Subject: "spot:BTCUSDT", Mode: "poll"}
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
		VenueID: "bybit", MarketType: "linear_perp", Base: "BTC", Quote: "USDT",
	}))
	b := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: "bybit", MarketType: "linear_perp", Base: "BTC", Quote: "USDT",
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
	if m.Provider() != "bybit" {
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
		if j.Provider != "bybit" || !j.Enabled {
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
