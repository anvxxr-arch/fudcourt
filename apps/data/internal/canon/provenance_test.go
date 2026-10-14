package canon

import (
	"math/big"
	"testing"
	"time"
)

func TestDecFromStringExact(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"4001.20", "4001.2"},
		{"4001", "4001"},
		{"0.000000000000000001", "0.000000000000000001"},
		{"-0.5", "-0.5"},
		{"1.5e3", "1500"},
		{"+2.25", "2.25"},
		{"123456789012345678901234567890.5", "123456789012345678901234567890.5"},
	}
	for _, c := range cases {
		d, err := DecFromString(c.in)
		if err != nil {
			t.Fatalf("DecFromString(%q): %v", c.in, err)
		}
		if got := d.String(); got != c.want {
			t.Errorf("DecFromString(%q).String() = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestDecRejectsNonDecimals(t *testing.T) {
	for _, in := range []string{"", "  ", "abc", "NaN", "Inf", "-Inf", "1/2", "null", "--1", "1..2"} {
		if _, err := DecFromString(in); err == nil {
			t.Errorf("DecFromString(%q) accepted, want error", in)
		}
	}
}

func TestDecPrecisionNotLostThroughFloat(t *testing.T) {
	// Two values that are distinct as decimals but collapse to one float64.
	a, err := DecFromString("0.1000000000000000055511151231257827021181583404541015625")
	if err != nil {
		t.Fatal(err)
	}
	b, err := DecFromString("0.1")
	if err != nil {
		t.Fatal(err)
	}
	if a.String() == b.String() {
		t.Fatal("distinct decimals collapsed to one string")
	}
	if a.Rat().Cmp(b.Rat()) == 0 {
		t.Fatal("distinct decimals compared equal")
	}
}

func TestDecFromJSONNumber(t *testing.T) {
	d, err := DecFromJSONNumber(jsonNumber("4001.20"))
	if err != nil {
		t.Fatal(err)
	}
	if d.String() != "4001.2" {
		t.Fatalf("got %q", d.String())
	}
}

func TestNilDecIsAbsentNotZero(t *testing.T) {
	if NilDec.Present() {
		t.Fatal("NilDec present")
	}
	if NilDec.String() != "" {
		t.Fatalf("NilDec.String() = %q, want empty", NilDec.String())
	}
	zero, err := DecFromString("0")
	if err != nil {
		t.Fatal(err)
	}
	if !zero.Present() || zero.String() != "0" {
		t.Fatalf("zero dec = %q present=%v", zero.String(), zero.Present())
	}
	if zero.Present() == NilDec.Present() {
		t.Fatal("absent and zero are indistinguishable")
	}
}

func TestTokenAmountExact(t *testing.T) {
	// 1.5 USDC (6 decimals) = 1500000 raw.
	amt, err := NewTokenAmount(big.NewInt(1500000), 6)
	if err != nil {
		t.Fatal(err)
	}
	if amt.RawString() != "1500000" {
		t.Fatalf("raw = %q", amt.RawString())
	}
	if got := amt.Normalized().String(); got != "1.5" {
		t.Fatalf("normalized = %q, want 1.5", got)
	}
	// 1 wei of an 18-decimal token.
	wei, err := NewTokenAmount(big.NewInt(1), 18)
	if err != nil {
		t.Fatal(err)
	}
	if got := wei.Normalized().String(); got != "0.000000000000000001" {
		t.Fatalf("1 wei = %q", got)
	}
	// A uint256-sized balance must survive exactly.
	big256, _ := new(big.Int).SetString("115792089237316195423570985008687907853269984665640564039457584007913129639935", 10)
	huge, err := NewTokenAmount(big256, 18)
	if err != nil {
		t.Fatal(err)
	}
	if huge.RawString() != big256.String() {
		t.Fatal("uint256 max raw did not round-trip")
	}
}

func TestTokenAmountRejectsBadDecimals(t *testing.T) {
	if _, err := NewTokenAmount(big.NewInt(1), -1); err == nil {
		t.Error("negative decimals accepted")
	}
	if _, err := NewTokenAmount(big.NewInt(1), 256); err == nil {
		t.Error("decimals 256 accepted")
	}
	if _, err := NewTokenAmount(nil, 18); err == nil {
		t.Error("nil raw accepted")
	}
}

func TestConfidenceClamp(t *testing.T) {
	if ClampConfidence(-5) != 0 || ClampConfidence(0) != 0 || ClampConfidence(97) != 97 || ClampConfidence(150) != 100 {
		t.Fatal("confidence clamp wrong")
	}
}

func TestSourceTierValid(t *testing.T) {
	for _, good := range []SourceTier{TierBlockchain, TierDexNative, TierIndexer, TierAggregator, TierAnalytics, TierDerived} {
		if !good.Valid() {
			t.Errorf("%q not valid", good)
		}
	}
	if SourceTier("S9").Valid() {
		t.Error("S9 accepted")
	}
}

func TestProvenanceZeroValueIsHonest(t *testing.T) {
	var p Provenance
	if p.BlockNumber != nil {
		t.Fatal("zero provenance has a block number")
	}
	if p.SourceProvider != "" || p.TxHash != "" {
		t.Fatal("zero provenance invents a source")
	}
	if p.Confidence != 0 {
		t.Fatal("zero confidence should be 0 (unknown)")
	}
	_ = time.Time{}
}
