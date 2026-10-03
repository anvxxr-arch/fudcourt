package cryptorank

import (
	"bytes"
	"encoding/json"
)

// Num models a TS `number | null` that is PRESENT in the JSON whenever the
// field is set. A nil *Num is "undefined" (the key is absent); &Num{V: nil} is
// a present null. Used for `upstreamTotal`, which the TS sets explicitly to
// `total` (number|null) on the modes whose page states a total.
type Num struct{ V *float64 }

func (n Num) MarshalJSON() ([]byte, error) {
	if n.V == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*n.V)
}

// PtrSlice is `*[]T`: nil means "undefined" (key absent), a non-nil pointer to
// an empty slice means `[]` -- which TS emits when a mode sets an empty array.
func PtrSlice[T any](s []T) *[]T {
	if s == nil {
		s = []T{}
	}
	return &s
}

// marshalNoEscape is json.Marshal without HTML escaping, used by every nested
// MarshalJSON below.
//
// It is REQUIRED, not decorative: a top-level Encoder with SetEscapeHTML(false)
// does NOT fix a nested encoder. The outer encoder runs the inner output through
// `compact(..., escapeHTML=false)`, which strips whitespace but can never
// UNESCAPE bytes the inner `json.Marshal` already turned into \u003c/\u0026 (it
// cannot tell an intended literal from an escape). Measured: with only the
// top-level setting, `rows` entries whose names carry `&` still served
// `\u0026` while the TS body served `&` (internal/research/paritytest catches it).
//
// Encode appends a newline, which the outer encoder would treat as trailing
// whitespace inside our raw value, so it is trimmed.
func marshalNoEscape(v interface{}) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// Row is the union of the three shared row shapes the `rows` key carries.
// Exactly one field is set; MarshalJSON reproduces the TS key set per shape
// (a listings coin carries change7d, a cex-transparency exchange carries the
// reserve columns, a plain coin does neither).
type Row struct {
	Coin             *CrCoin
	Listing          *CrListingCoin
	Trend            *CrTrendingRow
	Exch             *CrExchangeRow
	ExchTransparency *CrExchangeTransparencyRow
}

func (r Row) MarshalJSON() ([]byte, error) {
	switch {
	case r.Coin != nil:
		return marshalNoEscape(r.Coin)
	case r.Listing != nil:
		return marshalNoEscape(r.Listing)
	case r.Trend != nil:
		return marshalNoEscape(r.Trend)
	case r.Exch != nil:
		return marshalNoEscape(r.Exch)
	case r.ExchTransparency != nil:
		return marshalNoEscape(r.ExchTransparency)
	}
	return []byte("null"), nil
}
