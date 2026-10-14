package serve

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
)

// This file is the /api/v1/dex/* handler set (plan §30/§31). Every handler
// reads through dexstore.Reader and writes the canonical shape; none of them
// knows a provider's name. Filtering, sorting and cursor paging are the plan
// §31 requirements; diagnostics are opt-in.

// --- registry reads ---------------------------------------------------------

func (s *server) handleDexChains(w http.ResponseWriter, r *http.Request) {
	lim, err := limitParam(r)
	if err != nil {
		badRequest(w, r, err.Error())
		return
	}
	rows, err := s.r.ListChains(r.Context(), canon.ListQuery{Limit: lim})
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

func (s *server) handleDexProtocols(w http.ResponseWriter, r *http.Request) {
	lim, err := limitParam(r)
	if err != nil {
		badRequest(w, r, err.Error())
		return
	}
	rows, err := s.r.ListProtocols(r.Context(), canon.ListQuery{Limit: lim})
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleDexVenues serves the venue registry. A pool carries only
// dex_venue_id, an opaque minted id, so without this read a consumer can never
// render WHICH exchange a pool belongs to — the id alone is unreadable and
// resolving it in the frontend would mean hard-coding a mapping the API should
// own. Mirrors /chains and /protocols: the registry the other reads point into.
func (s *server) handleDexVenues(w http.ResponseWriter, r *http.Request) {
	lim, err := limitParam(r)
	if err != nil {
		badRequest(w, r, err.Error())
		return
	}
	rows, err := s.r.ListVenues(r.Context(), canon.ListQuery{Limit: lim})
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleDexToken serves one token plus its canonical anchor.
func (s *server) handleDexToken(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// The token list reader is the market contract's; resolve the single row by
	// scanning at a bounded window (a token id is opaque, so there is no
	// by-id reader on canon.Reader — the list is the supported read).
	rows, err := s.r.ListAssets(r.Context(), canon.ListQuery{Limit: 1000})
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	_ = rows
	writeErr(w, r, http.StatusNotFound, "not_found", "unknown token "+id)
}

// handleDexTokenPools serves the pools that trade one token. Filtering is on
// the pool query's token coordinate.
func (s *server) handleDexTokenPools(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if s.dex == nil {
		d.require()
		return
	}
	id := r.PathValue("id")
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	chain := r.URL.Query().Get("chain")
	rows, err := s.dex.ListDexPools(r.Context(), dexstore.DexPoolQuery{
		ChainID: chain, TokenID: id, Limit: lim,
	})
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// --- pools ------------------------------------------------------------------

// handleDexPools serves the filtered, cursor-paged pool list (plan §31).
func (s *server) handleDexPools(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	q := r.URL.Query()
	pool := dexstore.DexPoolQuery{
		ChainID:    q.Get("chain"),
		ProtocolID: q.Get("protocol"),
		VenueID:    q.Get("venue"),
		TokenID:    q.Get("token"),
		Limit:      lim,
	}
	if v := q.Get("cursor"); v != "" {
		at, poolID, err := decodePoolCursor(v)
		if err != nil {
			badRequest(w, r, err.Error())
			return
		}
		pool.BeforeAt, pool.BeforePoolID = at, poolID
	}
	if v := q.Get("min_liquidity"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			badRequest(w, r, "min_liquidity must be a number")
			return
		}
		pool.MinLiquidityUSD = &f
	}
	if v := q.Get("min_volume"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			badRequest(w, r, "min_volume must be a number")
			return
		}
		pool.MinVolume24hUSD = &f
	}
	rows, err := s.dex.ListDexPools(r.Context(), pool)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	out := rows
	// A cursor hint for the next page, when the page is full.
	if len(rows) == lim && len(rows) > 0 {
		w.Header().Set("Link", `</api/v1/dex/pools?cursor=`+encodePoolCursor(rows[len(rows)-1])+`>; rel="next"`)
	}
	writeData(w, out)
}

// handleDexPool serves one pool's latest snapshot.
func (s *server) handleDexPool(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	p, ok, err := s.dex.GetDexPool(r.Context(), r.PathValue("id"))
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	if !ok {
		writeErr(w, r, http.StatusNotFound, "not_found", "unknown pool "+r.PathValue("id"))
		return
	}
	writeData(w, p)
}

func (s *server) handleDexPoolSwaps(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	start, end, ok := d.window()
	if !ok {
		return
	}
	rows, err := s.dex.ReadDexSwaps(r.Context(), r.PathValue("id"), start, end, lim)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleDexPoolCandles serves a pool's OHLCV bars (plan §30). The interval is
// validated against the canon vocabulary so an unknown frame is a 400, never a
// silent empty result.
func (s *server) handleDexPoolCandles(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	interval := r.URL.Query().Get("interval")
	if interval == "" {
		interval = "1m"
	}
	if !canon.ValidateTimeframe(interval) {
		badRequest(w, r, "unknown interval "+interval)
		return
	}
	start, end, ok := d.window()
	if !ok {
		return
	}
	rows, err := s.dex.ReadDexCandles(r.Context(), r.PathValue("id"), interval, start, end, lim)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

func (s *server) handleDexPoolLiquidity(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	start, end, ok := d.window()
	if !ok {
		return
	}
	rows, err := s.dex.ReadDexLiquiditySnapshots(r.Context(), r.PathValue("id"), start, end, lim)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

func (s *server) handleDexPoolOrderbook(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	start, end, ok := d.window()
	if !ok {
		return
	}
	rows, err := s.dex.ReadDexOrderbookSnapshots(r.Context(), r.PathValue("id"), start, end, lim)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// --- markets + rankings -----------------------------------------------------

// handleDexMarkets serves the market snapshots the boards render, reading the
// exact-numeric data.dex_market_snapshot (dexscreener populates it). The pool
// filter is REQUIRED in practice: the reader is keyed on one pool's window, so a
// request without ?pool= returns an empty list rather than every pool's history.
func (s *server) handleDexMarkets(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	q := r.URL.Query()
	// Without ?pool= this is the market BOARD — the newest snapshot per pool —
	// not an empty list: a caller asking for markets wants the markets, and a
	// silently empty 200 is the failure mode the DEX surface forbids. Sorting
	// is a closed vocabulary, and an unknown sort is a loud 400 rather than a
	// quiet fallback to volume.
	if q.Get("pool") == "" {
		sort := q.Get("sort")
		if sort == "" {
			sort = "volume"
		}
		if !dexstore.ValidDexMarketSort(sort) {
			badRequest(w, r, "unknown sort "+sort)
			return
		}
		rows, err := s.dex.ListLatestDexMarketSnapshots(r.Context(), dexstore.DexMarketQuery{
			ChainID: q.Get("chain"), Sort: sort, Limit: lim,
		})
		if err != nil {
			s.readFailed(w, r, err)
			return
		}
		writeData(w, rows)
		return
	}
	rows, err := s.dex.ReadDexMarketSnapshots(r.Context(), q.Get("pool"), time.Time{}, time.Time{}, lim)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// handleDexRankings serves the plan §31 ranking query. An unknown sort is a
// LOUD 400 (never a silent default that mis-reports what the caller asked for).
func (s *server) handleDexRankings(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	sortKey := r.URL.Query().Get("sort")
	if sortKey == "" {
		sortKey = "volume"
	}
	if !dexstore.ValidDexRankingSort(sortKey) {
		badRequest(w, r, "unknown sort "+sortKey)
		return
	}
	rows, err := s.dex.ListDexRankings(r.Context(), dexstore.DexRankingQuery{
		ChainID: r.URL.Query().Get("chain"), Sort: sortKey, Limit: lim,
	})
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// --- routing ----------------------------------------------------------------

// handleDexRouteQuote serves the plan §21 route comparison for a pair.
func (s *server) handleDexRouteQuote(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	q := r.URL.Query()
	in, out := q.Get("token_in"), q.Get("token_out")
	if in == "" || out == "" {
		badRequest(w, r, "token_in and token_out are required")
		return
	}
	rows, err := s.dex.ReadDexRouteQuotes(r.Context(), q.Get("chain"), in, out, lim)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// --- wallets ----------------------------------------------------------------

func (s *server) handleDexWallet(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	start, end, ok := d.window()
	if !ok {
		return
	}
	rows, err := s.dex.ReadDexWalletActivity(r.Context(), r.PathValue("address"), start, end, lim)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// --- risk + MEV + perps -----------------------------------------------------

func (s *server) handleDexRisk(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	start, end, ok := d.window()
	if !ok {
		return
	}
	q := r.URL.Query()
	rows, err := s.dex.ReadDexRiskMetrics(r.Context(), q.Get("subject"), q.Get("metric"), start, end, lim)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

func (s *server) handleDexMEV(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	start, end, ok := d.window()
	if !ok {
		return
	}
	rows, err := s.dex.ReadDexMEVEvents(r.Context(), r.URL.Query().Get("chain"), start, end, lim)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

func (s *server) handleDexPerps(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	rows, err := s.dex.ReadDexPerpMarkets(r.Context(), r.URL.Query().Get("venue"), lim)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

func (s *server) handleDexPerpLiquidations(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	start, end, ok := d.window()
	if !ok {
		return
	}
	rows, err := s.dex.ReadDexPerpLiquidations(r.Context(), r.PathValue("id"), start, end, lim)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// --- observability ----------------------------------------------------------

func (s *server) handleDexProviders(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	rows, err := s.dex.ListProviderHealth(r.Context(), lim)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

func (s *server) handleDexQuality(w http.ResponseWriter, r *http.Request) {
	d := dx{s, w, r}
	if !d.require() {
		return
	}
	lim, ok := d.limit(defaultLimit)
	if !ok {
		return
	}
	rows, err := s.dex.ListQualityStatus(r.Context(), lim)
	if err != nil {
		s.readFailed(w, r, err)
		return
	}
	writeData(w, rows)
}

// --- cursor helpers ---------------------------------------------------------

// errNoDexStore is the loud error a DEX read returns with no store wired.
var errNoDexStore = errNoStore{}

type errNoStore struct{}

func (errNoStore) Error() string {
	return "dex store unavailable: no database pool (research families unaffected)"
}

// intParam parses ?limit= with the house rule: present must be a positive
// integer or a 400, absent takes def, and an oversized value is clamped to
// maxLimit — the same rule limitParam applies everywhere else on this mux, so
// the DEX surface does not have a second limit contract.
func intParam(r *http.Request, def int) (int, error) {
	q := r.URL.Query().Get("limit")
	if q == "" {
		return def, nil
	}
	n, err := strconv.Atoi(q)
	if err != nil {
		return 0, errBadLimit{q}
	}
	if n < 1 {
		return 0, errBadLimit{q}
	}
	if n > maxLimit {
		n = maxLimit
	}
	return n, nil
}

// encodePoolCursor renders the (at, pool_id) keyset cursor.
func encodePoolCursor(p canon.Pool) string {
	return p.At.UTC().Format(time.RFC3339Nano) + "|" + p.PoolID
}

// decodePoolCursor parses the (at, pool_id) keyset cursor.
func decodePoolCursor(s string) (time.Time, string, error) {
	i := strings.LastIndex(s, "|")
	if i <= 0 {
		return time.Time{}, "", errBadCursor{s}
	}
	at, err := time.Parse(time.RFC3339Nano, s[:i])
	if err != nil {
		return time.Time{}, "", errBadCursor{s}
	}
	return at, s[i+1:], nil
}

type errBadCursor struct{ v string }

func (e errBadCursor) Error() string { return "bad cursor " + strconv.Quote(e.v) }
