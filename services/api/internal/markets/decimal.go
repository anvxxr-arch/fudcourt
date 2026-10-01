package markets

import (
	"fmt"
	"math/big"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

// parseDecimal reports whether s is a plain decimal string (`12`, `12.340`,
// `.5`, `5.` with an optional sign) and, if so, its sign and whether it is
// exactly zero. Exponent notation, hex and anything else are refused: a price
// must never be validated from a value the parser guessed at.
func parseDecimal(s string) (negative, zero, ok bool) {
	if s == "" {
		return false, false, false
	}
	rest := s
	negative = false
	switch s[0] {
	case '+', '-':
		negative = s[0] == '-'
		rest = s[1:]
	}
	zero = true
	seenDigit := false
	seenDot := false
	for i := range len(rest) {
		switch c := rest[i]; {
		case c >= '0' && c <= '9':
			seenDigit = true
			if c != '0' {
				zero = false
			}
		case c == '.':
			if seenDot {
				return false, false, false
			}
			seenDot = true
		default:
			return false, false, false
		}
	}
	return negative, zero, seenDigit
}

// requireDecimal validates one decimal field of a market value. allowZero
// distinguishes levels that must be positive (a price in use) from values that
// may legitimately be zero (a flat quantity). INVARIANT: a negative value is
// always refused with the type's code and the field named — never abs()-ed,
// clamped or otherwise repaired.
func requireDecimal(code, field, value string, allowZero bool) error {
	negative, zero, ok := parseDecimal(value)
	if !ok {
		return errs.New(errs.CategoryValidation, code, fmt.Sprintf("field %s must be a plain decimal", field))
	}
	if negative {
		return errs.New(errs.CategoryValidation, code, fmt.Sprintf("field %s must not be negative", field))
	}
	if zero && !allowZero {
		return errs.New(errs.CategoryValidation, code, fmt.Sprintf("field %s must be positive", field))
	}
	return nil
}

// lessThan compares two non-negative plain decimals exactly (as big rationals,
// so 1e12-scale values compare right). Callers pass values parseDecimal has
// already accepted.
func lessThan(a, b string) bool {
	ra, ok := new(big.Rat).SetString(a)
	if !ok {
		return false // unreachable for validated fields; refuse to guess
	}
	rb, ok := new(big.Rat).SetString(b)
	if !ok {
		return false
	}
	return ra.Cmp(rb) < 0
}
