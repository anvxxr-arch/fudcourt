//! Persistence: the Turso write path.
//!
//! Today that is one module — the HTTP pipeline client (`db`) that speaks the
//! same protocol as the Python original's `db()` helper.
pub mod db;
