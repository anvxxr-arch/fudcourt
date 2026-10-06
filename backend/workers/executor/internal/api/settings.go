package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/planner"
)

// profileKeys is PROFILE_KEYS in runtime.ts: the eight profile fields and their
// value kind, in contract order. A key not listed here is ignored (the TS loop
// only reads these).
var profileKeys = []struct {
	name string
	kind string // "number" | "string"
}{
	{"defaultRiskMode", "string"},
	{"defaultRisk", "number"},
	{"maxRiskPerTradePct", "number"},
	{"maxOpenRiskPct", "number"},
	{"maxDailyLossPct", "number"},
	{"maxLeverage", "number"},
	{"defaultMarginMode", "string"},
	{"defaultExecutionUrgency", "string"},
}

// handleSettings ports /api/executor/settings (settings/route.ts): GET the
// user's risk profile, PUT a partial update.
func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.getSettings(w, r, userID)
	case http.MethodPut:
		s.putSettings(w, r, userID)
	default:
		methodGuard(w, r, http.MethodGet, http.MethodPut)
	}
}

// getSettings is `{ profile }`. A user with no stored row gets the defaults
// filled in server-side (DEFAULT_RISK_PROFILE), never an empty object.
func (s *Server) getSettings(w http.ResponseWriter, r *http.Request, userID string) {
	profile, err := s.store.GetRiskProfile(r.Context(), userID)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if profile.DefaultRiskMode == "" {
		profile = planner.DefaultRiskProfile
	}
	WriteJSON(w, http.StatusOK, SettingsResponse{Profile: toWireProfile(profile)})
}

// putSettings validates a partial update, merges it over the defaults (exactly
// as runtime.ts does: a fresh merge starts from DEFAULT_RISK_PROFILE, not from
// the stored row), stores it and answers `{ profile }`. Values are validated,
// never clamped: any bad value is a 400 with field-named errors and nothing is
// written.
func (s *Server) putSettings(w http.ResponseWriter, r *http.Request, userID string) {
	o, err := decodeSettingsPatch(readBody(r))
	if err != nil {
		invalidJSON(w)
		return
	}
	merged := map[string]string{
		"defaultRiskMode":         planner.DefaultRiskProfile.DefaultRiskMode,
		"defaultRisk":             planner.DefaultRiskProfile.DefaultRisk,
		"maxRiskPerTradePct":      planner.DefaultRiskProfile.MaxRiskPerTradePct,
		"maxOpenRiskPct":          planner.DefaultRiskProfile.MaxOpenRiskPct,
		"maxDailyLossPct":         planner.DefaultRiskProfile.MaxDailyLossPct,
		"maxLeverage":             planner.DefaultRiskProfile.MaxLeverage,
		"defaultMarginMode":       string(planner.DefaultRiskProfile.DefaultMarginMode),
		"defaultExecutionUrgency": string(planner.DefaultRiskProfile.DefaultExecutionUrgency),
	}
	var errs []string
	for _, key := range profileKeys {
		raw, present := o[key.name]
		if !present || isNullish(raw) {
			continue
		}
		if key.kind == "number" {
			v, err := decodeNum(raw)
			if err != nil || !isPositiveNumber(v) {
				errs = append(errs, key.name+": must be a positive number")
				continue
			}
			merged[key.name] = v
			continue
		}
		if !strings.HasPrefix(strings.TrimSpace(string(raw)), "\"") {
			errs = append(errs, key.name+": must be a string")
			continue
		}
		merged[key.name] = rawString(raw)
	}
	if mode := merged["defaultRiskMode"]; mode != "risk_usd" && mode != "risk_percent" {
		errs = append(errs, "defaultRiskMode: must be risk_usd or risk_percent")
	}
	if mode := merged["defaultMarginMode"]; mode != "isolated" && mode != "cross" {
		errs = append(errs, "defaultMarginMode: must be isolated or cross")
	}
	switch merged["defaultExecutionUrgency"] {
	case "passive", "balanced", "aggressive", "immediate":
	default:
		errs = append(errs, "defaultExecutionUrgency: must be passive, balanced, aggressive or immediate")
	}
	if len(errs) > 0 {
		validationError(w, errs)
		return
	}
	profile := profileFromWire(RiskProfile{
		DefaultRiskMode:         merged["defaultRiskMode"],
		DefaultRisk:             merged["defaultRisk"],
		MaxRiskPerTradePct:      merged["maxRiskPerTradePct"],
		MaxOpenRiskPct:          merged["maxOpenRiskPct"],
		MaxDailyLossPct:         merged["maxDailyLossPct"],
		MaxLeverage:             merged["maxLeverage"],
		DefaultMarginMode:       merged["defaultMarginMode"],
		DefaultExecutionUrgency: merged["defaultExecutionUrgency"],
	})
	stored, err := s.store.PutRiskProfile(r.Context(), userID, profile, s.now())
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	WriteJSON(w, http.StatusOK, SettingsResponse{Profile: toWireProfile(stored)})
}

// isPositiveNumber reports whether a decimal string parses and is > 0.
func isPositiveNumber(s string) bool {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return false
	}
	return f > 0
}
