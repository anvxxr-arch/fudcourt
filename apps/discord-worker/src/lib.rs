//! fudcourt Discord worker — the durable job runtime.
//!
//! Boundaries:
//! - [`config`]: bootstrap/secrets from the environment (nothing operational).
//! - [`storage`]: the connection pool and the job-table SQL.
//! - [`jobs`]: the lifecycle (status, disposition, retry policy, identity) and
//!   the runner loop.
//! - [`handlers`]: the `kind` -> code table.
//! - [`locks`]: an OPTIONAL Valkey advisory lock, never a correctness mechanism.
//! - [`health`]: `/healthz` and `/readyz`.

pub mod config;
pub mod handlers;
pub mod health;
pub mod jobs;
pub mod locks;
pub mod logging;
pub mod storage;
