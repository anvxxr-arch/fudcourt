//! Tests for the reconciliation maths and the HTTP routing table.
//!
//! OFFLINE and deterministic. The inputs are the three SELECT result sets as the
//! Postgres client hands them over, so the accumulation rules the TS route owned
//! (`|| 'Unknown'`, `Number(x) || 0`, `direction === 'IN'`) are asserted directly
//! rather than inferred from a live database.

use serde_json::{json, Map, Value};

use fudcourt_sync::reconciliation::reconcile::{
    body, num, reconcile, str_or, summary_map, ReconRow,
};
use fudcourt_sync::reconciliation::server::route;

type Row = Map<String, Value>;

fn row(pairs: &[(&str, Value)]) -> Row {
    let mut m = Row::new();
    for (k, v) in pairs {
        m.insert((*k).to_string(), v.clone());
    }
    m
}

// --- cell coercion ----------------------------------------------------------

#[test]
fn num_matches_the_routes_number_or_zero() {
    assert_eq!(num(Some(&json!(12.5))), 12.5);
    assert_eq!(num(Some(&json!(-3))), -3.0);
    // A numeric STRING parses (JS Number("4") === 4).
    assert_eq!(num(Some(&json!("4"))), 4.0);
    // Everything else is 0 -- null, a missing cell, empty string, prose.
    assert_eq!(num(Some(&Value::Null)), 0.0);
    assert_eq!(num(None), 0.0);
    assert_eq!(num(Some(&json!(""))), 0.0);
    assert_eq!(num(Some(&json!("n/a"))), 0.0);
    // `Number(true) === 1` in JS, so a boolean cell is 1/0 -- kept exact.
    assert_eq!(num(Some(&json!(true))), 1.0);
    assert_eq!(num(Some(&json!(false))), 0.0);
    // `Number(" 7 ")` is 7 in JS, and a stored value may carry padding.
    assert_eq!(num(Some(&json!(" 7 "))), 7.0);
}

#[test]
fn str_or_matches_the_routes_fallback() {
    assert_eq!(str_or(Some(&json!("alice")), "Unknown"), "alice");
    assert_eq!(str_or(Some(&json!("")), "Unknown"), "Unknown");
    assert_eq!(str_or(Some(&Value::Null), "Unknown"), "Unknown");
    assert_eq!(str_or(None, "Unknown"), "Unknown");
    // A non-string cell (a number) is not a wallet name.
    assert_eq!(str_or(Some(&json!(7)), "Unknown"), "Unknown");
}

// --- accumulation ----------------------------------------------------------

#[test]
fn assets_accumulate_into_current_and_transactions_split_by_direction() {
    let assets = vec![
        row(&[
            ("wallet", json!("w1")),
            ("asset", json!("USDT")),
            ("quantity", json!(100)),
        ]),
        row(&[
            ("wallet", json!("w1")),
            ("asset", json!("USDT")),
            ("quantity", json!(50.5)),
        ]),
    ];
    let txs = vec![
        row(&[
            ("wallet_to", json!("w1")),
            ("asset", json!("USDT")),
            ("direction", json!("IN")),
            ("amount_usd", json!(200)),
        ]),
        row(&[
            ("wallet_to", json!("w1")),
            ("asset", json!("USDT")),
            ("direction", json!("OUT")),
            ("amount_usd", json!(49.5)),
        ]),
    ];
    let (rows, _) = reconcile(&assets, &txs, vec![]);
    assert_eq!(rows.len(), 1);
    let r = &rows[0];
    assert_eq!(r.current, 150.5);
    assert_eq!(r.in_sum, 200.0);
    assert_eq!(r.out_sum, 49.5);
    assert_eq!(r.expected, 150.5);
    assert_eq!(r.diff, 0.0);
}

#[test]
fn a_direction_that_is_not_exactly_in_counts_as_out() {
    // The route compared with `=== 'IN'`, so a lowercase tag was an outflow.
    for tag in ["in", "In", "", "OUT"] {
        let txs = vec![row(&[
            ("wallet_to", json!("w1")),
            ("asset", json!("USDT")),
            ("direction", json!(tag)),
            ("amount_usd", json!(10)),
        ])];
        let (rows, _) = reconcile(&[], &txs, vec![]);
        assert_eq!(
            rows[0].out_sum, 10.0,
            "direction {tag:?} must be an outflow"
        );
        assert_eq!(
            rows[0].in_sum, 0.0,
            "direction {tag:?} must not be an inflow"
        );
    }
}

#[test]
fn missing_wallet_and_asset_use_the_routes_literals() {
    // An asset row with no wallet/asset, and a tx with no wallet_to (the asset
    // fallback differs between the two loops: 'Unknown' vs 'USDT').
    let assets = vec![row(&[("quantity", json!(5))])];
    let txs = vec![row(&[("direction", json!("IN")), ("amount_usd", json!(7))])];
    let (rows, _) = reconcile(&assets, &txs, vec![]);
    // The two loops' asset fallbacks differ on purpose: the assets loop's miss is
    // 'Unknown', the transactions loop's is 'USDT'. Compared as a SET because the
    // |diff| sort legitimately orders the USDT row (diff -7) above the other
    // (diff 5); row ORDER is pinned separately by the tie test.
    let mut seen: Vec<(String, String)> = rows
        .iter()
        .map(|r| (r.wallet.clone(), r.asset.clone()))
        .collect();
    seen.sort();
    assert_eq!(
        seen,
        vec![
            ("Unknown".to_string(), "USDT".to_string()),
            ("Unknown".to_string(), "Unknown".to_string()),
        ],
        "the two loops' fallbacks are different on purpose"
    );
}

#[test]
fn a_failed_row_is_never_dropped_a_zero_is_never_substituted_for_absence() {
    // The board's own rule: absent metrics render as an em-dash, so a row must
    // survive with the value it actually had (0 here is REAL: the column said 0).
    let assets = vec![row(&[
        ("wallet", json!("w")),
        ("asset", json!("ETH")),
        ("quantity", json!(0)),
    ])];
    let (rows, _) = reconcile(&assets, &[], vec![]);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].current, 0.0);
}

#[test]
fn rows_are_sorted_by_absolute_difference_desc() {
    let assets = vec![
        row(&[
            ("wallet", json!("small")),
            ("asset", json!("USDT")),
            ("quantity", json!(1)),
        ]),
        row(&[
            ("wallet", json!("big")),
            ("asset", json!("USDT")),
            ("quantity", json!(1000)),
        ]),
        row(&[
            ("wallet", json!("mid")),
            ("asset", json!("USDT")),
            ("quantity", json!(100)),
        ]),
    ];
    let (rows, _) = reconcile(&assets, &[], vec![]);
    let wallets: Vec<&str> = rows.iter().map(|r| r.wallet.as_str()).collect();
    assert_eq!(wallets, vec!["big", "mid", "small"]);
    // A NEGATIVE difference of the same magnitude sorts with its positive twin.
    let assets = vec![
        row(&[
            ("wallet", json!("neg")),
            ("asset", json!("USDT")),
            ("quantity", json!(-500)),
        ]),
        row(&[
            ("wallet", json!("pos")),
            ("asset", json!("USDT")),
            ("quantity", json!(400)),
        ]),
    ];
    let (rows, _) = reconcile(&assets, &[], vec![]);
    assert_eq!(rows[0].wallet, "neg", "|−500| > |400|");
}

#[test]
fn row_order_on_an_absolute_difference_tie_is_first_seen_not_byte_order() {
    // 'zeb' and 'abc' both have |diff| = 1 (no transactions), so a `BTreeMap`
    // accumulator would emit abc first; the route emitted them in asset order, so
    // an implementation diff that keys on ORDER would report a false difference.
    let assets = vec![
        row(&[
            ("wallet", json!("zeb")),
            ("asset", json!("USDT")),
            ("quantity", json!(1)),
        ]),
        row(&[
            ("wallet", json!("abc")),
            ("asset", json!("USDT")),
            ("quantity", json!(1)),
        ]),
    ];
    let (rows, _) = reconcile(&assets, &[], vec![]);
    let wallets: Vec<&str> = rows.iter().map(|r| r.wallet.as_str()).collect();
    assert_eq!(wallets, vec!["zeb", "abc"], "ties keep first-seen order");
}

#[test]
fn wallet_summary_counts_only_the_stablecoin_legs() {
    // The route's own quirk, preserved rather than "fixed": current_total sums
    // only the USDC/USDT legs, while expected_total and diff_total sum everything.
    let assets = vec![
        row(&[
            ("wallet", json!("w")),
            ("asset", json!("USDT")),
            ("quantity", json!(100)),
        ]),
        row(&[
            ("wallet", json!("w")),
            ("asset", json!("ETH")),
            ("quantity", json!(2)),
        ]),
    ];
    let (rows, _) = reconcile(&assets, &[], vec![]);
    let summary = summary_map(&rows);
    let w = &summary["w"];
    assert_eq!(w["current_total"], json!(100.0), "only the stablecoin leg");
    // expected comes from TRANSACTIONS ONLY, so with no transactions it is 0 and
    // the ETH leg contributes a +2 disagreement to diff_total.
    assert_eq!(
        w["expected_total"],
        json!(0.0),
        "expected is transaction-derived"
    );
    assert_eq!(w["diff_total"], json!(102.0), "current - expected, per row");
}

// --- the wire body ---------------------------------------------------------

#[test]
fn the_body_carries_rows_wallets_summary_and_its_source() {
    let (rows, wallets) = reconcile(
        &[row(&[
            ("wallet", json!("w")),
            ("asset", json!("USDT")),
            ("quantity", json!(1)),
        ])],
        &[],
        vec![json!({"address": "0xdead", "label": "hot"})],
    );
    let summary = summary_map(&rows);
    let b = body(&rows, &wallets, &summary, "rust");
    assert_eq!(b["source"], json!("rust"));
    assert_eq!(b["rows"][0]["wallet"], json!("w"));
    assert_eq!(b["rows"][0]["asset"], json!("USDT"));
    assert_eq!(b["wallets"][0]["label"], json!("hot"));
    assert_eq!(b["walletSummary"]["w"]["expected_total"], json!(0.0));
    // Every ReconRow field must be present, in the route's names.
    for k in [
        "wallet", "asset", "current", "in_sum", "out_sum", "expected", "diff",
    ] {
        assert!(b["rows"][0].get(k).is_some(), "row key {k} missing");
    }
}

#[test]
fn a_recon_row_round_trips_through_the_body() {
    let r = ReconRow {
        wallet: "w".into(),
        asset: "USDT".into(),
        current: 1.5,
        in_sum: 2.0,
        out_sum: 0.25,
        expected: 1.75,
        diff: -0.25,
    };
    let b = body(&[r.clone()], &[], &json!({}), "rust");
    let row = &b["rows"][0];
    assert_eq!(row["current"], json!(1.5));
    assert_eq!(row["in_sum"], json!(2.0));
    assert_eq!(row["out_sum"], json!(0.25));
    assert_eq!(row["expected"], json!(1.75));
    assert_eq!(row["diff"], json!(-0.25));
}

// --- routing ---------------------------------------------------------------

#[tokio::test]
async fn routing_table_refuses_everything_it_does_not_serve() {
    // A Db that can never be reached: these assertions are about the ROUTER, so
    // they must not depend on a live database. `/healthz` and `/api/reconcile`
    // therefore answer 500 here (loud, with the real reason) rather than 200,
    // which is itself the rule under test.
    let db = fudcourt_sync::persistence::db::Db::unreachable();
    let (st, body) = route(&db, "POST", "/api/reconcile").await;
    assert_eq!(st, 405);
    assert_eq!(body["error"], json!("method not allowed"));

    let (st, body) = route(&db, "GET", "/nope").await;
    assert_eq!(st, 404);
    assert_eq!(body["error"], json!("not found"));

    let (st, body) = route(&db, "DELETE", "/healthz").await;
    assert_eq!(st, 405);
    assert_eq!(body["error"], json!("method not allowed"));

    // A database that cannot be reached is a 500 with a reason, never a 200
    // carrying an empty reconciliation.
    let (st, body) = route(&db, "GET", "/api/reconcile").await;
    assert_eq!(
        st, 500,
        "an unreachable database must not read as 'all reconciled'"
    );
    assert!(
        body.get("error").is_some(),
        "the 500 must name the real reason"
    );
    assert!(
        body.get("rows").is_none(),
        "no payload may accompany a failure"
    );
}
