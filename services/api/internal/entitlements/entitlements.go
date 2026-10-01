// Package entitlements models WHAT a plan may do: feature toggles and numeric
// ceilings. Invariant throughout: entitlements are ceilings, never grants to
// be inferred — an off feature is denied and a zero limit means zero allowed;
// "unlimited" is math.MaxInt, an explicit sentinel, never an omission.
package entitlements

import (
	"fmt"
	"math"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

// Refusal codes carried by this package's errors.
const (
	// CodeEntitlementDenied names a disabled feature.
	CodeEntitlementDenied = "ENTITLEMENT_DENIED"
	// CodeLimitExceeded names a numeric ceiling already reached.
	CodeLimitExceeded = "LIMIT_EXCEEDED"
	// CodeLimitInvalid names an ill-formed limit or usage figure (refusing
	// invalid input instead of clamping it into a plausible number).
	CodeLimitInvalid = "LIMIT_INVALID"
)

// Feature is one gated capability.
type Feature string

// The gated capabilities mirror the Entitlements boolean fields.
const (
	FeatureExecutor     Feature = "executor"
	FeatureTWAP         Feature = "twap"
	FeatureVWAP         Feature = "vwap"
	FeatureIceberg      Feature = "iceberg"
	FeatureAdvancedRisk Feature = "advanced_risk"
	FeatureAPI          Feature = "api"
)

// Entitlements is one plan's grants. Invariant: every Max* field is a ceiling
// on concurrent or monthly usage — 0 means zero allowed and math.MaxInt means
// unlimited; nothing is unlimited by omission.
type Entitlements struct {
	// CanUseExecutor enables manual execution.
	CanUseExecutor bool
	// CanUseTWAP enables TWAP strategies.
	CanUseTWAP bool
	// CanUseVWAP enables VWAP strategies.
	CanUseVWAP bool
	// CanUseIceberg enables iceberg strategies.
	CanUseIceberg bool
	// CanUseAdvancedRisk enables advanced risk controls.
	CanUseAdvancedRisk bool
	// CanUseAPI enables programmatic (API token) access.
	CanUseAPI bool
	// MaxExchangeAccounts is the ceiling on connected exchange accounts.
	MaxExchangeAccounts int
	// MaxConcurrentExecutions is the ceiling on in-flight executions.
	MaxConcurrentExecutions int
	// MaxMonthlyOrders is the ceiling on orders placed per calendar month.
	MaxMonthlyOrders int
}

// Evaluate reports whether the feature is enabled. Invariant: any feature not
// recognized by the entitlements is denied (fail-closed), returning
// ENTITLEMENT_DENIED rather than guessing a default.
func Evaluate(ent Entitlements, feature Feature) error {
	switch feature {
	case FeatureExecutor:
		if ent.CanUseExecutor {
			return nil
		}
	case FeatureTWAP:
		if ent.CanUseTWAP {
			return nil
		}
	case FeatureVWAP:
		if ent.CanUseVWAP {
			return nil
		}
	case FeatureIceberg:
		if ent.CanUseIceberg {
			return nil
		}
	case FeatureAdvancedRisk:
		if ent.CanUseAdvancedRisk {
			return nil
		}
	case FeatureAPI:
		if ent.CanUseAPI {
			return nil
		}
	}
	return errs.New(errs.CategoryAuthorization, CodeEntitlementDenied,
		fmt.Sprintf("feature %q is not enabled for this plan", feature))
}

// CheckLimit gates ONE more unit of usage against a numeric ceiling.
// Invariants:
//   - limit is a ceiling: the request is refused when used >= limit, because
//     at `used` the ceiling has no room for one more; used == limit-1 is the
//     last allowed figure and used == limit the first refusal;
//   - limit 0 means zero allowed (always refused), math.MaxInt means unlimited
//     (never refused);
//   - negative limit or used figures are refused as LIMIT_INVALID — the limit
//     is never clamped and usage is never treated as zero.
//
// feature names the limit in the refusal message ("monthly orders", ...), and
// LIMIT_EXCEEDED refusals always name BOTH the ceiling and the usage.
func CheckLimit(feature string, limit, used int) error {
	if limit < 0 || used < 0 {
		return errs.New(errs.CategoryValidation, CodeLimitInvalid,
			fmt.Sprintf("%s: limit and used must be non-negative, got limit=%d used=%d", feature, limit, used))
	}
	if limit == math.MaxInt {
		return nil // unlimited sentinel: even used == MaxInt never refuses.
	}
	if used >= limit {
		return errs.New(errs.CategoryAuthorization, CodeLimitExceeded,
			fmt.Sprintf("%s: limit %d exceeded: %d used", feature, limit, used))
	}
	return nil
}
