package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/credentials"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/session"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/repository"
)

// PlainCredentials is a user-supplied credential set at the connect/test
// boundary. Plaintext enters the process only through the request body and is
// handed straight to the VenueFactory; it is sealed by the handler and never
// echoed, logged, or returned.
type PlainCredentials struct {
	APIKey     string
	APISecret  string
	Passphrase string
}

// VenueFactory is the composition-root seam (the resolver in cmd/executor). It
// owns unsealing: this package passes a sealed Envelope or user plaintext and
// receives a ready adapter, so credential plaintext never lives in the API
// layer. A test substitutes a factory returning the paper venue.
type VenueFactory interface {
	// AdapterSealed builds the adapter for a STORED account, unsealing the
	// credential inside the credential-owning package.
	AdapterSealed(ctx context.Context, exchange execution.ExchangeID, marketType execution.MarketType, id string) (exchanges.Exchange, error)
	// AdapterPlain builds the adapter for a connect/test probe from
	// user-supplied plaintext.
	AdapterPlain(ctx context.Context, exchange execution.ExchangeID, marketType execution.MarketType, creds PlainCredentials) (exchanges.Exchange, error)
	// Seal seals a plaintext credential set into the stored envelope (the ONE
	// place the master key is used).
	Seal(creds PlainCredentials) (credentials.Envelope, error)
}

// Server is the executor HTTP surface. Construct with New; the zero value is
// unusable (every handler needs a store, a venue factory and a session secret).
type Server struct {
	store   repository.ExecutorStore
	venues  VenueFactory
	secret  string
	live    bool
	now     func() int64
	markets *marketsCache
}

// Config wires one Server.
type Config struct {
	// Store is the executor API persistence port.
	Store repository.ExecutorStore
	// Venues is the credential-unsealing composition root.
	Venues VenueFactory
	// SessionSecret is FUDCOURT_SESSION_SECRET; it must pass
	// session.VerifySecret or New refuses (fail-closed).
	SessionSecret string
	// Live is the FUDCOURT_EXECUTOR_LIVE kill switch (`== "1"`).
	Live bool
	// Now is the injected clock (unix millis). Nil selects time.Now.
	Now func() int64
}

// New validates the config and returns a Server. A missing/short session secret
// is refused here (fail-closed), matching the objective's "missing required env
// exits non-zero before serving" rule: the cmd layer validates the same key
// before this constructor is reached.
func New(cfg Config) (*Server, error) {
	if cfg.Store == nil {
		return nil, errors.New("api: Store is required")
	}
	if cfg.Venues == nil {
		return nil, errors.New("api: Venues is required")
	}
	if err := session.VerifySecret(cfg.SessionSecret); err != nil {
		return nil, err
	}
	now := cfg.Now
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	return &Server{
		store:   cfg.Store,
		venues:  cfg.Venues,
		secret:  cfg.SessionSecret,
		live:    cfg.Live,
		now:     now,
		markets: newMarketsCache(10 * time.Minute),
	}, nil
}

// Router returns the executor API mux. Paths are literal except for the two
// `{id}` segments, parsed in-handler; unimplemented methods reach a handler and
// answer 405 with an Allow header, exactly as Next does for an unexported
// method.
func (s *Server) Router() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/executor/preview", s.handlePreview)
	mux.HandleFunc("/api/executor/executions", s.handleExecutions)
	mux.HandleFunc("/api/executor/executions/", s.handleExecutionByID)
	mux.HandleFunc("/api/executor/accounts", s.handleAccounts)
	mux.HandleFunc("/api/executor/accounts/", s.handleAccountByID)
	mux.HandleFunc("/api/executor/settings", s.handleSettings)
	mux.HandleFunc("/api/executor/emergency", s.handleEmergency)
	return mux
}

// --- auth ------------------------------------------------------------------

// authUser is the one gate: a verified session AT LEAST team tier, from the
// signed cookie only — never a header (a proxy-supplied identity is spoofable).
// On failure it answers the exact TS refusal and returns ok=false.
func (s *Server) authUser(w http.ResponseWriter, r *http.Request) (string, bool) {
	value := readCookie(r, session.CookieName)
	claims, err := session.RequireTeam(s.secret, value, time.UnixMilli(s.now()))
	if err != nil {
		if errors.Is(err, session.ErrSecretMissing) {
			// The operator's environment is broken, not the caller's request: a
			// 500 names the deployment fault instead of pretending the caller
			// is unauthenticated.
			writeDetail(w, http.StatusInternalServerError, "internal", err.Error())
			return "", false
		}
		writeDetail(w, http.StatusUnauthorized, "unauthorized", "requires team tier (no session)")
		return "", false
	}
	return claims.ID, true
}

// readCookie reads one cookie the same way next/headers does: the raw header
// value with one percent-decode applied. A value that does not decode reads as
// absent (a tampered cookie is never a session).
func readCookie(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return c.Value
}

// --- response helpers ------------------------------------------------------

// writeJSON emits v with JSON.stringify-compatible framing.
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// notFound answers `{ error: '<what> not found' }` with 404 — the TS refusal
// for a wrong-owner or missing row (existence is never leaked as 403).
func notFound(w http.ResponseWriter, what string) {
	writeJSON(w, http.StatusNotFound, ErrorBasic{Error: what + " not found"})
}

// invalidJSON answers the bare `{ error: 'invalid JSON body' }` 400 — the exact
// body every TS route handler returns from its req.json() catch block (no
// `detail` key: the TS literal carries none).
func invalidJSON(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, ErrorBasic{Error: "invalid JSON body"})
}

// validationError answers `{ error: 'validation', errors }` with 400.
func validationError(w http.ResponseWriter, errs []string) {
	if errs == nil {
		errs = []string{}
	}
	writeJSON(w, http.StatusBadRequest, ValidationError{Error: "validation", Errors: errs})
}

// writeDetail answers `{ error, detail }` at the given status.
func writeDetail(w http.ResponseWriter, status int, errToken, detail string) {
	writeJSON(w, status, ErrorDetail{Error: errToken, Detail: detail})
}

// writeCategorized answers `{ error, detail, category }` at the given status.
func writeCategorized(w http.ResponseWriter, status int, errToken, detail string, category execution.ErrorCategory) {
	writeJSON(w, status, CategorizedError{Error: errToken, Detail: detail, Category: category})
}

// methodGuard answers the methods a handler exported and 405s the rest, with an
// Allow header (Next answers 405 for an unexported method).
func methodGuard(w http.ResponseWriter, r *http.Request, allowed ...string) bool {
	for _, m := range allowed {
		if r.Method == m {
			return true
		}
	}
	w.Header().Set("Allow", strings.Join(allowed, ", "))
	writeDetail(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
	return false
}

// maxBody bounds a request body so a hostile client cannot exhaust memory.
const maxBody = 1 << 20

// readBody reads a bounded request body (an unreadable body reads as empty,
// which the caller reports as invalid JSON — the TS behaviour).
func readBody(r *http.Request) []byte {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody))
	if err != nil {
		return nil
	}
	return body
}

// decodeJSON reads a JSON body into v. It returns false (having written the TS
// `{ error: 'invalid JSON body' }` 400) when the body is absent or malformed.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	body := readBody(r)
	if len(strings.TrimSpace(string(body))) == 0 {
		invalidJSON(w)
		return false
	}
	if err := json.Unmarshal(body, v); err != nil {
		invalidJSON(w)
		return false
	}
	return true
}

// --- markets cache ---------------------------------------------------------

// marketsCache memoizes an account's instrument list for a TTL, mirroring the
// TS runtime's marketsCache (fetchMarkets is the heaviest read on the preview
// path). Keyed by account:marketType.
type marketsCache struct {
	ttl time.Duration
	mu  sync.Mutex
	m   map[string]cachedMarkets
}

type cachedMarkets struct {
	at    int64
	byKey map[string]exchanges.Instrument
}

func newMarketsCache(ttl time.Duration) *marketsCache {
	return &marketsCache{ttl: ttl, m: map[string]cachedMarkets{}}
}

// get returns the cached instruments when fresh.
func (c *marketsCache) get(key string, now int64) (map[string]exchanges.Instrument, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.m[key]
	if !ok || now-entry.at >= c.ttl.Milliseconds() {
		return nil, false
	}
	return entry.byKey, true
}

// put stores the instrument set for one key.
func (c *marketsCache) put(key string, byKey map[string]exchanges.Instrument, now int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[key] = cachedMarkets{at: now, byKey: byKey}
}
