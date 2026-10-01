//! Library surface of the fudcourt Rust services.
//!
//! Two binaries share it:
//!   * `fudcourt-sync`        -- the 5-minute balance sync (batch, DR-010)
//!   * `fudcourt-reconciled`  -- the `/api/reconcile` HTTP service (DR-014)
//!
//! The tree is grouped by event-pipeline capability, each directory named after
//! the stage it owns:
//!   * `streams`         -- realtime ingestion of venue state (the balance sync)
//!   * `persistence`     -- the Turso write path
//!   * `reconciliation`  -- reconcile maths + its HTTP surface
//!
//! `pyfmt` (CPython-exact float rendering), `oracle` (the Python-parity replay
//! seam), `chains` (the chain/wallet/price-oracle registry) and `jsonrpc` (the
//! JSON-RPC client with the retry/honesty rules) stay at the crate root: they are
//! cross-cutting primitives the sync binary and the parity gate both reach for,
//! not a pipeline stage of one binary.
//!
//! A capability directory is only created when a real module moves into it;
//! `telemetry/`, `config/`, `events/`, `exchanges/` and `normalization/` have no
//! matching code in this crate today and are deliberately absent.
pub mod chains;
pub mod jsonrpc;
pub mod oracle;
pub mod persistence;
pub mod pyfmt;
pub mod reconciliation;
pub mod streams;
