package dexstore

import (
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// The module's go directive is 1.25, so `new(expr)` (Go 1.26) is unavailable;
// address-of-local is the documented fallback.

// TestClassifyActivityTiers pins each tier at its documented boundary.
func TestClassifyActivityTiers(t *testing.T) {
	th := DefaultThresholds()
	aVol, aLiq, aTxns := 2e6, 2e6, int64(5000)
	b, bLiq, bTxns := 2e5, 2e5, int64(500)
	c, cLiq, cTxns := 50.0, 5e3, int64(3)
	dLiq, dTxns := 5e3, int64(0)
	dustVol, dustLiq, dustTxns := 5e6, 10.0, int64(9000)
	cases := []struct {
		name string
		a    Activity
		want ActivityTier
	}{
		{"high volume+liquidity+txns", Activity{&aVol, &aLiq, &aTxns, nil}, TierA},
		// Liquidity was never observed (the market snapshot has no liquidity
		// column): a hot pool must NOT be misread as dust just because one of
		// its signals is absent.
		{"high volume, unobserved liquidity", Activity{&aVol, nil, &aTxns, nil}, TierA},
		{"medium", Activity{&b, &bLiq, &bTxns, nil}, TierB},
		{"low but trading", Activity{&c, &cLiq, &cTxns, nil}, TierC},
		{"no volume", Activity{zeroF(), &dLiq, &dTxns, nil}, TierD},
		{"dust liquidity with loud volume", Activity{&dustVol, &dustLiq, &dustTxns, nil}, TierD},
	}
	for _, c := range cases {
		if got := ClassifyActivity(c.a, th); got != c.want {
			t.Fatalf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

// zeroF is an observed zero (distinct from an absent reading, nil).
func zeroF() *float64 {
	v := 0.0
	return &v
}

// TestClassifyActivityUnknownIsNotDead is the never-guess rule: a pool with no
// observed volume AND no observed liquidity is UNKNOWN, never TierD (which would
// idle a genuinely active but unmeasured pool) — and it takes the caller's
// default cadence, not the slowest one.
func TestClassifyActivityUnknownIsNotDead(t *testing.T) {
	th := DefaultThresholds()
	if got := ClassifyActivity(Activity{}, th); got != TierUnknown {
		t.Fatalf("empty activity = %q, want unknown", got)
	}
	// One observed zero is ENOUGH to say dead: volume 0 with liquidity known.
	liq := 1e5
	if got := ClassifyActivity(Activity{Volume24hUSD: zeroF(), LiquidityUSD: &liq}, th); got != TierD {
		t.Fatalf("observed zero volume = %q, want D", got)
	}
	def := 7 * time.Minute
	if got := CadenceFor(TierUnknown, def); got != def {
		t.Fatalf("unknown cadence = %v, want the default %v", got, def)
	}
}

// TestCadenceOrdering proves the cadences are ordered fastest to slowest.
func TestCadenceOrdering(t *testing.T) {
	def := time.Hour
	a := CadenceFor(TierA, def)
	b := CadenceFor(TierB, def)
	c := CadenceFor(TierC, def)
	d := CadenceFor(TierD, def)
	if !(a < b && b < c && c < d) {
		t.Fatalf("cadences not ordered: A=%v B=%v C=%v D=%v", a, b, c, d)
	}
}

// TestTierCursorRoundTrip proves the tier persists in the job cursor and reads
// back, with the inputs it was derived from (so the choice is auditable), and
// that a cursor carrying no tier reports ok=false rather than a guessed one.
func TestTierCursorRoundTrip(t *testing.T) {
	if _, ok := TierFromCursor(nil); ok {
		t.Fatal("nil cursor must report no tier")
	}
	if _, ok := TierFromCursor(map[string]any{"other": "x"}); ok {
		t.Fatal("cursor without a tier must report no tier")
	}
	vol, txns := 2e5, int64(500)
	cur := WithTier(map[string]any{"subject": "pool:1"}, TierB, Activity{&vol, nil, &txns, nil})
	got, ok := TierFromCursor(cur)
	if !ok || got != TierB {
		t.Fatalf("round trip = %q ok=%v", got, ok)
	}
	// The preserved keys survive, and the inputs ride along.
	if cur["subject"] != "pool:1" {
		t.Fatalf("existing cursor key lost: %v", cur)
	}
	if cur["volume_24h_usd"] != 2e5 || cur["txns_24h"] != int64(500) {
		t.Fatalf("inputs not recorded: %v", cur)
	}
	if _, present := cur["liquidity_usd"]; present {
		t.Fatalf("absent input must not be recorded: %v", cur)
	}
}

// TestActivityFromMarket reads the classifier input off a market snapshot and
// leaves the volume absent (never 0) when the row has none.
func TestActivityFromMarket(t *testing.T) {
	vol, _ := canon.DecFromString("2055.14")
	txns := int64(22)
	got := ActivityFromMarket(canon.DexMarketSnapshot{Volume24hUSD: &vol, Txns24h: &txns})
	if got.Volume24hUSD == nil || *got.Volume24hUSD != 2055.14 {
		t.Fatalf("volume = %v", got.Volume24hUSD)
	}
	if got.Txns24h == nil || *got.Txns24h != 22 {
		t.Fatalf("txns = %v", got.Txns24h)
	}
	// A row with no volume leaves the field nil (absent), so the classifier
	// treats it as unknown rather than zero.
	none := ActivityFromMarket(canon.DexMarketSnapshot{})
	if none.Volume24hUSD != nil {
		t.Fatalf("absent volume must stay nil, got %v", *none.Volume24hUSD)
	}
}
