//! Oracle replay seam for the Phase-6 cross-implementation gate.
//!
//! A capture recorded by `sync-live.py --oracle-record` maps a canonical
//! *request key* to the raw upstream HTTP response body. In replay mode every
//! upstream call this binary makes (price oracle, JSON-RPC, Hyperliquid) is
//! served from that map instead of the network, so the Rust producer and the
//! Python oracle are driven by byte-identical inputs. The store's write path is
//! never reached in oracle mode (see `sync.rs`), so a divergent or failed run
//! cannot touch the live `assets` table.
//!
//! Key format must match `sync-live.py`'s `canon()` + key builders exactly:
//!   rpc    -> `rpc|<url with ALCHEMY redacted>|<method>|<canon(params)>`
//!   prices -> `prices|<url>`
//!   hl     -> `hl|<canon(body)>`
//! `canon` is JSON with object keys sorted and compact separators, matching
//! Python's `json.dumps(x, sort_keys=True, separators=(',',':'))` for the
//! ASCII string/array/object payloads these requests carry.
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Mutex;

pub struct Oracle {
    data: BTreeMap<String, String>,
    trace: Vec<String>,
    trace_path: Option<String>,
}

static ORACLE: Mutex<Option<Oracle>> = Mutex::new(None);

/// Load a recorded capture. Called once at startup when `--oracle-inputs` is
/// present. No credential is needed: fixture keys carry `/v2/{ALCHEMY}`, never
/// a real key (see `redact`).
pub fn init(path: &str, trace_path: Option<&str>) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("oracle inputs {path}: {e}"))?;
    let blob: Value =
        serde_json::from_str(&text).map_err(|e| format!("oracle inputs {path}: {e}"))?;
    let empty = serde_json::Map::new();
    let responses = blob
        .get("responses")
        .and_then(|r| r.as_object())
        .unwrap_or(&empty);
    let mut data = BTreeMap::new();
    for (k, v) in responses {
        let s = match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        data.insert(k.clone(), s);
    }
    *ORACLE.lock().unwrap() = Some(Oracle {
        data,
        trace: Vec::new(),
        trace_path: trace_path.map(|s| s.to_string()),
    });
    Ok(())
}

pub fn active() -> bool {
    ORACLE.lock().unwrap().is_some()
}

/// Replay result for one upstream request:
///   `None`            -> oracle inactive (live run); caller performs real HTTP.
///   `Some(Ok(body))`  -> replayed from the capture.
///   `Some(Err(msg))`  -> replay active but no recorded response: fail loudly,
///                        never invent an empty result (honesty rule).
pub fn replay(key: &str) -> Option<Result<String, String>> {
    let mut g = ORACLE.lock().unwrap();
    let o = match g.as_mut() {
        Some(o) => o,
        None => return None,
    };
    o.trace.push(key.to_string());
    match o.data.get(key) {
        Some(b) => Some(Ok(b.clone())),
        None => Some(Err(format!("no recorded response for {key}"))),
    }
}

/// Append a key to the request trace in oracle mode (used by the "no writes"
/// assertion: a real write would appear here and must not).
pub fn note(key: &str) {
    if let Some(o) = ORACLE.lock().unwrap().as_mut() {
        o.trace.push(key.to_string());
    }
}

/// Flush the request trace so a test can assert no write was issued.
pub fn save_trace() {
    if let Some(o) = ORACLE.lock().unwrap().as_ref() {
        if let Some(p) = &o.trace_path {
            let _ = std::fs::write(p, format!("{}\n", o.trace.join("\n")));
        }
    }
}

/// `/v2/<last path segment>` -> `/v2/{ALCHEMY}`, independent of the key value
/// (so replay needs no credential and a capture never holds one).
fn redact(url: &str) -> String {
    match url.rfind("/v2/") {
        Some(i) => format!("{}/v2/{{ALCHEMY}}", &url[..i]),
        None => url.to_string(),
    }
}

/// `json.dumps(x, sort_keys=True, separators=(',',':'))` for ASCII payloads.
fn canon(v: &Value, out: &mut String) {
    match v {
        Value::Object(m) => {
            let mut sorted: Vec<&String> = m.keys().collect(); // BTreeMap? serde preserve_order => IndexMap
            sorted.sort();
            out.push('{');
            for (i, k) in sorted.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*k).clone()).to_string());
                out.push(':');
                canon(&m[*k], out);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canon(x, out);
            }
            out.push(']');
        }
        Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null => {
            out.push_str(&v.to_string());
        }
    }
}

fn canon_str(v: &Value) -> String {
    let mut s = String::new();
    canon(v, &mut s);
    s
}

pub fn key_rpc(url: &str, method: &str, params: &Value) -> String {
    format!("rpc|{}|{}|{}", redact(url), method, canon_str(params))
}

pub fn key_prices(url: &str) -> String {
    format!("prices|{}", url)
}

pub fn key_hl(body: &Value) -> String {
    format!("hl|{}", canon_str(body))
}
