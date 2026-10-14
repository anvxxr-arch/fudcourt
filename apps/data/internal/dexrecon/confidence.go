// Package dexrecon is the DEX Data Platform's reconciliation and quality
// engine (plan §24, §25, §32): it turns several providers' observations of the
// same fact into ONE canonical value with a confidence score, and it classifies
// a dataset's quality.
//
// It is what makes Fudcourt better than an API aggregator: instead of picking
// one provider or blindly averaging several, it weights by the plan §3 source
// tier, the trade recency, the pool's liquidity, the block confirmation and the
// provider's own freshness — and it REJECTS outliers rather than letting a
// stale or wrong number drag the answer (plan §24: "Jangan sekadar average").
//
// The package is pure: no HTTP, no database, no clock except an injected one.
// It imports canon (the domain) and the standard library.
package dexrecon

import (
	"math"
	"math/big"
	"sort"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// Confidence factor weights (plan §25). They sum to 100, which makes the total
// a 0-100 score directly.
const (
	WeightAgreement     = 30
	WeightFreshness     = 20
	WeightLiquidity     = 20
	WeightSourceQuality = 15
	WeightBlockConfirm  = 10
	WeightAnomaly       = 5
)

// tierQuality maps a source tier to a 0..1 quality factor. Ground truth (S0)
// scores 1; a derived value (S5) is trusted least, because it depends on
// whatever fed it.
func tierQuality(t canon.SourceTier) *big.Rat {
	switch t {
	case canon.TierBlockchain:
		return rat("1")
	case canon.TierDexNative:
		return rat("0.95")
	case canon.TierIndexer:
		return rat("0.85")
	case canon.TierAggregator:
		return rat("0.70")
	case canon.TierAnalytics:
		return rat("0.60")
	case canon.TierDerived:
		return rat("0.50")
	}
	return rat("0.50")
}

// freshnessFactor is 1 for an observation at or before the SLA and decays
// linearly to 0 at 4x the SLA. A negative age (a future timestamp) is treated as
// perfect freshness — the anomaly detector, not this factor, flags it.
func freshnessFactor(age, sla time.Duration) *big.Rat {
	if age <= 0 {
		return rat("1")
	}
	if sla <= 0 {
		return rat("0")
	}
	// f = 1 - age/(4*sla), clamped to [0,1]
	x := new(big.Rat).SetFrac64(int64(age), int64(4*sla))
	f := new(big.Rat).Sub(rat("1"), x)
	return clamp01(f)
}

// liquidityFactor saturates with pool liquidity: 0 at no liquidity, 1 at or
// above refUSD. It uses log scaling so a $10M pool is meaningfully better than
// a $100k one without a $1B pool dwarfing everything. A nil liquidity is
// NEUTRAL (0.5), never treated as zero liquidity.
func liquidityFactor(liq *canon.Dec, refUSD *big.Rat) *big.Rat {
	if liq == nil || !liq.Present() || liq.Rat().Sign() <= 0 {
		return rat("0.5")
	}
	if refUSD == nil || refUSD.Sign() <= 0 {
		return rat("0.5")
	}
	ratio := new(big.Rat).Quo(liq.Rat(), refUSD)
	f, _ := ratio.Float64()
	if f <= 0 {
		return rat("0")
	}
	if f >= 1 {
		return rat("1")
	}
	// log10(1+9f) maps f in [0,1] to [0,1].
	num := 1 + 9*f
	lg := log10(num)
	return clamp01(new(big.Rat).SetFloat64(lg))
}

// blockConfirmFactor scores confirmation depth: 0 with no block number known,
// rising to 1 at minConfirms and beyond. A nil block number is NEUTRAL (0.5)
// because a REST aggregator legitimately has none.
func blockConfirmFactor(block, head *int64, minConfirms int64) *big.Rat {
	if block == nil {
		return rat("0.5")
	}
	if head == nil {
		return rat("0.5")
	}
	if minConfirms <= 0 {
		minConfirms = 12
	}
	confirms := *head - *block
	if confirms < 0 {
		return rat("0")
	}
	if confirms >= minConfirms {
		return rat("1")
	}
	return clamp01(new(big.Rat).SetFrac64(confirms, minConfirms))
}

// agreementFactor scores how tightly the providers agree: 1 when the max
// pairwise deviation is 0, decaying to 0 at or beyond maxDeviation.
func agreementFactor(maxDev *big.Rat, maxDeviation *big.Rat) *big.Rat {
	if maxDev == nil || maxDev.Sign() <= 0 {
		return rat("1")
	}
	if maxDeviation == nil || maxDeviation.Sign() <= 0 {
		return rat("0")
	}
	f := new(big.Rat).Sub(rat("1"), new(big.Rat).Quo(maxDev, maxDeviation))
	return clamp01(f)
}

// --- small rational helpers -------------------------------------------------

// rat parses a decimal string into a *big.Rat (panicking on a bad literal,
// which can only be a programming error in this file's constants).
func rat(s string) *big.Rat {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		panic("dexrecon: bad rational literal " + s)
	}
	return r
}

func clamp01(r *big.Rat) *big.Rat {
	if r.Sign() < 0 {
		return rat("0")
	}
	if r.Cmp(rat("1")) > 0 {
		return rat("1")
	}
	return r
}

// log10 approximates base-10 log for a positive float.
func log10(x float64) float64 {
	if x <= 0 {
		return 0
	}
	return math.Log10(x)
}

// weightedTotal computes sum(weight_i * factor_i) for the 0-100 confidence and
// rounds to the nearest integer.
func weightedTotal(pairs [][2]int) int {
	total := 0
	for _, p := range pairs {
		total += p[0] * p[1]
	}
	return total
}

// factorToInt converts a 0..1 rational factor to an integer percentage 0..100.
func factorToInt(f *big.Rat) int {
	if f == nil {
		return 0
	}
	f = clamp01(f)
	// percentage = round(f * 100)
	num := new(big.Rat).Mul(f, rat("100"))
	// round half up
	half := rat("0.5")
	num.Add(num, half)
	i := new(big.Int).Quo(num.Num(), num.Denom())
	return int(i.Int64())
}

// sortRatVals returns the values sorted ascending (for median/outlier work).
func sortRatVals(vs []*big.Rat) []*big.Rat {
	out := append([]*big.Rat(nil), vs...)
	sort.Slice(out, func(i, j int) bool { return out[i].Cmp(out[j]) < 0 })
	return out
}

// medianRat returns the median of an ascending-sorted slice (the mean of the
// two middles for an even count, as an exact rational).
func medianRat(sorted []*big.Rat) *big.Rat {
	n := len(sorted)
	if n == 0 {
		return nil
	}
	if n%2 == 1 {
		return sorted[n/2]
	}
	return new(big.Rat).Quo(new(big.Rat).Add(sorted[n/2-1], sorted[n/2]), rat("2"))
}
