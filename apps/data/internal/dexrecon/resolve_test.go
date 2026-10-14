package dexrecon

import (
	"math/big"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

func dec(t *testing.T, s string) canon.Dec {
	t.Helper()
	d, err := canon.DecFromString(s)
	if err != nil {
		t.Fatalf("DecFromString(%q): %v", s, err)
	}
	return d
}

func at(base time.Time) time.Time { return base }

var baseTime = time.Unix(1_760_000_000, 0).UTC()

func newObs(t *testing.T, provider string, tier canon.SourceTier, price string, ageSec int) Observation {
	return Observation{
		Provider:   provider,
		Tier:       tier,
		Value:      dec(t, price),
		ObservedAt: baseTime.Add(-time.Duration(ageSec) * time.Second),
	}
}

// TestGoldenEthUsdcReconciles — the plan §33 golden case: four providers report
// ETH/USDC within a tight band; the resolver must pick a value inside that band
// with high confidence and include all four.
func TestGoldenEthUsdcReconciles(t *testing.T) {
	r := New(Config{
		FreshnessSLA: 10 * time.Second,
		Now:          func() time.Time { return baseTime },
	})
	obs := []Observation{
		newObs(t, "coingecko", canon.TierAggregator, "4001.20", 2),
		newObs(t, "dexscreener", canon.TierAggregator, "4000.92", 1),
		newObs(t, "bitquery", canon.TierIndexer, "4001.04", 3),
		newObs(t, "uniswap", canon.TierDexNative, "4001.01", 5),
	}
	got, ok := r.Resolve(obs)
	if !ok {
		t.Fatal("resolve failed on the golden set")
	}
	if got.ProviderCount != 4 {
		t.Fatalf("providers = %d, want 4 (none should be an outlier)", got.ProviderCount)
	}
	// Value must sit inside the observed band [4000.92, 4001.20].
	v := got.Value.Rat()
	lo := dec(t, "4000.90").Rat()
	hi := dec(t, "4001.25").Rat()
	if v.Cmp(lo) < 0 || v.Cmp(hi) > 0 {
		t.Fatalf("reconciled %s outside [4000.90,4001.25]", got.Value.String())
	}
	if got.Confidence < 70 {
		t.Fatalf("confidence = %d, want >= 70 for four agreeing sources", got.Confidence)
	}
	if got.Confidence > 100 {
		t.Fatalf("confidence = %d out of range", got.Confidence)
	}
}

// TestOutlierRejectedNotAveraged — a single wildly wrong provider must be
// excluded, and the canonical value must NOT be dragged toward it (the plan §24
// "jangan sekadar average" requirement).
func TestOutlierRejectedNotAveraged(t *testing.T) {
	r := New(Config{Now: func() time.Time { return baseTime }, OutlierDeviation: big.NewRat(2, 100)})
	obs := []Observation{
		newObs(t, "a", canon.TierDexNative, "4001.00", 1),
		newObs(t, "b", canon.TierIndexer, "4001.10", 1),
		newObs(t, "c", canon.TierAggregator, "4000.90", 1),
		newObs(t, "bad", canon.TierAnalytics, "9000.00", 1), // absurd
	}
	got, ok := r.Resolve(obs)
	if !ok {
		t.Fatal("resolve failed")
	}
	if got.ProviderCount != 3 {
		t.Fatalf("providers = %d, want 3 (bad excluded)", got.ProviderCount)
	}
	if len(got.Excluded) != 1 || got.Excluded[0] != "bad" {
		t.Fatalf("excluded = %v, want [bad]", got.Excluded)
	}
	// A plain average of all four would be ~5250; the answer must be near 4001.
	v := got.Value.Rat()
	if v.Cmp(dec(t, "4100").Rat()) > 0 {
		t.Fatalf("reconciled %s was dragged toward the outlier", got.Value.String())
	}
}

// TestHigherTierWeighsMore — with two values equidistant from the median, the
// higher-tier source must dominate the weighted median.
func TestHigherTierWeighsMore(t *testing.T) {
	r := New(Config{Now: func() time.Time { return baseTime }})
	obs := []Observation{
		newObs(t, "aggregator", canon.TierAggregator, "100.00", 1),
		newObs(t, "native", canon.TierDexNative, "100.20", 1),
	}
	got, ok := r.Resolve(obs)
	if !ok {
		t.Fatal("resolve failed")
	}
	// The weighted median lands on one of the two; with S1 weighted above S3 it
	// must be the native value.
	if got.Value.String() != "100.2" {
		t.Fatalf("value = %s, want the higher-tier 100.2", got.Value.String())
	}
}

// TestStaleObservationLowersConfidence — the same agreement at a great age must
// score lower than at a fresh age.
func TestStaleObservationLowersConfidence(t *testing.T) {
	fresh := New(Config{FreshnessSLA: 10 * time.Second, Now: func() time.Time { return baseTime }})
	stale := New(Config{FreshnessSLA: 10 * time.Second, Now: func() time.Time { return baseTime }})

	obsFresh := []Observation{newObs(t, "a", canon.TierIndexer, "100", 1), newObs(t, "b", canon.TierIndexer, "100", 1)}
	obsStale := []Observation{newObs(t, "a", canon.TierIndexer, "100", 120), newObs(t, "b", canon.TierIndexer, "100", 120)}

	f, okF := fresh.Resolve(obsFresh)
	s, okS := stale.Resolve(obsStale)
	if !okF || !okS {
		t.Fatal("resolve failed")
	}
	if s.Confidence >= f.Confidence {
		t.Fatalf("stale confidence %d not below fresh %d", s.Confidence, f.Confidence)
	}
	if s.Factors.Freshness >= f.Factors.Freshness {
		t.Fatalf("stale freshness factor %d not below fresh %d", s.Factors.Freshness, f.Factors.Freshness)
	}
}

// TestLiquidityRaisesConfidence — a deep pool scores better than a shallow one.
func TestLiquidityRaisesConfidence(t *testing.T) {
	r := New(Config{Now: func() time.Time { return baseTime }, LiquidityRefUSD: big.NewRat(1_000_000, 1)})
	deep := dec(t, "5000000")
	shallow := dec(t, "1000")
	mk := func(liq *canon.Dec) []Observation {
		a := newObs(t, "a", canon.TierDexNative, "100", 1)
		a.Liquidity = liq
		b := newObs(t, "b", canon.TierDexNative, "100", 1)
		b.Liquidity = liq
		return []Observation{a, b}
	}
	d, _ := r.Resolve(mk(&deep))
	sh, _ := r.Resolve(mk(&shallow))
	if d.Factors.Liquidity <= sh.Factors.Liquidity {
		t.Fatalf("deep liquidity factor %d not above shallow %d", d.Factors.Liquidity, sh.Factors.Liquidity)
	}
	if d.Confidence < sh.Confidence {
		t.Fatalf("deep confidence %d below shallow %d", d.Confidence, sh.Confidence)
	}
}

// TestNilBlockIsNeutral — an aggregator with no block number is not penalised
// to zero; it scores the neutral 0.5.
func TestNilBlockIsNeutral(t *testing.T) {
	r := New(Config{Now: func() time.Time { return baseTime }})
	obs := []Observation{newObs(t, "agg", canon.TierAggregator, "100", 1)}
	got, ok := r.Resolve(obs)
	if !ok {
		t.Fatal("resolve failed")
	}
	if got.Factors.BlockConfirm != 50 {
		t.Fatalf("block confirm factor = %d, want the neutral 50", got.Factors.BlockConfirm)
	}
}

// TestSingleObservationScoresBelowAgreement — one source agrees with nothing,
// so its agreement factor is 1 (no spread) but its confidence must still be
// finite and below a well-agreed set.
func TestSingleObservationScoresBelowAgreement(t *testing.T) {
	r := New(Config{Now: func() time.Time { return baseTime }})
	one, ok := r.Resolve([]Observation{newObs(t, "solo", canon.TierAggregator, "100", 1)})
	if !ok {
		t.Fatal("single-observation resolve failed")
	}
	if one.ProviderCount != 1 {
		t.Fatalf("providers = %d", one.ProviderCount)
	}
	if one.Confidence > 100 || one.Confidence < 0 {
		t.Fatalf("confidence %d out of range", one.Confidence)
	}
	four, _ := r.Resolve([]Observation{
		newObs(t, "a", canon.TierDexNative, "100", 1),
		newObs(t, "b", canon.TierIndexer, "100.01", 1),
		newObs(t, "c", canon.TierAggregator, "99.99", 1),
		newObs(t, "d", canon.TierAggregator, "100", 1),
	})
	if four.Confidence <= one.Confidence {
		t.Fatalf("one source (%d) should not outscore four agreeing (%d)", one.Confidence, four.Confidence)
	}
}

// TestNoUsableObservationsFailsLoud — absence must be an explicit failure, never
// a fabricated value (plan §65).
func TestNoUsableObservationsFailsLoud(t *testing.T) {
	r := New(Config{Now: func() time.Time { return baseTime }})
	if _, ok := r.Resolve(nil); ok {
		t.Fatal("resolved an empty set")
	}
	if _, ok := r.Resolve([]Observation{{Provider: "x", Value: canon.NilDec}}); ok {
		t.Fatal("resolved a set with only absent values")
	}
}

// TestFactorsSumToConfidence — the weighted factors must compose the reported
// confidence exactly (no hidden fudge).
func TestFactorsSumToConfidence(t *testing.T) {
	r := New(Config{Now: func() time.Time { return baseTime }})
	got, _ := r.Resolve([]Observation{
		newObs(t, "a", canon.TierDexNative, "100.00", 1),
		newObs(t, "b", canon.TierIndexer, "100.01", 1),
	})
	f := got.Factors
	sum := (WeightAgreement*f.Agreement + WeightFreshness*f.Freshness + WeightLiquidity*f.Liquidity +
		WeightSourceQuality*f.SourceQuality + WeightBlockConfirm*f.BlockConfirm + WeightAnomaly*f.Anomaly) / 100
	if int(got.Confidence) != sum {
		t.Fatalf("confidence %d != weighted sum %d", got.Confidence, sum)
	}
}
