package serve

import (
	"net/http"
	"time"
)

// This file serves the plan §30 canonical DEX query API under /api/v1/dex/*.
// Provider names appear NOWHERE in this surface: a consumer asks for
// /api/v1/dex/pools, never /api/v1/dex/dexscreener.
//
// MOUNTING: ServeHTTP strips the "/api/data" prefix (a NO-OP for a /api/v1/...
// path) and re-dispatches through the same mux, so these patterns are matched
// verbatim when main.go mounts this handler at /api/v1/ as well as /api/data/.
// The DEX reader (dexstore.Reader, implemented by *repo.Repo) is wired through
// WithDexReader; when it is nil every route answers the loud 503, never an
// empty 200 (plan §65).
//
// Diagnostics (plan §30) are OPT-IN via ?diagnostics=1 so the default payload
// is the canonical rows and nothing else.

// dexRoutes registers the canonical DEX surface on mux. Patterns carry the
// full /api/v1/dex prefix; the Go 1.22 {id} wildcard extracts path segments.
func (s *server) dexRoutes(mux *http.ServeMux) {
	reg := func(pattern string, fn http.HandlerFunc) {
		mux.HandleFunc(pattern, s.get(fn))
	}

	// --- registry (the canonical entities the market contract owns) --------
	reg("/api/v1/dex/chains", s.handleDexChains)
	reg("/api/v1/dex/protocols", s.handleDexProtocols)
	reg("/api/v1/dex/venues", s.handleDexVenues)
	reg("/api/v1/dex/tokens/{id}", s.handleDexToken)
	reg("/api/v1/dex/tokens/{id}/pools", s.handleDexTokenPools)

	// --- pools (plan §30) --------------------------------------------------
	reg("/api/v1/dex/pools", s.handleDexPools)
	reg("/api/v1/dex/pools/{id}", s.handleDexPool)
	reg("/api/v1/dex/pools/{id}/swaps", s.handleDexPoolSwaps)
	reg("/api/v1/dex/pools/{id}/candles", s.handleDexPoolCandles)
	reg("/api/v1/dex/pools/{id}/liquidity", s.handleDexPoolLiquidity)
	reg("/api/v1/dex/pools/{id}/orderbook", s.handleDexPoolOrderbook)

	// --- markets + rankings ------------------------------------------------
	reg("/api/v1/dex/markets", s.handleDexMarkets)
	reg("/api/v1/dex/rankings", s.handleDexRankings)

	// --- routing (plan §21) ------------------------------------------------
	reg("/api/v1/dex/routes/quote", s.handleDexRouteQuote)

	// --- wallets (plan §30) ------------------------------------------------
	reg("/api/v1/dex/wallets/{address}", s.handleDexWallet)

	// --- risk + MEV + perps ------------------------------------------------
	reg("/api/v1/dex/risk", s.handleDexRisk)
	reg("/api/v1/dex/mev", s.handleDexMEV)
	reg("/api/v1/dex/perps", s.handleDexPerps)
	reg("/api/v1/dex/perps/{id}/liquidations", s.handleDexPerpLiquidations)

	// --- observability (plan §58) ------------------------------------------
	reg("/api/v1/dex/providers", s.handleDexProviders)
	reg("/api/v1/dex/quality", s.handleDexQuality)
}

// dx holds the per-request helpers shared by the DEX handlers.
type dx struct {
	s *server
	w http.ResponseWriter
	r *http.Request
}

// require fails LOUDLY when no DEX reader is wired (no database pool).
func (d dx) require() bool {
	if d.s.dex == nil {
		unavailable(d.w, d.r, errNoDexStore)
		return false
	}
	return true
}

// diagnostics reports whether the caller opted into the diagnostic block.
func (d dx) diagnostics() bool {
	v := d.r.URL.Query().Get("diagnostics")
	return v == "1" || v == "true"
}

// limit parses ?limit= with the house rule (present must be a positive integer
// or a 400; absent takes def).
func (d dx) limit(def int) (int, bool) {
	n, err := intParam(d.r, def)
	if err != nil {
		badRequest(d.w, d.r, err.Error())
		return 0, false
	}
	return n, true
}

// window parses ?start=&end= (RFC3339 or bare date).
func (d dx) window() (start, end time.Time, ok bool) {
	start, end, err := window(d.r)
	if err != nil {
		badRequest(d.w, d.r, err.Error())
		return start, end, false
	}
	return start, end, true
}
