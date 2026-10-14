package serve

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
)

// This file is the /api/v1/dex/* handler test. Before it, the whole canonical
// DEX surface was exercised only by shell curl against a live sidecar — no test
// pinned the envelope, the loud failures, or the limit contract. The fake reader
// records the limit it was asked for so the shared clamp (maxLimit) is asserted,
// not assumed.

// fakeDexReader implements dexstore.Reader over seeded rows and records the
// limit it was handed. fail simulates a store outage (503).
//
// ListDexPools honours q.Limit exactly as the real reader does (SQL LIMIT $n
// after clampLimit, dex_reader.go:124-125): it returns at most q.Limit rows.
// A fake that ignored the limit would make any row-count assertion test the
// fake instead of the handler — that is the vacuous test this now avoids.
//
// The recorded limit is mutex-guarded: the handlers are safe to call from many
// goroutines (that is what the read surface promises), so a test fake that
// writes a field per call would report a RACE and block anyone from running
// this package under -race. The guard is on the FAKE, not the production path.
//
// f.pools and f.fail are set once at construction and never mutated, so reading
// them without the lock (as the non-recording methods do) is safe; a future
// mutation must take f.mu too.
type fakeDexReader struct {
	pools []canon.Pool
	fail  error

	mu        sync.Mutex
	lastLimit int
	// sortSeen is the sort the last board read was called with.
	sortSeen string
	// markets is the board the list read returns.
	markets []canon.DexMarketSnapshot
}

// recordedSort is the sort the last market-board read was called with.
func (f *fakeDexReader) recordedSort() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sortSeen
}

// recordedLimit reads the last limit the fake was handed.
func (f *fakeDexReader) recordedLimit() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastLimit
}

func (f *fakeDexReader) ListDexPools(_ context.Context, q dexstore.DexPoolQuery) ([]canon.Pool, error) {
	f.mu.Lock()
	f.lastLimit = q.Limit
	f.mu.Unlock()
	if f.fail != nil {
		return nil, f.fail
	}
	// Mirror the real reader: LIMIT $n caps the rows returned. A limit <= 0
	// never reaches a reader through the handler (limitParam rejects <1), but
	// clamp() treats it as "all", matching clampLimit's intent.
	return clamp(f.pools, q.Limit), nil
}

func (f *fakeDexReader) GetDexPool(context.Context, string) (canon.Pool, bool, error) {
	if f.fail != nil {
		return canon.Pool{}, false, f.fail
	}
	if len(f.pools) == 0 {
		return canon.Pool{}, false, nil
	}
	return f.pools[0], true, nil
}

func (f *fakeDexReader) ListDexRankings(_ context.Context, q dexstore.DexRankingQuery) ([]canon.Pool, error) {
	f.mu.Lock()
	f.lastLimit = q.Limit
	f.mu.Unlock()
	if f.fail != nil {
		return nil, f.fail
	}
	return f.pools, nil
}

func (f *fakeDexReader) ReadDexSwaps(context.Context, string, time.Time, time.Time, int) ([]canon.Swap, error) {
	return nil, f.fail
}
func (f *fakeDexReader) ReadDexCandles(context.Context, string, string, time.Time, time.Time, int) ([]canon.DexCandle, error) {
	return nil, f.fail
}
func (f *fakeDexReader) ReadDexLiquiditySnapshots(context.Context, string, time.Time, time.Time, int) ([]canon.DexLiquiditySnapshot, error) {
	return nil, f.fail
}
func (f *fakeDexReader) ReadDexMarketSnapshots(context.Context, string, time.Time, time.Time, int) ([]canon.DexMarketSnapshot, error) {
	return nil, f.fail
}

// ListLatestDexMarketSnapshots mirrors the real reader's board read and records
// the sort it was asked for, so the handler's default (volume) is asserted
// rather than assumed.
func (f *fakeDexReader) ListLatestDexMarketSnapshots(_ context.Context, q dexstore.DexMarketQuery) ([]canon.DexMarketSnapshot, error) {
	f.mu.Lock()
	f.sortSeen = q.Sort
	f.mu.Unlock()
	if f.fail != nil {
		return nil, f.fail
	}
	return f.markets, nil
}
func (f *fakeDexReader) ReadDexLiquidityPositions(context.Context, string, time.Time, time.Time, int) ([]canon.DexLiquidityPosition, error) {
	return nil, f.fail
}
func (f *fakeDexReader) ReadDexOrderbookSnapshots(context.Context, string, time.Time, time.Time, int) ([]canon.DexOrderbookSnapshot, error) {
	return nil, f.fail
}
func (f *fakeDexReader) ReadDexWalletActivity(context.Context, string, time.Time, time.Time, int) ([]canon.WalletActivity, error) {
	return nil, f.fail
}
func (f *fakeDexReader) ReadDexRiskMetrics(context.Context, string, string, time.Time, time.Time, int) ([]canon.RiskMetric, error) {
	return nil, f.fail
}
func (f *fakeDexReader) ReadDexMEVEvents(context.Context, string, time.Time, time.Time, int) ([]canon.MEVEvent, error) {
	return nil, f.fail
}
func (f *fakeDexReader) ReadDexPerpMarkets(context.Context, string, int) ([]canon.PerpMarket, error) {
	return nil, f.fail
}
func (f *fakeDexReader) ReadDexPerpLiquidations(context.Context, string, time.Time, time.Time, int) ([]canon.PerpLiquidation, error) {
	return nil, f.fail
}
func (f *fakeDexReader) ReadDexRouteQuotes(context.Context, string, string, string, int) ([]canon.RouteQuote, error) {
	return nil, f.fail
}
func (f *fakeDexReader) ListDexDeployments(context.Context, string, int) ([]canon.DexDeployment, error) {
	return nil, f.fail
}
func (f *fakeDexReader) ListProviderHealth(context.Context, int) ([]dexstore.ProviderHealth, error) {
	return nil, f.fail
}
func (f *fakeDexReader) ListQualityStatus(context.Context, int) ([]dexstore.QualityStatus, error) {
	return nil, f.fail
}

var _ dexstore.Reader = (*fakeDexReader)(nil)

// dexServer wires a test server with the DEX read port attached.
func dexServer(t *testing.T, dr dexstore.Reader) http.Handler {
	t.Helper()
	h, _, _ := newTestServer(t)
	if dr == nil {
		return h // no WithDexReader: the port stays unset
	}
	return WithDexReader(h, dr)
}

// TestDexVenuesServesTheRegistry pins the read that makes a pool's
// dex_venue_id readable. A pool carries only the minted id, so without this
// route a consumer can render "venue:cd59236a3b" and never the exchange. It
// reads through the canon reader (like /chains), so the fake canon reader is
// what must be seeded — seeding the DEX reader would assert on an empty list
// and pass vacuously.
func TestDexVenuesServesTheRegistry(t *testing.T) {
	name := "uniswap_v3"
	h, r, _ := newTestServer(t)
	r.venues = []canon.Venue{{
		VenueID: "venue:cd59236a3b", Name: &name, Kind: "dex",
		MarketTypes: []string{"swap"},
	}}
	rec, body := get(t, h, "/api/v1/dex/venues")
	if rec.Code != 200 {
		t.Fatalf("venues: %d %s", rec.Code, rec.Body.String())
	}
	rows, ok := body["data"].([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("envelope: %v", body)
	}
	row := rows[0].(map[string]any)
	if row["venue_id"] != "venue:cd59236a3b" || row["name"] != "uniswap_v3" {
		t.Fatalf("row: %v", row)
	}
}

// TestDexMarketsWithoutPoolIsTheBoard pins the read that replaced a silently
// empty list: a caller asking for markets gets the newest snapshot per pool. An
// empty 200 here would be indistinguishable from "no markets exist", which is
// the fabrication-by-omission the DEX surface forbids.
func TestDexMarketsWithoutPoolIsTheBoard(t *testing.T) {
	vol, err := canon.DecFromString("94241.71")
	if err != nil {
		t.Fatalf("fixture decimal: %v", err)
	}
	dr := &fakeDexReader{markets: []canon.DexMarketSnapshot{{
		SnapshotID: "market_snapshot:abc", PoolID: "pool:x", ChainID: "chain:y",
		Volume24hUSD: &vol,
	}}}
	h := dexServer(t, dr)
	rec, body := get(t, h, "/api/v1/dex/markets")
	if rec.Code != 200 {
		t.Fatalf("markets: %d %s", rec.Code, rec.Body.String())
	}
	rows, ok := body["data"].([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("envelope: %v", body)
	}
	if rows[0].(map[string]any)["pool_id"] != "pool:x" {
		t.Fatalf("row: %v", rows[0])
	}
	// The board's default sort is volume: the handler must not hand the reader
	// an empty sort the SQL would silently treat as something else.
	if got := dr.recordedSort(); got != "volume" {
		t.Fatalf("default sort = %q, want volume", got)
	}
}

// TestDexMarketsUnknownSortIsLoud400 pins the closed sort vocabulary: a sort the
// market board cannot satisfy (liquidity/trending/score belong to rankings) must
// fail loudly, never fall back to volume and mis-report what was asked for.
func TestDexMarketsUnknownSortIsLoud400(t *testing.T) {
	h := dexServer(t, &fakeDexReader{})
	for _, s := range []string{"bogus", "liquidity", "score"} {
		rec, body := get(t, h, "/api/v1/dex/markets?sort="+s)
		if rec.Code != 400 {
			t.Fatalf("sort=%s: want 400, got %d %s", s, rec.Code, rec.Body.String())
		}
		if body["error"] == nil {
			t.Fatalf("sort=%s: loud 400 must carry an error body, got %v", s, body)
		}
	}
}

// TestDexPoolsReturnsEnvelope pins the envelope and the row identity of the
// pool list.
func TestDexPoolsReturnsEnvelope(t *testing.T) {
	dr := &fakeDexReader{pools: []canon.Pool{{PoolID: "pool:x", ChainID: "chain:y", Address: "0xabc"}}}
	h := dexServer(t, dr)
	rec, body := get(t, h, "/api/v1/dex/pools")
	if rec.Code != 200 {
		t.Fatalf("pools: %d %s", rec.Code, rec.Body.String())
	}
	rows, ok := body["data"].([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("envelope: %v", body)
	}
	if rows[0].(map[string]any)["pool_id"] != "pool:x" {
		t.Fatalf("row: %v", rows[0])
	}
}

// TestDexLimitIsClamped is the guard for the second-limit-contract defect: the
// DEX surface must obey the same maxLimit as every other route on this mux.
func TestDexLimitIsClamped(t *testing.T) {
	dr := &fakeDexReader{}
	h := dexServer(t, dr)
	if rec, _ := get(t, h, "/api/v1/dex/pools?limit=5000"); rec.Code != 200 {
		t.Fatalf("clamped request must still succeed: %d", rec.Code)
	}
	if dr.recordedLimit() != maxLimit {
		t.Fatalf("limit passed to the reader = %d, want clamp to %d", dr.recordedLimit(), maxLimit)
	}
}

// TestDexLimitDefault pins the OTHER half of the contract: an absent ?limit=
// must hand the reader defaultLimit, not 0. Asserting only the clamp would let a
// regression that ignores `def` slip through — the repo's own clampLimit maps a
// 0 to 100, which would hide it at the handler level.
func TestDexLimitDefault(t *testing.T) {
	dr := &fakeDexReader{}
	h := dexServer(t, dr)
	if rec, _ := get(t, h, "/api/v1/dex/pools"); rec.Code != 200 {
		t.Fatalf("plain request: %d", rec.Code)
	}
	if dr.recordedLimit() != defaultLimit {
		t.Fatalf("default limit = %d, want %d", dr.recordedLimit(), defaultLimit)
	}
}

func TestDexBadLimitIsLoud400(t *testing.T) {
	h := dexServer(t, &fakeDexReader{})
	for _, q := range []string{"?limit=abc", "?limit=0", "?limit=-3"} {
		rec, body := get(t, h, "/api/v1/dex/pools"+q)
		if rec.Code != 400 {
			t.Fatalf("%s: want 400, got %d %s", q, rec.Code, rec.Body.String())
		}
		if body["error"] == nil {
			t.Fatalf("%s: want an error envelope, got %v", q, body)
		}
	}
}

func TestDexUnknownSortIsLoud400(t *testing.T) {
	h := dexServer(t, &fakeDexReader{})
	rec, _ := get(t, h, "/api/v1/dex/rankings?sort=bogus")
	if rec.Code != 400 {
		t.Fatalf("unknown sort: want 400, got %d", rec.Code)
	}
}

func TestDexUnknownIntervalIsLoud400(t *testing.T) {
	h := dexServer(t, &fakeDexReader{})
	rec, _ := get(t, h, "/api/v1/dex/pools/pool:x/candles?interval=nope")
	if rec.Code != 400 {
		t.Fatalf("unknown interval: want 400, got %d", rec.Code)
	}
}

// TestDexUnwiredReaderIsLoud503 proves the port absence is a 503, never an
// empty 200 that would read as "no data".
func TestDexUnwiredReaderIsLoud503(t *testing.T) {
	h := dexServer(t, nil)
	rec, _ := get(t, h, "/api/v1/dex/pools")
	if rec.Code != 503 {
		t.Fatalf("unwired reader: want 503, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestDexStoreFailureIsLoud503(t *testing.T) {
	h := dexServer(t, &fakeDexReader{fail: errStoreDown})
	rec, _ := get(t, h, "/api/v1/dex/pools")
	if rec.Code != 503 {
		t.Fatalf("store failure: want 503, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestDexUnknownPathIs404(t *testing.T) {
	h := dexServer(t, &fakeDexReader{})
	rec, _ := get(t, h, "/api/v1/dex/nope")
	if rec.Code != 404 {
		t.Fatalf("unknown dex path: want 404, got %d", rec.Code)
	}
}
