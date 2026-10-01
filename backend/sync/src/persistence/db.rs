//! Turso HTTP pipeline client, byte-for-byte the same protocol as the Python
//! original's `db()` helper: one `execute` request + `close`, every argument
//! sent as `{"type":"text","value":"<str(a)>"}`.

use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

pub const TURL: &str = "https://fud-balance-anvxxr.aws-ap-northeast-1.turso.io/v2/pipeline";

/// `Clone` because an HTTP service hands one per connection: it is two cheap
/// handles (a reqwest client is itself Arc-backed), and sharing the same client
/// across connections is what keeps its connection pool useful.
#[derive(Clone)]
pub struct Db {
    http: Client,
    token: String,
}

pub type Row = serde_json::Map<String, Value>;

impl Db {
    pub fn new(token: String, http: Client) -> Self {
        Self { http, token }
    }

    /// `db(sql, args)` -- raises on any transport error or `results[0].error`.
    ///
    /// FAIL-SAFE tripwire: when the oracle replay is active this returns an
    /// error WITHOUT touching the network, so an oracle run cannot send a
    /// single byte to Turso (`assets` stays exactly as it was).
    pub async fn query(&self, sql: &str, args: Option<&[String]>) -> Result<Vec<Row>, String> {
        if crate::oracle::active() {
            crate::oracle::note(&format!("db|{sql}"));
            return Err(format!(
                "oracle mode: refusing to send SQL to Turso ({sql})"
            ));
        }
        let mut stmt = serde_json::Map::new();
        stmt.insert("sql".into(), Value::String(sql.to_string()));
        if let Some(args) = args {
            stmt.insert(
                "args".into(),
                Value::Array(
                    args.iter()
                        .map(|a| json!({"type": "text", "value": a}))
                        .collect(),
                ),
            );
        }
        let body = json!({
            "requests": [
                {"type": "execute", "stmt": Value::Object(stmt)},
                {"type": "close"}
            ]
        });
        let resp = self
            .http
            .post(TURL)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Content-Type", "application/json")
            .timeout(Duration::from_secs(30))
            .body(serde_json::to_vec(&body).map_err(|e| e.to_string())?)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let j: Value = resp.json().await.map_err(|e| e.to_string())?;
        let res = j
            .get("results")
            .and_then(|r| r.get(0))
            .ok_or_else(|| format!("DB: malformed pipeline response: {j}"))?;
        // Python checks the key's presence (`'error' in res`), not truthiness.
        if res.get("error").is_some() {
            return Err(format!("DB: {}", res.get("error").unwrap()));
        }
        let rr = res
            .get("response")
            .and_then(|r| r.get("result"))
            .ok_or_else(|| format!("DB: malformed result: {res}"))?;
        let cols: Vec<String> = rr
            .get("cols")
            .and_then(|c| c.as_array())
            .map(|cs| {
                cs.iter()
                    .map(|c| {
                        c.get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or_default()
                            .to_string()
                    })
                    .collect()
            })
            .unwrap_or_default();
        let empty = Vec::new();
        let rows = rr.get("rows").and_then(|r| r.as_array()).unwrap_or(&empty);
        Ok(rows
            .iter()
            .map(|row| {
                let cells = row.as_array().unwrap_or(&empty);
                let mut out = Row::new();
                for (i, col) in cols.iter().enumerate() {
                    let cell = cells.get(i).and_then(|c| c.as_object());
                    // Python: `row[i]['value'] if row[i] else None`
                    let v = match cell {
                        Some(o) => o.get("value").cloned().unwrap_or(Value::Null),
                        None => Value::Null,
                    };
                    out.insert(col.clone(), v);
                }
                out
            })
            .collect())
    }

    /// `db('DELETE FROM assets')`
    pub async fn delete_assets(&self) -> Result<(), String> {
        self.query("DELETE FROM assets", None).await.map(|_| ())
    }

    /// `db('INSERT INTO assets (...) VALUES (...)')` -- arguments are pre-rendered
    /// Python-style text, exactly as `str(a)` would produce.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_asset(
        &self,
        chain: &str,
        asset: &str,
        quantity: &str,
        value_usd: &str,
        share_pct: &str,
        wallet: &str,
    ) -> Result<(), String> {
        self.query(
            "INSERT INTO assets (chain,asset,quantity,value_usd,share_pct,wallet,updated_at) \
             VALUES (?,?,?,?,?,?,datetime('now'))",
            Some(&[
                chain.to_string(),
                asset.to_string(),
                quantity.to_string(),
                value_usd.to_string(),
                share_pct.to_string(),
                wallet.to_string(),
            ]),
        )
        .await
        .map(|_| ())
    }
}
