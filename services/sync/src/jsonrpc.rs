//! JSON-RPC client with the Python original's honesty rules: three tries with
//! backoff, then raise. A failed call NEVER becomes a zero balance.

#[derive(Debug)]
pub struct RpcError(pub String);

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// `rpc(url, method, params, tries=3)`
pub async fn rpc(
    http: &reqwest::Client,
    url: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, RpcError> {
    let body = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
    // Oracle replay seam: a recorded body short-circuits the network entirely.
    // The key is only built in oracle mode, so the production path allocates
    // nothing extra.
    if crate::oracle::active() {
        let key = crate::oracle::key_rpc(url, method, &body["params"]);
        if let Some(hit) = crate::oracle::replay(&key) {
            let text = hit.map_err(RpcError)?;
            let j: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| RpcError(format!("{method}: {e}")))?;
            if j.get("error").is_some() {
                return Err(RpcError(format!("{method} -> {}", j["error"])));
            }
            return Ok(j.get("result").cloned().unwrap_or(serde_json::Value::Null));
        }
    }
    let body = serde_json::to_vec(&body).map_err(|e| RpcError(e.to_string()))?;
    let mut last: Option<String> = None;
    for attempt in 0..3u64 {
        match call_once(http, url, &body).await {
            Ok(j) => {
                if j.get("error").is_some() {
                    // Python: an RPC-level error is reported immediately, no retry.
                    return Err(RpcError(format!("{method} -> {}", j["error"])));
                }
                return Ok(j.get("result").cloned().unwrap_or(serde_json::Value::Null));
            }
            Err(e) => {
                last = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(1200 * (attempt + 1))).await;
            }
        }
    }
    Err(RpcError(last.unwrap_or_default()))
}

async fn call_once(
    http: &reqwest::Client,
    url: &str,
    body: &[u8],
) -> Result<serde_json::Value, String> {
    let short = &url[..url.len().min(40)];
    let resp = http
        .post(url)
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(30))
        .body(body.to_vec())
        .send()
        .await
        .map_err(|e| format!("post @ {short}: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("post @ {short}: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "post @ {short}: HTTP {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
    }
    serde_json::from_str(&text).map_err(|e| format!("post @ {short}: {e}"))
}

/// `hexint(v)` -- refusing to read a null as zero.
pub fn hexint(v: Option<&serde_json::Value>) -> Result<u128, RpcError> {
    let v = v.ok_or_else(|| {
        RpcError("hexint(None) -- refusing to treat a null as zero".to_string())
    })?;
    let s = match v {
        serde_json::Value::Null => {
            return Err(RpcError(
                "hexint(None) -- refusing to treat a null as zero".to_string(),
            ))
        }
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if s.is_empty() || s == "0x" || s == "0x0" {
        return Ok(0);
    }
    let digits = s.strip_prefix("0x").unwrap_or(&s);
    // The exact integer, never a float: the caller scales it by the token's
    // decimals with scale_dec, which reproduces CPython's single-rounding
    // `int / 10**dec`. Returning f64 here would round twice (ANALYSIS on the
    // parity requirement) and make a balance 1 wei off.
    u128::from_str_radix(digits, 16).map_err(|e| RpcError(format!("hexint({s:?}): {e}")))
}

/// `pad_addr(addr)` -- 32-byte left-padded lowercase address payload.
pub fn pad_addr(addr: &str) -> Result<String, String> {
    let mut a = addr.trim().to_lowercase();
    if let Some(rest) = a.strip_prefix("0x") {
        a = rest.to_string();
    }
    if a.len() != 40 || !a.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("bad EVM address: {addr:?}"));
    }
    Ok(format!("{:0>64}", a))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hexint_rules() {
        assert_eq!(hexint(Some(&json!("0x0"))).unwrap(), 0u128);
        assert_eq!(hexint(Some(&json!("0x"))).unwrap(), 0u128);
        assert!(hexint(None).is_err());
        assert!(hexint(Some(&json!(null))).is_err());
        assert_eq!(hexint(Some(&json!("0xde0b6b3a7640000"))).unwrap(), 1_000_000_000_000_000_000u128);
    }

    #[test]
    fn pad_addr_rules() {
        let p = pad_addr("0x6816ba2cb2bc013a78225228a153586ca63b1548").unwrap();
        assert_eq!(p.len(), 64);
        assert!(p.ends_with("6816ba2cb2bc013a78225228a153586ca63b1548"));
        assert!(pad_addr("0xdeadbeef").is_err());
    }
}
