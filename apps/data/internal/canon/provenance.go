package canon

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"
)

// This file is the provenance + numeric substrate for the DEX Data Platform
// canonical types (dex_types.go). It lives in package canon rather than a
// parallel package on purpose: the id space (ids.go) is platform-wide and
// shared bit-for-bit with apps/api/internal/markets/reference, so a second
// package minting DEX ids would fork identity.
//
// PLAN §6 (provenance) and §54 (precision) are implemented here:
//   - every DEX row carries a Provenance answering "where did this number come
//     from": provider, source type/id/endpoint, chain, block number/hash,
//     tx hash, observed_at, normalized_at, confidence;
//   - token amounts are EXACT: RawAmount is an integer count of the token's
//     smallest unit and Decimals says how to scale it. No float64 ever touches
//     a balance. Prices/liquidity/USD are carried as exact decimal STRINGS
//     (Dec) parsed from json.Number, never from a binary float.

// SourceTier is the plan §3 source-quality tier.
type SourceTier string

// The source tiers, highest first. S0 blockchain is ground truth; S5 is
// Fudcourt's own derived output.
const (
	TierBlockchain SourceTier = "S0"
	TierDexNative  SourceTier = "S1"
	TierIndexer    SourceTier = "S2"
	TierAggregator SourceTier = "S3"
	TierAnalytics  SourceTier = "S4"
	TierDerived    SourceTier = "S5"
)

// Valid reports whether t is one of the tiers above.
func (t SourceTier) Valid() bool {
	switch t {
	case TierBlockchain, TierDexNative, TierIndexer, TierAggregator, TierAnalytics, TierDerived:
		return true
	}
	return false
}

// Provenance answers the plan §6 question: "where did this number come from?".
// Every DEX fact row carries one. It is the audit trail that lets a consumer -
// or an operator debugging a wrong number - walk a canonical value back to the
// exact upstream endpoint, block and provider record that produced it.
//
// The optional fields are pointers/spelled-empty where a provider genuinely has
// no answer (a REST aggregator has no block number; a derived metric has no
// upstream endpoint). Never-fake: an absent coordinate is empty/nil, never a
// fabricated zero or a borrowed value.
type Provenance struct {
	// SourceProvider is the data.job provider column value ("dexscreener",
	// "bitquery"). Never a display name.
	SourceProvider string `json:"source_provider"`
	// SourceType classifies the upstream: "dex_native", "indexer",
	// "aggregator", "analytics", "rpc", "derived".
	SourceType string `json:"source_type"`
	// SourceID is the provider's own id for the record, when it has one.
	SourceID string `json:"source_id,omitempty"`
	// SourceEndpoint is the exact URL or RPC method the value came from.
	SourceEndpoint string `json:"source_endpoint,omitempty"`
	// Tier is the plan §3 source-quality tier.
	Tier SourceTier `json:"tier"`
	// ChainID is the canonical chain id the observation is about ("" for a
	// chain-aggregated metric).
	ChainID string `json:"chain_id,omitempty"`
	// BlockNumber is the block the observation was taken at; nil when the
	// provider does not report one.
	BlockNumber *int64 `json:"block_number,omitempty"`
	// BlockHash is the block hash, when known.
	BlockHash string `json:"block_hash,omitempty"`
	// TxHash is the transaction the observation came from, when it is one
	// event among many.
	TxHash string `json:"tx_hash,omitempty"`
	// ObservedAt is when the PROVIDER says the fact was true (block time for
	// on-chain data, the provider's own timestamp otherwise).
	ObservedAt time.Time `json:"observed_at"`
	// NormalizedAt is when Fudcourt mapped the provider payload into this
	// canonical struct.
	NormalizedAt time.Time `json:"normalized_at"`
	// Confidence is the plan §25 0-100 score. A directly-observed value from a
	// single provider is scored by the provider's tier; a reconciled value
	// carries the agreement-derived score.
	Confidence Confidence `json:"confidence"`
}

// Confidence is a plan §25 0-100 score. The zero value is "unknown" (0), which
// is honest: an unscored row is not a perfectly-confident one.
type Confidence int

// ClampConfidence bounds a score to [0, 100]. A score outside the range is a
// computation bug, so it is clamped rather than allowed to escape.
func ClampConfidence(v int) Confidence {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return Confidence(v)
}

// DerivedProvenance is the plan §6 extra block on a computed value: which
// algorithm produced it, at which version, from which inputs, when.
type DerivedProvenance struct {
	CalculationVersion string    `json:"calculation_version"`
	AlgorithmVersion   string    `json:"algorithm_version"`
	InputSources       []string  `json:"input_sources"`
	CalculatedAt       time.Time `json:"calculated_at"`
}

// --- exact numerics (plan §54) ----------------------------------------------
//
// DEX values arrive as decimal strings ("4001.20") or JSON numbers. Parsing
// either into float64 first destroys digits the provider published - and for a
// token balance it is outright forbidden (plan §65). Dec preserves the exact
// base-10 value as a *big.Rat, which represents every finite decimal exactly
// (a decimal is a rational with a power-of-ten denominator).

// Dec is an exact base-10 decimal. The zero value is "absent": use NilDec for
// an explicitly-absent reading and DecFromString/DecFromJSONNumber to build a
// present one. Dec is comparable for presence (IsZero) and exact for
// arithmetic, but it is NOT safe to copy a Dec after use (it wraps a *big.Rat);
// pass it by pointer in structs.
type Dec struct {
	rat *big.Rat
}

// NilDec is the absent Dec: rat == nil. A nil Dec means "the provider did not
// report this", which is different from a reported 0.
var NilDec = Dec{}

// DecFromString parses an exact decimal from its base-10 spelling. Accepts an
// optional sign, digits, a single '.', and exponent (e/E) notation, matching
// what JSON numbers and upstream decimal strings use. It does NOT accept
// Inf/NaN: those are not decimals and are rejected as errors.
func DecFromString(s string) (Dec, error) {
	t := strings.TrimSpace(s)
	if t == "" {
		return NilDec, fmt.Errorf("canon: empty decimal")
	}
	switch strings.ToLower(t) {
	case "inf", "+inf", "-inf", "infinity", "+infinity", "-infinity", "nan", "-nan", "null":
		return NilDec, fmt.Errorf("canon: %q is not a decimal", s)
	}
	// big.Rat.SetString accepts "a/b" and "a.b" and exponent forms like
	// "1.2e3" only via Float. Parse the common spellings explicitly so a
	// ratio-shaped string ("1/2") cannot slip in as if it were a decimal.
	if strings.ContainsAny(t, "/") {
		return NilDec, fmt.Errorf("canon: %q is not a decimal", s)
	}
	r, ok := new(big.Rat).SetString(t)
	if !ok {
		// SetString handles "1.5" but not "1.5e3"; try the exponent branch.
		f, _, err := big.ParseFloat(t, 10, 256, big.ToNearestEven)
		if err != nil {
			return NilDec, fmt.Errorf("canon: %q is not a decimal", s)
		}
		r, _ = f.Rat(nil)
	}
	return Dec{rat: r}, nil
}

// DecFromJSONNumber parses a json.Number WITHOUT going through float64. This is
// the only correct way to read a price off a UseNumber() decode; parsing a
// json.Number via .Float64() first would defeat the point.
func DecFromJSONNumber(n jsonNumber) (Dec, error) {
	return DecFromString(string(n))
}

// jsonNumber is the structural type of encoding/json's json.Number, declared
// locally so this package need not import encoding/json for one alias.
type jsonNumber string

// DecFromInt builds an exact Dec from an integer.
func DecFromInt(v int64) Dec {
	return Dec{rat: new(big.Rat).SetInt64(v)}
}

// Present reports whether the Dec carries a value.
func (d Dec) Present() bool { return d.rat != nil }

// DecFromRat builds a Dec from an exact rational. A nil rational yields NilDec
// (absent), never a zero. The rational is copied, so the caller may keep and
// mutate its own.
//
// A rational that is NOT a finite decimal (a denominator with a prime factor
// other than 2 or 5, e.g. 1/3) yields NilDec: such a value has no exact decimal
// spelling, and String()'s bounded fallback render would present float64 noise
// as the value — a precision lie this type exists to prevent. Callers that
// divide must therefore round to a finite scale first (see the derive package's
// exact helpers), which makes the result exact rather than lossy.
func DecFromRat(r *big.Rat) Dec {
	if r == nil {
		return NilDec
	}
	if !finiteDecimal(r.Denom()) {
		return NilDec
	}
	return Dec{rat: new(big.Rat).Set(r)}
}

// finiteDecimal reports whether den factors into 2s and 5s only, i.e. whether
// the rational has an exact finite decimal expansion.
func finiteDecimal(den *big.Int) bool {
	d := new(big.Int).Set(den)
	for _, p := range []int64{2, 5} {
		bp := big.NewInt(p)
		for {
			q, m := new(big.Int).QuoRem(d, bp, new(big.Int))
			if m.Sign() != 0 {
				break
			}
			d = q
		}
	}
	return d.Cmp(big.NewInt(1)) == 0
}

// Rat returns the underlying rational, or nil when absent. Callers must not
// mutate the returned value.
func (d Dec) Rat() *big.Rat { return d.rat }

// String renders the exact decimal. An absent Dec renders as "" (never "0").
// Present values render in plain decimal notation with no exponent, so a
// consumer (and the database) sees the same digits the provider published.
func (d Dec) String() string {
	if d.rat == nil {
		return ""
	}
	if d.rat.IsInt() {
		return d.rat.Num().String()
	}
	// Render as a finite decimal: multiply out the denominator, which is
	// 2^a*5^b for any decimal input, so the expansion always terminates.
	return ratToDecimalString(d.rat)
}

// ratToDecimalString renders a rational whose denominator is 2^a*5^b (every
// finite decimal) as an exact decimal string.
//
// For r = num/den with den = 2^a * 5^b, the exact decimal is N/10^scale where
// scale = max(a, b) and N = num * 2^(scale-a) * 5^(scale-b). Getting the scale
// wrong here is a silent off-by-10^n on every small decimal, so it is computed
// from the two exponents independently rather than by counting divisions.
func ratToDecimalString(r *big.Rat) string {
	num := new(big.Int).Set(r.Num())
	den := new(big.Int).Set(r.Denom())
	two, five := big.NewInt(2), big.NewInt(5)
	mod := new(big.Int)
	a, b := 0, 0
	for {
		mod.Mod(den, two)
		if mod.Sign() != 0 {
			break
		}
		den.Div(den, two)
		a++
	}
	for {
		mod.Mod(den, five)
		if mod.Sign() != 0 {
			break
		}
		den.Div(den, five)
		b++
	}
	if den.Cmp(big.NewInt(1)) != 0 {
		// Not a finite decimal (e.g. 1/3). Rather than a float64 approximation
		// that would present noise as the value — or a panic inside JSON
		// encoding — return the EXACT rational spelling ("1000000/99"), which is
		// true and unmistakably not a decimal. A consumer sees immediately that
		// the value is not decimal-expressed; DecFromRat refuses to build such a
		// Dec in the first place, so this is the defensive path.
		return r.RatString()
	}
	scale := a
	if b > scale {
		scale = b
	}
	// N = num * 2^(scale-a) * 5^(scale-b)
	if scale > a {
		num.Mul(num, new(big.Int).Exp(two, big.NewInt(int64(scale-a)), nil))
	}
	if scale > b {
		num.Mul(num, new(big.Int).Exp(five, big.NewInt(int64(scale-b)), nil))
	}
	if scale == 0 {
		return num.String()
	}
	s := num.String()
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	for len(s) <= scale {
		s = "0" + s
	}
	out := s[:len(s)-scale] + "." + s[len(s)-scale:]
	if neg {
		out = "-" + out
	}
	return out
}

// --- exact token amounts (plan §54) -----------------------------------------

// TokenAmount is an exact token quantity in the plan §54 triple: the integer
// raw amount in the token's smallest unit, the token's decimals, and the
// normalized (human) value derived from the two. Raw is authoritative;
// Normalized is a rendering, never a source.
type TokenAmount struct {
	// Raw is the integer amount in the smallest unit (wei for an 18-decimal
	// token, satoshi-style units otherwise). Never a float.
	Raw *big.Int `json:"raw"`
	// Decimals is the token's decimals (0..255). The scaling exponent.
	Decimals int `json:"decimals"`
}

// NewTokenAmount builds an exact amount from a raw integer and a decimals
// exponent. raw is copied; Decimals out of range is an error (a negative
// exponent cannot be scaled and a >255 exponent is never a real token).
func NewTokenAmount(raw *big.Int, decimals int) (TokenAmount, error) {
	if raw == nil {
		return TokenAmount{}, fmt.Errorf("canon: nil token amount")
	}
	if decimals < 0 || decimals > 255 {
		return TokenAmount{}, fmt.Errorf("canon: token decimals %d out of range", decimals)
	}
	return TokenAmount{Raw: new(big.Int).Set(raw), Decimals: decimals}, nil
}

// Normalized renders the human value as an exact Dec: Raw / 10^Decimals. The
// division is exact because 10^Decimals is a power of ten.
func (a TokenAmount) Normalized() Dec {
	if a.Raw == nil {
		return NilDec
	}
	r := new(big.Rat).SetInt(a.Raw)
	if a.Decimals > 0 {
		scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(a.Decimals)), nil)
		r.Quo(r, new(big.Rat).SetInt(scale))
	}
	return Dec{rat: r}
}

// RawString spells the raw integer amount (the storage form).
func (a TokenAmount) RawString() string {
	if a.Raw == nil {
		return ""
	}
	return a.Raw.String()
}

// --- JSON wire shapes (plan §54: exact decimals cross the wire as STRINGS) ---
//
// A canon.Dec marshals to its exact decimal STRING, or null when absent. It
// must never marshal as a JSON number: a consumer's json parser would turn
// "4001.20" into a binary64 and quietly lose the digits this type exists to
// preserve. Marshaling as a string makes that impossible.

// MarshalJSON renders the Dec as a JSON string (or null when absent).
func (d Dec) MarshalJSON() ([]byte, error) {
	if d.rat == nil {
		return []byte("null"), nil
	}
	return []byte(strconv.Quote(d.String())), nil
}

// UnmarshalJSON parses a Dec from a JSON string OR number, exactly. A JSON
// number arrives as its literal text, so no float64 is involved.
func (d *Dec) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" || s == `""` {
		d.rat = nil
		return nil
	}
	s = strings.Trim(s, `"`)
	parsed, err := DecFromString(s)
	if err != nil {
		return err
	}
	*d = parsed
	return nil
}

// tokenAmountJSON is the wire shape of a TokenAmount: the raw integer, the
// decimals exponent and the normalized decimal, ALL as strings/ints so a
// consumer never needs a float to read an amount.
type tokenAmountJSON struct {
	Raw        string `json:"raw"`
	Decimals   int    `json:"decimals"`
	Normalized string `json:"normalized"`
}

// MarshalJSON renders the exact amount triple.
func (a TokenAmount) MarshalJSON() ([]byte, error) {
	if a.Raw == nil {
		return []byte("null"), nil
	}
	return json.Marshal(tokenAmountJSON{
		Raw:        a.Raw.String(),
		Decimals:   a.Decimals,
		Normalized: a.Normalized().String(),
	})
}

// UnmarshalJSON parses the exact amount triple (Raw + Decimals are
// authoritative; Normalized is ignored on read, since it is derivable).
func (a *TokenAmount) UnmarshalJSON(b []byte) error {
	if strings.TrimSpace(string(b)) == "null" {
		return nil
	}
	var wire tokenAmountJSON
	if err := json.Unmarshal(b, &wire); err != nil {
		return err
	}
	if wire.Raw == "" {
		return nil
	}
	bi, ok := new(big.Int).SetString(wire.Raw, 10)
	if !ok {
		return fmt.Errorf("canon: bad raw amount %q", wire.Raw)
	}
	amt, err := NewTokenAmount(bi, wire.Decimals)
	if err != nil {
		return err
	}
	*a = amt
	return nil
}
