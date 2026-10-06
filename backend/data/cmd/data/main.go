// Command fudcourt-data is the standalone Go port of the Next.js CryptoRank read
// proxy (frontend/web/app/api/cryptorank/route.ts + scripts/cr_fetch.py +
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

	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/chainrank"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/coinank"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/coinglass"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/coinmarketcap"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/cryptorank"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/khala"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/llama"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/news"
	"github.com/anvxxr-arch/fudcourt/backend/data/platform/cache"
	"github.com/anvxxr-arch/fudcourt/backend/data/platform/httpx"
)

func main() {
	addr := envOr("FUDCOURT_DATA_ADDR", "127.0.0.1:3101")
	ttl := envInt("FUDCOURT_DATA_TTL", 60)
	// The shared L2 (Valkey). It is initialised before the families so that a
	// cold start after a deploy can serve from a cache that outlives this
	// process; a failure here only logs, and every family then falls back to
	// its own in-process cache exactly as before (platform/cache's contract).
	cache.Init()

	f, err := cryptorank.New(cryptorank.Options{})
	if err != nil {
		log.Fatalf("fudcourt-data: %v", err)
	}
	// khala is a SECOND family with its own fetcher (plain net/http, no
	// tls-client) and its own cache subdirectory. The two clients stay separate
	// on purpose: cryptorank.io fingerprints the TLS ClientHello and khala.io
	// never challenged a non-browser client, so unifying them would either
	// impose the browser fingerprint on a site that never asked for it, or
	// tempt a reader into deleting the profile cryptorank depends on
	// (internal/research/khala package doc; DR-006 D1/D9).
	kf, err := khala.New(khala.Options{})
	if err != nil {
		log.Fatalf("fudcourt-data: khala: %v", err)
	}
	// llama is a THIRD family, again with its own client: api.llama.fi is plain
	// HTTPS (no fingerprinting wall) and its cache is IN-MEMORY with a 15s TTL
	// rather than a disk cache, because its largest body is an 8.9MB list whose
	// window the TS route also kept in process. Keeping the three clients
	// separate is the same call as khala's (internal/research/llama's package doc);
	// FUDCOURT_DATA_LLAMA_TTL overrides the TTL.
	lf, err := llama.New(llama.Options{})
	if err != nil {
		log.Fatalf("fudcourt-data: llama: %v", err)
	}
	// news is a FOURTH family and the first whose upstream is a document rather
	// than a JSON API: cointelegraph.com/rss is plain HTTPS (no fingerprint
	// needed), so it is a third plain net/http fetcher, not a tls-client one.
	nf, err := news.New(news.Options{})
	if err != nil {
		log.Fatalf("fudcourt-data: news: %v", err)
	}
	// chainrank is a FIFTH family: two read modes over a JSON API whose
	// pagination is relayed UNTOUCHED (upstream's own clamping is the answer the
	// board must show). Its writes stay unproxied on purpose -- each has a real
	// side effect on someone else's production service.
	cf, err := chainrank.New(chainrank.Options{})
	if err != nil {
		log.Fatalf("fudcourt-data: chainrank: %v", err)
	}
	// coinglass is the SIXTH family, and the first whose upstream encrypts its
	// payloads: capi.coinglass.com is the dashboard's own backend and takes NO
	// API key, so the body is AES-128-ECB x2 + gzip instead of authenticated.
	// Plain net/http is enough -- the host does not fingerprint the TLS
	// ClientHello -- and the decryptor is stdlib only
	// (internal/research/coinglass package doc).
	gf, err := coinglass.New(coinglass.Options{})
	if err != nil {
		log.Fatalf("fudcourt-data: coinglass: %v", err)
	}
	// coinank is the SEVENTH family, and the second keyless one -- but for a
	// different reason. coinglass is keyless because a PAYLOAD is encrypted and
	// we decrypt it; coinank is keyless because the CREDENTIAL is computed by the
	// client. Its `coinank-apikey` header looks like a key and is not one: the
	// browser derives it from a public uuid constant and the clock, so there is
	// nothing to procure. Plain net/http is again enough (measured), and the
	// signature is stdlib only (internal/research/coinank package doc).
	af, err := coinank.New(coinank.Options{})
	if err != nil {
		log.Fatalf("fudcourt-data: coinank: %v", err)
	}
	// coinmarketcap is the EIGHTH family, and the third keyless one -- but the
	// simplest: nothing is encrypted (unlike coinglass) and nothing is computed
	// (unlike coinank). api.coinmarketcap.com/data-api/v3 is the dashboard's own
	// backend and takes NO credential of any kind, so this is a plain GET. The
	// documented pro-api host needs an issued X-CMC_PRO_API_KEY and is not used.
	// Plain net/http is enough -- the host does not fingerprint the TLS
	// ClientHello -- and the family is stdlib only (internal/research/
	// coinmarketcap package doc).
	mf, err := coinmarketcap.New(coinmarketcap.Options{})
	if err != nil {
		log.Fatalf("fudcourt-data: coinmarketcap: %v", err)
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           newServer(f, ttl, khala.Service{F: kf, TTL: khala.TTLDefault()}, llama.Service{F: lf}, news.Service{F: nf}, chainrank.Service{F: cf}, coinglass.Service{F: gf}, coinank.Service{F: af}, coinmarketcap.Service{F: mf}).mux(),
		ReadHeaderTimeout: 10 * time.Second,
		// The handler set is GET-only (the families are read surfaces), so the
		// whole request -- headers plus the empty body -- must arrive well
		// inside a request budget; ReadHeaderTimeout alone leaves a slow-body
		// client holding a connection. ReadTimeout closes that gap.
		ReadTimeout: 15 * time.Second,
		// A cold CoinGlass fetch decrypts two gzip'd AES layers before it can
		// answer, so the write budget stays generous; it is the ceiling a stuck
		// handler hits instead of pinning a connection forever.
		WriteTimeout: 90 * time.Second,
		// Keep-alive reuse from the web proxy is the point of the outbound pool
		// (platform/httpx); the idle ceiling is what stops an abandoned
		// keep-alive connection from lingering.
		IdleTimeout: 120 * time.Second,
		// The proxy forwards a small header set; 64 KiB is far above anything a
		// legitimate caller sends and well under the 1 MiB stdlib default, so an
		// oversized-header request is refused at the listener rather than after
		// the handler has read it.
		MaxHeaderBytes: 1 << 16,
	}
	log.Printf("fudcourt-data listening on %s (cryptorank: cache %s, ttl %ds, %d modes; khala: cache %s, ttl %ds, %d modes; llama: ttl %ds, %d modes; news: ttl %ds, %d feeds; chainrank: ttl %ds, %d modes; coinglass: cache %s, ttl %ds, %d modes; coinank: cache %s, ttl %ds, %d modes; coinmarketcap: cache %s, ttl %ds, %d modes)",
		addr, f.CacheDir(), ttl, cryptorank.ModeCount, kf.CacheDir(), khala.TTLDefault(), khala.ModeCount, lf.TTL(), llama.ModeCount, nf.TTL(), news.SourceCount, cf.TTL(), chainrank.ModeCount, gf.CacheDir(), coinglass.TTLDefault(), coinglass.ModeCount, af.CacheDir(), coinank.TTLDefault(), coinank.ModeCount, mf.CacheDir(), coinmarketcap.TTLDefault(), coinmarketcap.ModeCount)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sh, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sh)
	}()
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("fudcourt-data: %v", err)
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
	// cgs is the coinglass family orchestrator (fetch -> dual AES decrypt ->
	// envelope), a value for the same reason: the Fetcher it wraps owns the
	// cache, and `fresh` travels per request.
	cgs coinglass.Service
	// ans is the coinank family orchestrator (fetch -> signed envelope), a value
	// for the same reason: the Fetcher owns the cache and `fresh` travels per
	// request.
	ans coinank.Service
	// cms is the coinmarketcap family orchestrator (fetch -> verbatim envelope),
	// a value for the same reason: the Fetcher owns the cache and `fresh`
	// travels per request.
	cms coinmarketcap.Service
	// ttl is the per-route cache TTL in seconds for an ordinary request; a
	// fresh=1 request passes 0 instead (the Python helper's --ttl 0). Both are
	// per-request arguments, never shared fetcher state.
	ttl int
	// retryBase is the first 429 backoff step; the route uses 3s and the tests
	// set 0 so the policy is proven without sleeping.
	retryBase time.Duration
}

func newServer(f fetcher, ttl int, ks khala.Service, ls llama.Service, ns news.Service, cs chainrank.Service, cgs coinglass.Service, ans coinank.Service, cms coinmarketcap.Service) *server {
	return &server{f: f, ks: ks, ls: ls, ns: ns, cs: cs, cgs: cgs, ans: ans, cms: cms, ttl: ttl, retryBase: 3 * time.Second}
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
			// (cmd/data/main_test.go, backend/data/README.md,
			// frontend/web/scripts/check-contract.py), and a reader can still see
			// both families from one probe.
			"khala": fmt.Sprintf("%d modes", khala.ModeCount),
			// llama is the third independent mode table, reported the same way.
			"llama": fmt.Sprintf("%d modes", llama.ModeCount),
			// news is a fourth family, reported as its own key for the same
			// reason: `build` stays the cryptorank count every gate asserts.
			"news": fmt.Sprintf("%d feeds", news.SourceCount),
			// chainrank is the fifth.
			"chainrank": fmt.Sprintf("%d modes", chainrank.ModeCount),
			// coinglass is the sixth. `keyless` is stated here because it is
			// the family's whole reason to exist: a reader must be able to
			// tell, from one probe, that this needs no API key.
			"coinglass": fmt.Sprintf("%d modes (keyless)", coinglass.ModeCount),
			// coinank is the seventh, and keyless for a DIFFERENT reason than
			// coinglass: nothing is encrypted here, the request carries a
			// client-computed signature instead of an issued key. The qualifier
			// distinguishes the two so a reader does not assume one scheme.
			"coinank": fmt.Sprintf("%d modes (keyless, client signature)", coinank.ModeCount),
			// coinmarketcap is the eighth, and keyless for a THIRD reason:
			// neither an encrypted body nor a computed signature — the
			// dashboard's own backend simply takes no credential at all.
			"coinmarketcap": fmt.Sprintf("%d modes (keyless, no credential)", coinmarketcap.ModeCount),
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
	mux.HandleFunc("/api/coinglass", func(w http.ResponseWriter, r *http.Request) {
		s.handleCoinglass(w, r)
	})
	mux.HandleFunc("/api/coinank", func(w http.ResponseWriter, r *http.Request) {
		s.handleCoinank(w, r)
	})
	mux.HandleFunc("/api/coinmarketcap", func(w http.ResponseWriter, r *http.Request) {
		s.handleCoinmarketcap(w, r)
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

// handleCoinglass serves the CoinGlass futures family.
//
// EVERY mode on this table is KEYLESS. The bytes come from capi.coinglass.com --
// the endpoint the www.coinglass.com dashboard itself calls -- and are unwrapped
// with the two-layer AES scheme in internal/research/coinglass/decrypt.go. There
// is no CG-API-KEY anywhere in this path, on purpose: the official open-api-v4
// host is a different product (a human-issued key, different coverage), not an
// alternative transport for these modes, so wiring it would trade a solved
// reverse-engineering problem for a procurement one.
//
// Posture mirrors handleKhala: local params validated strictly and never
// clamped, an unscoped param refused with 400, and CoinGlass's OWN refusal
// envelope surfaced as 502 carrying its message -- never a 200 with an empty
// table.
func (s *server) handleCoinglass(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, 405, map[string]interface{}{"error": "method not allowed"})
		return
	}
	q := r.URL.Query()
	mode := q.Get(coinglass.ParamMode)
	if mode == "" || !coinglass.Known(mode) {
		var got interface{}
		if mode != "" {
			got = mode
		}
		writeJSON(w, 400, map[string]interface{}{
			"error": coinglass.ErrUnknownMode,
			"modes": coinglass.Modes,
			"got":   got,
		})
		return
	}
	// Param scoping: a param the mode does not accept (including a known param
	// sent to the wrong mode, and any unknown name) is a 400, never ignored.
	for p := range q {
		if !coinglass.Accepts(mode, p) {
			writeJSON(w, 400, map[string]interface{}{
				"error":  coinglass.ErrUnexpected,
				"detail": coinglass.UnexpectedParamDetail(p, mode),
				"param":  p,
				"mode":   mode,
			})
			return
		}
	}
	symbol := ""
	if mode == "openInterest" {
		symbol = q.Get(coinglass.ParamSymbol)
		if symbol == "" {
			writeJSON(w, 400, map[string]interface{}{
				"error": coinglass.ErrMissingParam, "detail": coinglass.DetailSymbolRequired, "mode": mode,
			})
			return
		}
		if !coinglass.ValidSymbol(symbol) {
			writeJSON(w, 400, map[string]interface{}{
				"error": coinglass.ErrInvalidParam, "detail": coinglass.DetailSymbolInvalid, "mode": mode, "symbol": symbol,
			})
			return
		}
	}
	// fresh=1 bypasses the disk cache for this request only, exactly as the
	// khala handler does. The value is an ARGUMENT, never fetcher state, so two
	// concurrent requests cannot observe each other's policy.
	fresh := q.Get(coinglass.ParamFresh) == "1"
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	env, err := s.cgs.Envelope(ctx, mode, symbol, fresh)
	if err != nil {
		writeCoinglassError(w, mode, err)
		return
	}
	w.Header().Set("X-CG-Upstream", env.Upstream)
	w.Header().Set("X-CG-Cache", env.Cache)
	// X-CG-Cipher exposes which rotation slot (`v`) upstream used. It is a
	// header rather than body state because it describes the TRANSPORT: the
	// `v` table is what decides Key0, so a consumer debugging a payload needs
	// the slot alongside the rows. It is NOT derivable from the envelope.
	if env.Cipher != "" {
		w.Header().Set("X-CG-Cipher", env.Cipher)
	}
	w.Header().Set("Cache-Control", "public, max-age=30")
	writeJSON(w, 200, env)
}

// writeCoinglassError maps a family error to the frozen body. An upstream
// refusal is 502 carrying CoinGlass's own code and message: the caller learns
// what upstream said, and no empty table is invented for it.
func writeCoinglassError(w http.ResponseWriter, mode string, err error) {
	var he *coinglass.HardError
	if errors.As(err, &he) && he.Kind == "upstream" {
		writeJSON(w, 502, map[string]interface{}{
			"error":  coinglass.ErrUpstream,
			"mode":   mode,
			"code":   he.Code,
			"detail": he.Detail,
		})
		return
	}
	writeJSON(w, 502, map[string]interface{}{
		"error":  "upstream unreachable",
		"mode":   mode,
		"detail": err.Error(),
	})
}

// handleCoinank serves the CoinAnk futures family.
//
// EVERY mode on this table is KEYLESS, and in a different sense from coinglass:
// nothing here is encrypted. The upstream demands a `coinank-apikey` header that
// is not an issued credential at all -- it is computed from a public uuid
// constant and the clock (internal/research/coinank/sign.go), so there is no key
// to acquire and no reason for this route to ever read one.
//
// The route is strict in the same way the coinglass one is, and one case here is
// stricter because upstream is QUIETER than CoinGlass's:
//
//	mode       required, must be in coinank.Modes
//	interval   only mode=liquidation; must be in coinank.Intervals
//	fresh=1    skips the disk cache for this request only
//
// The interval allowlist is not decoration. CoinAnk answers an UNSUPPORTED
// interval with HTTP 200, the same exchange rows, and totalTurnover=0 on every
// row -- indistinguishable from "no liquidations occurred". Passing a bad value
// through would render a confident all-zero table, so it is refused with a 400
// here and never reaches upstream.
//
// Params upstream IGNORES get no accept row at all (symbol/baseCoin on
// fundingRate, pageNum/pageSize on whales -- both measured as no-ops): a route
// that accepts a param the request does not honour is lying about what it did.
//
// Upstream's own refusal (HTTP 200, success:false, "system error!") becomes a 502
// carrying its code and message. It never becomes a 200 with an empty table.
func (s *server) handleCoinank(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, 405, map[string]interface{}{"error": "method not allowed"})
		return
	}
	q := r.URL.Query()
	mode := q.Get(coinank.ParamMode)
	if mode == "" || !coinank.Known(mode) {
		var got interface{}
		if mode != "" {
			got = mode
		}
		writeJSON(w, 400, map[string]interface{}{
			"error": coinank.ErrUnknownMode,
			"modes": coinank.Modes,
			"got":   got,
		})
		return
	}
	// Param scoping: a param the mode does not accept (including a known param
	// sent to the wrong mode, and any unknown name) is a 400, never ignored.
	for p := range q {
		if !coinank.Accepts(mode, p) {
			writeJSON(w, 400, map[string]interface{}{
				"error":  coinank.ErrUnexpected,
				"detail": coinank.UnexpectedParamDetail(p, mode),
				"param":  p,
				"mode":   mode,
			})
			return
		}
	}
	interval := ""
	if mode == "liquidation" {
		interval = q.Get(coinank.ParamInterval)
		if interval == "" {
			interval = coinank.DefaultInterval
		}
		if !coinank.ValidInterval(interval) {
			writeJSON(w, 400, map[string]interface{}{
				"error":    coinank.ErrInvalidParam,
				"detail":   coinank.DetailIntervalInvalid,
				"mode":     mode,
				"interval": interval,
			})
			return
		}
	}
	// fresh=1 bypasses the disk cache for this request only. It is an ARGUMENT,
	// never fetcher state, so two concurrent requests cannot observe each other's
	// policy. It is also the only path that re-signs the request, since the
	// signature is derived from the millisecond clock.
	fresh := q.Get(coinank.ParamFresh) == "1"
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	env, err := s.ans.Envelope(ctx, mode, interval, fresh)
	if err != nil {
		writeCoinankError(w, mode, err)
		return
	}
	w.Header().Set("X-CA-Upstream", env.Upstream)
	w.Header().Set("X-CA-Cache", env.Cache)
	w.Header().Set("Cache-Control", "public, max-age=30")
	writeJSON(w, 200, env)
}

// writeCoinankError maps a family error to the frozen body. An upstream refusal
// is 502 carrying CoinAnk's own code and message: the caller learns what upstream
// said, and no empty table is invented for it.
func writeCoinankError(w http.ResponseWriter, mode string, err error) {
	var he *coinank.HardError
	if errors.As(err, &he) && he.Kind == "upstream" {
		writeJSON(w, 502, map[string]interface{}{
			"error":  coinank.ErrUpstream,
			"mode":   mode,
			"code":   he.Code,
			"detail": he.Detail,
		})
		return
	}
	writeJSON(w, 502, map[string]interface{}{
		"error":  "upstream unreachable",
		"mode":   mode,
		"detail": err.Error(),
	})
}

// handleCoinmarketcap serves the CoinMarketCap market-data family (the eighth).
// The wire contract mirrors the coinglass/coinank siblings -- validate local
// params strictly (never clamp), refuse loudly, never invent a payload -- with
// three family differences:
//   - the mode table is its own (4 modes), reported separately on /healthz;
//   - the paginated modes validate `start`/`limit` against LOCAL bounds, because
//     upstream answers limit=0 with a success envelope carrying an empty list;
//   - mode=marketPairs requires a `slug` and validates it, because upstream
//     answers a missing slug with a 200 refusal envelope.
func (s *server) handleCoinmarketcap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, 405, map[string]interface{}{"error": "method not allowed"})
		return
	}
	q := r.URL.Query()
	mode := q.Get(coinmarketcap.ParamMode)
	if mode == "" || !coinmarketcap.Known(mode) {
		var got interface{}
		if mode != "" {
			got = mode
		}
		writeJSON(w, 400, map[string]interface{}{
			"error": coinmarketcap.ErrUnknownMode,
			"modes": coinmarketcap.Modes,
			"got":   got,
		})
		return
	}
	// Param scoping: a param the mode does not accept (including a known param
	// sent to the wrong mode, and any unknown name) is a 400, never ignored.
	// This matters because upstream IGNORES an unrecognised param outright.
	for p := range q {
		if !coinmarketcap.Accepts(mode, p) {
			writeJSON(w, 400, map[string]interface{}{
				"error":  coinmarketcap.ErrUnexpected,
				"detail": coinmarketcap.UnexpectedParamDetail(p, mode),
				"param":  p,
				"mode":   mode,
			})
			return
		}
	}

	slug := ""
	if mode == "marketPairs" {
		slug = q.Get(coinmarketcap.ParamSlug)
		if !coinmarketcap.ValidSlug(slug) {
			writeJSON(w, 400, map[string]interface{}{
				"error":  coinmarketcap.ErrInvalidParam,
				"detail": coinmarketcap.MissingSlugDetail,
				"mode":   mode,
				"slug":   slug,
			})
			return
		}
	}

	start, limit := coinmarketcap.DefaultStart, coinmarketcap.DefaultLimit
	if mode == "listing" || mode == "exchanges" || mode == "marketPairs" {
		var ok bool
		if start, ok = coinmarketcap.ParseStart(q.Get(coinmarketcap.ParamStart)); !ok {
			writeJSON(w, 400, map[string]interface{}{
				"error":  coinmarketcap.ErrInvalidParam,
				"detail": coinmarketcap.DetailStartInvalid,
				"mode":   mode,
				"start":  q.Get(coinmarketcap.ParamStart),
			})
			return
		}
		if limit, ok = coinmarketcap.ParseLimit(q.Get(coinmarketcap.ParamLimit)); !ok {
			writeJSON(w, 400, map[string]interface{}{
				"error":  coinmarketcap.ErrInvalidParam,
				"detail": coinmarketcap.DetailLimitInvalid,
				"mode":   mode,
				"limit":  q.Get(coinmarketcap.ParamLimit),
			})
			return
		}
	}

	// fresh=1 bypasses the disk cache for this request only. It is an ARGUMENT,
	// never fetcher state, so two concurrent requests cannot observe each
	// other's policy.
	fresh := q.Get(coinmarketcap.ParamFresh) == "1"
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	env, err := s.cms.Envelope(ctx, mode, slug, start, limit, fresh)
	if err != nil {
		writeCoinmarketcapError(w, mode, err)
		return
	}
	w.Header().Set("X-CMC-Upstream", env.Upstream)
	w.Header().Set("X-CMC-Cache", env.Cache)
	w.Header().Set("Cache-Control", "public, max-age=30")
	writeJSON(w, 200, env)
}

// writeCoinmarketcapError maps a family error to the frozen body. An upstream
// refusal is 502 carrying CoinMarketCap's own code and message: the caller
// learns what upstream said, and no empty table is invented for it.
func writeCoinmarketcapError(w http.ResponseWriter, mode string, err error) {
	var he *coinmarketcap.HardError
	if errors.As(err, &he) && he.Kind == "upstream" {
		writeJSON(w, 502, map[string]interface{}{
			"error":  coinmarketcap.ErrUpstream,
			"mode":   mode,
			"code":   he.Code,
			"detail": he.Detail,
		})
		return
	}
	writeJSON(w, 502, map[string]interface{}{
		"error":  "upstream unreachable",
		"mode":   mode,
		"detail": err.Error(),
	})
}

// handleLlama serves the DeFiLlama read family (api.llama.fi): three modes with
// two of OUR params validated strictly. It is the Go half of
// frontend/web/app/api/llama/route.ts, which is now a verbatim proxy here.
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
	if he.Status == 429 {
		writeJSON(w, 429, body)
		return
	}
	// Status 0, or any other 2xx, is NOT a real upstream failure status: the
	// refusal bodies built in llama/fetch.go carry "not-a-list"/"non-json" with
	// Status 200 (the upstream HTTP status, not an error status), and relaying
	// it would serve a fake 200 error page. Coerce those to a 502.
	if he.Status > 0 && he.Status < 300 {
		writeJSON(w, 502, body)
		return
	}
	if he.Status >= 300 {
		writeJSON(w, he.Status, body)
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
		log.Printf("fudcourt-data: ALARM khala %s %s: %s (%s)", he.Kind, upstream, he.Detail, mode)
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
		log.Printf("fudcourt-data: ALARM %s %s: %s (%s)", hard.Kind, upstream, hard.Detail, hard.Upstrl)
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

// writeJSON delegates to platform/httpx so the served-bytes parity test proves
// the production writer (no HTML escaping, one trailing newline).
func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	httpx.WriteJSON(w, code, v)
}

// handleNews serves the Cointelegraph RSS read family: one feed with two of OUR
// params validated strictly. It is the Go half of
// frontend/web/app/api/news/route.ts, which is now a verbatim proxy here.
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
// frontend/web/app/api/chainrank/route.ts, which is now a verbatim proxy here.
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
	var se *chainrank.ShapeError
	if errors.As(err, &se) {
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
