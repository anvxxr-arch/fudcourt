//! fudcourt Discord worker — the durable job runtime.
//!
//! Boundaries:
//! - [`config`]: bootstrap/secrets from the environment (nothing operational).
//! - [`storage`]: the connection pool and the job-table SQL.
//! - [`jobs`]: the lifecycle (status, disposition, retry policy, identity) and
//!   the runner loop.
//! - [`handlers`]: the `kind` -> code table.
//! - [`discord`]: the one Discord REST surface every sender posts through.
//! - [`locks`]: an OPTIONAL Valkey advisory lock, never a correctness mechanism.
//! - [`health`]: `/healthz` and `/readyz`.

pub mod config;
pub mod discord;
pub mod feeds;
pub mod handlers;
pub mod health;
pub mod jobs;
pub mod locks;
pub mod logging;
pub mod scheduler;
pub mod storage;
