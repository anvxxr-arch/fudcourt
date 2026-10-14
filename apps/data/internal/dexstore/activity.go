package dexstore

import (
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// This file is the plan §28 activity-based scheduling vocabulary: a pure
// classifier over a pool's 24h activity that maps to a poll cadence, plus the
// canonical spelling of the tier so the schedule can be persisted and re-read.
//
// DESIGN (and the reason this is a pure function, not a live tier table): the
// ingest engine's EnsureJobs OVERWRITES a job's schedule_seconds from the seed
// spec on every restart, so a runtime-mutated cadence would silently revert on
// the next boot. The cheap honest design is therefore to DERIVE the cadence at
// SEED TIME from the latest known activity: JobSpecs rebuilt on restart pick up
// the freshest tier automatically, with no schema change and no clobber hazard.
// The classifier is pure and unit-testable, in the established dexcap/dexrecon
// style.

// ActivityTier is the plan §28 pool tier. The zero value means UNKNOWN: a pool
// with no activity snapshot yet is NOT guessed into TierDead (which would idle a
// brand-new high-volume pool) — the caller falls back to the documented default
// cadence.
type ActivityTier string

const (
	// TierUnknown is a pool with no activity reading yet. It maps to the
	// default cadence, never to the slowest one.
	TierUnknown ActivityTier = ""
	// TierA is a high-volume, high-liquidity, high-interest pool: poll fast.
	TierA ActivityTier = "A"
	// TierB is medium activity.
	TierB ActivityTier = "B"
	// TierC is low activity.
	TierC ActivityTier = "C"
	// TierD is a dead/inactive pool: poll rarely.
	TierD ActivityTier = "D"
)

// Activity is the pool activity signal the classifier reads. Every field is a
// pointer so an absent reading is distinguishable from a genuine zero: a pool
// that traded $0 is TierD, but a pool whose volume was never observed is
// TierUnknown. nil anywhere the tier decision needs -> unknown.
type Activity struct {
	Volume24hUSD *float64
	LiquidityUSD *float64
	Txns24h      *int64
	// Newer signals age: a pool created very recently with real volume is
	// interesting even before its liquidity matures. nil when unknown.
	AgeHours *float64
}

// Thresholds are the plan §28 tier boundaries as configuration, so an operator
// can tune them without a code change and a test can pin the exact boundary.
// The zero value is unusable (every pool would be TierD); use DefaultThresholds.
type Thresholds struct {
	// ATierVolumeUSD/ATierLiquidityUSD are the floors for the fastest tier.
	ATierVolumeUSD    float64
	ATierLiquidityUSD float64
	ATierTxns         int64
	// BTier* are the medium floors.
	BTierVolumeUSD    float64
	BTierLiquidityUSD float64
	BTierTxns         int64
	// CTierVolumeUSD is the low-activity floor; below it (with some liquidity
	// present) is TierD.
	CTierVolumeUSD float64
	// DeadBelowLiquidityUSD is the liquidity under which a pool is dead
	// regardless of volume (a dust pool with fake volume should not be fast).
	DeadBelowLiquidityUSD float64
}

// DefaultThresholds is a documented starting point, not a law: $1M/24h volume
// with $1M liquidity is TierA; $100k/$100k is TierB; anything with a nonzero
// volume above $0 is at least TierC; a pool under $1k liquidity or with zero
// volume is TierD.
func DefaultThresholds() Thresholds {
	return Thresholds{
		ATierVolumeUSD:        1_000_000,
		ATierLiquidityUSD:     1_000_000,
		ATierTxns:             1_000,
		BTierVolumeUSD:        100_000,
		BTierLiquidityUSD:     100_000,
		BTierTxns:             100,
		CTierVolumeUSD:        0,
		DeadBelowLiquidityUSD: 1_000,
	}
}

// ClassifyActivity maps a pool's activity to its plan §28 tier. It is total and
// pure: same input, same tier, no clock and no IO.
//
// An ABSENT signal never disqualifies a pool: absence (nil) means "we did not
// measure this", which is different from a measured zero. Coercing nil
// liquidity to 0 would push every pool whose liquidity column we do not read
// (the market snapshot has no liquidity field) into TierD regardless of its
// volume — a hot pool polled hourly looks exactly like a dead one. So the
// liquidity/dead-floor and txn gates apply only when the field is PRESENT;
// a nil volume AND nil liquidity is TierUnknown (the caller's default cadence),
// and a present-and-tiny liquidity is still the dust case it should be.
func ClassifyActivity(a Activity, t Thresholds) ActivityTier {
	if a.Volume24hUSD == nil && a.LiquidityUSD == nil {
		return TierUnknown
	}
	// Dust liquidity, but only when we actually observed liquidity: a genuine
	// 0 that was never reported must not be treated as a dead pool.
	if a.LiquidityUSD != nil && *a.LiquidityUSD < t.DeadBelowLiquidityUSD {
		return TierD
	}
	vol := 0.0
	hasVol := a.Volume24hUSD != nil
	if hasVol {
		vol = *a.Volume24hUSD
	}
	// A pool with no observed volume at all cannot be ranked by volume: it
	// falls through to the liquidity-based floor below rather than being
	// declared dead.
	liq := 0.0
	hasLiq := a.LiquidityUSD != nil
	if hasLiq {
		liq = *a.LiquidityUSD
	}
	txns := int64(0)
	hasTxns := a.Txns24h != nil
	if hasTxns {
		txns = *a.Txns24h
	}
	meets := func(minVol, minLiq float64, minTxns int64) bool {
		// Each gate is skipped when the signal is absent, so a partially
		// measured pool is ranked on what IS known instead of being rejected.
		if hasVol && vol < minVol {
			return false
		}
		if hasLiq && liq < minLiq {
			return false
		}
		if hasTxns && txns < minTxns {
			return false
		}
		return true
	}
	switch {
	case meets(t.ATierVolumeUSD, t.ATierLiquidityUSD, t.ATierTxns):
		return TierA
	case meets(t.BTierVolumeUSD, t.BTierLiquidityUSD, t.BTierTxns):
		return TierB
	case hasVol && vol > t.CTierVolumeUSD:
		return TierC
	case !hasVol && hasLiq && liq >= t.BTierLiquidityUSD:
		// No volume signal, but real depth: at least medium.
		return TierB
	default:
		return TierD
	}
}

// CadenceFor maps a tier to its poll interval (plan §28). An unknown tier takes
// def, which the caller supplies (the dataset's documented default), so an
// unmeasured pool is never silently pushed onto the slowest cadence.
func CadenceFor(tier ActivityTier, def time.Duration) time.Duration {
	switch tier {
	case TierA:
		return 15 * time.Second
	case TierB:
		return time.Minute
	case TierC:
		return 5 * time.Minute
	case TierD:
		return time.Hour
	default: // TierUnknown
		return def
	}
}

// --- persisting the tier ------------------------------------------------------

// ActivityKey is the cursor field the tier and its inputs ride under, so the
// decision is auditable next to the job it drove. It lives in the job's cursor
// (jsonb), which EnsureJobs preserves across restarts — unlike schedule_seconds,
// which the seed overwrites.
const ActivityKey = "activity_tier"

// TierFromCursor reads a persisted tier back out of a job cursor. ok is false
// when the cursor carries none (a first run), in which case the caller
// classifies fresh.
func TierFromCursor(cursor map[string]any) (ActivityTier, bool) {
	if cursor == nil {
		return TierUnknown, false
	}
	v, ok := cursor[ActivityKey].(string)
	if !ok {
		return TierUnknown, false
	}
	switch ActivityTier(v) {
	case TierA, TierB, TierC, TierD:
		return ActivityTier(v), true
	default:
		return TierUnknown, false
	}
}

// WithTier returns a copy of cursor carrying the tier and the inputs it was
// derived from, so a reader can tell WHY a pool is polled at its cadence.
func WithTier(cursor map[string]any, tier ActivityTier, a Activity) map[string]any {
	out := make(map[string]any, len(cursor)+5)
	for k, v := range cursor {
		out[k] = v
	}
	out[ActivityKey] = string(tier)
	if a.Volume24hUSD != nil {
		out["volume_24h_usd"] = *a.Volume24hUSD
	}
	if a.LiquidityUSD != nil {
		out["liquidity_usd"] = *a.LiquidityUSD
	}
	if a.Txns24h != nil {
		out["txns_24h"] = *a.Txns24h
	}
	return out
}

// ActivityFromMarket reads the classifier's input off a canonical market
// snapshot, so the seed path does not re-derive the field mapping. Volume is an
// exact Dec on the row; the classifier's thresholds are float64 dollars (a
// coarse tier boundary, not a money amount), so the conversion is confined here
// and documented rather than scattered. The rational is read exactly and only
// then narrowed — the tier decision never needs the low digits.
func ActivityFromMarket(m canon.DexMarketSnapshot) Activity {
	var a Activity
	if m.Volume24hUSD != nil && m.Volume24hUSD.Present() {
		if r := m.Volume24hUSD.Rat(); r != nil {
			f, _ := r.Float64()
			a.Volume24hUSD = &f
		}
	}
	if m.Txns24h != nil {
		a.Txns24h = m.Txns24h
	}
	return a
}
