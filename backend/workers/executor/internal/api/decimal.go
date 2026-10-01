package api

// Small exact-decimal and string helpers shared by the handler files. Every
// money/quantity computation goes through internal/platform/decimal (never
// float64); the helpers here are thin wrappers that default to a safe value when
// an operand is malformed, because the values they touch were already validated
// by the planner.

import (
	"math/big"
	"strconv"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/decimal"
)

// addDec adds two decimal strings; a malformed operand yields the other
// (the caller passed planner-validated figures).
func addDec(a, b string) string {
	out, err := decimal.Add(a, b)
	if err != nil {
		return "0"
	}
	return out
}

// cmpDec compares two decimal strings: -1, 0, +1. A malformed operand compares
// as equal (0) so a gate never fires on garbage.
func cmpDec(a, b string) int {
	c, err := decimal.Cmp(a, b)
	if err != nil {
		return 0
	}
	return c
}

// absDec renders the absolute value of a decimal string.
func absDec(s string) string {
	r, err := decimal.Parse(s)
	if err != nil {
		return "0"
	}
	return decimal.Trim(new(big.Rat).Abs(r))
}

// sign returns -1, 0 or +1 for a decimal string; a malformed value is 0.
func sign(s string) int {
	r, err := decimal.Parse(s)
	if err != nil {
		return 0
	}
	return r.Sign()
}

// isPositiveDec reports whether s parses as a decimal strictly greater than 0.
func isPositiveDec(s string) bool {
	if s == "" {
		return false
	}
	r, err := decimal.Parse(s)
	if err != nil {
		return false
	}
	return r.Sign() > 0
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func itoa(v int) string     { return strconv.Itoa(v) }
func itoa64(v int64) string { return strconv.FormatInt(v, 10) }
