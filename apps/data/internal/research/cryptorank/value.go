package cryptorank

import (
	"math"
	"strconv"
	"strings"
)

// JSON value helpers. These are deliberately JS-semantics ports of the five
// helpers in lib/shapers.ts plus the small amount of JS coercion the shape
// functions rely on (`??` nullish coalescing, `typeof x === 'object'`, truthiness,
// `Number(string)`, `String(x)`, template-literal number formatting).
//
// House rule that must survive: an absent upstream value is null, never 0.

// asNum is the port of `asNum`: only a finite JS number survives.
func asNum(v interface{}) *float64 {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return &f
}

// asNumLoose is the port of `asNumLoose`: upstream ships some numerics as
// strings (token-unlock marketCap).
func asNumLoose(v interface{}) *float64 {
	if f, ok := v.(float64); ok {
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil
		}
		return &f
	}
	if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
		if f, ok := jsNumber(s); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
			return &f
		}
	}
	return nil
}

// asStr is `asStr`: non-empty strings only (JS ” is falsy).
func asStr(v interface{}) *string {
	s, ok := v.(string)
	if !ok || s == "" {
		return nil
	}
	return &s
}

// asStrOrDash is `asStrOrDash`: upstream marks undisclosed names/types as '~';
// that renders as absent (em-dash), not as a tilde.
func asStrOrDash(v interface{}) *string {
	s := asStr(v)
	if s != nil && *s == "~" {
		return nil
	}
	return s
}

// asPriceUsd is `asPriceUsd`: `{USD: n}` or a bare number.
func asPriceUsd(v interface{}) *float64 {
	if m, ok := v.(map[string]interface{}); ok {
		return asNum(m["USD"])
	}
	return asNum(v)
}

// strOr is `asStr(v) ?? ”` (or a caller-supplied default).
func strOr(v interface{}, def string) string {
	if s := asStr(v); s != nil {
		return *s
	}
	return def
}

// stringOf is `asStr(v) ?? fallback` where fallback is itself nullable.
func stringOf(v, fallback interface{}) *string {
	if s := asStr(v); s != nil {
		return s
	}
	return asStr(fallback)
}

// obj is the `typeof v === 'object' && v !== null` test, restricted to the
// JSON object case (JS property access on a non-object yields undefined).
func obj(v interface{}) map[string]interface{} {
	if m, ok := v.(map[string]interface{}); ok {
		return m
	}
	return nil
}

// field is `(v as any)?.k` -- a property read that survives non-objects.
func field(v interface{}, k string) interface{} {
	if m := obj(v); m != nil {
		return m[k]
	}
	return nil
}

// truthy is JS truthiness ({} and [] are truthy).
func truthy(v interface{}) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case string:
		return t != ""
	default:
		return true
	}
}

// isObject is `typeof v === 'object'` (includes arrays and null-less values).
func isObject(v interface{}) bool {
	switch v.(type) {
	case map[string]interface{}, []interface{}:
		return true
	}
	return false
}

// objOrEmpty models `(x ?? {}) as Record<string, unknown>`: a non-object is
// still dereferenced in JS (yielding undefined), which is the same as {}.
func objOrEmpty(v interface{}) map[string]interface{} {
	if m, ok := v.(map[string]interface{}); ok {
		return m
	}
	return map[string]interface{}{}
}

// nullish is `a ?? b`: only nil/undefined falls through (JS undefined is
// modelled as a nil JSON value here).
func nullish(a, b interface{}) interface{} {
	if a == nil {
		return b
	}
	return a
}

// numOrNull is `asNum(a ?? b)`.
func numOrNull(a, b interface{}) *float64 { return asNum(nullish(a, b)) }

// jsNumber is `Number(s)` for the shapes upstream actually ships (decimal
// literals). Hex and Infinity prefixes are handled because JS accepts them.
func jsNumber(s string) (float64, bool) {
	t := strings.TrimSpace(s)
	switch strings.ToLower(t) {
	case "":
		return 0, true
	case "infinity", "+infinity":
		return math.Inf(1), true
	case "-infinity":
		return math.Inf(-1), true
	}
	lower := strings.ToLower(t)
	if strings.HasPrefix(lower, "0x") || strings.HasPrefix(lower, "-0x") || strings.HasPrefix(lower, "+0x") {
		neg := strings.HasPrefix(lower, "-")
		hex := strings.TrimPrefix(strings.TrimPrefix(lower, "-"), "+")
		n, err := strconv.ParseUint(strings.TrimPrefix(hex, "0x"), 16, 64)
		if err != nil {
			return math.NaN(), false
		}
		f := float64(n)
		if neg {
			f = -f
		}
		return f, true
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN(), false
	}
	return f, true
}

// jsNumStr renders a number the way a JS template literal / Number#toString
// does: plain decimal in [1e-6, 1e21), exponent form outside it.
func jsNumStr(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	abs := math.Abs(f)
	format := byte('f')
	if abs != 0 && (abs < 1e-6 || abs >= 1e21) {
		format = 'e'
	}
	s := strconv.FormatFloat(f, format, -1, 64)
	if format == 'e' {
		// JS prints 1e-7, not 1e-07; and 1e+21, not 1e+021.
		if i := strings.IndexByte(s, 'e'); i >= 0 {
			mant, exp := s[:i], s[i+1:]
			sign := "+"
			if strings.HasPrefix(exp, "-") {
				sign = "-"
				exp = exp[1:]
			} else if strings.HasPrefix(exp, "+") {
				exp = exp[1:]
			}
			exp = strings.TrimLeft(exp, "0")
			if exp == "" {
				exp = "0"
			}
			s = mant + "e" + sign + exp
		}
	}
	return s
}

// jsString is `String(v)` for the JSON value shapes upstream ships (used by
// the media tag list).
func jsString(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return "" // JSON has no undefined; a JSON null never reaches String() upstream
	case string:
		return t
	case float64:
		return jsNumStr(t)
	case bool:
		if t {
			return "true"
		}
		return "false"
	case []interface{}:
		parts := make([]string, 0, len(t))
		for _, e := range t {
			parts = append(parts, jsString(e))
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// genesisSlice copies a JSON array (nil for a non-array), the JS
// `Array.isArray(x) ? x : []` test at the call sites that need the "not an
// array" distinction.
func jsonArray(v interface{}) []interface{} {
	if a, ok := v.([]interface{}); ok {
		return a
	}
	return nil
}

func dictArray(v interface{}) []map[string]interface{} {
	a, ok := v.([]interface{})
	if !ok {
		return nil
	}
	out := make([]map[string]interface{}, 0, len(a))
	for _, e := range a {
		if m, ok := e.(map[string]interface{}); ok {
			out = append(out, m)
		} else {
			out = append(out, map[string]interface{}{})
		}
	}
	return out
}

func strs(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}
