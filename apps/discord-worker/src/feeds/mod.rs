//! The feed pipeline: poll an external source, decide what is new, announce it.
//!
//! Three pieces, in the order a poll runs them:
//!
//! 1. [`guard`] — may this URL be fetched at all? A feed URL is untrusted text
//!    and this host has an internal network behind it, so vetting happens before
//!    a socket exists and produces the address that gets connected to.
//! 2. [`parse`] — feed-rs handles RSS 2.0/1.0, Atom and JSON Feed; this module
//!    turns entries into the one shape the ledger stores, including the
//!    **item key** that decides what "already seen" means.
//! 3. [`store`] — the ledger. `feed_items` has a unique key per source, so
//!    "announce it once" is a constraint rather than a promise, and a re-poll
//!    (or a restart mid-poll) inserts nothing.
//!
//! The scheduler drives it: a poll is an ordinary `scheduled_jobs` definition
//! whose `job_kind` is [`POLL_KIND`], so there is still exactly one scheduling
//! mechanism in the worker.

pub mod deliver;
pub mod fetch;
pub mod guard;
pub mod parse;
pub mod poll;
pub mod store;

/// The job kind that polls one source. Its payload is `{"source_id": N}`.
pub const POLL_KIND: &str = "feed.poll";

/// The job kind that announces one item. Its payload is
/// `{"source_id": N, "item_id": N}`, and its `dedupe_key` is
/// `feed.deliver:{source_id}:{item_id}` — per item, so a re-poll (which inserts
/// no new row) cannot queue a second announcement, while a later item still can.
pub const DELIVER_KIND: &str = "feed.deliver";

/// What a poll decided to do, for the log line and the tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    /// The source served 304 for our validators: nothing was parsed.
    NotModified,
    /// Deliberately nothing to do, and not a failure — a disabled source, or one
    /// that has been deleted from the dashboard but still owns a queued poll.
    Skipped(String),
    /// Fetched and parsed; `new` items entered the ledger, `known` were already
    /// in it, `filtered` were dropped by the include/exclude rules, and `primed`
    /// were recorded silently because this was the source's first poll.
    Changed {
        new: usize,
        known: usize,
        filtered: usize,
        primed: usize,
    },
}
