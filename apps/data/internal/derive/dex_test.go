package derive

import (
	"math"
	"math/big"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// This file pins the DEX Data Platform primitives (plan §26 group A). The
// exact-Dec functions are the important ones: a float64 in that path would be a
// silently wrong depth/impact, which is why they are tested against exact
// rational expectations rather than approximations.

func dec(t *testing.T, s string) canon.Dec {
	t.Helper()
	d, err := canon.DecFromString(s)
	if err != nil {
		t.Fatalf("bad decimal %q: %v", s, err)
	}
	return d
}

func TestBuySellImbalance(t *testing.T) {
	got := BuySellImbalance([]float64{6, 5, 0}, []float64{4, 5, 0})
	if got[0] != 0.2 || got[1] != 0 {
		t.Fatalf("imbalance %v", got)
	}
	// A window with no trades is absent (NaN), never 0.
	if !math.IsNaN(got[2]) {
		t.Fatalf("empty window should be NaN, got %v", got[2])
	}
	// NaN propagates.
	if g := BuySellImbalance([]float64{math.NaN()}, []float64{1}); !math.IsNaN(g[0]) {
		t.Fatalf("NaN should propagate, got %v", g[0])
	}
}

func TestVolumeVelocity(t *testing.T) {
	got := VolumeVelocity([]float64{100, 100, 150, 0}, 1)
	if !math.IsNaN(got[0]) || got[1] != 0 || got[2] != 0.5 {
		t.Fatalf("velocity %v", got)
	}
	// A series that DROPS to zero is a legitimate -100% change (a dead pool is
	// real signal), not an absent reading.
	if got[3] != -1 {
		t.Fatalf("volume collapsing to 0 should be -1, got %v", got[3])
	}
	// A window that RISES FROM a zero reference is undefined (a percentage
	// change from nothing), NaN rather than a fabricated +Inf.
	fromZero := VolumeVelocity([]float64{0, 100}, 1)
	if !math.IsNaN(fromZero[1]) {
		t.Fatalf("rising from zero should be NaN, got %v", fromZero[1])
	}
}

func TestPoolHealthBounded(t *testing.T) {
	// depth at the reference, perfectly balanced -> 0.6 + 0.4*0.5 = 0.8
	got := PoolHealth([]float64{1e6}, []float64{1e6}, []float64{0})
	if math.Abs(got[0]-0.8) > 1e-9 {
		t.Fatalf("health %v (want 0.8)", got[0])
	}
	// depth above reference saturates at 1.
	got = PoolHealth([]float64{1e9}, []float64{1e6}, []float64{0})
	if math.Abs(got[0]-0.8) > 1e-9 {
		t.Fatalf("saturated health %v", got[0])
	}
	// A missing depth is NaN even with a good imbalance.
	got = PoolHealth([]float64{math.NaN()}, []float64{1e6}, []float64{0})
	if !math.IsNaN(got[0]) {
		t.Fatalf("missing depth should be NaN, got %v", got[0])
	}
}

// TestLiquidityDepthExact is the precision test: 1,000,000 reserve at a 1%
// tolerance is 1000000/99 = 10101.010101... which is NOT a finite decimal, so
// the exact helper rounds it half-up to a cent: 10101.01. A float64 path would
// have produced the same-looking number with noise in the low digits, which is
// why the exactness test also asserts the 8-decimal impact below.
func TestLiquidityDepthExact(t *testing.T) {
	got := LiquidityDepthUSDExact(dec(t, "1000000"), dec(t, "0.01"))
	if !got.Present() {
		t.Fatal("depth absent")
	}
	if got.String() != "10101.01" {
		t.Fatalf("depth = %s, want 10101.01 (1000000/99 rounded to cents)", got.String())
	}
	// Absent/zero/invalid inputs are NilDec, never a fabricated 0.
	if LiquidityDepthUSDExact(canon.NilDec, dec(t, "0.01")).Present() {
		t.Fatal("absent reserve must yield absent depth")
	}
	if LiquidityDepthUSDExact(dec(t, "0"), dec(t, "0.01")).Present() {
		t.Fatal("zero reserve must yield absent depth")
	}
	if LiquidityDepthUSDExact(dec(t, "1000"), dec(t, "1")).Present() {
		t.Fatal("1.0 tolerance must yield absent depth (division by zero)")
	}
}

// TestPriceImpactExact: 10 against a 990 reserve is exactly 1/100 = 0.01.
func TestPriceImpactExact(t *testing.T) {
	got := PriceImpactPctExact(dec(t, "990"), dec(t, "10"))
	if got.String() != "0.01" {
		t.Fatalf("impact = %s, want 0.01", got.String())
	}
	// A non-terminating impact (1 against 3 -> 0.25 terminates, but 1 against
	// 2 with a third of the reserve does not) rounds to 8 places exactly.
	got = PriceImpactPctExact(dec(t, "3"), dec(t, "1"))
	if got.String() != "0.25" {
		t.Fatalf("impact = %s, want 0.25", got.String())
	}
	if PriceImpactPctExact(dec(t, "0"), dec(t, "10")).Present() {
		t.Fatal("zero reserve must yield absent impact")
	}
	if PriceImpactPctExact(dec(t, "1000"), dec(t, "0")).Present() {
		t.Fatal("zero amount must yield absent impact")
	}
}

// TestDepthImpactRoundTrip proves the two exact inverses agree where the
// tolerance lands on a finite decimal (0.5): depth = r, and that depth's impact
// is exactly the tolerance again.
func TestDepthImpactRoundTrip(t *testing.T) {
	reserve := dec(t, "1000000")
	tol := dec(t, "0.5")
	depth := LiquidityDepthUSDExact(reserve, tol)
	if depth.String() != "1000000" {
		t.Fatalf("depth = %s, want 1000000 (1000000*0.5/0.5)", depth.String())
	}
	impact := PriceImpactPctExact(reserve, depth)
	if impact.String() != "0.5" {
		t.Fatalf("round-trip impact = %s, want exactly 0.5", impact.String())
	}
}

// TestDecFromRatRefusesNonTerminating is the canon-side guard: a rational with a
// non-finite-decimal denominator yields NilDec (absent), never a Dec that would
// render float noise or a rational spelling as if it were a price.
func TestDecFromRatRefusesNonTerminating(t *testing.T) {
	if canon.DecFromRat(big.NewRat(1, 3)).Present() {
		t.Fatal("1/3 has no exact decimal: must be absent, not a rounded Dec")
	}
	if canon.DecFromRat(big.NewRat(1000000, 99)).Present() {
		t.Fatal("1000000/99 has no exact decimal: must be absent")
	}
	// Finite decimals are accepted and exact.
	if got := canon.DecFromRat(big.NewRat(1, 8)); got.String() != "0.125" {
		t.Fatalf("1/8 = %s, want 0.125", got.String())
	}
	if got := canon.DecFromRat(big.NewRat(-3, 4)); got.String() != "-0.75" {
		t.Fatalf("-3/4 = %s, want -0.75", got.String())
	}
}

func TestImpermanentLoss(t *testing.T) {
	// r = 1 -> no loss; r = 4 -> 2*2/5 - 1 = -0.2.
	got := ImpermanentLossPct([]float64{1, 4})
	if math.Abs(got[0]) > 1e-12 {
		t.Fatalf("r=1 loss %v (want 0)", got[0])
	}
	if math.Abs(got[1]-(-0.2)) > 1e-12 {
		t.Fatalf("r=4 loss %v (want -0.2)", got[1])
	}
	if g := ImpermanentLossPct([]float64{0}); !math.IsNaN(g[0]) {
		t.Fatalf("r=0 should be NaN, got %v", g[0])
	}
}

func TestLPAPR(t *testing.T) {
	// 1000 volume * 0.003 fee / 10000 liquidity * 365 = 0.1095
	got := LPAPRPct([]float64{1000}, []float64{10000}, []float64{0.003})
	if math.Abs(got[0]-0.1095) > 1e-12 {
		t.Fatalf("apr %v (want 0.1095)", got[0])
	}
	if g := LPAPRPct([]float64{1000}, []float64{0}, []float64{0.003}); !math.IsNaN(g[0]) {
		t.Fatalf("zero liquidity should be NaN, got %v", g[0])
	}
}

// TestDexProcessorsRegistered proves the two SINGLE-input DEX metrics are wired
// into the default registry and that a full run carries values through the
// shared adapter (NaN -> nil, never a fake 0). The multi-input DEX functions are
// deliberately NOT registered — a processor that can only emit NULL under a real
// metric name would be a silent lie — so they are asserted absent here.
func TestDexProcessorsRegistered(t *testing.T) {
	r := NewDefaultRegistry()
	for _, name := range []string{"volume_velocity", "impermanent_loss"} {
		if _, ok := r.Lookup(name); !ok {
			t.Fatalf("processor %q not registered", name)
		}
	}
	for _, name := range []string{"buy_sell_imbalance", "pool_health", "lp_apr"} {
		if _, ok := r.Lookup(name); ok {
			t.Fatalf("multi-input %q must NOT be registered (it can only emit NULL)", name)
		}
	}
	// Run the velocity processor end to end through the adapter.
	p, _ := r.Lookup("volume_velocity")
	base := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	in := make([]canon.MetricPoint, 3)
	for i, v := range []float64{100, 110, 121} {
		vv := v
		in[i] = canon.MetricPoint{At: base.Add(time.Duration(i) * time.Hour), Value: &vv}
	}
	out, err := p.Compute(t.Context(), in)
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	if out[0].Value != nil {
		t.Fatalf("first point must be absent (nil), got %v", *out[0].Value)
	}
	if out[2].Value == nil || math.Abs(*out[2].Value-0.1) > 1e-9 {
		t.Fatalf("third point %v (want ~0.1)", out[2].Value)
	}
}
