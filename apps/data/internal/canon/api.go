package canon

import (
	"context"
	"net/http"
	"time"
)

// ValidTimeframes is the closed set of timeframes the platform accepts. The
// mixed-case entries are deliberate: 1M is one calendar month and is NOT 1m
// (one minute); quarterly/annual/event are non-uniform frames the economic
// domains arrive in.
var ValidTimeframes = []string{
	"tick", "1s", "1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M",
	"quarterly", "annual", "event",
}

// ValidateTimeframe reports whether tf is one of the platform's closed
// timeframe vocabulary. Comparison is exact: no trimming, no lowercasing -
// "1M" and "1m" are different frames, and a caller sending "1M " is sending a
// different (invalid) frame.
func ValidateTimeframe(tf string) bool {
	for _, v := range ValidTimeframes {
		if tf == v {
			return true
		}
	}
	return false
}

// Doer is the subset of *http.Client the provider adapters use, exactly as
// apps/data/internal/research/fetch.go defines it for the research families.
// Adapters take a Doer instead of a *http.Client so tests inject canned
// responses without a network.
type Doer interface {
	Do(*http.Request) (*http.Response, error)
}

// RunRecord is one row of the ingestion run journal (data.ingestion_run): what
// ran, when, and what it did to the tables. It is the observability contract
// between the engine and the /api/data/runs endpoint.
type RunRecord struct {
	ID           int64      `json:"id"`
	Provider     string     `json:"provider"`
	Dataset      string     `json:"dataset"`
	Subject      string     `json:"subject"`
	Mode         string     `json:"mode"`
	StartedAt    time.Time  `json:"started_at"`
	FinishedAt   *time.Time `json:"finished_at"`
	Status       string     `json:"status"`
	RowsIn       int        `json:"rows_in"`
	RowsWritten  int        `json:"rows_written"`
	RowsRejected int        `json:"rows_rejected"`
	Error        string     `json:"error"`
	Attempt      int        `json:"attempt"`
}

// Writer is the write side of the canon store: upsert entities, append
// fact rows. Every Write method returns (written, rejected): written rows were
// persisted, rejected rows failed validation and were counted, never silently
// dropped and never faked with a zero. A batch is not required to be atomic -
// the engine journals the counts either way.
type Writer interface {
	UpsertAssets(ctx context.Context, rows []Asset) (int, error)
	UpsertChains(ctx context.Context, rows []Chain) (int, error)
	UpsertVenues(ctx context.Context, rows []Venue) (int, error)
	UpsertInstruments(ctx context.Context, rows []Instrument) (int, error)
	UpsertProtocols(ctx context.Context, rows []Protocol) (int, error)
	UpsertSeries(ctx context.Context, rows []SeriesMeta) (int, error)
	UpsertProviderSymbols(ctx context.Context, rows []ProviderSymbol) (int, error)
	WriteOhlcv(ctx context.Context, rows []Ohlcv) (written, rejected int, err error)
	WriteTrades(ctx context.Context, rows []Trade) (written, rejected int, err error)
	WriteQuotes(ctx context.Context, rows []Quote) (written, rejected int, err error)
	WriteOrderbook(ctx context.Context, rows []OrderbookSnap) (written, rejected int, err error)
	WriteLiquidations(ctx context.Context, rows []Liquidation) (written, rejected int, err error)
	WriteOptionQuotes(ctx context.Context, rows []OptionQuote) (written, rejected int, err error)
	WriteObservations(ctx context.Context, rows []Observation) (written, rejected int, err error)
	WriteFunding(ctx context.Context, rows []FundingRate) (written, rejected int, err error)
	WriteOpenInterest(ctx context.Context, rows []OpenInterest) (written, rejected int, err error)
	WritePools(ctx context.Context, rows []Pool) (written, rejected int, err error)
	WriteArticles(ctx context.Context, rows []Article) (written, rejected int, err error)
	WritePredictionMarkets(ctx context.Context, rows []PredictionMarket) (written, rejected int, err error)
	WriteChainTVL(ctx context.Context, rows []ChainTVL) (written, rejected int, err error)
	WriteProtocolTVL(ctx context.Context, rows []ProtocolTVL) (written, rejected int, err error)
	WriteSupply(ctx context.Context, rows []SupplySnapshot) (written, rejected int, err error)
	// WriteMetric appends derived datapoints to one series' metric table.
	// Series row must already exist; the count is all-or-nothing on error.
	WriteMetric(ctx context.Context, seriesID string, points []MetricPoint) (int, error)
}

// Reader is the read side of the canon store: what the /api/data/* handlers
// call. Read windows are half-open [start, end); zero start/end mean unbounded
// on that side. A nil row pointer is never returned for an existing entity -
// absence is an empty slice or an ErrUnknownSymbol, never a fake row.
type Reader interface {
	ListAssets(ctx context.Context, q ListQuery) ([]Asset, error)
	ListChains(ctx context.Context, q ListQuery) ([]Chain, error)
	ListVenues(ctx context.Context, q ListQuery) ([]Venue, error)
	ListProtocols(ctx context.Context, q ListQuery) ([]Protocol, error)
	ListInstruments(ctx context.Context, q InstrumentQuery) ([]Instrument, error)
	ListSeries(ctx context.Context, q SeriesQuery) ([]SeriesMeta, error)
	ReadTimeseries(ctx context.Context, seriesID string, start, end time.Time, limit int) ([]Observation, error)
	ReadOhlcv(ctx context.Context, instrumentID, venueID, timeframe string, start, end time.Time, limit int) ([]Ohlcv, error)
	// ReadFunding reads funding rows; asset, when non-empty, joins the
	// instrument's base symbol so callers can ask by asset instead of id.
	ReadFunding(ctx context.Context, instrumentID, venueID, asset string, start, end time.Time, limit int) ([]FundingRate, error)
	// ReadOpenInterest reads open-interest rows with the same asset join.
	ReadOpenInterest(ctx context.Context, instrumentID, venueID, asset string, start, end time.Time, limit int) ([]OpenInterest, error)
	// ReadLiquidations reads liquidation events; asset, when non-empty, joins
	// the instrument's base symbol so callers can ask by asset instead of id.
	ReadLiquidations(ctx context.Context, instrumentID, venueID, asset string, start, end time.Time, limit int) ([]Liquidation, error)
	// ReadOptionQuotes reads options ticker snapshots with the same asset join.
	ReadOptionQuotes(ctx context.Context, instrumentID, venueID, asset string, start, end time.Time, limit int) ([]OptionQuote, error)
	// ReadTrades reads executed trades for one instrument/venue window.
	ReadTrades(ctx context.Context, instrumentID, venueID string, start, end time.Time, limit int) ([]Trade, error)
	// ReadOrderbook reads depth snapshots for one instrument/venue window.
	ReadOrderbook(ctx context.Context, instrumentID, venueID string, start, end time.Time, limit int) ([]OrderbookSnap, error)
	ListPools(ctx context.Context, q PoolQuery) ([]Pool, error)
	ListArticles(ctx context.Context, limit int) ([]Article, error)
	ListPredictionMarkets(ctx context.Context, limit int) ([]PredictionMarket, error)
	ListChainTVL(ctx context.Context, limit int) ([]ChainTVL, error)
	ListProtocolTVL(ctx context.Context, limit int) ([]ProtocolTVL, error)
	// ResolveProviderSymbol resolves one (provider, symbol) pair to its
	// canonical id. Unknown symbols return ErrUnknownSymbol, never a guess.
	ResolveProviderSymbol(ctx context.Context, provider, symbol string) (kind, canonicalID string, err error)
	ListRuns(ctx context.Context, limit int) ([]RunRecord, error)
	HealthCheck(ctx context.Context) error
}

// ErrUnknownSymbol is returned by ResolveProviderSymbol when the resolution
// table has no row for the pair. It is a sentinel: callers compare with
// errors.Is.
var ErrUnknownSymbol = errUnknownSymbol{}

type errUnknownSymbol struct{}

func (errUnknownSymbol) Error() string { return "canon: unknown provider symbol" }
