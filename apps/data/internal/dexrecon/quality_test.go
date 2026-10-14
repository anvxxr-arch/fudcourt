package dexrecon

import (
	"math/big"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

func canonDecPtr(t *testing.T, s string) (*canon.Dec, error) {
	t.Helper()
	d, err := canon.DecFromString(s)
	if err != nil {
		t.Fatalf("DecFromString(%q): %v", s, err)
	}
	return &d, nil
}

func TestStateForSeverity(t *testing.T) {
	cases := []struct {
		name     string
		findings []Finding
		want     QualityState
	}{
		{"none", nil, QualityHealthy},
		{"info only", []Finding{{Code: "x", Severity: Info}}, QualityHealthy},
		{"warn", []Finding{{Code: "x", Severity: Warn}}, QualityDegraded},
		{"conflict", []Finding{{Code: "x", Severity: Conflict}}, QualityConflicting},
		{"invalid", []Finding{{Code: "x", Severity: Invalid}}, QualityInvalid},
		{"worst wins", []Finding{{Code: "a", Severity: Warn}, {Code: "b", Severity: Invalid}}, QualityInvalid},
	}
	for _, c := range cases {
		if got := stateFor(c.findings); got != c.want {
			t.Errorf("%s: state = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestDetectStale(t *testing.T) {
	now := baseTime
	// fresh
	if f := DetectStale("p", now.Add(-time.Second), now, 10*time.Second, 5); len(f) != 0 {
		t.Errorf("fresh flagged: %v", f)
	}
	// stale: 100s > 5*10s
	f := DetectStale("p", now.Add(-100*time.Second), now, 10*time.Second, 5)
	if len(f) != 1 || f[0].Code != "stale_data" {
		t.Fatalf("stale not flagged: %v", f)
	}
	// missing
	f = DetectStale("p", time.Time{}, now, 10*time.Second, 5)
	if len(f) != 1 || f[0].Severity != Invalid {
		t.Fatalf("missing not flagged invalid: %v", f)
	}
}

func TestDetectPriceOutlier(t *testing.T) {
	median := big.NewRat(100, 1)
	tol := big.NewRat(2, 100) // 2%
	if f := DetectPriceOutlier("p", median, median, tol); len(f) != 0 {
		t.Errorf("equal value flagged: %v", f)
	}
	bad := big.NewRat(110, 1) // 10% off
	if f := DetectPriceOutlier("p", bad, median, tol); len(f) != 1 || f[0].Code != "price_outlier" {
		t.Fatalf("outlier not flagged: %v", f)
	}
}

func TestDetectDuplicateSwaps(t *testing.T) {
	mk := func(tx string, idx int) canon.Swap {
		return canon.Swap{ChainID: "chain:eth", TxHash: tx, LogIndex: idx}
	}
	swaps := []canon.Swap{
		{ChainID: "chain:eth", TxHash: "0xa", LogIndex: 0},
		{ChainID: "chain:eth", TxHash: "0xa", LogIndex: 1},
		{ChainID: "chain:eth", TxHash: "0xa", LogIndex: 0}, // dup
	}
	f := DetectDuplicateSwaps(swaps)
	if len(f) != 1 || f[0].Code != "duplicate_swaps" {
		t.Fatalf("duplicate not flagged: %v", f)
	}
	_ = mk
}

func TestDetectMissingCandles(t *testing.T) {
	t0 := baseTime
	// regular 1m bars
	times := []time.Time{t0, t0.Add(time.Minute), t0.Add(2 * time.Minute)}
	if f := DetectMissingCandles("p", times, time.Minute); len(f) != 0 {
		t.Errorf("regular series flagged: %v", f)
	}
	// gap
	gapped := []time.Time{t0, t0.Add(time.Minute), t0.Add(10 * time.Minute)}
	if f := DetectMissingCandles("p", gapped, time.Minute); len(f) != 1 || f[0].Code != "missing_candles" {
		t.Fatalf("gap not flagged: %v", f)
	}
}

func TestDetectBrokenDecimals(t *testing.T) {
	if f := DetectBrokenDecimals("t", 18); len(f) != 0 {
		t.Errorf("18 decimals flagged: %v", f)
	}
	if f := DetectBrokenDecimals("t", -1); len(f) != 1 || f[0].Severity != Invalid {
		t.Errorf("negative decimals not invalid: %v", f)
	}
	if f := DetectBrokenDecimals("t", 255); len(f) != 1 {
		t.Errorf("255 decimals not flagged: %v", f)
	}
}

func TestDetectWrongTokenMapping(t *testing.T) {
	if f := DetectWrongTokenMapping("p", "token:a", "token:b"); len(f) != 0 {
		t.Errorf("distinct tokens flagged: %v", f)
	}
	if f := DetectWrongTokenMapping("p", "token:a", "token:a"); len(f) != 1 || f[0].Severity != Invalid {
		t.Errorf("same tokens not invalid: %v", f)
	}
}

func TestDetectChainMismatch(t *testing.T) {
	if f := DetectChainMismatch("p", "chain:eth", "chain:eth"); len(f) != 0 {
		t.Errorf("matching chains flagged: %v", f)
	}
	if f := DetectChainMismatch("p", "chain:base", "chain:eth"); len(f) != 1 {
		t.Errorf("mismatch not flagged: %v", f)
	}
}

func TestDetectNegativeAndImpossible(t *testing.T) {
	neg, _ := canonDecPtr(t, "-5")
	if f := DetectImpossibleLiquidity("p", neg); len(f) != 1 {
		t.Errorf("negative liquidity not flagged: %v", f)
	}
	ok, _ := canonDecPtr(t, "5")
	if f := DetectImpossibleLiquidity("p", ok); len(f) != 0 {
		t.Errorf("positive liquidity flagged: %v", f)
	}
	if f := DetectNegativeMetrics("s", "volume", neg); len(f) != 1 {
		t.Errorf("negative metric not flagged: %v", f)
	}
}

func TestCheckerReport(t *testing.T) {
	c := NewChecker(10*time.Second, func() time.Time { return baseTime })
	r := c.Report("pool:x", "swaps", []Finding{{Code: "stale_data", Severity: Warn}})
	if r.State != QualityDegraded {
		t.Fatalf("state = %q, want degraded", r.State)
	}
	if r.SubjectKey != "pool:x" || r.Dataset != "swaps" {
		t.Fatalf("report identity wrong: %+v", r)
	}
	clean := c.Report("pool:y", "swaps", nil)
	if clean.State != QualityHealthy {
		t.Fatalf("clean state = %q", clean.State)
	}
}
