package derive

import (
	"context"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// TestMetricSuffix pins the suffix builder: sorted values joined by '_',
// sanitized for the series natural key, "d" when empty.
func TestMetricSuffix(t *testing.T) {
	cases := []struct {
		params map[string]string
		want   string
	}{
		{nil, "d"},
		{map[string]string{}, "d"},
		{map[string]string{"period": "14"}, "14"},
		{map[string]string{"fast": "12", "slow": "26", "signal": "9"}, "12_9_26"},
		{map[string]string{"period": "20", "mult": "2"}, "2_20"},
		{map[string]string{"mult": "-2.5"}, "d2d5"},
		{map[string]string{"k": ""}, "d"},
	}
	for _, c := range cases {
		if got := MetricSuffix(c.params); got != c.want {
			t.Errorf("MetricSuffix(%v) = %q, want %q", c.params, got, c.want)
		}
	}
}

// TestDerivedSeriesKey pins the series id minting rule: canonical SeriesKey
// over (domain, metric_suffix, subject), lowercased subject.
func TestDerivedSeriesKey(t *testing.T) {
	got := DerivedSeriesKey("market", "rsi", "Asset:btcusd", map[string]string{"period": "14"})
	want := "series/market/rsi_14/asset:btcusd"
	if got != want {
		t.Fatalf("DerivedSeriesKey = %q, want %q", got, want)
	}

	noParams := DerivedSeriesKey("market", "obv", "global", nil)
	if want := "series/market/obv_d/global"; noParams != want {
		t.Fatalf("DerivedSeriesKey(no params) = %q, want %q", noParams, want)
	}
}

// TestSpecParam pins the parameter accessor with default.
func TestSpecParam(t *testing.T) {
	spec := MetricSpec{Params: map[string]string{"period": "14"}}
	if got := spec.Param("period", "20"); got != "14" {
		t.Fatalf("Param(period) = %q, want 14", got)
	}
	if got := spec.Param("missing", "20"); got != "20" {
		t.Fatalf("Param(missing) = %q, want default 20", got)
	}
	if got := (MetricSpec{}).Param("period", "20"); got != "20" {
		t.Fatalf("Param(nil params) = %q, want default 20", got)
	}
}

// stubProcessor is a minimal Processor for registry tests.
type stubProcessor struct {
	name string
}

func (s *stubProcessor) Name() string { return s.name }

func (s *stubProcessor) Compute(_ context.Context, _ []canon.MetricPoint) ([]canon.MetricPoint, error) {
	return nil, nil
}

// TestRegistryDuplicateNamePanic pins the wiring rule: registering two
// processors under one metric name is a programmer error and panics.
func TestRegistryDuplicateNamePanic(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("duplicate registration did not panic")
		}
	}()
	r := NewRegistry()
	r.Register(MetricSpec{Metric: "sma"}, &stubProcessor{name: "sma"})
	r.Register(MetricSpec{Metric: "sma"}, &stubProcessor{name: "sma"})
}

// TestRegistryNilAndEmptyPanic pins the other wiring errors.
func TestRegistryNilAndEmptyPanic(t *testing.T) {
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("nil processor registration did not panic")
			}
		}()
		r := NewRegistry()
		r.Register(MetricSpec{Metric: "x"}, nil)
	}()
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("empty metric registration did not panic")
			}
		}()
		r := NewRegistry()
		r.Register(MetricSpec{Metric: ""}, &stubProcessor{name: "x"})
	}()
}

// TestRegistryLookupAndNames pins Lookup, Spec, Window and Names.
func TestRegistryLookupAndNames(t *testing.T) {
	r := NewDefaultRegistry()
	p, ok := r.Lookup("sma")
	if !ok || p.Name() != "sma" {
		t.Fatalf("Lookup(sma) = %v, %v", p, ok)
	}
	if _, ok := r.Lookup("nope"); ok {
		t.Fatal("Lookup(nope) found a processor that cannot exist")
	}
	spec, ok := r.Spec("sma")
	if !ok || spec.Metric != "sma" {
		t.Fatalf("Spec(sma) = %v, %v", spec, ok)
	}
	if _, ok := r.Spec("nope"); ok {
		t.Fatal("Spec(nope) found a spec that cannot exist")
	}
	// sma's default period is 20 → window 20.
	if w := r.Window("sma"); w != 20 {
		t.Fatalf("Window(sma) = %d, want 20", w)
	}
	// obv declares no warmup.
	if w := r.Window("obv"); w != 0 {
		t.Fatalf("Window(obv) = %d, want 0", w)
	}
	names := r.Names()
	if len(names) == 0 {
		t.Fatal("Names() empty for the default registry")
	}
	for i := 1; i < len(names); i++ {
		if names[i-1] >= names[i] {
			t.Fatalf("Names() not sorted: %q before %q", names[i-1], names[i])
		}
	}
}
