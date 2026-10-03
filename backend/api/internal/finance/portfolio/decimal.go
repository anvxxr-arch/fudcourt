package portfolio

import (
	"math/big"
	"regexp"
	"strings"
)

// rational is the exact-arithmetic representation behind every money figure in
// this package. math/big rationals keep sums, differences and products of
// decimal strings exact; float64 never touches a value. The helpers are
// package-private on purpose: packages must not couple through a shared money
// type (no cross-imports between domain packages).
type rational = big.Rat

// decimalShape accepts exactly plain signed decimal notation ("3", "-0.5",
// "10.25"). Exponents, fractions, hex, whitespace and bare signs are refused:
// money input is validated, never coerced.
var decimalShape = regexp.MustCompile(`^-?\d+(\.\d+)?$`)

// parseDecimal parses s iff it is plain decimal notation. ok is false for
// anything else — the caller refuses, it never guesses.
func parseDecimal(s string) (*rational, bool) {
	if !decimalShape.MatchString(s) {
		return nil, false
	}
	r, ok := new(rational).SetString(s)
	if !ok {
		return nil, false
	}
	return r, true
}

// addDecimals returns the exact sum of a and b.
func addDecimals(a, b *rational) *rational {
	return new(rational).Add(a, b)
}

// subDecimals returns the exact difference a−b.
func subDecimals(a, b *rational) *rational {
	return new(rational).Sub(a, b)
}

// mulDecimals returns the exact product of a and b.
func mulDecimals(a, b *rational) *rational {
	return new(rational).Mul(a, b)
}

// quoDecimals returns the exact quotient a/b.
func quoDecimals(a, b *rational) *rational {
	return new(rational).Quo(a, b)
}

// renderDecimal renders r as the canonical decimal string: exact, with
// trailing zeros trimmed ("3.3", never "3.3000000000000003") and zero spelled
// "0" (never "-0"). ok is false when r has no finite decimal expansion, which
// cannot happen for sums and products of decimal strings (a quotient of
// decimals may not terminate — callers refuse rather than round).
func renderDecimal(r *rational) (string, bool) {
	if r.Sign() == 0 {
		return "0", true
	}
	scale, ok := terminatingScale(r.Denom())
	if !ok {
		return "", false
	}
	s := r.FloatString(scale)
	if dot := strings.IndexByte(s, '.'); dot >= 0 {
		s = strings.TrimRight(s, "0")
		s = strings.TrimRight(s, ".")
	}
	return s, true
}

// terminatingScale returns the number of fractional digits any rational with
// this denominator needs for an exact decimal expansion. Such an expansion
// exists iff the reduced denominator factors as 2^a·5^b, and then the scale is
// max(a, b).
func terminatingScale(den *big.Int) (int, bool) {
	rem := new(big.Int).Set(den)
	mod := new(big.Int)
	a, b := 0, 0
	two, five := big.NewInt(2), big.NewInt(5)
	for {
		q, m := new(big.Int).QuoRem(rem, two, mod)
		if m.Sign() != 0 {
			break
		}
		rem, a = q, a+1
	}
	for {
		q, m := new(big.Int).QuoRem(rem, five, mod)
		if m.Sign() != 0 {
			break
		}
		rem, b = q, b+1
	}
	if rem.Cmp(big.NewInt(1)) != 0 {
		return 0, false
	}
	if a > b {
		return a, true
	}
	return b, true
}

// sortedKeys returns the set's members in ascending order so derived views
// render deterministically.
func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	// insertion-sort by string: sets here hold a handful of assets
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
