//! Realtime ingestion: the balance sync pipeline.
//!
//! `sync` is the ported run — prices -> balances -> Hyperliquid -> projection ->
//! Postgres — driven by the `fudcourt-sync` binary and the Python-parity oracle
//! gate.
pub mod sync;
