//! Library surface of the fudcourt Rust services.
//!
//! Two binaries share it:
//!   * `fudcourt-sync`        -- the 5-minute balance sync (batch, DR-010)
//!   * `fudcourt-reconciled`  -- the `/api/reconcile` HTTP service (DR-014)
//!
//! Modules live at the crate root rather than under a `mod` tree because the
//! first binary grew them that way and a second consumer is no reason to move a
//! working file. What belongs here is the code both binaries can use: the Turso
//! pipeline client (`db`), CPython-exact float rendering (`pyfmt`), and now the
//! reconciliation maths + its HTTP surface (`reconcile`, `server`).
pub mod db;
pub mod pyfmt;
pub mod reconcile;
pub mod server;
