//! The Turso read for `/api/reconcile`, plus the pure reconciliation maths.
//!
//! This is the Rust port of
//! `frontend/web/src/app/(frontend)/api/reconcile/route.ts` (DR-014): the
//! same three SELECTs, the same accumulation rules and the same sort/summary
//! passes, so the TS route can become a verbatim proxy and the two
//! implementations can be diffed against each other on live data.
//!
//! HARD RULES inherited from the route it replaces:
//!   * `wallet`/`asset` fall back to the literal `"Unknown"` when the column is
//!     absent or empty -- never dropped, because a row that vanishes from a
//!     reconciliation is a row nobody reconciles.
//!   * a non-numeric quantity/amount counts as 0 (`Number(x) || 0`), which is the
//!     route's own rule; it is NOT the sync's "a failed RPC never becomes 0" rule
//!     because this path reads stored numbers, not live balances.
//!   * `direction` is IN/else: anything that is not `IN` accumulates into
//!     `out_sum`, exactly as `if (t.direction === 'IN') ... else ...` did.
//!   * `expected` is derived from TRANSACTIONS ONLY (`in_sum - out_sum`) while
//!     `current` comes from the assets table, so an asset with no transaction
//!     history reconciles against an expected 0. That is the route's definition of
//!     expected, preserved rather than "improved" -- a different definition would
//!     silently re-score every wallet.
//!   * ROW ORDER is the route's own iteration order: assets first (in SQL order),
//!     then transactions, each wallet in first-seen order and each asset within a
//!     wallet in first-seen order. A `BTreeMap` would be deterministic but NOT the
//!     same order on ties, and `|diff|` ties are exactly where a diff between the
//!     two implementations would show up as a false alarm.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::persistence::db::{Db, Row};

/// One reconciliation row, in the wire order the TS route emitted.
#[derive(Debug, Clone, PartialEq)]
pub struct ReconRow {
    pub wallet: String,
    pub asset: String,
    pub current: f64,
    pub in_sum: f64,
    pub out_sum: f64,
    pub expected: f64,
    pub diff: f64,
}

/// One wallet's rolled-up totals.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct WalletSummary {
    pub current_total: f64,
    pub expected_total: f64,
    pub diff_total: f64,
}

/// A map that keeps first-insertion key order, which is what a JavaScript object
/// literal gives the route it replaces.
struct Ordered<T> {
    keys: Vec<String>,
    vals: HashMap<String, T>,
}

impl<T: Default> Default for Ordered<T> {
    fn default() -> Self {
        Self {
            keys: Vec::new(),
            vals: HashMap::new(),
        }
    }
}

impl<T: Default> Ordered<T> {
    fn entry(&mut self, k: &str) -> &mut T {
        if !self.vals.contains_key(k) {
            self.keys.push(k.to_string());
            self.vals.insert(k.to_string(), T::default());
        }
        self.vals.get_mut(k).expect("just inserted")
    }
}

/// `Number(x) || 0` for a JSON cell: a number survives, a numeric string parses,
/// everything else (null, prose, an absent column) is 0.
pub fn num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        // `Number(true) === 1`; kept exact because it costs nothing. Exotic JS
        // numeric literals (`Number('0x10')`) are not reproduced -- a Turso cell
        // in these columns cannot hold one.
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    }
}

/// `x || 'Unknown'` for a JSON cell: a non-empty string survives, everything else
/// (null, missing, "") becomes the fallback.
pub fn str_or(v: Option<&Value>, fallback: &str) -> String {
    match v {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => fallback.to_string(),
    }
}

/// The reconciliation itself: pure, so it is testable without a database.
///
/// `assets`, `transactions` and `wallets` are the three SELECT result sets in the
/// route's own order.
pub fn reconcile(
    assets: &[Row],
    transactions: &[Row],
    wallets: Vec<Value>,
) -> (Vec<ReconRow>, Vec<Value>) {
    // wallet -> asset -> (current, in_sum, out_sum), in first-seen order.
    let mut balance: Ordered<Ordered<(f64, f64, f64)>> = Ordered::default();

    for a in assets {
        let w = str_or(a.get("wallet"), "Unknown");
        let asset = str_or(a.get("asset"), "Unknown");
        balance.entry(&w).entry(&asset).0 += num(a.get("quantity"));
    }

    for t in transactions {
        let w = str_or(t.get("wallet_to"), "Unknown");
        // The two loops' asset fallbacks differ on purpose: an unknown asset on a
        // transaction is assumed to be the stablecoin it was moved as.
        let asset = str_or(t.get("asset"), "USDT");
        let amt = num(t.get("amount_usd"));
        let b = balance.entry(&w).entry(&asset);
        // `direction === 'IN'` is an exact match: a lowercase 'in' is NOT an
        // inflow, which is what the route's strict comparison did.
        if t.get("direction").and_then(|d| d.as_str()) == Some("IN") {
            b.1 += amt;
        } else {
            b.2 += amt;
        }
    }

    let mut rows: Vec<ReconRow> = Vec::new();
    for w in &balance.keys {
        let per_asset = &balance.vals[w];
        for asset in &per_asset.keys {
            let (current, in_sum, out_sum) = per_asset.vals[asset];
            let expected = in_sum - out_sum;
            rows.push(ReconRow {
                wallet: w.clone(),
                asset: asset.clone(),
                current,
                in_sum,
                out_sum,
                expected,
                diff: current - expected,
            });
        }
    }
    // `Math.abs(b.diff) - Math.abs(a.diff)`: biggest disagreement first. A tie
    // keeps the order established above (sort_by is stable).
    rows.sort_by(|a, b| {
        b.diff
            .abs()
            .partial_cmp(&a.diff.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    (rows, wallets)
}

/// `walletSummary` as the wire map (wallet name -> totals), matching the route's
/// `Record<string, {...}>`: built by walking the SORTED rows in insertion order.
///
/// `current_total` counts only the stablecoin legs (USDC/USDT) while
/// `expected_total`/`diff_total` count every leg -- the route's own quirk, kept.
pub fn summary_map(rows: &[ReconRow]) -> Value {
    let mut m: Ordered<WalletSummary> = Ordered::default();
    for r in rows {
        let s = m.entry(&r.wallet);
        if r.asset == "USDC" || r.asset == "USDT" {
            s.current_total += r.current;
        }
        s.expected_total += r.expected;
        s.diff_total += r.diff;
    }
    let mut out = serde_json::Map::new();
    for k in &m.keys {
        let s = &m.vals[k];
        out.insert(
            k.clone(),
            json!({
                "current_total": s.current_total,
                "expected_total": s.expected_total,
                "diff_total": s.diff_total,
            }),
        );
    }
    Value::Object(out)
}

/// Run the three SELECTs and reconcile. Any database failure is returned as an
/// error string; the caller answers 500 with it, never a partial board.
pub async fn load(db: &Db) -> Result<(Vec<ReconRow>, Value, Vec<Value>), String> {
    let assets = db
        .query(
            "SELECT wallet, chain, asset, quantity, value_usd, updated_at FROM assets ORDER BY wallet, chain, asset",
            None,
        )
        .await?;
    let transactions = db
        .query(
            "SELECT id, date, chain, asset, event, amount_usd, direction, memo, wallet_to, hash, url, source FROM transactions ORDER BY date ASC",
            None,
        )
        .await?;
    let wallets: Vec<Value> = db
        .query(
            "SELECT address, label, alias, emoji, color, chain FROM wallets ORDER BY label",
            None,
        )
        .await?
        .into_iter()
        .map(Value::Object)
        .collect();

    let (rows, wallets_out) = reconcile(&assets, &transactions, wallets);
    let summary = summary_map(&rows);
    Ok((rows, summary, wallets_out))
}

/// The JSON body of a successful `/api/reconcile`, in the field order the TS
/// route used: `{rows, wallets, walletSummary}` -- plus `source`, which names the
/// implementation that produced it so a reader can tell the Rust service's answer
/// from the TS one during the parallel run.
pub fn body(rows: &[ReconRow], wallets: &[Value], summary: &Value, source: &str) -> Value {
    json!({
        "rows": rows.iter().map(|r| json!({
            "wallet": r.wallet,
            "asset": r.asset,
            "current": r.current,
            "in_sum": r.in_sum,
            "out_sum": r.out_sum,
            "expected": r.expected,
            "diff": r.diff,
        })).collect::<Vec<_>>(),
        "wallets": wallets,
        "walletSummary": summary,
        "source": source,
    })
}
