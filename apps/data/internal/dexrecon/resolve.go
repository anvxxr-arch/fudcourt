package dexrecon

import (
	"math/big"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// Observation is one provider's reading of a scalar fact (a price, a liquidity
// figure, a volume) about one subject at one instant. It is the unit of
// reconciliation: the resolver turns a set of these into one canonical value.
type Observation struct {
	Provider string
	Tier     canon.SourceTier
	// Value is the observed scalar, exact.
	Value canon.Dec
	// ObservedAt is when the provider says the value was true.
	ObservedAt time.Time
	// BlockNumber / HeadBlock locate the observation for confirmation scoring;
	// both nil for a REST aggregator.
	BlockNumber *int64
	HeadBlock   *int64
	// Liquidity is the pool's liquidity in USD, when known (the plan §25
	// liquidity factor).
	Liquidity *canon.Dec
	// Endpoint is the exact source, carried into the provenance.
	Endpoint string
}

// Config tunes the resolver. Zero values take documented defaults.
type Config struct {
	// FreshnessSLA is the maximum age at which an observation still counts as
	// fully fresh; freshnessFactor decays over 4x this.
	FreshnessSLA time.Duration
	// MaxDeviation is the relative deviation (as a rational, e.g. 0.005 = 0.5%)
	// at which agreement scores zero.
	MaxDeviation *big.Rat
	// OutlierDeviation is the relative deviation from the median beyond which
	// an observation is REJECTED as an outlier before weighting.
	OutlierDeviation *big.Rat
	// LiquidityRefUSD is the liquidity at which the liquidity factor saturates.
	LiquidityRefUSD *big.Rat
	// MinConfirms is the confirmation depth at which the block factor saturates.
	MinConfirms int64
	// Now is the reference clock (nil = time.Now).
	Now func() time.Time
}

func (c Config) withDefaults() Config {
	if c.FreshnessSLA <= 0 {
		c.FreshnessSLA = 10 * time.Second
	}
	if c.MaxDeviation == nil {
		c.MaxDeviation = rat("0.005") // 0.5%
	}
	if c.OutlierDeviation == nil {
		c.OutlierDeviation = rat("0.02") // 2%
	}
	if c.LiquidityRefUSD == nil {
		c.LiquidityRefUSD = big.NewRat(1_000_000, 1)
	}
	if c.MinConfirms == 0 {
		c.MinConfirms = 12
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return c
}

// Reconciled is the resolver's answer (plan §24/§25): the canonical value, how
// many providers fed it, how much they disagreed, how stale the freshest input
// was, and the 0-100 confidence.
type Reconciled struct {
	Value         canon.Dec
	Confidence    canon.Confidence
	ProviderCount int
	// Included / Excluded name the providers whose values were used / rejected.
	Included []string
	Excluded []string
	// Deviation is the max pairwise relative deviation of the INCLUDED values.
	Deviation *big.Rat
	// Freshest is the age of the newest included observation.
	Freshest time.Duration
	// Factors is the per-factor 0-100 breakdown, for diagnostics (plan §30
	// "confidence" on request).
	Factors Factors
}

// Factors is the confidence breakdown.
type Factors struct {
	Agreement     int
	Freshness     int
	Liquidity     int
	SourceQuality int
	BlockConfirm  int
	Anomaly       int
}

// Resolver reconciles observations into a canonical value.
type Resolver struct {
	cfg Config
}

// New builds a resolver with the given config (zero values defaulted).
func New(cfg Config) *Resolver {
	return &Resolver{cfg: cfg.withDefaults()}
}

// Resolve turns a set of observations of one fact into one canonical value.
//
// The algorithm (plan §24 — NOT a plain average):
//  1. drop observations with an absent value;
//  2. compute the median and drop any observation deviating from it by more
//     than OutlierDeviation (a stale or wrong provider cannot drag the answer);
//  3. weight the survivors by tier quality x freshness, and take the weighted
//     median (robust to a single extreme survivor);
//  4. score confidence from agreement, freshness, liquidity, source quality,
//     block confirmation and an anomaly penalty.
//
// ok is false when nothing usable remains — the caller must fail LOUDLY (plan
// §65: never hide missing data, never fabricate a value).
func (r *Resolver) Resolve(obs []Observation) (Reconciled, bool) {
	now := r.cfg.Now()

	// 1. keep observations that actually carry a value.
	live := make([]Observation, 0, len(obs))
	for _, o := range obs {
		if o.Value.Present() {
			live = append(live, o)
		}
	}
	if len(live) == 0 {
		return Reconciled{}, false
	}

	// 2. outlier rejection against the median.
	var excluded []string
	vals := make([]*big.Rat, len(live))
	for i, o := range live {
		vals[i] = o.Value.Rat()
	}
	med := medianRat(sortRatVals(vals))
	kept := make([]Observation, 0, len(live))
	for _, o := range live {
		if med != nil && med.Sign() != 0 {
			dev := new(big.Rat).Abs(new(big.Rat).Quo(new(big.Rat).Sub(o.Value.Rat(), med), med))
			if dev.Cmp(r.cfg.OutlierDeviation) > 0 {
				excluded = append(excluded, o.Provider)
				continue
			}
		}
		kept = append(kept, o)
	}
	if len(kept) == 0 {
		// Every input was an outlier of every other; rather than invent a
		// value, report the failure honestly.
		return Reconciled{}, false
	}

	// 3. weighted median.
	type weighted struct {
		o   Observation
		w   *big.Rat
		age time.Duration
	}
	ws := make([]weighted, 0, len(kept))
	for _, o := range kept {
		age := now.Sub(o.ObservedAt)
		w := new(big.Rat).Mul(tierQuality(o.Tier), freshnessFactor(age, r.cfg.FreshnessSLA))
		ws = append(ws, weighted{o: o, w: w, age: age})
	}
	// order by value for the weighted median.
	for i := 1; i < len(ws); i++ {
		for j := i; j > 0 && ws[j-1].o.Value.Rat().Cmp(ws[j].o.Value.Rat()) > 0; j-- {
			ws[j-1], ws[j] = ws[j], ws[j-1]
		}
	}
	totalW := rat("0")
	for _, w := range ws {
		totalW.Add(totalW, w.w)
	}
	canonical := ws[len(ws)-1].o.Value // fallback: highest
	if totalW.Sign() > 0 {
		half := new(big.Rat).Quo(totalW, rat("2"))
		acc := rat("0")
		for _, w := range ws {
			acc.Add(acc, w.w)
			if acc.Cmp(half) >= 0 {
				canonical = w.o.Value
				break
			}
		}
	}

	// 4. confidence factors over the KEPT set.
	var maxDev *big.Rat
	if med != nil && med.Sign() != 0 {
		for _, o := range kept {
			dev := new(big.Rat).Abs(new(big.Rat).Quo(new(big.Rat).Sub(o.Value.Rat(), med), med))
			if maxDev == nil || dev.Cmp(maxDev) > 0 {
				maxDev = dev
			}
		}
	}
	// freshest + best-tier/liquidity/block across the kept set.
	var freshest time.Duration
	var bestTier canon.SourceTier
	var bestLiq *canon.Dec
	var block, head *int64
	for i, o := range kept {
		age := now.Sub(o.ObservedAt)
		if i == 0 || age < freshest {
			freshest = age
		}
		if i == 0 || tierQuality(o.Tier).Cmp(tierQuality(bestTier)) > 0 {
			bestTier = o.Tier
		}
		if o.Liquidity != nil && o.Liquidity.Present() {
			if bestLiq == nil || o.Liquidity.Rat().Cmp(bestLiq.Rat()) > 0 {
				bestLiq = o.Liquidity
			}
		}
		if o.BlockNumber != nil {
			block = o.BlockNumber
		}
		if o.HeadBlock != nil {
			head = o.HeadBlock
		}
	}

	f := Factors{
		Agreement:     factorToInt(agreementFactor(maxDev, r.cfg.MaxDeviation)),
		Freshness:     factorToInt(freshnessFactor(freshest, r.cfg.FreshnessSLA)),
		Liquidity:     factorToInt(liquidityFactor(bestLiq, r.cfg.LiquidityRefUSD)),
		SourceQuality: factorToInt(tierQuality(bestTier)),
		BlockConfirm:  factorToInt(blockConfirmFactor(block, head, r.cfg.MinConfirms)),
		Anomaly:       r.anomalyFactor(kept, len(obs)),
	}
	conf := weightedTotal([][2]int{
		{WeightAgreement, f.Agreement},
		{WeightFreshness, f.Freshness},
		{WeightLiquidity, f.Liquidity},
		{WeightSourceQuality, f.SourceQuality},
		{WeightBlockConfirm, f.BlockConfirm},
		{WeightAnomaly, f.Anomaly},
	}) / 100

	included := make([]string, len(kept))
	for i, o := range kept {
		included[i] = o.Provider
	}
	return Reconciled{
		Value:         canonical,
		Confidence:    canon.ClampConfidence(conf),
		ProviderCount: len(kept),
		Included:      included,
		Excluded:      excluded,
		Deviation:     maxDev,
		Freshest:      freshest,
		Factors:       f,
	}, true
}

// anomalyFactor penalises a run where many observations were dropped: if half
// the inputs were outliers, the remaining agreement is less trustworthy.
func (r *Resolver) anomalyFactor(kept []Observation, total int) int {
	if total <= 0 {
		return 50
	}
	dropped := total - len(kept)
	frac := float64(dropped) / float64(total)
	// 1 - frac, as a percentage.
	return factorToInt(new(big.Rat).SetFloat64(1 - frac))
}
