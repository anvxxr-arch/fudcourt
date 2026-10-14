// Package dexstore is the DEX Data Platform's storage port: the write and read
// contracts for the data.dex_* tables (docs/dex/audit.md §4), implemented by
// internal/ingest/repo.
//
// WHY A SEPARATE PORT (plan §38/§39). canon.Writer/Reader are the FROZEN market
// contract with five implementations (repo.Repo, main.go's unavailableReader,
// serve's failingWriter, and the test fakes in derive and ingest/serve). Widening
// them would churn every one of those for a bounded context they do not touch.
// The DEX subsystem is a new context with its own facts and its own tables, so
// it gets its own port: dexstore imports canon (the domain) and the standard
// library, nothing else. The dependency arrow points INWARD — repo implements
// dexstore; dexstore never imports repo.
//
// Every write follows the platform's never-fake rule: a batch is partitioned
// through per-row validation, accepted rows are written, rejected rows are
// COUNTED and returned, and a nil/absent value is stored as NULL — never as a
// fabricated zero.
package dexstore

import (
	"context"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// Writer is the DEX write side. Every Write method returns (written, rejected,
// err): written rows were persisted, rejected rows failed validation and are
// counted, never silently dropped. A batch is not required to be atomic.
type Writer interface {
	// Entities (upsert).
	UpsertDexDeployments(ctx context.Context, rows []canon.DexDeployment) (int, error)
	UpsertPoolTokens(ctx context.Context, rows []canon.PoolToken) (int, error)

	// Facts (append/upsert on the natural key).
	WriteDexSwaps(ctx context.Context, rows []canon.Swap) (written, rejected int, err error)
	WriteDexCandles(ctx context.Context, rows []canon.DexCandle) (written, rejected int, err error)
	WriteDexLiquiditySnapshots(ctx context.Context, rows []canon.DexLiquiditySnapshot) (written, rejected int, err error)
	WriteDexMarketSnapshots(ctx context.Context, rows []canon.DexMarketSnapshot) (written, rejected int, err error)
	WriteDexLiquidityPositions(ctx context.Context, rows []canon.DexLiquidityPosition) (written, rejected int, err error)
	WriteDexWalletActivity(ctx context.Context, rows []canon.WalletActivity) (written, rejected int, err error)
	WriteDexRouteQuotes(ctx context.Context, rows []canon.RouteQuote) (written, rejected int, err error)
	WriteDexRiskMetrics(ctx context.Context, rows []canon.RiskMetric) (written, rejected int, err error)
	WriteDexMEVEvents(ctx context.Context, rows []canon.MEVEvent) (written, rejected int, err error)
	WriteDexPerpMarkets(ctx context.Context, rows []canon.PerpMarket) (written, rejected int, err error)
	WriteDexPerpLiquidations(ctx context.Context, rows []canon.PerpLiquidation) (written, rejected int, err error)
	WriteDexOrderbookSnapshots(ctx context.Context, rows []canon.DexOrderbookSnapshot) (written, rejected int, err error)
	WriteProviderObservations(ctx context.Context, rows []canon.ProviderObservation) (written, rejected int, err error)

	// Reliability + quality facts.
	WriteProviderHealth(ctx context.Context, rows []ProviderHealth) (written, rejected int, err error)
	WriteQualityStatus(ctx context.Context, rows []QualityStatus) (written, rejected int, err error)
}

// ProviderHealth is one window's reliability facts for one provider (plan §34).
// It is the row shape of data.dex_provider_health; the reliability recorder
// produces these, the dashboard and the capability registry read them.
type ProviderHealth struct {
	Provider         string
	WindowStart      int64 // unix seconds
	AvailabilityPct  *float64
	LatencyP50Ms     *float64
	LatencyP95Ms     *float64
	LatencyP99Ms     *float64
	ErrorCount       int64
	SuccessCount     int64
	RateLimitEvents  int64
	LastSuccessUnix  *int64
	LastFailureUnix  *int64
	StalenessSeconds *float64
	State            string
}

// QualityStatus is one quality verdict for one (subject, dataset) (plan §32).
// State is the closed healthy|degraded|stale|conflicting|invalid vocabulary.
type QualityStatus struct {
	SubjectKey string
	Dataset    string
	AtUnix     int64
	State      string
	Reasons    []string
	Detail     map[string]any
}

// QualityStates is the closed plan §32 vocabulary. Exported so a producer and
// the database CHECK agree on one spelling.
var QualityStates = []string{"healthy", "degraded", "stale", "conflicting", "invalid"}

// ValidQualityState reports whether s is one of the states above.
func ValidQualityState(s string) bool {
	for _, v := range QualityStates {
		if s == v {
			return true
		}
	}
	return false
}
