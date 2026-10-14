package derive

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// TestSubsidyAtHeight pins the halving schedule at each epoch boundary.
func TestSubsidyAtHeight(t *testing.T) {
	cases := []struct {
		height int
		want   float64
	}{
		{0, 50},
		{209999, 50},
		{210000, 25},
		{420000, 12.5},
		{630000, 6.25},
		{840000, 3.125},
		{1050000, 1.5625},
		{33 * HalvingInterval, 0},
	}
	for _, c := range cases {
		if got := SubsidyAtHeight(c.height); got != c.want {
			t.Fatalf("SubsidyAtHeight(%d) = %v, want %v", c.height, got, c.want)
		}
	}
	if got := SubsidyAtHeight(-1); got != 0 {
		t.Fatalf("SubsidyAtHeight(-1) = %v, want 0", got)
	}
}

// TestSupplyAtHeight pins the cumulative supply at the 2024 halving and the
// 21M cap.
func TestSupplyAtHeight(t *testing.T) {
	got := SupplyAtHeight(840000)
	// 210000*(50+25+12.5+6.25) = 19,687,500
	if math.Abs(got-19_687_500) > 1 {
		t.Fatalf("SupplyAtHeight(840000) = %v, want ~19,687,500", got)
	}
	// The 33-epoch sum converges just under 21M (finite geometric series); the
	// cap is a safety net, never reached exactly.
	if got := SupplyAtHeight(33 * HalvingInterval); got <= 0 || got > MaxSupply || MaxSupply-got > 1 {
		t.Fatalf("SupplyAtHeight(exhausted) = %v, want just under %v", got, MaxSupply)
	}
}

// TestS2FAfterHalving pins stock-to-flow just after the 2024 halving.
func TestS2FAfterHalving(t *testing.T) {
	h := 840000
	got := S2FRatio(SupplyAtHeight(h), AnnualIssuance(SubsidyAtHeight(h)))
	if math.IsNaN(got) || math.Abs(got-121) > 5 {
		t.Fatalf("S2F after 2024 halving = %v, want ~121", got)
	}
	// exhausted schedule -> NaN, never +Inf.
	if got := S2FRatio(21_000_000, 0); !math.IsNaN(got) {
		t.Fatalf("S2F with zero issuance = %v, want NaN", got)
	}
}

// TestFitPowerLawRecoversSynthetic pins the OLS fit on a known power law.
func TestFitPowerLawRecoversSynthetic(t *testing.T) {
	days := []float64{1, 10, 100, 1000}
	price := make([]float64, len(days))
	for i, d := range days {
		price[i] = 3 * math.Pow(d, 0.5)
	}
	a, b := FitPowerLaw(days, price)
	if math.Abs(a-math.Log(3)) > 1e-9 || math.Abs(b-0.5) > 1e-9 {
		t.Fatalf("FitPowerLaw = (%v, %v), want (%v, 0.5)", a, b, math.Log(3))
	}
	// degenerate: one usable point -> NaN.
	if a, b := FitPowerLaw([]float64{1}, []float64{2}); !math.IsNaN(a) || !math.IsNaN(b) {
		t.Fatalf("degenerate fit = (%v, %v), want NaN", a, b)
	}
}

// TestAtProcessorsRun pins the timestamp-derived processors over one point and
// that a zero annual issuance (s2f at exhaustion) lands as NULL, not +Inf.
func TestAtProcessorsRun(t *testing.T) {
	at := time.Unix(GenesisUnix, 0).UTC().AddDate(15, 0, 0) // ~2015
	in := []canon.MetricPoint{{At: at, Value: ptr(300.0)}}
	for _, name := range []string{"supply", "s2f", "halving", "power_law", "power_law_osc", "drawdown"} {
		proc, ok := NewDefaultRegistry().Lookup(name)
		if !ok {
			t.Fatalf("processor %q not registered", name)
		}
		out, err := proc.Compute(context.Background(), in)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(out) != 1 {
			t.Fatalf("%s: %d points", name, len(out))
		}
		if name != "drawdown" && (out[0].Value == nil || math.IsNaN(*out[0].Value) || math.IsInf(*out[0].Value, 0)) {
			t.Fatalf("%s: value = %v", name, out[0].Value)
		}
	}
}

// TestPowerLawOscillatorAbsentPrice pins NaN (->NULL) for a non-positive price.
func TestPowerLawOscillatorAbsentPrice(t *testing.T) {
	proc := NewPowerLawOscillatorProcessor(nil)
	at := time.Unix(GenesisUnix, 0).UTC().AddDate(10, 0, 0)
	out, err := proc.Compute(context.Background(), []canon.MetricPoint{{At: at}})
	if err != nil {
		t.Fatalf("osc: %v", err)
	}
	if out[0].Value != nil {
		t.Fatalf("absent price should be NULL, got %v", *out[0].Value)
	}
}

// TestRunPointsMatchesRun pins that the OHLCV bridge entry point produces the
// same derived series as the observation-reading Run.
func TestRunPointsMatchesRun(t *testing.T) {
	vals := []float64{1, 2, 3, 4, 5, 6}
	obs := testObs(t, vals)
	reader := &fakeReader{obs: obs}
	writer := newFakeWriter()
	p := NewPipeline(reader, writer, NewDefaultRegistry(), 0)
	spec := MetricSpec{Domain: "market", Metric: "sma", SubjectKey: "asset:btcusd", Params: map[string]string{"period": "3"}}
	if err := p.Run(context.Background(), spec, testSourceID, 0); err != nil {
		t.Fatalf("Run: %v", err)
	}
	viaRun := writer.metrics[DerivedSeriesKey(spec.Domain, spec.Metric, spec.SubjectKey, spec.Params)]

	reader2 := &fakeReader{obs: obs}
	writer2 := newFakeWriter()
	p2 := NewPipeline(reader2, writer2, NewDefaultRegistry(), 0)
	if err := p2.RunPoints(context.Background(), spec, testSourceID, observationsToPoints(obs)); err != nil {
		t.Fatalf("RunPoints: %v", err)
	}
	viaPoints := writer2.metrics[DerivedSeriesKey(spec.Domain, spec.Metric, spec.SubjectKey, spec.Params)]

	if len(viaRun) != len(viaPoints) || len(viaRun) == 0 {
		t.Fatalf("Run=%d RunPoints=%d points", len(viaRun), len(viaPoints))
	}
	for i := range viaRun {
		if !viaRun[i].At.Equal(viaPoints[i].At) {
			t.Fatalf("ts[%d]: %v vs %v", i, viaRun[i].At, viaPoints[i].At)
		}
		switch {
		case viaRun[i].Value == nil && viaPoints[i].Value == nil:
		case viaRun[i].Value == nil || viaPoints[i].Value == nil:
			t.Fatalf("value[%d]: %v vs %v", i, viaRun[i].Value, viaPoints[i].Value)
		case *viaRun[i].Value != *viaPoints[i].Value:
			t.Fatalf("value[%d]: %v vs %v", i, *viaRun[i].Value, *viaPoints[i].Value)
		}
	}
	// RunPoints must not read the source series at all.
	if reader2.reads != 0 {
		t.Fatalf("RunPoints read the source series %d times", reader2.reads)
	}
}

// TestRunPointsEmptyInput pins the loud failure on an empty bridge input.
func TestRunPointsEmptyInput(t *testing.T) {
	p := NewPipeline(&fakeReader{}, newFakeWriter(), NewDefaultRegistry(), 0)
	err := p.RunPoints(context.Background(), MetricSpec{Domain: "market", Metric: "sma", SubjectKey: "asset:btcusd"}, testSourceID, nil)
	if !errors.Is(err, ErrEmptyInput) {
		t.Fatalf("RunPoints(empty) = %v, want ErrEmptyInput", err)
	}
}
