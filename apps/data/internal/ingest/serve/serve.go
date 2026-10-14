package serve

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

// read limits (contract "API surface"): a bare limit query defaults to
// defaultLimit and is clamped to maxLimit.
const (
	defaultLimit = 100
	maxLimit     = 1000
)

// storeTimeout bounds ONE read against the store. Windows are indexed and the
// pool is bounded (MaxConns 8), so a query that has not answered in this long
// is hung, not slow — and a hung query would otherwise hold a pool connection
// forever, so eight of them would wedge the whole read surface. The bound is
// generous against a healthy read (<100ms) and finite against a broken one.
// Manual ingest runs are NOT wrapped by it: one fetch legitimately takes
// minutes, and runTimeout is its own budget.
const storeTimeout = 15 * time.Second

// error envelopes. The codes are the ones main.go's research handlers and the
// contract spell out; a handler maps a failure to a status, never to a fake
// empty payload.
type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
	// RequestID correlates this failure with the process log line that carries
	// the same id. It rides under the schema's own field name
	// (contracts/schemas/error-envelope.json: code + message required,
	// request_id optional) exactly as apps/api's errs.EnvelopeBody does, so a
	// consumer that reads either surface sees one shape. Omitted when absent
	// rather than sent as an empty string.
	RequestID string `json:"request_id,omitempty"`
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

// WithDexReader wires the DEX Data Platform read port onto the handler. It is
// the additive, mutation-style option (same shape as WithWriter) so New's
// signature stays frozen. A nil reader leaves the port unset, and every
// /api/v1/dex route then answers the loud 503.
func WithDexReader(h http.Handler, r dexstore.Reader) http.Handler {
	s, ok := h.(*server)
	if !ok || r == nil {
		return h
	}
	s.dex = r
	return h
}

func writeErr(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	httpx.WriteJSON(w, status, errorEnvelope{Error: apiError{
		Code:      code,
		Message:   message,
		RequestID: requestIDFrom(r.Context()),
	}})
}

func notFound(w http.ResponseWriter, r *http.Request, path string) {
	writeErr(w, r, http.StatusNotFound, "not_found", "unknown path "+path)
}

func badRequest(w http.ResponseWriter, r *http.Request, message string) {
	writeErr(w, r, http.StatusBadRequest, "bad_request", message)
}

// unavailable is the loud 503: the store could not answer. The message
// carries the underlying error text so an operator sees the cause in one
// probe.
func unavailable(w http.ResponseWriter, r *http.Request, err error) {
	writeErr(w, r, http.StatusServiceUnavailable, "unavailable", err.Error())
}

// --- correlation + panic containment ---------------------------------------

type ctxKey int

const requestIDKey ctxKey = 0

// validRequestID bounds what an inbound X-Request-Id may contain. The id
// travels into log lines, so a caller-sent id must match [A-Za-z0-9._-]{1,128}
// or it is replaced with a generated one (log-forging guard). Mirrors
// apps/api/internal/platform/httpx.validRequestID.
func validRequestID(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	for _, c := range id {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '.', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}

// newRequestID generates a 16-byte random hex correlation id.
func newRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// A broken machine is not a routing decision; the id stays usable as a
		// constant so the response still carries a well-formed header.
		return "generated-unavailable"
	}
	return hex.EncodeToString(b[:])
}

// requestIDFrom returns the correlation id carried by ctx ("" when absent).
func requestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// withRequestID adopts a well-formed inbound X-Request-Id or generates one and
// exposes it on the context and the response header. Mirrors
// apps/api/internal/platform/httpx.RequestID, so an id minted at the web tier
// (or forwarded by a client) survives into this surface's logs and its error
// envelopes — one correlation id across the whole request path.
func withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !validRequestID(id) {
			id = newRequestID()
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

// withRecover contains a panic at the handler boundary: the caller gets the
// canonical internal envelope and the stack goes to the log, never the wire
// (objective §43: no internal stack traces to users). Mirrors apps/api's
// httpx.Recover. Before this, a nil-map or nil-pointer panic in one handler
// dropped the connection with no body and no correlation id.
func withRecover(next http.Handler, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Error("api/data: panic contained",
					"request_id", requestIDFrom(r.Context()),
					"path", r.URL.Path,
					"panic", rec,
					"stack", string(debug.Stack()),
				)
				writeErr(w, r, http.StatusInternalServerError, "internal", "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// withHarden stamps the response hardening headers on the data surface. The
// body is JSON only, so the policy is maximally restrictive — the same one
// apps/api's httpx.Harden applies: this origin renders nothing and may not be
// embedded. They are defense-in-depth for a direct loopback caller; the public
// ingress is the web tier, which sets its own headers.
func withHarden(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

// server holds the read model, the job store and the module registry.
type server struct {
	r       canon.Reader
	store   ingest.JobStore
	modules func() []ingest.Module
	log     *slog.Logger
	// inner is the middleware chain (withRequestID → withRecover →
	// withHarden) over the route mux. ServeHTTP dispatches here, so the chain
	// is applied exactly once per request regardless of the mount.
	inner http.Handler
	mux   *http.ServeMux
	// writerOverride, when non-nil, is the canon.Writer manual ingest runs
	// write through (main.go hands the repo; the store is only the JobStore
	// half). Nil keeps the dynamic-assert behavior of writer().
	writerOverride canon.Writer
	// dex is the DEX Data Platform read port (docs/dex/audit.md §4). It is nil
	// when no database pool is wired, in which case every /api/v1/dex route
	// answers the loud 503 rather than an empty 200.
	dex dexstore.Reader
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
	h("/metrics", s.get(s.handleMetrics))
	h("/charts/index", s.get(s.handleChartsIndex))
	h("/ohlcv", s.get(s.handleOhlcv))
	h("/trades", s.get(s.handleTrades))
	h("/orderbook", s.get(s.handleOrderbook))
	h("/derivatives/funding", s.get(s.handleFunding))
	h("/derivatives/open-interest", s.get(s.handleOpenInterest))
	h("/derivatives/liquidations", s.get(s.handleLiquidations))
	h("/derivatives/options", s.get(s.handleOptionQuotes))
	h("/defi/protocols", s.get(handleList(s, func(ctx context.Context, q canon.ListQuery) ([]canon.ProtocolTVL, error) {
		return s.r.ListProtocolTVL(ctx, q.Limit)
	})))
	h("/defi/chains", s.get(handleList(s, func(ctx context.Context, q canon.ListQuery) ([]canon.ChainTVL, error) {
		return s.r.ListChainTVL(ctx, q.Limit)
	})))
	h("/dex/pools", s.get(s.handlePools))
	// DEX Data Platform canonical surface (plan §30). Registered with the full
	// /api/v1/dex prefix; main.go mounts this handler at /api/v1/ as well as
	// /api/data/, and ServeHTTP's prefix strip is a no-op for /api/v1 paths.
	s.dexRoutes(mux)
	h("/news", s.get(s.handleNews))
	h("/prediction", s.get(s.handlePrediction))
	h("/runs", s.get(s.handleRuns))
	h("/ingest/run", s.handleIngestRun)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		notFound(w, r, r.URL.Path)
	})
	return mux
}

// ServeHTTP adapts the mux for main.go's mount: it accepts the full
// /api/data/... path (stripPrefix behavior) so the mux patterns stay
// suffix-shaped either way. Method and path checks live in the handlers.
//
// The middleware chain wraps the WHOLE surface, once, outermost first:
// withRequestID mints/ adopts the correlation id every error envelope and log
// line carries; withRecover turns a handler panic into the canonical 500
// envelope instead of a dropped connection; withHarden stamps the JSON-only
// hardening headers. They live here rather than per-handler so a new route
// cannot forget them.
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
	s.inner.ServeHTTP(w, &r2)
}

// get wraps a handler with the GET/HEAD method rule the research handlers
// use (main.go: read surfaces are GET-only) and bounds the store work under
// storeTimeout. The bound is applied here, not in each handler, so every read
// path inherits it: a hung query is cancelled and answers the loud 503 rather
// than pinning a pool connection for the life of the request.
func (s *server) get(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeErr(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "read endpoints are GET-only")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), storeTimeout)
		defer cancel()
		fn(w, r.WithContext(ctx))
	}
}

// limitParam parses ?limit= with the default/cap rule. A present value must be
// a positive integer: "0", "-1", and "abc" are all 400s, never silently
// coerced into the default (the house rule — a parameter the caller sent is
// either honored or refused, never quietly replaced). An absent value takes
// the default; an oversized one is clamped to the cap.
func limitParam(r *http.Request) (int, error) {
	q := r.URL.Query().Get("limit")
	if q == "" {
		return defaultLimit, nil
	}
	n, err := strconv.Atoi(q)
	if err != nil {
		return 0, err
	}
	if n < 1 {
		return 0, errBadLimit{q}
	}
	if n > maxLimit {
		n = maxLimit
	}
	return n, nil
}

// errBadLimit is the non-numeric-parse failure mode: a syntactically valid but
// out-of-range limit, which must still be a loud 400.
type errBadLimit struct{ v string }

func (e errBadLimit) Error() string {
	return "limit must be a positive integer, got " + strconv.Quote(e.v)
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
			badRequest(w, r, "limit must be a positive integer")
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
// is not a store outage surfaces as 503 with its message intact. The log line
// carries the correlation id the response envelope also carries, so an
// operator can tie a client-reported failure to its cause in one grep.
func (s *server) readFailed(w http.ResponseWriter, r *http.Request, err error) {
	s.log.Error("api/data: read failed",
		"request_id", requestIDFrom(r.Context()),
		"path", r.URL.Path,
		"err", err)
	unavailable(w, r, err)
}

// handleInstruments serves /instruments with the InstrumentQuery filters.
func (s *server) handleInstruments(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, r, "limit must be a positive integer")
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
		badRequest(w, r, "limit must be a positive integer")
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
		badRequest(w, r, "limit must be a positive integer")
		return
	}
	seriesID := r.URL.Query().Get("series_id")
	if seriesID == "" {
		badRequest(w, r, "series_id is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, r, err.Error())
		return
	}
	rows, err := s.r.ReadTimeseries(r.Context(), seriesID, start, end, limit)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleMetrics serves /metrics?series_id=&start=&end=&limit= — the read side
// of data.metric (derived datapoints). Same envelope and failure semantics as
// /timeseries; an unknown series_id answers an empty data array, never 404.
func (s *server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, r, "limit must be a positive integer")
		return
	}
	seriesID := r.URL.Query().Get("series_id")
	if seriesID == "" {
		badRequest(w, r, "series_id is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, r, err.Error())
		return
	}
	rows, err := s.r.ReadMetric(r.Context(), seriesID, start, end, limit)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleChartsIndex serves /charts/index?domain=&limit= — the chart catalog:
// derived series rows (is_derived=true) with their Title/Unit/Frequency.
func (s *server) handleChartsIndex(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, r, "limit must be a positive integer")
		return
	}
	derived := true
	rows, err := s.r.ListSeries(r.Context(), canon.SeriesQuery{
		Domain:    r.URL.Query().Get("domain"),
		IsDerived: &derived,
		Limit:     limit,
	})
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
		badRequest(w, r, "limit must be a positive integer")
		return
	}
	instrument := r.URL.Query().Get("instrument")
	if instrument == "" {
		badRequest(w, r, "instrument is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, r, err.Error())
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
		badRequest(w, r, "limit must be a positive integer")
		return
	}
	instrument := r.URL.Query().Get("instrument")
	if instrument == "" {
		badRequest(w, r, "instrument is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, r, err.Error())
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
		badRequest(w, r, "limit must be a positive integer")
		return
	}
	instrument := r.URL.Query().Get("instrument")
	if instrument == "" {
		badRequest(w, r, "instrument is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, r, err.Error())
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
		badRequest(w, r, "limit must be a positive integer")
		return
	}
	q := r.URL.Query()
	if q.Get("instrument") == "" && q.Get("asset") == "" {
		badRequest(w, r, "instrument or asset is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, r, err.Error())
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
		badRequest(w, r, "limit must be a positive integer")
		return
	}
	q := r.URL.Query()
	if q.Get("instrument") == "" && q.Get("asset") == "" {
		badRequest(w, r, "instrument or asset is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, r, err.Error())
		return
	}
	rows, err := s.r.ReadOpenInterest(r.Context(), q.Get("instrument"), q.Get("venue"), q.Get("asset"), start, end, limit)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleLiquidations serves /derivatives/liquidations with the same filters.
func (s *server) handleLiquidations(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, r, "limit must be a positive integer")
		return
	}
	q := r.URL.Query()
	if q.Get("instrument") == "" && q.Get("asset") == "" {
		badRequest(w, r, "instrument or asset is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, r, err.Error())
		return
	}
	rows, err := s.r.ReadLiquidations(r.Context(), q.Get("instrument"), q.Get("venue"), q.Get("asset"), start, end, limit)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleOptionQuotes serves /derivatives/options with the same filters.
func (s *server) handleOptionQuotes(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, r, "limit must be a positive integer")
		return
	}
	q := r.URL.Query()
	if q.Get("instrument") == "" && q.Get("asset") == "" {
		badRequest(w, r, "instrument or asset is required")
		return
	}
	start, end, err := window(r)
	if err != nil {
		badRequest(w, r, err.Error())
		return
	}
	rows, err := s.r.ReadOptionQuotes(r.Context(), q.Get("instrument"), q.Get("venue"), q.Get("asset"), start, end, limit)
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
		badRequest(w, r, "limit must be a positive integer")
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
			badRequest(w, r, "min_liquidity must be a number")
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

// handleNews serves /news with the ArticleQuery filters. Every filter is
// optional; an unknown value yields an empty page, never a 400 — filters
// narrow, they do not assert. The response carries a Link-style cursor hint
// when the page is full, so a client can continue with before=<published_at>
// of the last row.
func (s *server) handleNews(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, r, "limit must be a positive integer")
		return
	}
	q := canon.ArticleQuery{
		Source:   r.URL.Query().Get("source"),
		Category: r.URL.Query().Get("category"),
		Asset:    r.URL.Query().Get("asset"),
		Search:   r.URL.Query().Get("search"),
		Limit:    limit,
	}
	if v := r.URL.Query().Get("before"); v != "" {
		t, err := parseTimeParam(v)
		if err != nil {
			badRequest(w, r, "before must be an RFC3339 timestamp or YYYY-MM-DD date")
			return
		}
		q.Before = t
	}
	rows, err := s.r.ListArticlesFiltered(r.Context(), q)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	// A full page almost certainly has more: advertise the keyset cursor for
	// the next request. The path is built explicitly, NOT copied from r.URL:
	// ServeHTTP strips the /api/data prefix before dispatch, so a copied URL
	// would emit a bare "/news?…" that a client resolving it from the public
	// surface would follow to /api/news — the research relay, a different
	// document. The absolute path keeps the cursor on this endpoint.
	if len(rows) == limit && rows[len(rows)-1].PublishedAt != nil {
		next := url.URL{
			Path: "/api/data/news",
			RawQuery: url.Values{
				"limit":  {strconv.Itoa(limit)},
				"before": {rows[len(rows)-1].PublishedAt.UTC().Format(time.RFC3339)},
			}.Encode(),
		}
		for _, f := range []string{"source", "category", "asset", "search"} {
			if v := r.URL.Query().Get(f); v != "" {
				q := next.Query()
				q.Set(f, v)
				next.RawQuery = q.Encode()
			}
		}
		w.Header().Set("Link", "<"+next.String()+`>; rel="next"`)
	}
	writeData(w, rows)
}

// handlePrediction serves /prediction?limit=.
func (s *server) handlePrediction(w http.ResponseWriter, r *http.Request) {
	limit, err := limitParam(r)
	if err != nil {
		badRequest(w, r, "limit must be a positive integer")
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
		badRequest(w, r, "limit must be a positive integer")
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

func (f failingWriter) WriteLiquidations(ctx context.Context, rows []canon.Liquidation) (int, int, error) {
	return 0, 0, f.unavailable()
}

func (f failingWriter) WriteOptionQuotes(ctx context.Context, rows []canon.OptionQuote) (int, int, error) {
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
