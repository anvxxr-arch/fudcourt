//! Persistence: the Postgres write path.
//!
//! Today that is one module — the client (`db`) that reads and writes the
//! system of record, the same role the Python original's `db()` helper plays.
pub mod db;
