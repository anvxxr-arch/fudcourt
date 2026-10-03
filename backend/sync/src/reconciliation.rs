//! Reconciliation: the pure reconcile maths and the HTTP surface serving it.
//!
//! `reconcile` holds the projection (Postgres reads + accumulation rules) and
//! `server` is the bounded HTTP/1.1 delivery surface for `/api/reconcile`
//! (DR-014). Both are the whole codebase of the `fudcourt-reconciled` binary.
pub mod reconcile;
pub mod server;
