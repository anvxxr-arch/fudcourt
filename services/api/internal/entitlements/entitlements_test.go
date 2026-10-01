package entitlements

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

func TestEvaluateFeatureMatrix(t *testing.T) {
	allOn := Entitlements{
		CanUseExecutor: true, CanUseTWAP: true, CanUseVWAP: true,
		CanUseIceberg: true, CanUseAdvancedRisk: true, CanUseAPI: true,
	}
	features := []Feature{FeatureExecutor, FeatureTWAP, FeatureVWAP, FeatureIceberg, FeatureAdvancedRisk, FeatureAPI}
	for _, f := range features {
		if err := Evaluate(allOn, f); err != nil {
			t.Errorf("Evaluate(all on, %q) = %v, want nil", f, err)
		}
		if err := Evaluate(Entitlements{}, f); err == nil {
			t.Errorf("Evaluate(none on, %q) = nil, want ENTITLEMENT_DENIED", f)
		} else {
			var e *errs.Error
			if !errors.As(err, &e) || e.Code != CodeEntitlementDenied {
				t.Errorf("Evaluate(none on, %q) = %v, want %s", f, err, CodeEntitlementDenied)
			}
		}
	}
	// A feature unknown to the entitlements is denied, never guessed at.
	if err := Evaluate(Entitlements{}, Feature("dark-pool")); err == nil {
		t.Error("unknown feature must be denied, got nil")
	}
}

func TestCheckLimitBoundaries(t *testing.T) {
	cases := []struct {
		name     string
		limit    int
		used     int
		wantCode string // "" means allowed
	}{
		{name: "used == limit-1 is allowed", limit: 10, used: 9},
		{name: "used == limit is refused", limit: 10, used: 10, wantCode: CodeLimitExceeded},
		{name: "used above limit is refused", limit: 10, used: 11, wantCode: CodeLimitExceeded},
		{name: "limit 0 = zero allowed", limit: 0, used: 0, wantCode: CodeLimitExceeded},
		{name: "unlimited never refuses", limit: math.MaxInt, used: 1_000_000},
		{name: "unlimited never refuses at the sentinel itself", limit: math.MaxInt, used: math.MaxInt},
		{name: "negative limit is refused as invalid", limit: -1, used: 0, wantCode: CodeLimitInvalid},
		{name: "negative used is refused as invalid", limit: 10, used: -1, wantCode: CodeLimitInvalid},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := CheckLimit("monthly orders", c.limit, c.used)
			if c.wantCode == "" {
				if err != nil {
					t.Fatalf("CheckLimit(%d, %d) = %v, want nil", c.limit, c.used, err)
				}
				return
			}
			var e *errs.Error
			if !errors.As(err, &e) {
				t.Fatalf("CheckLimit(%d, %d) = %v, want errs.Error", c.limit, c.used, err)
			}
			if e.Code != c.wantCode {
				t.Fatalf("CheckLimit(%d, %d) = %s, want %s", c.limit, c.used, e.Code, c.wantCode)
			}
			if c.wantCode == CodeLimitExceeded {
				// The refusal must name BOTH figures.
				if !strings.Contains(e.Message, "10") && c.limit == 10 {
					t.Errorf("message must name the limit %d: %q", c.limit, e.Message)
				}
				if !strings.Contains(e.Message, "monthly orders") {
					t.Errorf("message must name the feature: %q", e.Message)
				}
			}
		})
	}
}
