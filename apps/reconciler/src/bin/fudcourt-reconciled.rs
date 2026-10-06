//! `fudcourt-reconciled` -- the Rust HTTP service that serves `/api/reconcile`
//! (DR-014).
//!
//! WHY THIS EXISTS: the owner's direction puts the backend on Go *and* Rust.
//! Every acquisition family is Go; the Rust crate owned the 5-minute balance sync
//! (a batch job). This binary is the Rust half of the *serving* surface: one
//! bounded, read-only endpoint with a fully portable contract, so the TS route can
//! proxy to it and the two implementations can be diffed on live data.
//!
//! WHY NO WEB FRAMEWORK: the service needs one route, two methods and a JSON body.
//! `tokio::net::TcpListener` plus a 40-line request reader does that with the
//! crates the crate already depends on, so this port adds NO dependency -- which
//! is the difference between shipping it and shipping a supply-chain decision.
//! The cost is honest and bounded: HTTP/1.1 only, `Content-Length` framing only
//! (no chunked request bodies), one request per connection, and no TLS -- it binds
//! loopback and the Next route is the only client, exactly like the Go sidecar.
//!
//! CONTRACT (frozen; `verify-reconcile.py` asserts it):
//!   GET  /healthz          -> 200 {"ok":true,"service":"reconcile","rows":N}
//!   GET  /api/reconcile    -> 200 the reconciliation body
//!   anything else          -> 404
//!   any non-GET/HEAD verb  -> 405
//!   a database failure     -> 500 {"error":"<real reason>"}  (never a partial board)
//!   no FUDCOURT_PG_URL     -> refuses to START (a missing credential must be
//!                             loud, the same rule the sync binary obeys)

use std::path::{Path, PathBuf};

// The modules live in the crate's library, shared with `fudcourt-sync`.
use fudcourt_reconciler::persistence::db;
use fudcourt_reconciler::reconciliation::server;

/// Walk up from this binary to the repo-root `.env` and export its keys, the same
/// rule the sync binary and the Python oracle use. Never prints a value.
fn load_env() {
    let mut dir: Option<PathBuf> = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    // From target/release/ that is three levels below the crate root; the walk
    // below covers both a `cargo run` layout and an installed binary.
    let mut hops = 0;
    while let Some(d) = dir {
        let env = d.join(".env");
        if env.exists() {
            if let Ok(text) = std::fs::read_to_string(&env) {
                for line in text.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with('#') {
                        continue;
                    }
                    if let Some((k, v)) = line.split_once('=') {
                        if std::env::var_os(k.trim()).is_none() {
                            std::env::set_var(k.trim(), v.trim());
                        }
                    }
                }
            }
            return;
        }
        hops += 1;
        if hops > 8 {
            return;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
}

fn pg_dsn() -> Option<String> {
    std::env::var("FUDCOURT_PG_URL")
        .ok()
        .filter(|t| !t.is_empty())
}

#[tokio::main]
async fn main() {
    load_env();
    let addr = std::env::var("RECONCILE_ADDR").unwrap_or_else(|_| "127.0.0.1:3102".to_string());
    let Some(dsn) = pg_dsn() else {
        // Loud, at startup: a service that silently reconciles against nothing
        // would answer `{rows: []}` and look healthy.
        eprintln!("fudcourt-reconciled: refusing to start: FUDCOURT_PG_URL is not set");
        std::process::exit(2);
    };
    let db = match db::Db::connect(&dsn).await {
        Ok(db) => db,
        Err(e) => {
            eprintln!("fudcourt-reconciled: refusing to start: {e}");
            std::process::exit(2);
        }
    };
    if let Err(e) = server::serve(&addr, db).await {
        eprintln!("fudcourt-reconciled: {e}");
        std::process::exit(1);
    }
}
