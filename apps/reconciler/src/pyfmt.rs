//! Python-identical number formatting.
//!
//! The Rust port must write the same `assets` rows and print the same journal
//! lines as the Python oracle, so every number that Python renders with
//! `str()`/`repr()` (float) has to render identically here.
//!
//! Python's `repr(float)` (and `str(float)`, since 3.1) is the shortest decimal
//! string that round-trips, formatted positionally when `-4 <= decpt <= 16`
//! and in scientific notation (`d.ddde±XX`, exponent always signed, at least
//! two digits) otherwise. `format!("{:e}")` gives the same shortest digit
//! string, so the exponent rule is all that has to be reproduced.

/// `round(x, 4)` on an f64.
///
/// Python's `round(float, n)` for n >= 0 is `float(round_half_even(x * 10^n)) / 10^n`;
/// Rust's `round_ties_even` is the same operation on the same doubles and
/// `1e4`/`1e-4` are exactly representable, so the final division only cancels
/// the multiplication's rounding error.
#[inline]
pub fn round4(x: f64) -> f64 {
    round_n(x, 4)
}

/// `round(x, n)` exactly as CPython implements it for a float.
///
/// This is NOT `(x * 10^n).round_ties_even() / 10^n`: CPython converts the
/// double to its EXACT decimal expansion and rounds that half-to-even, which
/// differs whenever the `* 10^n` product lands on a tie by accident. Measured:
/// `round(12.345, 2)` is **12.35** (the double is 12.34500000000000063…) while
/// `round(12.335, 2)` is **12.34** (that double is 12.33499999999999996…); the
/// multiply-and-round form gives 12.34 for both, i.e. it is wrong on the first
/// and right on the second by luck. Rust's fixed-precision formatting performs
/// the same correctly-rounded conversion CPython does, so parse that back.
fn round_n(x: f64, n: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    match format!("{:.*}", n, x).parse::<f64>() {
        // A value too large for the fixed form (or a format edge) falls back to
        // the input: never a panic, never an invented number.
        Ok(v) => v,
        Err(_) => x,
    }
}

/// `round(x, 10)` on an f64 (used for the stored `quantity`).
#[inline]
pub fn round10(x: f64) -> f64 {
    round_n(x, 10)
}

/// `round(x, 2)` on an f64 (used for `share_pct` / the net-worth total).
#[inline]
pub fn round2(x: f64) -> f64 {
    round_n(x, 2)
}

/// `repr(x)` for an f64.
pub fn repr(x: f64) -> String {
    if x.is_nan() {
        return "nan".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf" } else { "-inf" }.to_string();
    }
    let neg = x.is_sign_negative();
    let sci = format!("{:e}", x.abs()); // shortest digits, e.g. "2.7362683254322483e3"
    let (mant, exp) = match sci.split_once('e') {
        Some((m, e)) => (m, e.parse::<i32>().unwrap_or(0)),
        None => (sci.as_str(), 0),
    };
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let ndigits = digits.len() as i32;
    let decpt = exp + 1; // value == 0.digits * 10^decpt
    let body = if decpt <= -4 || decpt > 16 {
        let mut m = String::from(&digits[..1]);
        if digits.len() > 1 {
            m.push('.');
            m.push_str(&digits[1..]);
        }
        let e = decpt - 1;
        format!("{m}e{}{:02}", if e < 0 { '-' } else { '+' }, e.abs())
    } else if decpt <= 0 {
        format!("0.{}{}", "0".repeat((-decpt) as usize), digits)
    } else if decpt >= ndigits {
        format!("{}{}.0", digits, "0".repeat((decpt - ndigits) as usize))
    } else {
        format!(
            "{}.{}",
            &digits[..decpt as usize],
            &digits[decpt as usize..]
        )
    };
    if neg {
        format!("-{body}")
    } else {
        body
    }
}

/// `{x:>width.8f}`
#[inline]
pub fn fixed8(x: f64, width: usize) -> String {
    format!("{x:>width$.prec$}", width = width, prec = 8)
}

/// `{x:>width.2f}`
#[inline]
pub fn fixed2(x: f64, width: usize) -> String {
    format!("{x:>width$.prec$}", width = width, prec = 2)
}

/// `{x:.4f}`
#[inline]
pub fn fixed4(x: f64) -> String {
    format!("{x:.4}")
}

/// `str()` of a JSON scalar exactly as Python would render the parsed value:
/// integers stay integral, floats go through `repr()`, strings pass through.
pub fn json_str(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => "None".to_string(),
        serde_json::Value::Bool(b) => if *b { "True" } else { "False" }.to_string(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => {
            if n.is_f64() {
                repr(n.as_f64().unwrap_or_default())
            } else {
                n.to_string()
            }
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Expected values produced by CPython 3 (`repr()`), including every
    /// exponent-format boundary.
    // `3.14159` below is a deliberate INPUT value for the repr-parity table, not
    // an approximation of PI; clippy's `approx_constant` reads the digits and
    // fires. The value is part of the CPython-parity contract, so it stays.
    #[allow(clippy::approx_constant)]
    #[test]
    fn repr_matches_cpython() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0.0"),
            (-0.0, "-0.0"),
            (1.0, "1.0"),
            (5.0, "5.0"),
            (0.999999, "0.999999"),
            (0.1, "0.1"),
            (0.0001, "0.0001"),
            (0.0003, "0.0003"),
            (3e-05, "3e-05"),
            (1e-05, "1e-05"),
            (2.5e-07, "2.5e-07"),
            (1e-04, "0.0001"),
            (1e15, "1000000000000000.0"),
            (1e16, "1e+16"),
            (1e17, "1e+17"),
            (9999999999999998.0, "9999999999999998.0"),
            (12345.678, "12345.678"),
            (3.14159, "3.14159"),
            (2736.2683254322483, "2736.2683254322483"),
            (-2736.2683254322483, "-2736.2683254322483"),
            (890881.0, "890881.0"),
            (0.890881, "0.890881"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (1.0e-4, "0.0001"),
        ];
        for (v, want) in cases {
            assert_eq!(&repr(*v), want, "repr({v:?})");
        }
    }

    #[test]
    fn rounding_matches_cpython() {
        assert_eq!(repr(round4(2736.2683254322483)), "2736.2683");
        assert_eq!(repr(round4(0.0)), "0.0");
        assert_eq!(repr(round4(0.999999)), "1.0");
        assert_eq!(repr(round4(1.00005)), "1.0001");
        assert_eq!(repr(round2(12.345)), "12.35"); // CPython: round(12.345, 2) == 12.35
        assert_eq!(repr(round2(12.335)), "12.34"); // CPython: 12.335 is
                                                   // really 12.33499999... in binary, so the correctly-rounded 2-dp
                                                   // result is 12.34 — measured with python3 -c "print(round(12.335,2))"
        assert_eq!(repr(round10(0.890881)), "0.890881");
    }

    #[test]
    fn widths() {
        assert_eq!(fixed8(0.890881, 20), "          0.89088100"); // f"{v:>20.8f}"
        assert_eq!(fixed2(890881.0, 11), "  890881.00");
        assert_eq!(fixed4(1.5), "1.5000");
    }
}
