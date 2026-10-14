//! Persistence: the connection pool and the job tables.

pub mod db;
pub mod jobs;

pub use db::{Pool, Session};
