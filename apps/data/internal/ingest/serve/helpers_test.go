package serve

// The in-memory canon.Reader used by the handler tests: every method answers
// from pre-seeded slices/maps, and one configurable failure mode simulates a
// store outage (503) per surface. No network, no database.
import (
	"context"
	"errors"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// fakeReader implements canon.Reader over seeded data.
type fakeReader struct {
	assets       []canon.Asset
	chains       []canon.Chain
	venues       []canon.Venue
	protocols    []canon.Protocol
	instruments  []canon.Instrument
	series       []canon.SeriesMeta
	observations []canon.Observation
	ohlcv        []canon.Ohlcv
	funding      []canon.FundingRate
	oi           []canon.OpenInterest
	trades       []canon.Trade
	orderbook    []canon.OrderbookSnap
	pools        []canon.Pool
	articles     []canon.Article
	predictions  []canon.PredictionMarket
	chainTVL     []canon.ChainTVL
	protocolTVL  []canon.ProtocolTVL
	runs         []canon.RunRecord

	// err, when non-nil, is returned by every method (store outage).
	err error
}

func (f *fakeReader) fail() error {
	if f.err != nil {
		return f.err
	}
	return nil
}

func (f *fakeReader) ListAssets(ctx context.Context, q canon.ListQuery) ([]canon.Asset, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	return clamp(f.assets, q.Limit), nil
}

func (f *fakeReader) ListChains(ctx context.Context, q canon.ListQuery) ([]canon.Chain, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	return clamp(f.chains, q.Limit), nil
}

func (f *fakeReader) ListVenues(ctx context.Context, q canon.ListQuery) ([]canon.Venue, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	return clamp(f.venues, q.Limit), nil
}

func (f *fakeReader) ListProtocols(ctx context.Context, q canon.ListQuery) ([]canon.Protocol, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	return clamp(f.protocols, q.Limit), nil
}

func (f *fakeReader) ListInstruments(ctx context.Context, q canon.InstrumentQuery) ([]canon.Instrument, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	out := make([]canon.Instrument, 0, len(f.instruments))
	for _, in := range f.instruments {
		if q.VenueID != "" && in.VenueID != q.VenueID {
			continue
		}
		if q.MarketType != "" && in.MarketType != q.MarketType {
			continue
		}
		if q.Base != "" && in.BaseSymbol != q.Base {
			continue
		}
		if q.Quote != "" && in.QuoteSymbol != q.Quote {
			continue
		}
		out = append(out, in)
	}
	return clamp(out, q.Limit), nil
}

func (f *fakeReader) ListSeries(ctx context.Context, q canon.SeriesQuery) ([]canon.SeriesMeta, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	out := make([]canon.SeriesMeta, 0, len(f.series))
	for _, s := range f.series {
		if q.Domain != "" && s.Domain != q.Domain {
			continue
		}
		if q.Metric != "" && s.Metric != q.Metric {
			continue
		}
		if q.AssetID != "" && (s.AssetID == nil || *s.AssetID != q.AssetID) {
			continue
		}
		if q.CountryID != "" && (s.CountryID == nil || *s.CountryID != q.CountryID) {
			continue
		}
		out = append(out, s)
	}
	return clamp(out, q.Limit), nil
}

func (f *fakeReader) ReadTimeseries(ctx context.Context, seriesID string, start, end time.Time, limit int) ([]canon.Observation, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	out := make([]canon.Observation, 0)
	for _, o := range f.observations {
		if seriesID != "" && o.SeriesID != seriesID {
			continue
		}
		if !start.IsZero() && o.ObservedAt.Before(start) {
			continue
		}
		if !end.IsZero() && !o.ObservedAt.Before(end) {
			continue
		}
		out = append(out, o)
	}
	return clamp(out, limit), nil
}

func (f *fakeReader) ReadOhlcv(ctx context.Context, instrumentID, venueID, timeframe string, start, end time.Time, limit int) ([]canon.Ohlcv, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	out := make([]canon.Ohlcv, 0)
	for _, b := range f.ohlcv {
		if instrumentID != "" && b.InstrumentID != instrumentID {
			continue
		}
		if venueID != "" && b.VenueID != venueID {
			continue
		}
		if timeframe != "" && b.Timeframe != timeframe {
			continue
		}
		if !start.IsZero() && b.OpenTime.Before(start) {
			continue
		}
		if !end.IsZero() && !b.OpenTime.Before(end) {
			continue
		}
		out = append(out, b)
	}
	return clamp(out, limit), nil
}

func (f *fakeReader) ReadFunding(ctx context.Context, instrumentID, venueID, asset string, start, end time.Time, limit int) ([]canon.FundingRate, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	out := make([]canon.FundingRate, 0)
	for _, r := range f.funding {
		if instrumentID != "" && r.InstrumentID != instrumentID {
			continue
		}
		if venueID != "" && r.VenueID != venueID {
			continue
		}
		if !start.IsZero() && r.FundingTime.Before(start) {
			continue
		}
		if !end.IsZero() && !r.FundingTime.Before(end) {
			continue
		}
		out = append(out, r)
	}
	return clamp(out, limit), nil
}

func (f *fakeReader) ReadOpenInterest(ctx context.Context, instrumentID, venueID, asset string, start, end time.Time, limit int) ([]canon.OpenInterest, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	out := make([]canon.OpenInterest, 0)
	for _, r := range f.oi {
		if instrumentID != "" && r.InstrumentID != instrumentID {
			continue
		}
		if venueID != "" && r.VenueID != venueID {
			continue
		}
		if !start.IsZero() && r.OIAt.Before(start) {
			continue
		}
		if !end.IsZero() && !r.OIAt.Before(end) {
			continue
		}
		out = append(out, r)
	}
	return clamp(out, limit), nil
}

func (f *fakeReader) ReadTrades(ctx context.Context, instrumentID, venueID string, start, end time.Time, limit int) ([]canon.Trade, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	out := make([]canon.Trade, 0)
	for _, r := range f.trades {
		if instrumentID != "" && r.InstrumentID != instrumentID {
			continue
		}
		if venueID != "" && r.VenueID != venueID {
			continue
		}
		if !start.IsZero() && r.TradeTime.Before(start) {
			continue
		}
		if !end.IsZero() && !r.TradeTime.Before(end) {
			continue
		}
		out = append(out, r)
	}
	return clamp(out, limit), nil
}

func (f *fakeReader) ReadOrderbook(ctx context.Context, instrumentID, venueID string, start, end time.Time, limit int) ([]canon.OrderbookSnap, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	out := make([]canon.OrderbookSnap, 0)
	for _, r := range f.orderbook {
		if instrumentID != "" && r.InstrumentID != instrumentID {
			continue
		}
		if venueID != "" && r.VenueID != venueID {
			continue
		}
		if !start.IsZero() && r.At.Before(start) {
			continue
		}
		if !end.IsZero() && !r.At.Before(end) {
			continue
		}
		out = append(out, r)
	}
	return clamp(out, limit), nil
}

func (f *fakeReader) ListPools(ctx context.Context, q canon.PoolQuery) ([]canon.Pool, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	out := make([]canon.Pool, 0)
	for _, p := range f.pools {
		if q.ChainID != "" && p.ChainID != q.ChainID {
			continue
		}
		if q.DEXID != "" && p.DEXVenueID != q.DEXID {
			continue
		}
		if q.MinLiquidityUSD > 0 && (p.LiquidityUSD == nil || *p.LiquidityUSD < q.MinLiquidityUSD) {
			continue
		}
		out = append(out, p)
	}
	return clamp(out, q.Limit), nil
}

func (f *fakeReader) ListArticles(ctx context.Context, limit int) ([]canon.Article, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	return clamp(f.articles, limit), nil
}

func (f *fakeReader) ListPredictionMarkets(ctx context.Context, limit int) ([]canon.PredictionMarket, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	return clamp(f.predictions, limit), nil
}

func (f *fakeReader) ListChainTVL(ctx context.Context, limit int) ([]canon.ChainTVL, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	return clamp(f.chainTVL, limit), nil
}

func (f *fakeReader) ListProtocolTVL(ctx context.Context, limit int) ([]canon.ProtocolTVL, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	return clamp(f.protocolTVL, limit), nil
}

func (f *fakeReader) ListRuns(ctx context.Context, limit int) ([]canon.RunRecord, error) {
	if err := f.fail(); err != nil {
		return nil, err
	}
	return clamp(f.runs, limit), nil
}

func (f *fakeReader) HealthCheck(ctx context.Context) error {
	return f.fail()
}

func (f *fakeReader) ResolveProviderSymbol(ctx context.Context, provider, symbol string) (string, string, error) {
	if err := f.fail(); err != nil {
		return "", "", err
	}
	return "", "", canon.ErrUnknownSymbol
}

// clamp applies the limit to a slice (limit <= 0 means all).
func clamp[T any](rows []T, limit int) []T {
	if limit <= 0 || limit >= len(rows) {
		return rows
	}
	return rows[:limit]
}

// testWriter is the canon.Writer spy the manual-trigger tests use: it records
// which write methods fired.
type testWriter struct {
	assets    int
	instr     int
	venue     int
	protocol  int
	chain     int
	provSym   int
	ohlcv     int
	funding   int
	oi        int
	quotes    int
	orderbook int
	series    int
	obs       int
	chainTVLw int
	protTVLw  int
	fail      error
}

func (w *testWriter) unavailable() (int, int, error) { return 0, 0, w.fail }

func (w *testWriter) UpsertAssets(ctx context.Context, rows []canon.Asset) (int, error) {
	w.assets += len(rows)
	return len(rows), w.fail
}

func (w *testWriter) UpsertChains(ctx context.Context, rows []canon.Chain) (int, error) {
	w.chain += len(rows)
	return len(rows), w.fail
}

func (w *testWriter) UpsertVenues(ctx context.Context, rows []canon.Venue) (int, error) {
	w.venue += len(rows)
	return len(rows), w.fail
}

func (w *testWriter) UpsertInstruments(ctx context.Context, rows []canon.Instrument) (int, error) {
	w.instr += len(rows)
	return len(rows), w.fail
}

func (w *testWriter) UpsertProtocols(ctx context.Context, rows []canon.Protocol) (int, error) {
	w.protocol += len(rows)
	return len(rows), w.fail
}

func (w *testWriter) UpsertSeries(ctx context.Context, rows []canon.SeriesMeta) (int, error) {
	w.series += len(rows)
	return len(rows), w.fail
}

func (w *testWriter) UpsertProviderSymbols(ctx context.Context, rows []canon.ProviderSymbol) (int, error) {
	w.provSym += len(rows)
	return len(rows), w.fail
}

func (w *testWriter) WriteOhlcv(ctx context.Context, rows []canon.Ohlcv) (int, int, error) {
	if w.fail != nil {
		return w.unavailable()
	}
	w.ohlcv += len(rows)
	return len(rows), 0, nil
}

func (w *testWriter) WriteTrades(ctx context.Context, rows []canon.Trade) (int, int, error) {
	return 0, 0, w.fail
}

func (w *testWriter) WriteQuotes(ctx context.Context, rows []canon.Quote) (int, int, error) {
	if w.fail != nil {
		return w.unavailable()
	}
	w.quotes += len(rows)
	return len(rows), 0, nil
}

func (w *testWriter) WriteOrderbook(ctx context.Context, rows []canon.OrderbookSnap) (int, int, error) {
	if w.fail != nil {
		return w.unavailable()
	}
	w.orderbook += len(rows)
	return len(rows), 0, nil
}

func (w *testWriter) WriteObservations(ctx context.Context, rows []canon.Observation) (int, int, error) {
	if w.fail != nil {
		return w.unavailable()
	}
	w.obs += len(rows)
	return len(rows), 0, nil
}

func (w *testWriter) WriteFunding(ctx context.Context, rows []canon.FundingRate) (int, int, error) {
	if w.fail != nil {
		return w.unavailable()
	}
	w.funding += len(rows)
	return len(rows), 0, nil
}

func (w *testWriter) WriteOpenInterest(ctx context.Context, rows []canon.OpenInterest) (int, int, error) {
	if w.fail != nil {
		return w.unavailable()
	}
	w.oi += len(rows)
	return len(rows), 0, nil
}

func (w *testWriter) WritePools(ctx context.Context, rows []canon.Pool) (int, int, error) {
	return 0, 0, w.fail
}

func (w *testWriter) WriteArticles(ctx context.Context, rows []canon.Article) (int, int, error) {
	return 0, 0, w.fail
}

func (w *testWriter) WritePredictionMarkets(ctx context.Context, rows []canon.PredictionMarket) (int, int, error) {
	return 0, 0, w.fail
}

func (w *testWriter) WriteChainTVL(ctx context.Context, rows []canon.ChainTVL) (int, int, error) {
	if w.fail != nil {
		return w.unavailable()
	}
	w.chainTVLw += len(rows)
	return len(rows), 0, nil
}

func (w *testWriter) WriteProtocolTVL(ctx context.Context, rows []canon.ProtocolTVL) (int, int, error) {
	if w.fail != nil {
		return w.unavailable()
	}
	w.protTVLw += len(rows)
	return len(rows), 0, nil
}

func (w *testWriter) WriteSupply(ctx context.Context, rows []canon.SupplySnapshot) (int, int, error) {
	return 0, 0, w.fail
}

func (w *testWriter) WriteMetric(ctx context.Context, seriesID string, points []canon.MetricPoint) (int, error) {
	return 0, w.fail
}

// stubModule is a minimal ingest.Module for the trigger tests.
type stubModule struct {
	provider string
	fetchers map[string]stubFetcher
	jobs     []ingest.JobSpec
}

func (m *stubModule) Provider() string { return m.provider }
func (m *stubModule) Fetchers() map[string]ingest.Fetcher {
	out := make(map[string]ingest.Fetcher, len(m.fetchers))
	for k, f := range m.fetchers {
		out[k] = f
	}
	return out
}
func (m *stubModule) Jobs() []ingest.JobSpec { return m.jobs }

// stubFetcher is a minimal ingest.Fetcher: it returns canned results or a
// canned error, and records the Job and Writer it was called with.
type stubFetcher struct {
	dataset string
	res     ingest.FetchResult
	err     error
	// write, when non-nil, is called with the Writer the server handed the
	// fetch: trigger tests use it to observe WHICH writer (override vs
	// failingWriter) the run wrote through.
	write func(w canon.Writer) error
}

func (f stubFetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	if f.err != nil {
		return ingest.FetchResult{}, f.err
	}
	if f.write != nil {
		if err := f.write(w); err != nil {
			return ingest.FetchResult{}, err
		}
	}
	return f.res, nil
}

var errStoreDown = errors.New("store down")
