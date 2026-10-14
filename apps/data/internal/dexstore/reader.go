package dexstore

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// Reader is the DEX read side the /api/v1/dex/* handlers call (plan §30). It is
// deliberately MINIMAL: the frozen model entity lists (chains, protocols,
// tokens, venues) are served by canon.Reader and are NOT repeated here; this
// port adds only the DEX-specific reads the market contract has no shape for.
//
// Windows are half-open [start, end); a zero start/end is unbounded on that
// side. A nil pointer field on a returned row is an absent reading, never a
// fabricated zero.
type Reader interface {
	// --- per-entity --------

	// ListDexPools pages pool snapshots, newest first, with the plan §31
	// filters. chainID/protocolID/venueID/tokenID are optional ("" = any).
	// Order is cursor-based on (at DESC, pool_id); Before carries the keyset
	// cursor from a previous page (zero = first page).
	ListDexPools(ctx context.Context, q DexPoolQuery) ([]canon.Pool, error)

	// GetDexPool returns the latest snapshot for one pool id. ok is false when
	// the pool is unknown (never a zero-valued row).
	GetDexPool(ctx context.Context, poolID string) (canon.Pool, bool, error)

	// --- facts (pool windowed) --------

	ReadDexSwaps(ctx context.Context, poolID string, start, end time.Time, limit int) ([]canon.Swap, error)
	ReadDexCandles(ctx context.Context, poolID, interval string, start, end time.Time, limit int) ([]canon.DexCandle, error)
	ReadDexLiquiditySnapshots(ctx context.Context, poolID string, start, end time.Time, limit int) ([]canon.DexLiquiditySnapshot, error)
	ReadDexMarketSnapshots(ctx context.Context, poolID string, start, end time.Time, limit int) ([]canon.DexMarketSnapshot, error)
	// ListLatestDexMarketSnapshots returns the newest market snapshot per pool
	// — the board a UI lists, as opposed to one pool's history. A pool with no
	// snapshot is absent, never a zero row.
	ListLatestDexMarketSnapshots(ctx context.Context, q DexMarketQuery) ([]canon.DexMarketSnapshot, error)
	ReadDexLiquidityPositions(ctx context.Context, poolID string, start, end time.Time, limit int) ([]canon.DexLiquidityPosition, error)
	ReadDexOrderbookSnapshots(ctx context.Context, poolID string, start, end time.Time, limit int) ([]canon.DexOrderbookSnapshot, error)

	// --- facts (subject windowed) --------

	ReadDexWalletActivity(ctx context.Context, wallet string, start, end time.Time, limit int) ([]canon.WalletActivity, error)
	ReadDexRiskMetrics(ctx context.Context, subjectKey, metric string, start, end time.Time, limit int) ([]canon.RiskMetric, error)
	ReadDexMEVEvents(ctx context.Context, chainID string, start, end time.Time, limit int) ([]canon.MEVEvent, error)
	ReadDexPerpMarkets(ctx context.Context, venueID string, limit int) ([]canon.PerpMarket, error)
	ReadDexPerpLiquidations(ctx context.Context, perpMarketID string, start, end time.Time, limit int) ([]canon.PerpLiquidation, error)

	// --- routing + registry --------

	// ReadDexRouteQuotes returns the freshest quote per provider for a pair,
	// so a consumer compares routers rather than paging history.
	ReadDexRouteQuotes(ctx context.Context, chainID, tokenIn, tokenOut string, limit int) ([]canon.RouteQuote, error)

	// ListDexDeployments lists a protocol's per-chain deployments.
	ListDexDeployments(ctx context.Context, protocolID string, limit int) ([]canon.DexDeployment, error)

	// --- rankings + observability --------

	// ListDexRankings returns the top pools by the plan §31 sort key.
	ListDexRankings(ctx context.Context, q DexRankingQuery) ([]canon.Pool, error)

	// ListProviderHealth returns the latest reliability window per provider
	// (plan §34/§58).
	ListProviderHealth(ctx context.Context, limit int) ([]ProviderHealth, error)

	// ListQualityStatus returns the latest quality verdict per (subject,
	// dataset) (plan §32).
	ListQualityStatus(ctx context.Context, limit int) ([]QualityStatus, error)
}

// DexPoolQuery is the plan §31 pool filter: every field optional, "" = any.
// Before is a keyset cursor on (at, pool_id) so paging is stable under
// concurrent writes.
type DexPoolQuery struct {
	ChainID    string
	ProtocolID string
	VenueID    string
	TokenID    string
	// MinLiquidityUSD / MinVolume24hUSD are optional numeric floors; nil =
	// no floor (a genuine 0 floor is spelled as a present 0.0).
	MinLiquidityUSD *float64
	MinVolume24hUSD *float64
	Limit           int
	BeforeAt        time.Time
	BeforePoolID    string
}

// DexRankingQuery is the plan §31 ranking query. Sort is a closed vocabulary;
// an unknown sort is an error at the handler, never a silent default.
type DexRankingQuery struct {
	ChainID string
	// Sort is one of DexRankingSorts.
	Sort  string
	Limit int
}

// DexRankingSorts is the closed plan §31 sort vocabulary for pool rankings.
var DexRankingSorts = []string{"volume", "liquidity", "price_change", "transactions", "newest", "trending", "score"}

// ValidDexRankingSort reports whether s is one of the sorts above.
func ValidDexRankingSort(s string) bool {
	for _, v := range DexRankingSorts {
		if s == v {
			return true
		}
	}
	return false
}

// DexMarketQuery is the plan §31 market-state LIST query: the newest snapshot
// per pool, i.e. the board, not the history. Per-pool reads stay on
// ReadDexMarketSnapshots.
type DexMarketQuery struct {
	ChainID string
	// Sort is one of DexMarketSorts.
	Sort  string
	Limit int
}

// DexMarketSorts is the closed sort vocabulary for the market board. It is
// deliberately NARROWER than DexRankingSorts: a market snapshot has no
// liquidity, trending or score column, and accepting those names would silently
// sort by something else for every caller who asked for one.
var DexMarketSorts = []string{"volume", "price_change", "transactions", "newest"}

// ValidDexMarketSort reports whether s is one of the sorts above.
func ValidDexMarketSort(s string) bool {
	for _, v := range DexMarketSorts {
		if s == v {
			return true
		}
	}
	return false
}

// ReaderWriter is both halves, satisfied by one *repo.Repo.
type ReaderWriter interface {
	Reader
	Writer
}
