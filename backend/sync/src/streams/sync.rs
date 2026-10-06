//! The ported sync: prices -> balances -> Hyperliquid -> print -> Postgres.
//!
//! Every honesty rule of the Python original is preserved:
//!   * a missing price RAISES, it never values an asset at 0
//!   * a failed RPC is an error, never a 0 balance (hexint refuses nulls)
//!   * rows are written exactly as read from the chains

use crate::chains::*;
use crate::jsonrpc::{hexint, pad_addr, rpc};
use crate::persistence::db::{Db, Row};
use crate::pyfmt::{fixed2, fixed4, fixed8, json_str, repr, round10, round2, round4};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

pub struct Env {
    pub pg_dsn: String,
    pub alchemy_key: String,
}

struct Position {
    chain: String,
    owner: String,
    asset: String,
    qty: f64,
    usd: f64,
}

type Prices = Vec<(&'static str, f64)>;
/// `print_projection(rows, tot)` — oracle mode only. Prints the exact `assets`
/// rows the run would have written, byte-for-byte, between the same markers
/// `sync-live.py` uses (the gate diffs the two).
///
/// Rounding mirrors the Python `projection()` exactly: quantity round(..,10),
/// value round(..,4), share round(usd/tot*100, 2) or "0" when tot == 0, and
/// the net worth is the readback sum of the stored values in DESC order —
/// Python sums its `stored` floats in descending order too, so the ORDER of
/// the float additions is identical and the totals cannot diverge by an ulp.
fn print_projection(rows: &[Position], tot: f64) {
    println!("#ASSETS-PROJECTION-BEGIN");
    println!("[\"chain\",\"asset\",\"quantity\",\"value_usd\",\"share_pct\",\"wallet\"]");
    let mut stored: Vec<f64> = Vec::with_capacity(rows.len());
    for r in rows {
        let share = if tot != 0.0 {
            repr(round2(r.usd / tot * 100.0))
        } else {
            "0".to_string()
        };
        let q = repr(round10(r.qty));
        let v = repr(round4(r.usd));
        stored.push(v.parse().unwrap_or(0.0));
        // The Python oracle prints `json.dumps(row)`: quantity, value_usd and
        // share_pct are PYTHON STRINGS (str(round(...))), so the wire form is
        // JSON-quoted. Emitting them bare here would be a real divergence.
        println!(
            "[\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\"]",
            r.chain, r.asset, q, v, share, r.owner
        );
    }
    let mut desc = stored.clone();
    desc.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let mut s = 0.0f64;
    for v in &desc {
        s += v;
    }
    println!("#NET_WORTH={}", repr(round2(s)));
    println!("#ASSETS-PROJECTION-END");
}

fn price(p: &Prices, sym: &str) -> Option<f64> {
    p.iter().find(|(k, _)| *k == sym).map(|(_, v)| *v)
}

/// `prices()` -- coins.llama.fi spot oracle.
async fn prices(http: &Client) -> Result<Prices, String> {
    let ids: Vec<&str> = LLAMA_IDS.iter().map(|(_, id)| *id).collect();
    let url = format!("https://coins.llama.fi/prices/current/{}", ids.join(","));
    let body = if crate::oracle::active() {
        match crate::oracle::replay(&crate::oracle::key_prices(&url)) {
            Some(hit) => hit.map_err(|e| format!("price oracle: {e}"))?,
            None => fetch_prices(http, &url).await?,
        }
    } else {
        fetch_prices(http, &url).await?
    };
    let j: Value = serde_json::from_str(&body).map_err(|e| format!("price oracle: {e}"))?;
    let empty = serde_json::Map::new();
    let coins = j.get("coins").and_then(|c| c.as_object()).unwrap_or(&empty);
    let mut out: Prices = Vec::new();
    for (sym, cid) in LLAMA_IDS {
        let price = coins
            .get(*cid)
            .and_then(|e| e.get("price"))
            .and_then(json_f64);
        // A missing id must STOP the sync, never value an asset at 0.
        let p = match price {
            Some(p) => p,
            None => {
                return Err(format!(
                    "price oracle returned no usable price for {sym} ({cid})"
                ))
            }
        };
        out.push((sym, p));
    }
    // The Polygon native balance is valued in POL; `assets` rows labelled MATIC
    // (read by the UI) carry the same number.
    let pol = price(&out, "POL").unwrap_or_default();
    out.push(("MATIC", pol));
    Ok(out)
}

async fn fetch_prices(http: &Client, url: &str) -> Result<String, String> {
    let resp = http
        .get(url)
        .header("User-Agent", "Mozilla/5.0")
        .timeout(Duration::from_secs(25))
        .send()
        .await
        .map_err(|e| format!("price oracle: {e}"))?;
    resp.text().await.map_err(|e| format!("price oracle: {e}"))
}
/// `float(v)` as Python would apply it to a parsed JSON scalar.
fn json_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

/// `sol_val = (b.get('value', 0) if isinstance(b, dict) else 0) / 1e9`
fn sol_lamports(v: &Value) -> f64 {
    let lamports = v
        .as_object()
        .and_then(|o| o.get("value"))
        .and_then(json_f64)
        .unwrap_or(0.0);
    lamports / 1e9
}

/// `inf['tokenAmount']['uiAmount'] or 0` -- missing, 0 and 0.0 all give 0.
fn ui_amount(v: &Value) -> f64 {
    json_f64(v).unwrap_or(0.0)
}

async fn sync_solana(
    http: &Client,
    label: &str,
    addr: &str,
    p: &Prices,
    rows: &mut Vec<Position>,
    errors: &mut Vec<String>,
) {
    // Native SOL
    match rpc(http, SOLANA_RPC, "getBalance", json!([addr])).await {
        Ok(b) => {
            let sol_val = sol_lamports(&b);
            if sol_val > 1e-9 {
                rows.push(Position {
                    chain: "Solana".into(),
                    owner: label.into(),
                    asset: "SOL".into(),
                    qty: sol_val,
                    usd: sol_val * price(p, "SOL").unwrap_or(0.0),
                });
            }
        }
        Err(ex) => errors.push(format!("Solana native {label}: {ex}")),
    }
    // SPL tokens
    let params = json!([
        addr,
        {"programId": TOKEN_PROGRAM_ID},
        {"encoding": "jsonParsed"}
    ]);
    match rpc(http, SOLANA_RPC, "getTokenAccountsByOwner", params).await {
        Ok(ta) => {
            let empty = Vec::new();
            let accounts = ta.get("value").and_then(|v| v.as_array()).unwrap_or(&empty);
            for t in accounts {
                let inf = t
                    .pointer("/account/data/parsed/info")
                    .cloned()
                    .unwrap_or(Value::Null);
                let amt = inf
                    .pointer("/tokenAmount/uiAmount")
                    .map(ui_amount)
                    .unwrap_or(0.0);
                if amt > 0.0 {
                    let mint = inf.get("mint").and_then(|m| m.as_str()).unwrap_or("");
                    let short: String = mint.chars().take(6).collect();
                    rows.push(Position {
                        chain: "Solana".into(),
                        owner: label.into(),
                        asset: format!("SPL:{short}"),
                        qty: amt,
                        usd: 0.0,
                    });
                }
            }
        }
        Err(ex) => errors.push(format!("Solana SPL {label}: {ex}")),
    }
}

async fn sync_evm(
    http: &Client,
    env: &Env,
    label: &str,
    addr: &str,
    p: &Prices,
    rows: &mut Vec<Position>,
    errors: &mut Vec<String>,
) {
    // RPC error text can quote the request URL; never let the key reach the log.
    let redact = |s: String| s.replace(&env.alchemy_key, "***");
    for chain in EVM {
        let url = format!("https://{}/v2/{}", chain.host, env.alchemy_key);
        // Native balance
        let native = match rpc(http, &url, "eth_getBalance", json!([addr, "latest"])).await {
            Ok(v) => hexint(Some(&v))
                .map(|raw| scale_dec(raw, 18))
                .map_err(|e| e.0),
            Err(e) => Err(e.0),
        };
        match native {
            Ok(nb) => {
                if nb > 1e-9 {
                    rows.push(Position {
                        chain: chain.name.into(),
                        owner: label.into(),
                        asset: chain.native.into(),
                        qty: nb,
                        usd: nb * price(p, chain.native).unwrap_or(0.0),
                    });
                }
            }
            Err(ex) => errors.push(redact(format!("{} native {label}: {ex}", chain.name))),
        }
        // ERC-20 balances
        for (sym, taddr, dec) in chain.tokens {
            let res: Result<f64, String> = async {
                let data = format!("{ERC20_BALANCE_OF}{}", pad_addr(addr)?);
                let call = json!([{"to": taddr, "data": data}, "latest"]);
                let raw = rpc(http, &url, "eth_call", call).await.map_err(|e| e.0)?;
                let raw = hexint(Some(&raw)).map_err(|e| e.0)?;
                Ok(scale_dec(raw, *dec))
            }
            .await;
            match res {
                Ok(tb) => {
                    if tb > 1e-6 {
                        rows.push(Position {
                            chain: chain.name.into(),
                            owner: label.into(),
                            asset: (*sym).into(),
                            qty: tb,
                            usd: tb * price(p, sym).unwrap_or(1.0),
                        });
                    }
                }
                Err(ex) => errors.push(redact(format!("{} {sym} {label}: {ex}", chain.name))),
            }
        }
    }
}

/// `raw / 10**dec` for a Python `int` numerator.
///
/// CPython's `int.__truediv__` rounds the exact rational once; `raw as f64`
/// followed by a division would round twice. Split off the integer part and
/// carry the fraction with 64 extra bits so the single final add is the only
/// rounding below `q`'s ulp.
fn scale_dec(raw: u128, dec: u32) -> f64 {
    let d = 10u128.pow(dec);
    let q = raw / d;
    let r = raw % d;
    if r == 0 {
        return q as f64;
    }
    if q >= (1u128 << 63) {
        // r/d < 1 is far below q's ulp (>= 2048): the correctly rounded sum is
        // just the correctly rounded q.
        return q as f64;
    }
    let frac = ((r << 64) / d) as f64 / 2f64.powi(64);
    q as f64 + frac
}

/// `am * P.get(coin, 1.0) if coin in P else am`
fn hl_usd(coin: &str, amt: f64, p: &Prices) -> f64 {
    match price(p, coin) {
        Some(px) => amt * px,
        None => amt,
    }
}

/// Hyperliquid (Main) -- spot + perp + PnL. Python wraps the whole block in one
/// `try`, so a failure anywhere aborts it and contributes exactly one error.
async fn sync_hyperliquid(
    http: &Client,
    p: &Prices,
    rows: &mut Vec<Position>,
    errors: &mut Vec<String>,
) {
    match hyperliquid_inner(http, p, rows).await {
        Ok(()) => {}
        Err(ex) => errors.push(format!("Hyperliquid: {ex}")),
    }
}

async fn hyperliquid_inner(
    http: &Client,
    p: &Prices,
    rows: &mut Vec<Position>,
) -> Result<(), String> {
    let user = WALLETS[0].addr;
    let hl = |body: Value| async move {
        if crate::oracle::active() {
            if let Some(hit) = crate::oracle::replay(&crate::oracle::key_hl(&body)) {
                let text = hit?;
                return serde_json::from_str(&text).map_err(|e| e.to_string());
            }
        }
        let resp = http
            .post(HYPERLIQUID_INFO)
            .header("Content-Type", "application/json")
            .timeout(Duration::from_secs(30))
            .body(serde_json::to_vec(&body).map_err(|e| e.to_string())?)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        resp.json::<Value>().await.map_err(|e| e.to_string())
    };
    let spot = hl(json!({"type": "spotClearinghouseState", "user": user})).await?;
    let empty = Vec::new();
    for b in spot
        .get("balances")
        .and_then(|b| b.as_array())
        .unwrap_or(&empty)
    {
        let amt = json_f64(b.get("total").unwrap_or(&Value::Null)).unwrap_or(0.0);
        if amt > 0.0 {
            let coin = b.get("coin").and_then(|c| c.as_str()).unwrap_or("");
            rows.push(Position {
                chain: "Hyperliquid (spot)".into(),
                owner: "Main".into(),
                asset: coin.to_string(),
                qty: amt,
                usd: hl_usd(coin, amt, p),
            });
        }
    }
    let cs = hl(json!({"type": "clearinghouseState", "user": user})).await?;
    let av = cs
        .pointer("/marginSummary/accountValue")
        .and_then(json_f64)
        .unwrap_or(0.0);
    if av > 0.0 {
        rows.push(Position {
            chain: "Hyperliquid (perp)".into(),
            owner: "Main".into(),
            asset: "USDC".into(),
            qty: av,
            usd: av,
        });
    }
    println!("Hyperliquid perp accountValue: ${}", repr(av));
    let fills = hl(json!({"type": "userFills", "user": user})).await?;
    if let Some(list) = fills.as_array() {
        let mut pnl = 0.0f64;
        let mut fees = 0.0f64;
        for f in list {
            pnl += json_f64(f.get("closedPnl").unwrap_or(&Value::Null)).unwrap_or(0.0);
            fees += json_f64(f.get("fee").unwrap_or(&Value::Null)).unwrap_or(0.0);
        }
        println!(
            "Hyperliquid fills={} realizedPnL=${} fees=${}",
            list.len(),
            fixed4(pnl),
            fixed4(fees)
        );
    }
    Ok(())
}

pub async fn run(env: &Env) -> Result<(), String> {
    let http = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let p = prices(&http).await?;
    let rendered: Vec<String> = p
        .iter()
        .map(|(k, v)| format!("'{k}': {}", repr(round4(*v))))
        .collect();
    println!("prices: {{{}}}", rendered.join(", "));

    let mut rows: Vec<Position> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for w in WALLETS {
        match w.kind {
            Kind::Sol => sync_solana(&http, w.label, w.addr, &p, &mut rows, &mut errors).await,
            Kind::Evm => sync_evm(&http, env, w.label, w.addr, &p, &mut rows, &mut errors).await,
        }
    }
    sync_hyperliquid(&http, &p, &mut rows, &mut errors).await;

    // ---- print (stable descending sort by USD value, like the oracle) ----
    println!("\n=== LIVE ON-CHAIN ({} positions) ===", rows.len());
    let mut order: Vec<usize> = (0..rows.len()).collect();
    order.sort_by(|a, b| {
        (-rows[*b].usd)
            .partial_cmp(&(-rows[*a].usd))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut tot = 0.0f64;
    for i in &order {
        let r = &rows[*i];
        tot += r.usd;
        println!(
            "  {:6} {:11} {:9} {}  ${}",
            r.owner,
            r.chain,
            r.asset,
            fixed8(r.qty, 20),
            fixed2(r.usd, 11)
        );
    }
    if !errors.is_empty() {
        println!(
            "\n!!! {} RPC ERRORS (NOT treated as zero) !!!",
            errors.len()
        );
        for e in &errors {
            println!("  - {e}");
        }
    }

    if crate::oracle::active() {
        print_projection(&rows, tot);
        return Ok(());
    }
    // ---- write ----
    let db = Db::connect(&env.pg_dsn).await?;
    // A run with RPC errors is NOT a success: the honest board is the one from
    // the last fully-successful run. Bail (loudly, non-zero) before touching
    // `assets`, exactly like the Python oracle's failed-run path.
    if !errors.is_empty() {
        return Err(format!(
            "refusing to write assets: {} RPC error(s); the board keeps the last good snapshot",
            errors.len()
        ));
    }
    // The board replace is ONE transaction (DELETE + all INSERTs + the 90-day
    // retentions), the same atomic replace the Python oracle does. The
    // single-flight advisory lock is taken on that same connection, so a
    // concurrent run bails loudly before it can interleave.
    let mut rendered: Vec<(String, String, String, String, String)> = Vec::new();
    for r in &rows {
        let share = if tot != 0.0 {
            repr(round2(r.usd / tot * 100.0))
        } else {
            "0".to_string()
        };
        rendered.push((
            r.chain.clone(),
            r.asset.clone(),
            repr(round10(r.qty)),
            repr(round4(r.usd)),
            share,
        ));
    }
    let mut asset_rows: Vec<crate::persistence::db::AssetRow<'_>> = Vec::new();
    for ((chain, asset, qty, usd, share), r) in rendered.iter().zip(rows.iter()) {
        asset_rows.push(crate::persistence::db::AssetRow {
            chain: chain.as_str(),
            asset: asset.as_str(),
            quantity: qty.as_str(),
            value_usd: usd.as_str(),
            share_pct: share.as_str(),
            wallet: r.owner.as_str(),
        });
    }
    db.replace_assets(&asset_rows).await?;

    println!("\n=== POSTGRES assets (LIVE) ===");
    let mut s = 0.0f64;
    for a in db
        .query(
            "SELECT wallet,chain,asset,quantity,value_usd,share_pct FROM assets ORDER BY value_usd DESC",
            None,
        )
        .await?
    {
        let v = row_f64(&a, "value_usd")?;
        s += v;
        println!(
            "  {:6} {:11} {:9} {}  ${}  {}%",
            row_str(&a, "wallet"),
            row_str(&a, "chain"),
            row_str(&a, "asset"),
            fixed8(row_f64(&a, "quantity")?, 20),
            fixed2(v, 10),
            row_str(&a, "share_pct")
        );
    }
    println!("\nNET WORTH: ${}", repr(round2(s)));
    Ok(())
}

fn row_str(r: &Row, k: &str) -> String {
    r.get(k).map(json_str).unwrap_or_default()
}

fn row_f64(r: &Row, k: &str) -> Result<f64, String> {
    r.get(k)
        .and_then(json_f64)
        .ok_or_else(|| format!("row missing numeric column {k}: {r:?}"))
}
