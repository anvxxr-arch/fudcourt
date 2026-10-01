package instruments

import (
	"errors"
	"math/big"
	"strings"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

// All rounding here is exact integer arithmetic on scaled decimals
// (value = mant · 10^-scale) via math/big — never float64, so 1e12-scale
// quantities keep every cent (PRD §71).

// decimal is an exact base-10 value mant·10^-scale with mant kept as an
// arbitrary-precision integer.
type decimal struct {
	mant  *big.Int
	scale int // number of fractional digits; 0 for integers
}

// errNotDecimal is the shared refusal cause for malformed decimal strings; it
// is wrapped into domain errors at the API boundary and never reaches a wire
// payload on its own.
var errNotDecimal = errors.New("not a plain decimal string")

// parseDecimal parses a plain decimal string (`12`, `12.340`, `.5`, `5.`,
// with an optional sign) into its exact scaled form. Exponent notation,
// hex, whitespace and anything else are refused: a grid must never be built
// from a value the parser had to guess at.
func parseDecimal(s string) (decimal, error) {
	if s == "" {
		return decimal{}, errNotDecimal
	}
	rest := s
	neg := false
	if s[0] == '+' || s[0] == '-' {
		neg = s[0] == '-'
		rest = s[1:]
	}
	digits := make([]byte, 0, len(rest))
	scale := -1 // -1: no decimal point seen yet
	for i := range len(rest) {
		c := rest[i]
		switch {
		case c >= '0' && c <= '9':
			digits = append(digits, c)
			if scale >= 0 {
				scale++
			}
		case c == '.':
			if scale >= 0 {
				return decimal{}, errNotDecimal
			}
			scale = 0
		default:
			return decimal{}, errNotDecimal
		}
	}
	if len(digits) == 0 {
		return decimal{}, errNotDecimal
	}
	if scale < 0 {
		scale = 0
	}
	mant, ok := new(big.Int).SetString(string(digits), 10) // base 10: no 0x guessing
	if !ok {
		return decimal{}, errNotDecimal
	}
	if neg {
		mant.Neg(mant)
	}
	return decimal{mant: mant, scale: scale}, nil
}

// formatDecimal renders a scaled decimal in plain notation with trailing
// fraction zeros trimmed ("0.012", "1", "123456789012.345"): the canonical
// string form of a money/quantity field.
func formatDecimal(d decimal) string {
	mant := new(big.Int).Set(d.mant)
	scale := d.scale
	if scale < 0 { // cannot occur from the arithmetic below; normalize anyway
		mant.Mul(mant, pow10(-scale))
		scale = 0
	}
	sign := ""
	if mant.Sign() < 0 {
		sign = "-"
		mant.Neg(mant)
	}
	digits := mant.String()
	if len(digits) <= scale {
		digits = strings.Repeat("0", scale-len(digits)+1) + digits
	}
	split := len(digits) - scale
	out := sign + digits[:split]
	if frac := strings.TrimRight(digits[split:], "0"); frac != "" {
		out += "." + frac
	}
	return out
}

// pow10 returns 10^n as an integer.
func pow10(n int) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil)
}

// ratioParts rewrites a/m (with a = A·10^-aScale, m = M·10^-mScale) as the
// exact integer fraction num/den.
func ratioParts(a *big.Int, aScale int, m *big.Int, mScale int) (num, den *big.Int) {
	switch {
	case mScale >= aScale:
		return new(big.Int).Mul(a, pow10(mScale-aScale)), new(big.Int).Set(m)
	default:
		return new(big.Int).Set(a), new(big.Int).Mul(m, pow10(aScale-mScale))
	}
}

// RoundQuantityDown floors a quantity onto the quantity-step grid — the
// risk-safe direction (exposure never rounds up; PRD §71, mirrored from
// roundQuantityDown in apps/web/src/platform/executor/risk.ts). Vectors:
// 0.012583 @ 0.001 → 0.012, an on-grid value is preserved (0.013 @ 0.001),
// and 1e12-scale values stay exact (123456789012.345 @ 0.001).
//
// INVARIANT: never guess. A negative or empty quantity, or an empty, negative
// or zero step, is refused with an errs.CategoryValidation error naming the
// offending field — the caller gets no number at all rather than a plausible
// one. (Note: this deliberately refuses what the TS engine clamps to 0; the Go
// domain rejects bad input outright.)
func RoundQuantityDown(quantity, step string) (string, error) {
	q, err := parseDecimal(quantity)
	if err != nil {
		return "", errs.Wrap(errs.CategoryValidation, CodeQuantityInvalid, "field quantity must be a plain decimal", err)
	}
	if q.mant.Sign() < 0 {
		return "", errs.New(errs.CategoryValidation, CodeQuantityInvalid, "field quantity must not be negative")
	}
	s, err := parseDecimal(step)
	if err != nil {
		return "", errs.Wrap(errs.CategoryValidation, CodeStepInvalid, "field quantity_step must be a plain decimal", err)
	}
	if s.mant.Sign() <= 0 {
		return "", errs.New(errs.CategoryValidation, CodeStepInvalid, "field quantity_step must be positive")
	}
	num, den := ratioParts(q.mant, q.scale, s.mant, s.scale)
	// num/den >= 0 here, so Euclidean division truncates downward.
	k := new(big.Int).Div(num, den)
	return formatDecimal(decimal{mant: new(big.Int).Mul(k, s.mant), scale: s.scale}), nil
}

// RoundPrice snaps a price onto the tick-size grid, ties rounding half-up
// (mirrored from roundPrice in apps/web/src/platform/executor/risk.ts).
// Vectors: 1.005 @ 0.01 → 1.01 (the exact tie rounds up), 1.004 @ 0.01 → 1,
// 100.0049 @ 0.01 → 100, 98000.126 @ 0.01 → 98000.13, and 1e12-scale values
// stay exact (123456789012.345 @ 0.001).
//
// INVARIANT: never guess. A negative or empty price, or an empty, negative or
// zero tick, is refused with an errs.CategoryValidation error naming the
// offending field — never silently signed, clamped or rounded.
func RoundPrice(price, tick string) (string, error) {
	p, err := parseDecimal(price)
	if err != nil {
		return "", errs.Wrap(errs.CategoryValidation, CodePriceInvalid, "field price must be a plain decimal", err)
	}
	if p.mant.Sign() < 0 {
		return "", errs.New(errs.CategoryValidation, CodePriceInvalid, "field price must not be negative")
	}
	t, err := parseDecimal(tick)
	if err != nil {
		return "", errs.Wrap(errs.CategoryValidation, CodeStepInvalid, "field tick_size must be a plain decimal", err)
	}
	if t.mant.Sign() <= 0 {
		return "", errs.New(errs.CategoryValidation, CodeStepInvalid, "field tick_size must be positive")
	}
	num, den := ratioParts(p.mant, p.scale, t.mant, t.scale)
	// Half-up on num/den: floor((2·num + den) / (2·den)); inputs are
	// non-negative so Euclidean division is plain truncation.
	twice := new(big.Int).Lsh(num, 1)
	k := new(big.Int).Div(twice.Add(twice, den), new(big.Int).Lsh(den, 1))
	return formatDecimal(decimal{mant: new(big.Int).Mul(k, t.mant), scale: t.scale}), nil
}
