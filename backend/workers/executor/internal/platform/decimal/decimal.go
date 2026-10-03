// Package decimal is exact decimal string arithmetic for money and quantity
// (objective §36: never float64 in financial paths). Every function is pure and
// refuses malformed input rather than clamping it.
package decimal

import (
	"errors"
	"math/big"
	"strings"
)

var (
	// ErrInvalid is returned for empty, non-numeric or non-finite input.
	ErrInvalid = errors.New("decimal: invalid number")
	// ErrNegative is returned where the domain requires a non-negative value.
	ErrNegative = errors.New("decimal: negative value not allowed")
)

// Parse validates and normalizes a decimal string ("1.2300" -> "1.23"). The
// normalized form is what equality checks compare.
//
// Syntax is strict decimal: optional sign, digits with at most one '.', optional
// exponent. big.Rat.SetString alone accepts fractions ("a/b"), hex ("0x10") and
// "Inf" — those are garbage for money columns and are refused here.
func Parse(s string) (*big.Rat, error) {
	s = strings.TrimSpace(s)
	if !validDecimalSyntax(s) {
		return nil, ErrInvalid
	}
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		return nil, ErrInvalid
	}
	return r, nil
}

// validDecimalSyntax reports whether s is [-]digits[.digits][e[-]digits] with
// at least one digit in the mantissa and, when present, in the exponent.
func validDecimalSyntax(s string) bool {
	i := 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	digits := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
		digits++
	}
	if i < len(s) && s[i] == '.' {
		i++
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			digits++
		}
	}
	if digits == 0 {
		return false
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		exp := 0
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			exp++
		}
		if exp == 0 {
			return false
		}
	}
	return i == len(s)
}

// MustParse is Parse for constants inside tests and package-level tables; it
// panics on programmer error (never on user input).
func MustParse(s string) *big.Rat {
	r, err := Parse(s)
	if err != nil {
		panic(err)
	}
	return r
}

// FloorToScale returns r truncated toward zero at the given decimal scale
// (round DOWN — the quantity rule: a rounded position never exceeds the budget).
func FloorToScale(r *big.Rat, scale int) *big.Rat {
	if scale < 0 {
		scale = 0
	}
	pow := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil)
	scaled := new(big.Rat).Mul(r, new(big.Rat).SetInt(pow))
	num := new(big.Int).Quo(scaled.Num(), scaled.Denom()) // trunc toward zero
	return new(big.Rat).SetFrac(num, pow)
}

// FloorToStep floors q DOWN to the instrument's step grid ("0.012583" @
// "0.001" -> "0.012"). ok=false when the grid is unusable (step <= 0) or the
// value is unusable — the caller refuses rather than guessing.
func FloorToStep(q, step string) (string, bool, error) {
	qr, err := Parse(q)
	if err != nil {
		return "", false, err
	}
	sr, err := Parse(step)
	if err != nil {
		return "", false, err
	}
	if sr.Sign() <= 0 {
		return "", false, nil
	}
	if qr.Sign() < 0 {
		return "", false, ErrNegative
	}
	steps := new(big.Rat).Quo(qr, sr)
	floored := FloorToScale(steps, 0)
	return Trim(new(big.Rat).Mul(floored, sr)), true, nil
}

// RoundToTick snaps a price to the tick size, ties half-up (mirror of the TS
// roundPrice).
func RoundToTick(p, tick string) (string, error) {
	pr, err := Parse(p)
	if err != nil {
		return "", err
	}
	tr, err := Parse(tick)
	if err != nil {
		return "", err
	}
	if tr.Sign() <= 0 {
		return "", errors.New("decimal: tick must be > 0")
	}
	steps := new(big.Rat).Quo(pr, tr)
	half := new(big.Rat).SetFrac64(1, 2)
	whole := FloorToScale(new(big.Rat).Add(steps, half), 0) // ties half-up
	return Trim(new(big.Rat).Mul(whole, tr)), nil
}

// Add sums decimal strings exactly ("0.1"+"0.2" -> "0.3").
func Add(a, b string) (string, error) {
	ar, err := Parse(a)
	if err != nil {
		return "", err
	}
	br, err := Parse(b)
	if err != nil {
		return "", err
	}
	return Trim(new(big.Rat).Add(ar, br)), nil
}

// Sub subtracts exactly (a - b).
func Sub(a, b string) (string, error) {
	ar, err := Parse(a)
	if err != nil {
		return "", err
	}
	br, err := Parse(b)
	if err != nil {
		return "", err
	}
	return Trim(new(big.Rat).Sub(ar, br)), nil
}

// Mul multiplies exactly.
func Mul(a, b string) (string, error) {
	ar, err := Parse(a)
	if err != nil {
		return "", err
	}
	br, err := Parse(b)
	if err != nil {
		return "", err
	}
	return Trim(new(big.Rat).Mul(ar, br)), nil
}

// Quo divides exactly where possible; the result is a rational rendered by Trim.
// Division by zero is ErrInvalid, never a panic.
func Quo(a, b string) (string, error) {
	ar, err := Parse(a)
	if err != nil {
		return "", err
	}
	br, err := Parse(b)
	if err != nil {
		return "", err
	}
	if br.Sign() == 0 {
		return "", ErrInvalid
	}
	return Trim(new(big.Rat).Quo(ar, br)), nil
}

// Cmp compares two decimal strings: -1, 0, +1.
func Cmp(a, b string) (int, error) {
	ar, err := Parse(a)
	if err != nil {
		return 0, err
	}
	br, err := Parse(b)
	if err != nil {
		return 0, err
	}
	return ar.Cmp(br), nil
}

// Trim renders a rational in plain decimal notation without exponent or
// trailing zeros ("1.2300" -> "1.23", "4" -> "4").
func Trim(r *big.Rat) string {
	if r.IsInt() {
		return r.Num().String()
	}
	s := new(big.Float).SetPrec(256).SetRat(r).Text('f', 24)
	s = strings.TrimRight(s, "0")
	s = strings.TrimRight(s, ".")
	return s
}
