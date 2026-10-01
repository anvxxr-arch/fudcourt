// Command apicalls is the standalone Go port of the Next.js CryptoRank read
// proxy (apps/web/app/api/cryptorank/route.ts + scripts/cr_fetch.py +
// lib/shapers.ts).
//
// It binds loopback only; the public ingress stays the Cloudflare tunnel to the
// Next app. The HTTP contract is byte-compatible with the TS route -- see
// README.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/anvxxr-arch/fudcourt/services/data/internal/cache"
	"github.com/anvxxr-arch/fudcourt/services/data/internal/chainrank"
	"github.com/anvxxr-arch/fudcourt/services/data/internal/cryptorank"
	"github.com/anvxxr-arch/fudcourt/services/data/internal/httpx"
	"github.com/anvxxr-arch/fudcourt/services/data/internal/khala"
	"github.com/anvxxr-arch/fudcourt/services/data/internal/llama"
	"github.com/anvxxr-arch/fudcourt/services/data/internal/news"
)

func main() {
	addr := envOr("APICALLS_ADDR", "127.0.0.1:3101")
	ttl := envInt("APICALLS_TTL", 60)
	// The shared L2 (Valkey). It is initialised before the families so that a
	// cold start after a deploy can serve from a cache that outlives this
	// process; a failure here only logs, and every family then falls back to
	// its own in-process cache exactly as before (internal/cache's contract).
	cache.Init()

	f, err := cryptorank.New(cryptorank.Options{})
	if err != nil {
		log.Fatalf("apicalls: %v", err)
	}
	// khala is a SECOND family with its own fetcher (plain net/http, no
	// tls-client) and its own cache subdirectory. The two clients stay separate
	// on purpose: cryptorank.io fingerprints the TLS ClientHello and khala.io
	// never challenged a non-browser client, so unifying them would either
	// impose the browser fingerprint on a site that never asked for it, or
	// tempt a reader into deleting the profile cryptorank depends on
	// (internal/khala package doc; DR-006 D1/D9).
	kf, err := khala.New(khala.Options{})
	if err != nil {
		log.Fatalf("apicalls: khala: %v", err)
	}
	// llama is a THIRD family, again with its own client: api.llama.fi is plain
	// HTTPS (no fingerprinting wall) and its cache is IN-MEMORY with a 15s TTL
	// rather than a disk cache, because its largest body is an 8.9MB list whose
	// window the TS route also kept in process. Keeping the three clients
	// separate is the same call as khala's (internal/llama's package doc);
	// APICALLS_LLAMA_TTL overrides the TTL.
	lf, err := llama.New(llama.Options{})
	if err != nil {
		log.Fatalf("apicalls: llama: %v", err)
	}
	// news is a FOURTH family and the first whose upstream is a document rather
	// than a JSON API: cointelegraph.com/rss is plain HTTPS (no fingerprint
	// needed), so it is a third plain net/http fetcher, not a tls-client one.
	nf, err := news.New(news.Options{})
	if err != nil {
		log.Fatalf("apicalls: news: %v", err)
	}
	// chainrank is a FIFTH family: two read modes over a JSON API whose
	// pagination is relayed UNTOUCHED (upstream's own clamping is the answer the
	// board must show). Its writes stay unproxied on purpose -- each has a real
	// side effect on someone else's production service.
	cf, err := chainrank.New(chainrank.Options{})
	if err != nil {
		log.Fatalf("apicalls: chainrank: %v", err)
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           newServer(f, ttl, khala.Service{F: kf, TTL: khala.TTLDefault()}, llama.Service{F: lf}, news.Service{F: nf}, chainrank.Service{F: cf}).mux(),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      90 * time.Second,
	}
	log.Printf("apicalls listening on %s (cryptorank: cache %s, ttl %ds, %d modes; khala: cache %s, ttl %ds, %d modes; llama: ttl %ds, %d modes; news: ttl %ds, %d feeds; chainrank: ttl %ds, %d modes)",
		addr, f.CacheDir(), ttl, cryptorank.ModeCount, kf.CacheDir(), khala.TTLDefault(), khala.ModeCount, lf.TTL(), llama.ModeCount, nf.TTL(), news.SourceCount, cf.TTL(), chainrank.ModeCount)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sh, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sh)
	}()
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("apicalls: %v", err)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// fetcher is the slice of cryptorank.Fetcher the HTTP layer needs; injectable so
// the wire contract is testable without touching upstream.
type fetcher interface {
	Fetch(ctx context.Context, route, target string, ttl int) (*cryptorank.HelperOut, error)
}

type server struct {
	f fetcher
	// ks is the khala family orchestrator (fetch -> parse -> shape). It is a
	// value, not a pointer: khala.Service has no mutable state of its own (the
	// fetcher it wraps owns the cache and single-flight) and the TTL it carries
	// is per-instance configuration, never per-request state.
	ks khala.Service
	// ls is the llama family orchestrator (fetch -> sort/trim -> envelope),
	// again a value: the Fetcher it wraps owns the cache and single-flight.
	ls llama.Service
	// ns is the news family orchestrator (fetch -> parse -> envelope), a value
	// for the same reason.
	ns news.Service
	// cs is the chainrank family orchestrator (fetch -> shape check -> envelope),
	// again a value.
	cs chainrank.Service
	// ttl is the per-route cache TTL in seconds for an ordinary request; a
	// fresh=1 request passes 0 instead (the Python helper's --ttl 0). Both are
	// per-request arguments, never shared fetcher state.
	ttl int
	// retryBase is the first 429 backoff step; the route uses 3s and the tests
	// set 0 so the policy is proven without sleeping.
	retryBase time.Duration
}

func newServer(f fetcher, ttl int, ks khala.Service, ls llama.Service, ns news.Service, cs chainrank.Service) *server {
	return &server{f: f, ks: ks, ls: ls, ns: ns, cs: cs, ttl: ttl, retryBase: 3 * time.Second}
}

func (s *server) mux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]interface{}{
			"ok":    true,
			"build": fmt.Sprintf("%d modes", cryptorank.ModeCount),
			// khala is a second, independent mode table. It is reported as its
			// own key rather than folded into `build` so the cryptorank count
			// stays exactly the number every existing consumer and gate asserts
			// (cmd/apicalls/main_test.go, services/data/README.md,
			// apps/web/scripts/check-contract.py), and a reader can still see
			// both families from one probe.
			"khala": fmt.Sprintf("%d modes", khala.ModeCount),
			// llama is the third independent mode table, reported the same way.
			"llama": fmt.Sprintf("%d modes", llama.ModeCount),
			// news is a fourth family, reported as its own key for the same
			// reason: `build` stays the cryptorank count every gate asserts.
			"news": fmt.Sprintf("%d feeds", news.SourceCount),
			// chainrank is the fifth.
			"chainrank": fmt.Sprintf("%d modes", chainrank.ModeCount),
		})
	})
	mux.HandleFunc("/api/cryptorank", func(w http.ResponseWriter, r *http.Request) {
		s.handleCryptorank(w, r)
	})
	mux.HandleFunc("/api/khala", func(w http.ResponseWriter, r *http.Request) {
		s.handleKhala(w, r)
	})
	mux.HandleFunc("/api/llama", func(w http.ResponseWriter, r *http.Request) {
		s.handleLlama(w, r)
	})
	mux.HandleFunc("/api/news", func(w http.ResponseWriter, r *http.Request) {
		s.handleNews(w, r)
	})
	mux.HandleFunc("/api/chainrank", func(w http.ResponseWriter, r *http.Request) {
		s.handleChainrank(w, r)
	})
	return mux
}

func (s *server) handleCryptorank(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, 405, map[string]interface{}{"error": "method not allowed"})
		return
	}
	q := r.URL.Query()
	mode := q.Get("mode")
	if mode == "" || !cryptorank.Known(mode) {
		var got interface{}
		if mode != "" {
			got = mode
		}
		writeJSON(w, 400, map[string]interface{}{
			"error": "unknown mode",
			"modes": cryptorank.Modes,
			"got":   got,
		})
		return
	}
	// Data-integrity refusal: these modes' upstream class serves synthetic
	// decoy (see cryptorank.DisabledReason). Loud 503, never a forwarded payload.
	if cryptorank.IsDisabled(mode) {
		writeJSON(w, 503, map[string]interface{}{
			"error":    cryptorank.DisabledReason,
			"kind":     mode,
			"disabled": true,
			"upstream": cryptorank.Upstream(mode),
			"reverify": cryptorank.Reverify,
		})
		return
	}

	// fresh=1 disables the per-route TTL cache, mirroring the Python helper's
	// `--ttl 0` (and the TS route's runHelperOnce fresh flag). The value travels
	// with the call, so two concurrent requests with different fresh values
	// cannot observe each other's TTL.
	ttl := s.ttl
	if q.Get("fresh") == "1" {
		ttl = 0
	}

	key, ok := resolveKey(w, mode, q.Get("key"))
	if !ok {
		return
	}
	path, err := cryptorank.CanonicalPath(mode, key)
	if err != nil {
		writeJSON(w, 500, map[string]interface{}{"error": "unknown mode (bug)", "mode": mode})
		return
	}
	upstream := cryptorank.Base + path

	flag := cryptorank.ModeArgs[mode].Flag
	route := "html"
	if flag == "--data-route" {
		route = "data"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	h, ferr := fetchWithRetry(ctx, s.f, route, path, ttl, s.retryBase)
	if ferr != nil {
		writeFetchError(w, mode, key, upstream, ferr)
		return
	}

	// newstag soft-404 derivation: /news/tag/<unknown> answers HTTP 200 with
	// tag:null (measured) -- convert that honest marker into a real 404 so a
	// slug we don't know never ships the unfiltered feed under a tag label.
	if mode == "newstag" && !truthyValue(h.PageProps["tag"]) {
		writeJSON(w, 404, map[string]interface{}{
			"error":          "upstream ships tag:null for this slug (soft-404) -> no such tag",
			"mode":           mode,
			"key":            nullIfEmpty(key),
			"upstreamStatus": 200,
		})
		return
	}

	body, err := cryptorank.Envelope(mode, h, cryptorank.Opts{Key: key, Upstream: upstream})
	if err != nil {
		writeJSON(w, 502, map[string]interface{}{
			"error":          err.Error(),
			"upstreamStatus": h.Status,
			"upstream":       upstream,
			"kind":           mode,
		})
		return
	}
	w.Header().Set("X-CR-Upstream", body.Upstream)
	w.Header().Set("X-CR-Cache", body.Cache)
	w.Header().Set("Cache-Control", "public, max-age=30")
	writeJSON(w, 200, body)
}

// handleKhala serves the khala research-report family (PLAN G8 / DR-006). The
// wire contract is frozen in /home/dwizzy/khala-probe/DESIGN.md v4; this
// handler implements it and the tests assert it verbatim.
//
// It mirrors handleCryptorank's posture -- validate local params strictly
// (never clamp), refuse loudly, never invent a payload -- with three family
// differences:
//   - the mode table is khala's own (3 modes), reported separately on /healthz;
//   - an unknown query param for a mode is a 400 (the family's param scoping
//     matrix is part of the contract), where cryptorank ignores extras;
//   - an honest upstream 404 is a real 404 keyed on the Framer "Page Not
//     Found" marker (a 404 without that marker is a 502, never a 404).
func (s *server) handleKhala(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, 405, map[string]interface{}{"error": "method not allowed"})
		return
	}
	q := r.URL.Query()
	mode := q.Get(khala.ParamMode)
	if mode == "" || !khala.Known(mode) {
		var got interface{}
		if mode != "" {
			got = mode
		}
		writeJSON(w, 400, map[string]interface{}{
			"error": khala.ErrUnknownMode,
			"modes": khala.Modes,
			"got":   got,
		})
		return
	}
	// Param scoping: a param the mode does not accept (including a known param
	// sent to the wrong mode, and any unknown name) is a 400, never ignored.
	for p := range q {
		if !khala.Accepts(mode, p) {
			writeJSON(w, 400, map[string]interface{}{
				"error":  khala.ErrUnexpected,
				"detail": khala.UnexpectedParamDetail(p, mode),
				"param":  p,
				"mode":   mode,
			})
			return
		}
	}
	key := q.Get(khala.ParamKey)
	limit := 0
	switch mode {
	case "report":
		if key == "" {
			writeJSON(w, 400, map[string]interface{}{
				"error": khala.ErrMissingParam, "detail": khala.DetailKeyRequired, "mode": mode,
			})
			return
		}
		if !khala.ValidKey(key) {
			writeJSON(w, 400, map[string]interface{}{
				"error": khala.ErrInvalidKey, "detail": khala.DetailKeyInvalid, "mode": mode, "key": key,
			})
			return
		}
	case "latest":
		raw := q.Get(khala.ParamLimit)
		if raw == "" {
			limit = khala.DefaultLimit
		} else {
			n, ok := khala.ParseLimit(raw)
			if !ok {
				writeJSON(w, 400, map[string]interface{}{
					"error": khala.ErrInvalidLimit, "detail": khala.DetailLimitInvalid, "mode": mode, "limit": raw,
				})
				return
			}
			limit = n
		}
	}
	// fresh=1 disables the TTL cache for this request only (ttl 0), exactly as
	// the cryptorank handler does. The value travels with the call; it is never
	// fetcher state. The Service is copied so two concurrent requests with
	// different fresh values cannot observe each other's TTL -- mutating s.ks
	// would be a data race on the server struct.
	ttl := s.ks.TTL
	if q.Get(khala.ParamFresh) == "1" {
		ttl = 0
	}
	svc := khala.Service{F: s.ks.F, TTL: ttl}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	var (
		env khala.KhEnvelope
		err error
	)
	if mode == "report" {
		env, err = svc.Report(ctx, key)
	} else {
		env, err = svc.List(ctx, mode, limit)
	}
	if err != nil {
		writeKhalaError(w, mode, key, err)
		return
	}
	w.Header().Set("X-KH-Upstream", env.Upstream)
	w.Header().Set("X-KH-Cache", env.Cache)
	w.Header().Set("Cache-Control", "public, max-age=30")
	writeJSON(w, 200, env)
}

// handleLlama serves the DeFiLlama read family (api.llama.fi): three modes with
// two of OUR params validated strictly. It is the Go half of
// apps/web/app/api/llama/route.ts, which is now a verbatim proxy here.
//
//	chains      full /v2/chains list, re-sorted by tvl desc
//	protocols   head `top` (default 50, max 200) of /protocols, tvl desc
//	historical  tail `days` (default 365, max 3288) of /v2/historicalChainTvl
//
// Every refusal is the TS route's own string, because scripts/verify-llama.py
// asserts the fragments: "unknown mode", "<param> must be an integer, got …",
// "<param> must be between 1 and <max>, got …". A refused param never reaches
// upstream and is never clamped.
func (s *server) handleLlama(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, 405, map[string]interface{}{"error": "method not allowed"})
		return
	}
	q := r.URL.Query()
	mode := q.Get("mode")
	if mode == "" {
		mode = "chains"
	}
	if !llama.Known(mode) {
		writeJSON(w, 400, map[string]interface{}{
			"error":  "unknown mode '" + mode + "'",
			"detail": llama.UnknownModeDetail(),
		})
		return
	}
	// Only the mode's own param is read: chains takes neither, and a `top` sent
	// to historical is ignored exactly as the TS Intl param read ignored it
	// (the TS route's `top` is only consulted in the protocols branch).
	top, days := 0, 0
	switch mode {
	case "protocols":
		v, err := llama.ParseParam(q, llama.TopParam)
		if err != nil {
			writeJSON(w, 400, map[string]interface{}{"error": err.Error()})
			return
		}
		top = v
	case "historical":
		v, err := llama.ParseParam(q, llama.DaysParam)
		if err != nil {
			writeJSON(w, 400, map[string]interface{}{"error": err.Error()})
			return
		}
		days = v
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	env, err := s.ls.Envelope(ctx, mode, top, days)
	if err != nil {
		writeLlamaError(w, mode, err)
		return
	}
	w.Header().Set("X-Cache", env.Cache)
	writeJSON(w, 200, env)
}

// writeLlamaError maps a llama failure onto the TS route's error bodies: the
// param refusals are written by the caller (they never reach the fetcher), so
// this covers the upstream arm -- real status kept, real text quoted, never a
// substituted payload and never a fake 200.
func writeLlamaError(w http.ResponseWriter, mode string, err error) {
	he, ok := llama.IsHardError(err)
	if !ok {
		writeJSON(w, 502, map[string]interface{}{"error": "upstream " + mode + " unreachable: " + err.Error()})
		return
	}
	body := map[string]interface{}{"error": he.Message(mode)}
	if he.HasBody {
		body["detail"] = he.Body
	}
	if he.Status != 0 && he.Status != 429 {
		writeJSON(w, he.Status, body)
		return
	}
	if he.Status == 429 {
		writeJSON(w, 429, body)
		return
	}
	writeJSON(w, 502, body)
}

// writeKhalaError maps khala failures onto the frozen error bodies: an honest
// upstream 404 stays a 404, everything else that is alarmable (layout drift, a
// missing CMS resource, a transport failure) is a 502 carrying the real status
// and detail. An empty payload is never substituted for an error.
func writeKhalaError(w http.ResponseWriter, mode, key string, err error) {
	upstream := khala.UpstreamURL(mode, key)
	var nf *khala.NotFoundError
	if errors.As(err, &nf) {
		if nf.URL != "" {
			upstream = nf.URL
		}
		writeJSON(w, 404, map[string]interface{}{
			"error":          khala.UpstreamMissingKey,
			"upstreamStatus": nf.Status,
			"upstream":       upstream,
			"kind":           mode,
		})
		return
	}
	if he, ok := khala.IsHardError(err); ok {
		if he.URL != "" {
			upstream = he.URL
		}
		log.Printf("apicalls: ALARM khala %s %s: %s (%s)", he.Kind, upstream, he.Detail, mode)
		writeJSON(w, 502, map[string]interface{}{
			"error":          he.Detail,
			"upstreamStatus": nullIfZero(he.Status),
			"upstream":       upstream,
			"kind":           mode,
		})
		return
	}
	// Transport/other failure: the real error text, never invented.
	writeJSON(w, 502, map[string]interface{}{
		"error":          err.Error(),
		"upstreamStatus": nil,
		"upstream":       upstream,
		"kind":           mode,
	})
}

// resolveKey mirrors the route's key validation exactly: `key === ”` falls
// back to the documented default, every other value is validated (never
// clamped) and a bad one is a 400.
func resolveKey(w http.ResponseWriter, mode, raw string) (string, bool) {
	key := raw
	switch {
	case cryptorank.IsKeyed(mode):
		if key == "" {
			key = cryptorank.DefaultKeys[mode]
		}
		if !cryptorank.ValidKey(mode, key) {
			detail := fmt.Sprintf("key must match %s (lowercase alnum + dashes, 1-64)", cryptorank.KeyRe.String())
			if mode == "rwaasset" {
				detail = "key must be <plural-type>/<slug>, plural-type in bonds|commodities|etfs|stocks (never clamped)"
			}
			writeJSON(w, 400, map[string]interface{}{
				"error": "invalid key", "detail": detail, "mode": mode, "key": key,
			})
			return "", false
		}
	case mode == "exchanges":
		if key == "" {
			key = cryptorank.DefaultExchange
		}
		if !cryptorank.InList(cryptorank.ExchangeLists, key) {
			writeJSON(w, 400, map[string]interface{}{
				"error":   "invalid exchange list",
				"detail":  "key must be one of the whitelisted venue lists (never clamped)",
				"allowed": cryptorank.ExchangeLists, "mode": mode, "key": key,
			})
			return "", false
		}
	case mode == "launchpool":
		if key == "" {
			key = cryptorank.DefaultLP
		}
		if !cryptorank.InList(cryptorank.LPLists, key) {
			writeJSON(w, 400, map[string]interface{}{
				"error":   "invalid launchpool list",
				"detail":  "key must be one of the whitelisted event lists (never clamped)",
				"allowed": cryptorank.LPLists, "mode": mode, "key": key,
			})
			return "", false
		}
	case mode == "nodesale":
		if key == "" {
			key = cryptorank.DefaultND
		}
		if !cryptorank.InList(cryptorank.NDLists, key) {
			writeJSON(w, 400, map[string]interface{}{
				"error":   "invalid nodesale list",
				"detail":  "key must be one of the whitelisted node sale lists (never clamped)",
				"allowed": cryptorank.NDLists, "mode": mode, "key": key,
			})
			return "", false
		}
	}
	return key, true
}

// fetchWithRetry is the port of the route's runHelper: a page mount fires every
// mode at once, which can trip cryptorank's CF burst limiter (upstream 429).
// Back off and retry the SAME fetch -- responses may only fail on real data,
// never on a hiccup. 3 attempts, 3s x (attempt+1).
func fetchWithRetry(ctx context.Context, f fetcher, route, path string, ttl int, retryBase time.Duration) (*cryptorank.HelperOut, error) {
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		h, err := f.Fetch(ctx, route, path, ttl)
		if err == nil {
			return h, nil
		}
		last = err
		var he *cryptorank.HelperErr
		if errors.As(err, &he) && he.Status == 429 {
			if attempt < 2 {
				select {
				case <-time.After(retryBase * time.Duration(attempt+1)):
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			continue
		}
		return nil, err
	}
	return nil, last
}

// writeFetchError maps failures to the route's error bodies. A Cloudflare
// challenge (or a transport failure) is a HARD, alarmable failure: it is
// reported as 502 with a distinct error string and never parsed as "no data".
func writeFetchError(w http.ResponseWriter, mode, key, upstream string, err error) {
	var hard *cryptorank.HardError
	if errors.As(err, &hard) {
		log.Printf("apicalls: ALARM %s %s: %s (%s)", hard.Kind, upstream, hard.Detail, hard.Upstrl)
		writeJSON(w, 502, map[string]interface{}{
			"error":          hard.Detail,
			"upstreamStatus": nullIfZero(hard.Status),
			"upstream":       upstream,
			"kind":           mode,
		})
		return
	}
	var he *cryptorank.HelperErr
	if errors.As(err, &he) {
		if he.Status == 404 {
			// Honest upstream miss (e.g. /price/zzznoexist) -> real 404.
			writeJSON(w, 404, map[string]interface{}{
				"error":          "upstream 404: no such resource",
				"mode":           mode,
				"key":            nullIfEmpty(key),
				"upstreamStatus": 404,
			})
			return
		}
		writeJSON(w, 502, map[string]interface{}{
			"error":          he.Err,
			"upstreamStatus": nullIfZero(he.Status),
			"upstream":       upstream,
			"kind":           mode,
		})
		return
	}
	// Transport/other failure: real error text, never invented.
	writeJSON(w, 502, map[string]interface{}{
		"error":          err.Error(),
		"upstreamStatus": nil,
		"upstream":       upstream,
		"kind":           mode,
	})
}

func nullIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func nullIfZero(n int) interface{} {
	if n == 0 {
		return nil
	}
	return n
}

func truthyValue(v interface{}) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0
	case string:
		return t != ""
	case []interface{}:
		return true
	case map[string]interface{}:
		return true
	}
	return true
}

// writeJSON delegates to internal/httpx so the served-bytes parity test proves
// the production writer (no HTML escaping, one trailing newline).
func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	httpx.WriteJSON(w, code, v)
}

// handleNews serves the Cointelegraph RSS read family: one feed with two of OUR
// params validated strictly. It is the Go half of
// apps/web/app/api/news/route.ts, which is now a verbatim proxy here.
//
//	source  the feed table's wire name (default cointelegraph)
//	limit   how many of the parsed items to ship (default 30, 1..100)
//
// Every refusal is the TS route's own string, because scripts/verify-news.py
// asserts the fragments: "unknown source", "expected one of …",
// "limit must be an integer, got …", "limit must be between 1 and 100, got …".
// A refused param never reaches upstream and is never clamped; the parsed items
// are cached under the FEED URL, so every `limit` shares one 340KB fetch.
func (s *server) handleNews(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, 405, map[string]interface{}{"error": "method not allowed"})
		return
	}
	q := r.URL.Query()
	src, err := news.ParseSource(q)
	if err != nil {
		writeJSON(w, 400, map[string]interface{}{
			"error":  err.Error(),
			"detail": news.UnknownSourceDetail(),
		})
		return
	}
	limit, err := news.ParseLimit(q)
	if err != nil {
		writeJSON(w, 400, map[string]interface{}{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	env, err := s.ns.Envelope(ctx, src, limit)
	if err != nil {
		writeNewsError(w, err)
		return
	}
	w.Header().Set("X-Cache", env.Cache)
	writeJSON(w, 200, env)
}

// writeNewsError maps a news failure onto the TS route's error bodies: the real
// upstream status is kept, the real text is quoted, and no payload is ever
// substituted -- an empty feed reaches the client as a 502, never as an
// honest-looking empty list.
func writeNewsError(w http.ResponseWriter, err error) {
	he, ok := news.IsHardError(err)
	if !ok {
		writeJSON(w, 502, map[string]interface{}{"error": "upstream request failed"})
		return
	}
	body := map[string]interface{}{"error": he.Message()}
	if he.HasBody {
		body["detail"] = he.Body
	}
	if he.Status != 0 && he.Status != 429 && he.Kind != "empty" {
		writeJSON(w, he.Status, body)
		return
	}
	if he.Kind == "rate-limit" {
		writeJSON(w, 429, body)
		return
	}
	// transport, an empty feed and any other shape refusal are all a 502: the
	// upstream said something we refuse to serve as data.
	writeJSON(w, 502, body)
}

// handleChainrank serves the chainrank.fyi read family: two modes over a JSON
// API, with pagination relayed UNTOUCHED. It is the Go half of
// apps/web/app/api/chainrank/route.ts, which is now a verbatim proxy here.
//
//	stats      the leaderboard's aggregate counters
//	listings   the board rows, with `page`/`pageSize` passed through verbatim
//
// The relay-verbatim rule is the whole honesty contract for this family:
// upstream silently clamps page<1 to 1 and caps pageSize at 200, so re-clamping
// locally would produce a response indistinguishable from upstream's own answer
// while actually being OUR guess. Relayed, the clamping in the body is
// upstream's, and `upstream` names the exact URL that produced it.
//
// Write endpoints are documented in lib/chainrank.ts and deliberately NOT
// proxied: each has a real side effect on someone else's production service.
func (s *server) handleChainrank(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, 405, map[string]interface{}{"error": "method not allowed"})
		return
	}
	q := r.URL.Query()
	mode := q.Get(chainrank.ParamMode)
	if mode == "" {
		mode = chainrank.DefaultMode
	}
	if !chainrank.Known(mode) {
		writeJSON(w, 400, map[string]interface{}{
			"error":  "unknown mode '" + mode + "'",
			"detail": chainrank.UnknownModeDetail(),
		})
		return
	}
	// The upstream URL doubles as the cache key and as the envelope's
	// `upstream`, and it carries the pagination query exactly as received.
	upstream := chainrank.UpstreamURL(mode, q)

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	env, info, err := s.cs.Envelope(ctx, mode, upstream)
	if err != nil {
		writeChainrankError(w, mode, upstream, err)
		return
	}
	// The TS route set X-Cache on success and failure alike; a refusal that
	// dropped it would make a cache bug invisible exactly when it matters.
	w.Header().Set("X-Cache", info.Cache)
	httpx.WriteJSON(w, 200, env)
}

// writeChainrankError maps a chainrank failure onto the TS route's error bodies:
// the real status is kept (405 and 429 keep their own meaning), the real body is
// quoted, and a shape refusal is a 502 -- never a fake 200 with empty data.
func writeChainrankError(w http.ResponseWriter, mode, upstream string, err error) {
	if se, ok := err.(*chainrank.ShapeError); ok {
		writeJSON(w, 502, map[string]interface{}{"error": se.Detail})
		return
	}
	he, ok := chainrank.IsHardError(err)
	if !ok {
		writeJSON(w, 502, map[string]interface{}{
			"error": "upstream " + mode + " unreachable: " + err.Error(),
		})
		return
	}
	body := map[string]interface{}{"error": he.Message()}
	if he.HasBody {
		body["detail"] = he.Body
	}
	switch he.Kind {
	case "rate-limit":
		writeJSON(w, 429, body)
	case "method":
		writeJSON(w, 405, body)
	case "transport", "non-json":
		writeJSON(w, 502, body)
	default:
		if he.Status != 0 {
			writeJSON(w, he.Status, body)
			return
		}
		writeJSON(w, 502, body)
	}
}
