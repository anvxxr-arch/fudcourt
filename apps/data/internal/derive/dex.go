package derive

import (
	"math"
	"math/big"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// This file is the DEX Data Platform's derived-analytics primitives (plan §26
// group A), pure functions over canonical DEX facts. Every function is a pure
// value function (no IO, no clock), so the processors in processors.go wrap
// them exactly like the price indicators.
//
// Precision discipline (plan §54): "depth" and "price impact" are computed on
// the exact canon.Dec side with *big.Rat, never a float64 — they feed risk and
// execution decisions where a rounded cents value is a wrong answer. The
// statistical series (imbalance, health, momentum) are bounded [-1,1]/[0,1]
// ratios whose float arithmetic is documented and cheap; the exact boundary is
// stated per function rather than left implicit.

// BuySellImbalance is the net pressure of buys over sells in [-1, 1]:
// (buys - sells) / (buys + sells). A window with no trades is NaN (absent), not
// 0 — the same convention the price indicators use, so the metric table stores
// NULL rather than a fake neutral reading. Both inputs are the per-window
// counts; a NaN in either propagates.
func BuySellImbalance(buys, sells []float64) []float64 {
	out := nanLike(buys)
	for i := range buys {
		b, s := buys[i], sells[i]
		if math.IsNaN(b) || math.IsNaN(s) {
			continue
		}
		total := b + s
		if total <= 0 {
			continue // no trades in the window: absent, never 0
		}
		out[i] = (b - s) / total
	}
	return out
}

// VolumeVelocity is the period-over-period change of volume:
// (v[i] - v[i-n]) / v[i-n], in [-1, ∞). A zero or NaN reference is NaN (a
// percentage change from zero is undefined, not infinity), so a quiet-then-loud
// window is absent rather than a fabricated +Inf that would poison the table.
func VolumeVelocity(v []float64, n int) []float64 {
	out := nanLike(v)
	if n <= 0 {
		return out
	}
	for i := n; i < len(v); i++ {
		prev := v[i-n]
		if math.IsNaN(v[i]) || math.IsNaN(prev) || prev <= 0 {
			continue
		}
		out[i] = (v[i] - prev) / prev
	}
	return out
}

// PoolHealth blends two normalized signals into [0, 1]: how deep the pool is
// relative to a reference liquidity, and how balanced its flow is. depth is the
// liquidity in USD, refLiquidity the "healthy" depth (the score saturates at
// ref); imbalance is BuySellImbalance's output in [-1, 1]. A missing depth
// (NaN) or a non-positive reference is NaN. The blend is 60% depth / 40%
// balance, documented here rather than hidden in a magic constant at the call
// site.
func PoolHealth(depth, refLiquidity, imbalance []float64) []float64 {
	out := nanLike(depth)
	for i := range depth {
		d, ref := depth[i], refLiquidity[i]
		imb := imbalance[i]
		if math.IsNaN(d) || math.IsNaN(ref) || ref <= 0 {
			continue
		}
		if math.IsNaN(imb) {
			imb = 0 // no flow in the window is neutral balance, not absent depth
		}
		ratio := d / ref
		if ratio > 1 {
			ratio = 1
		}
		if ratio < 0 {
			ratio = 0
		}
		balance := (imb + 1) / 2 // [-1,1] -> [0,1]
		out[i] = 0.6*ratio + 0.4*balance
	}
	return out
}

// LiquidityDepthUSDExact is the spendable depth at a price tolerance, computed
// EXACTLY then rounded to a cent. For a constant-product pool the amount of the
// `reserve` side needed to move the price by impactPct is
// reserve * impactPct / (1 - impactPct) (the closed form of x*y=k: buying until
// the price rises by 1/(1-t) requires y*t/(1-t)). The division rarely terminates
// in decimal (1/0.99 does not), so the result is rounded HALF-UP to 2 decimals —
// a USD figure needs no more, and rounding explicitly beats an infinite
// expansion or a float approximation. Returns NilDec for a missing/zero reserve
// or a tolerance outside (0,1); never a float64 and never a negative depth.
func LiquidityDepthUSDExact(reserveUSD canon.Dec, impactPct canon.Dec) canon.Dec {
	r, err := decRat(reserveUSD)
	if err != nil || r.Sign() <= 0 {
		return canon.NilDec
	}
	t, err := decRat(impactPct)
	if err != nil || t.Sign() <= 0 || t.Cmp(big.NewRat(1, 1)) >= 0 {
		return canon.NilDec
	}
	// depth = r * t / (1 - t), exact, then rounded to cents.
	num := new(big.Rat).Mul(r, t)
	den := new(big.Rat).Sub(big.NewRat(1, 1), t)
	return roundRatToDec(new(big.Rat).Quo(num, den), 2)
}

// PriceImpactPctExact is the fractional price move of trading amountUSD against
// a constant-product reserve, computed EXACTLY then rounded to 8 decimals:
// impact = amount / (reserve + amount). 8 places is far finer than any execution
// decision needs (1e-8 of a fraction). This is the inverse of
// LiquidityDepthUSDExact (same x*y=k model). A missing reserve or a non-positive
// amount is NilDec; the amount may exceed the reserve (the impact approaches 1),
// which is a real, large trade, not an error.
func PriceImpactPctExact(reserveUSD, amountUSD canon.Dec) canon.Dec {
	r, err := decRat(reserveUSD)
	if err != nil || r.Sign() <= 0 {
		return canon.NilDec
	}
	a, err := decRat(amountUSD)
	if err != nil || a.Sign() <= 0 {
		return canon.NilDec
	}
	impact := new(big.Rat).Quo(a, new(big.Rat).Add(r, a))
	return roundRatToDec(impact, 8)
}

// roundRatToDec rounds r to scale decimal places (half away from zero) and
// builds the exact Dec. This is the honest way to land a non-terminating
// quotient in the decimal type: the rounding is explicit and bounded rather than
// an infinite expansion or a float64 approximation.
func roundRatToDec(r *big.Rat, scale int) canon.Dec {
	pow := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil)
	scaled := new(big.Rat).Mul(r, new(big.Rat).SetInt(pow))
	num, den := scaled.Num(), scaled.Denom()
	q, rem := new(big.Int).QuoRem(num, den, new(big.Int))
	// Half away from zero: |rem|*2 >= den rounds the magnitude up.
	twiceRem := new(big.Int).Abs(rem)
	twiceRem.Lsh(twiceRem, 1)
	if twiceRem.Cmp(den) >= 0 {
		if q.Sign() < 0 {
			q.Sub(q, big.NewInt(1))
		} else {
			q.Add(q, big.NewInt(1))
		}
	}
	return canon.DecFromRat(new(big.Rat).SetFrac(q, pow))
}

// ImpermanentLossPct is the classic v2 LP loss versus holding, as a NEGATIVE
// fraction (e.g. -0.0574 for a 5.74% loss) for a price ratio r:
//
//	IL(r) = 2*sqrt(r)/(1+r) - 1
//
// r is the ratio of the new price to the entry price (r=1 -> 0 loss). A missing
// or non-positive ratio is NaN (undefined). The square root is the one float
// step; the result is bounded [-1, 0] so the rounding is not decision-relevant,
// and the exact-boundary comment states it.
func ImpermanentLossPct(priceRatio []float64) []float64 {
	out := nanLike(priceRatio)
	for i, r := range priceRatio {
		if math.IsNaN(r) || r <= 0 {
			continue
		}
		out[i] = 2*math.Sqrt(r)/(1+r) - 1
	}
	return out
}

// LPAPRPct is the annualized fee yield of a pool: feePct of the 24h volume over
// the pool's liquidity, times 365. All three inputs are exact fractions (fee as
// a fraction of notional, volumeUSD, liquidityUSD). A non-positive liquidity is
// NaN (dividing by a pool with no depth is undefined). The result is a fraction
// (0.42 = 42% APR), not a percent, matching the rest of this package.
func LPAPRPct(volume24hUSD, liquidityUSD, feePct []float64) []float64 {
	out := nanLike(volume24hUSD)
	for i := range volume24hUSD {
		v, l, f := volume24hUSD[i], liquidityUSD[i], feePct[i]
		if math.IsNaN(v) || math.IsNaN(l) || math.IsNaN(f) || l <= 0 {
			continue
		}
		out[i] = (v * f / l) * 365
	}
	return out
}

// --- exact-Dec helpers -------------------------------------------------------

// decRat returns the exact rational behind a canon.Dec, or an error when the
// Dec is absent. No float64 ever appears in this path.
func decRat(d canon.Dec) (*big.Rat, error) {
	r := d.Rat()
	if r == nil {
		return nil, errAbsentDec
	}
	return r, nil
}

type absentDecErr struct{}

func (absentDecErr) Error() string { return "derive: absent decimal" }

var errAbsentDec = absentDecErr{}
