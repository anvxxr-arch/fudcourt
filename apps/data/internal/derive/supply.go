package derive

import (
	"math"
	"time"
)

// This file holds the deterministic Bitcoin issuance primitives: supply,
// subsidy, stock-to-flow and the long-term power law. They are pure functions
// of a timestamp (and, for the oscillator, the price) — no network, no clock,
// no global state — so every process computes the same value for the same
// input.

// GenesisUnix is Bitcoin's genesis block time (2009-01-03 UTC).
const GenesisUnix = 1231006505

// BlocksPerDay is the protocol's 10-minute target cadence (144 blocks/day).
const BlocksPerDay = 144

// HalvingInterval is the subsidy-halving epoch length in blocks.
const HalvingInterval = 210000

// MaxSupplySats caps the issuance schedule at 21 million BTC.
const MaxSupply = 21_000_000.0

// DaysSinceGenesis is the whole-day count from the genesis block to at.
func DaysSinceGenesis(at time.Time) float64 {
	return at.Sub(time.Unix(GenesisUnix, 0)).Hours() / 24
}

// HeightAt estimates the chain height at at from the issuance schedule: the
// protocol targets 144 blocks/day. It is an ESTIMATE (the real chain drifts
// from the target by a few percent); series that use it record
// method="issuance_schedule" so the provenance is explicit.
func HeightAt(at time.Time) int {
	d := DaysSinceGenesis(at)
	if d < 0 {
		return 0
	}
	return int(d * BlocksPerDay)
}

// SubsidyAtHeight is the block subsidy in BTC at height: 50 BTC halved every
// 210000 blocks, 0 once the schedule is exhausted (epoch 33+).
func SubsidyAtHeight(h int) float64 {
	if h < 0 {
		return 0
	}
	epoch := h / HalvingInterval
	if epoch >= 33 {
		return 0
	}
	return 50 * math.Pow(0.5, float64(epoch))
}

// SupplyAtHeight is the cumulative mined supply in BTC at height: the full
// subsidy of every completed epoch plus the partial epoch's blocks, capped at
// the 21M maximum.
func SupplyAtHeight(h int) float64 {
	if h < 0 {
		return 0
	}
	var total float64
	remaining := h
	subsidy := 50.0
	for epoch := 0; epoch < 33 && remaining > 0; epoch++ {
		blocks := remaining
		if blocks > HalvingInterval {
			blocks = HalvingInterval
		}
		total += float64(blocks) * subsidy
		remaining -= blocks
		subsidy /= 2
	}
	if total > MaxSupply {
		return MaxSupply
	}
	return total
}

// AnnualIssuance is the yearly new supply in BTC at a given block subsidy:
// subsidy * 144 blocks/day * 365 days.
func AnnualIssuance(subsidy float64) float64 {
	return subsidy * BlocksPerDay * 365
}

// S2FRatio is stock-to-flow: current supply over annual issuance. It returns
// NaN when annual issuance is zero (the schedule is exhausted), never +Inf —
// the caller stores NaN as NULL.
func S2FRatio(supply, annualIssuance float64) float64 {
	if annualIssuance <= 0 {
		return math.NaN()
	}
	return supply / annualIssuance
}

// PowerLawA and PowerLawB are the pinned long-term power-law fit
// (log(price) = a + b*log(days_since_genesis)) over BTC's full history. They
// are constants so the model is deterministic; a refit is a NEW named fit
// parameter, never a silent overwrite of this one.
const (
	PowerLawA = -17.08
	PowerLawB = 5.82
)

// FitPowerLaw runs an ordinary least-squares fit of ln(price) on ln(days),
// skipping any pair where days <= 0 or price <= 0. It returns the intercept
// and slope; a degenerate input (fewer than two usable points, or a
// zero-variance x) yields NaN for both, which the caller stores as NULL.
func FitPowerLaw(days, price []float64) (a, b float64) {
	n := len(days)
	if n != len(price) {
		return math.NaN(), math.NaN()
	}
	var sx, sy, sxx, sxy float64
	var m int
	for i := range n {
		if days[i] <= 0 || price[i] <= 0 {
			continue
		}
		x := math.Log(days[i])
		y := math.Log(price[i])
		sx += x
		sy += y
		sxx += x * x
		sxy += x * y
		m++
	}
	if m < 2 {
		return math.NaN(), math.NaN()
	}
	fm := float64(m)
	den := fm*sxx - sx*sx
	if den == 0 {
		return math.NaN(), math.NaN()
	}
	b = (fm*sxy - sx*sy) / den
	a = (sy - b*sx) / fm
	return a, b
}

// PowerLawModel is the price the power law predicts at a given age in days:
// exp(a + b*ln(days)). days <= 0 yields NaN.
func PowerLawModel(a, b, days float64) float64 {
	if days <= 0 {
		return math.NaN()
	}
	return math.Exp(a + b*math.Log(days))
}
