package serve

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

// read limits (contract "API surface"): a bare limit query defaults to
// defaultLimit and is clamped to maxLimit.
const (
	defaultLimit = 100
	maxLimit     = 1000
)

// error envelopes. The codes are the ones main.go's research handlers and the
// contract spell out; a handler maps a failure to a status, never to a fake
// empty payload.
type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
}

type errorEnvelope struct {
	Error apiError `json:"error"`
}

type dataEnvelope struct {
	Data any `json:"data"`
}

func writeData(w http.ResponseWriter, v any) {
	httpx.WriteJSON(w, http.StatusOK, dataEnvelope{Data: v})
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	httpx.WriteJSON(w, status, errorEnvelope{Error: apiError{Code: code, Message: message}})
}

func notFound(w http.ResponseWriter, path string) {
	writeErr(w, http.StatusNotFound, "not_found", "unknown path "+path)
}

func badRequest(w http.ResponseWriter, message string) {
	writeErr(w, http.StatusBadRequest, "bad_request", message)
}

// unavailable is the loud 503: the store could not answer. The message
// carries the underlying error text so an operator sees the cause in one
// probe.
func unavailable(w http.ResponseWriter, err error) {
	writeErr(w, http.StatusServiceUnavailable, "unavailable", err.Error())
}

// server holds the read model, the job store and the module registry.
type server struct {
	r       canon.Reader
	store   ingest.JobStore
	modules func() []ingest.Module
	log     *slog.Logger
	mux     *http.ServeMux
	// writerOverride, when non-nil, is the canon.Writer manual ingest runs
	// write through (main.go hands the repo; the store is only the JobStore
	// half). Nil keeps the dynamic-assert behavior of writer().
	writerOverride canon.Writer
}

// routeMux routes the /api/data/* surface. Paths are matched WITHOUT the
// "/api/data" prefix (ServeHTTP strips it when the handler is mounted
// under it); an unmatched path falls through to the 404 envelope.
func (s *server) routeMux() *http.ServeMux {
	mux := http.NewServeMux()
	h := func(pattern string, fn http.HandlerFunc) {
		mux.HandleFunc(pattern, fn)
	}
	h("/health", s.handleHealth)
	h("/assets", s.get(handleList(s, s.r.ListAssets)))
	h("/instruments", s.get(s.handleInstruments))
	h("/venues", s.get(handleList(s, s.r.ListVenues)))
	h("/protocols", s.get(handleList(s, s.r.ListProtocols)))
	h("/chains", s.get(handleList(s, s.r.ListChains)))
	h("/series", s.get(s.handleSeries))
	h("/timeseries", s.get(s.handleTimeseries))
	h("/ohlcv", s.get(s.handleOhlcv))
	h("/trades", s.get(s.handleTrades))
	h("/orderbook", s.get(s.handleOrderbook))
	h("/derivatives/funding", s.get(s.handleFunding))
	h("/derivatives/open-interest", s.get(s.handleOpenInterest))
	h("/defi/protocols", s.get(handleList(s, func(ctx context.Context, q canon.ListQuery) ([]canon.ProtocolTVL, error) {
		return s.r.ListProtocolTVL(ctx, q.Limit)
	})))
	h("/defi/chains", s.get(handleList(s, func(ctx context.Context, q canon.ListQuery) ([]canon.ChainTVL, error) {
		return s.r.ListChainTVL(ctx, q.Limit)
	})))
	h("/dex/pools", s.get(s.handlePools))
	h("/news", s.get(s.handleNews))
	h("/prediction", s.get(s.handlePrediction))
	h("/runs", s.get(s.handleRuns))
	h("/ingest/run", s.handleIngestRun)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		notFound(w, r.URL.Path)
	})
	return mux
}

// ServeHTTP adapts the mux for main.go's mount: it accepts the full
// /api/data/... path (stripPrefix behavior) so the mux patterns stay
// suffix-shaped either way. Method and path checks live in the handlers.
func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Re-dispatch through the mux on the stripped path. "/api/data" exactly
	// (no trailing slash) is the collection root: it is not a route, so it
	// 404s like any unknown path.
	p := r.URL.Path
	p = strings.TrimPrefix(p, "/api/data")
	if p == "" {
		p = "/"
	}
	r2 := *r
	u := *r.URL
	r2.URL = &u
	r2.URL.Path = p
	s.mux.ServeHTTP(w, &r2)
}

// get wraps a handler with the GET/HEAD method rule the research handlers
// use (main.go: read surfaces are GET-only).
func (s *server) get(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "read endpoints are GET-only")
			return
		}
		fn(w, r)
	}
}

// limitParam parses ?limit= with the default/cap rule.
func limitParam(r *http.Request) (int, error) {
	q := r.URL.Query().Get("limit")
	if q == "" {
		return defaultLimit, nil
	}
	n, err := strconv.Atoi(q)
	if err != nil || n < 1 {
		return 0, err
	}
	if n > maxLimit {
		n = maxLimit
	}
	return n, nil
}

// parseTimeParam parses one start/end value: RFC3339 first, then a bare
// YYYY-MM-DD date (midnight UTC). "" is a zero Time (unbounded side).
func parseTimeParam(v string) (time.Time, error) {
	if v == "" {
		return time.Time{}, nil
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t, nil
	}
	if t, err := time.ParseInLocation("2006-01-02", v, time.UTC); err == nil {
		return t, nil
	}
	return time.Time{}, errBadTime{v}
}

type errBadTime struct{ v string }

func (e errBadTime) Error() string { return "bad timestamp " + strconv.Quote(e.v) }

// window parses the shared start/end pair.
func window(r *http.Request) (start, end time.Time, err error) {
	if start, err = parseTimeParam(r.URL.Query().Get("start")); err != nil {
		return time.Time{}, time.Time{}, err
	}
	if end, err = parseTimeParam(r.URL.Query().Get("end")); err != nil {
		return time.Time{}, time.Time{}, err
	}
	return start, end, nil
}

// handleList adapts a canon list reader taking ListQuery. TVL readers take a
// bare limit instead, so they get their own closure at the route table.
func handleList[T any](s *server, fn func(ctx context.Context, q canon.ListQuery) ([]T, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit, err := limitParam(r)
		if err != nil {
			badRequest(w, "limit must be a positive integer")
			return
		}
		rows, err := fn(r.Context(), canon.ListQuery{Limit: limit, Search: r.URL.Query().Get("search")})
		if err != nil {
			s.readFailed(w, r, err)
			return
		}
		writeData(w, rows)
	}
}

// readFailed maps one reader error to the loud envelope. A store failure is
// 503; nothing else is expected from the reader contract, so anything that
// is not a store outage surfaces as 503 with its message intact.
func (s *server) readFailed(w http.ResponseWriter, r *http.Request, err error) {
	s.log.Error("api/data: read failed", "path", r.URL.Path, "err", err)
	unavailable(w, err)
}

// handleInstruments serves /instruments with the InstrumentQuery filters.
func (s *server) handleInstruments(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, "limit must be a positive integer")
		return
	}
	q := canon.InstrumentQuery{
		VenueID:    r.URL.Query().Get("venue"),
		MarketType: r.URL.Query().Get("market_type"),
		Base:       r.URL.Query().Get("base"),
		Quote:      r.URL.Query().Get("quote"),
		Limit:      limit,
	}
	rows, err := s.r.ListInstruments(r.Context(), q)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleSeries serves /series?domain=&metric=&country=&asset=&limit=.
func (s *server) handleSeries(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, "limit must be a positive integer")
		return
	}
	q := canon.SeriesQuery{
		Domain:    r.URL.Query().Get("domain"),
		Metric:    r.URL.Query().Get("metric"),
		AssetID:   r.URL.Query().Get("asset"),
		CountryID: r.URL.Query().Get("country"),
		Limit:     limit,
	}
	rows, err := s.r.ListSeries(r.Context(), q)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleTimeseries serves /timeseries?series_id=&start=&end=&limit=.
func (s *server) handleTimeseries(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, "limit must be a positive integer")
		return
	}
	seriesID := r.URL.Query().Get("series_id")
	if seriesID == "" {
		badRequest(w, "series_id is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	rows, err := s.r.ReadTimeseries(r.Context(), seriesID, start, end, limit)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleOhlcv serves /ohlcv?instrument=&venue=&timeframe=&start=&end=&limit=.
func (s *server) handleOhlcv(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, "limit must be a positive integer")
		return
	}
	instrument := r.URL.Query().Get("instrument")
	if instrument == "" {
		badRequest(w, "instrument is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	rows, err := s.r.ReadOhlcv(r.Context(), instrument, r.URL.Query().Get("venue"),
		r.URL.Query().Get("timeframe"), start, end, limit)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleTrades serves /trades?instrument=&venue=&start=&end=&limit=.
func (s *server) handleTrades(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, "limit must be a positive integer")
		return
	}
	instrument := r.URL.Query().Get("instrument")
	if instrument == "" {
		badRequest(w, "instrument is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	rows, err := s.r.ReadTrades(r.Context(), instrument, r.URL.Query().Get("venue"), start, end, limit)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleOrderbook serves /orderbook?instrument=&venue=&start=&end=&limit=.
func (s *server) handleOrderbook(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, "limit must be a positive integer")
		return
	}
	instrument := r.URL.Query().Get("instrument")
	if instrument == "" {
		badRequest(w, "instrument is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	rows, err := s.r.ReadOrderbook(r.Context(), instrument, r.URL.Query().Get("venue"), start, end, limit)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleFunding serves /derivatives/funding?instrument=&asset=&venue=&start=&end=&limit=.
func (s *server) handleFunding(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, "limit must be a positive integer")
		return
	}
	q := r.URL.Query()
	if q.Get("instrument") == "" && q.Get("asset") == "" {
		badRequest(w, "instrument or asset is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	rows, err := s.r.ReadFunding(r.Context(), q.Get("instrument"), q.Get("venue"), q.Get("asset"), start, end, limit)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleOpenInterest serves /derivatives/open-interest with the same filters.
func (s *server) handleOpenInterest(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, "limit must be a positive integer")
		return
	}
	q := r.URL.Query()
	if q.Get("instrument") == "" && q.Get("asset") == "" {
		badRequest(w, "instrument or asset is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	rows, err := s.r.ReadOpenInterest(r.Context(), q.Get("instrument"), q.Get("venue"), q.Get("asset"), start, end, limit)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handlePools serves /dex/pools?chain=&dex=&base=&quote=&limit=.
func (s *server) handlePools(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, "limit must be a positive integer")
		return
	}
	q := r.URL.Query()
	pq := canon.PoolQuery{
		ChainID: q.Get("chain"),
		DEXID:   q.Get("dex"),
		Base:    q.Get("base"),
		Quote:   q.Get("quote"),
		Limit:   limit,
	}
	if v := q.Get("min_liquidity"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			badRequest(w, "min_liquidity must be a number")
			return
		}
		pq.MinLiquidityUSD = f
	}
	rows, err := s.r.ListPools(r.Context(), pq)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleNews serves /news?limit=.
func (s *server) handleNews(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, "limit must be a positive integer")
		return
	}
	rows, err := s.r.ListArticles(r.Context(), limit)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handlePrediction serves /prediction?limit=.
func (s *server) handlePrediction(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, "limit must be a positive integer")
		return
	}
	rows, err := s.r.ListPredictionMarkets(r.Context(), limit)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleRuns serves /runs?limit= — the ingestion run journal.
func (s *server) handleRuns(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, "limit must be a positive integer")
		return
	}
	rows, err := s.r.ListRuns(r.Context(), limit)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleHealth serves /health: {ok, db, runs, providers}. db is the store's
// own answer (SELECT 1 behind HealthCheck); runs is the latest run count the
// journal exposes through ListRuns with a small window; providers is the
// module registry's names. A DB outage is NOT a 503 here — the sidecar is
// fail-open (contract "fail-open on DB absence"), so health reports the
// outage honestly and stays up.
func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	dbOK := true
	if err := s.r.HealthCheck(r.Context()); err != nil {
		dbOK = false
	}
	runs := 0
	if rows, err := s.r.ListRuns(r.Context(), 1); err != nil {
		dbOK = false
	} else {
		runs = len(rows)
	}
	providers := []string{}
	for _, m := range s.modules() {
		providers = append(providers, m.Provider())
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"db":        dbOK,
		"runs":      runs,
		"providers": providers,
		// Storage contract §40: schema behavior changes are never silent —
		// every health answer names the schema and normalization versions
		// that produced it.
		"schema_version":        canon.SchemaVersion,
		"normalization_version": canon.NormalizationVersion,
	})
}

// writer returns the canon.Writer the manual run writes through. The read
// handler set is built from a canon.Reader; the ingest sidecar's single
// process owns both halves, so the store itself is the Writer — asserted
// dynamically. When no Writer is wired (store nil, or the store is
// read-only), the manual run fails LOUDLY rather than pretending rows were
// written.
func (s *server) writer() canon.Writer {
	if s.writerOverride != nil {
		return s.writerOverride
	}
	if store, ok := s.store.(canon.Writer); ok && store != nil {
		return store
	}
	return failingWriter{}
}

// failingWriter is the loud no-op Writer used when no real one is wired: the
// fetch proceeds but every write reports the missing backend so the manual
// run's FetchResult shows zero rows and the error surfaces as 503.
type failingWriter struct{}

func (f failingWriter) unavailable() error {
	return errors.New("serve: no canon.Writer wired for manual ingest runs")
}

func (f failingWriter) UpsertAssets(ctx context.Context, rows []canon.Asset) (int, error) {
	return 0, f.unavailable()
}

func (f failingWriter) UpsertChains(ctx context.Context, rows []canon.Chain) (int, error) {
	return 0, f.unavailable()
}

func (f failingWriter) UpsertVenues(ctx context.Context, rows []canon.Venue) (int, error) {
	return 0, f.unavailable()
}

func (f failingWriter) UpsertInstruments(ctx context.Context, rows []canon.Instrument) (int, error) {
	return 0, f.unavailable()
}

func (f failingWriter) UpsertProtocols(ctx context.Context, rows []canon.Protocol) (int, error) {
	return 0, f.unavailable()
}

func (f failingWriter) UpsertSeries(ctx context.Context, rows []canon.SeriesMeta) (int, error) {
	return 0, f.unavailable()
}

func (f failingWriter) UpsertProviderSymbols(ctx context.Context, rows []canon.ProviderSymbol) (int, error) {
	return 0, f.unavailable()
}

func (f failingWriter) WriteOhlcv(ctx context.Context, rows []canon.Ohlcv) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WriteTrades(ctx context.Context, rows []canon.Trade) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WriteQuotes(ctx context.Context, rows []canon.Quote) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WriteOrderbook(ctx context.Context, rows []canon.OrderbookSnap) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WriteObservations(ctx context.Context, rows []canon.Observation) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WriteFunding(ctx context.Context, rows []canon.FundingRate) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WriteOpenInterest(ctx context.Context, rows []canon.OpenInterest) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WritePools(ctx context.Context, rows []canon.Pool) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WriteArticles(ctx context.Context, rows []canon.Article) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WritePredictionMarkets(ctx context.Context, rows []canon.PredictionMarket) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WriteChainTVL(ctx context.Context, rows []canon.ChainTVL) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WriteProtocolTVL(ctx context.Context, rows []canon.ProtocolTVL) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WriteSupply(ctx context.Context, rows []canon.SupplySnapshot) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WriteMetric(ctx context.Context, seriesID string, points []canon.MetricPoint) (int, error) {
	return 0, f.unavailable()
}
