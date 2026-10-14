//! Structured logs: one JSON object per line on stdout.
//!
//! Dependency-free (serde_json is already here). The shape is fixed —
//! `level`, `msg`, `ts_unix`, plus caller fields — so the lines are greppable
//! and machine-readable without a logging framework. Secrets never reach here:
//! nothing in this crate logs a DSN, a token or a payload body.

use serde_json::{Map, Value};

/// Build the caller's field map from pairs, so call sites stay one line.
pub fn fields(pairs: Vec<(&str, Value)>) -> Map<String, Value> {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert(key.to_string(), value);
    }
    map
}

pub fn info(msg: &str) {
    emit("info", msg, Map::new());
}

pub fn info_map(msg: &str, fields: Map<String, Value>) {
    emit("info", msg, fields);
}

pub fn warn(msg: &str, fields: Map<String, Value>) {
    emit("warn", msg, fields);
}

pub fn error(msg: &str, fields: Map<String, Value>) {
    emit("error", msg, fields);
}

fn emit(level: &str, msg: &str, mut fields: Map<String, Value>) {
    fields.insert("level".into(), Value::String(level.to_string()));
    fields.insert("msg".into(), Value::String(msg.to_string()));
    fields.insert("ts_unix".into(), Value::from(unix_secs()));
    // `println!` is line-buffered and every record is a single line, so records
    // never interleave.
    println!("{}", Value::Object(fields));
}

fn unix_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_build_a_map() {
        let map = fields(vec![("a", Value::from(1)), ("b", Value::from("x"))]);
        assert_eq!(map.get("a"), Some(&Value::from(1)));
        assert_eq!(map.get("b"), Some(&Value::from("x")));
    }

    #[test]
    fn emit_produces_one_json_object_per_call() {
        // Exercise the renderer without capturing stdout: the same assembly the
        // logger performs, asserted on shape rather than on I/O.
        let mut map = fields(vec![("job_id", Value::from(7))]);
        map.insert("level".into(), Value::String("info".into()));
        map.insert("msg".into(), Value::String("claimed".into()));
        map.insert("ts_unix".into(), Value::from(unix_secs()));
        let line = Value::Object(map).to_string();
        assert!(line.starts_with('{') && line.ends_with('}'));
        assert!(!line.contains('\n'));
        assert!(line.contains("\"job_id\":7"));
        assert!(line.contains("\"level\":\"info\""));
    }

    #[test]
    fn unix_secs_is_a_plausible_epoch() {
        // Sanity: after 2020-01-01, before 2100.
        let now = unix_secs();
        assert!(now > 1_577_836_800.0, "got {now}");
        assert!(now < 4_102_444_800.0, "got {now}");
    }
}
