//! The job lifecycle: what a handler reports, and where the job lands next.
//!
//! The decision table is a pure function so the two rules that matter most —
//! "do not retry a permanent error" and "do not retry forever" — are unit-tested
//! without a database or a clock.

pub mod backoff;
pub mod identity;
pub mod runner;

pub use backoff::Backoff;

/// A job's lifecycle state. Mirrors the `jobs.status` CHECK constraint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Pending,
    Running,
    Done,
    Failed,
    Dead,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Running => "running",
            Status::Done => "done",
            Status::Failed => "failed",
            Status::Dead => "dead",
        }
    }

    /// Map a `jobs.status` value from the database back to the enum. An
    /// unrecognised value is treated as `Pending` — the safe reading, since it
    /// means the job is still eligible to run rather than silently dropped.
    pub fn from_db(value: &str) -> Self {
        match value {
            "running" => Status::Running,
            "done" => Status::Done,
            "failed" => Status::Failed,
            "dead" => Status::Dead,
            _ => Status::Pending,
        }
    }
}

/// What a handler reported about one attempt.
#[derive(Debug, Clone)]
pub enum Disposition {
    /// The work is done.
    Done,
    /// A transient failure: retry later with backoff, unless attempts are spent.
    Retryable(String),
    /// A failure that retrying cannot fix (bad payload, deleted target):
    /// the job goes straight to `dead` and is never attempted again.
    Permanent(String),
}

/// The status a job lands in after an attempt, given the attempt count that
/// includes the attempt just finished.
///
/// `attempts >= max_attempts` on a retryable failure is what turns a hopeless
/// job into `dead` — the job is not silently dropped, it is parked where the
/// dashboard can show it and an operator can re-arm it.
pub fn next_status(attempts: u32, max_attempts: u32, disposition: &Disposition) -> Status {
    match disposition {
        Disposition::Done => Status::Done,
        Disposition::Permanent(_) => Status::Dead,
        Disposition::Retryable(_) => {
            if attempts >= max_attempts {
                Status::Dead
            } else {
                Status::Pending
            }
        }
    }
}

/// One claimed job, as handed to a handler. `attempts` already counts the claim
/// that produced this value.
#[derive(Debug, Clone)]
pub struct ClaimedJob {
    pub id: i64,
    pub guild_id: String,
    pub kind: String,
    pub dedupe_key: String,
    pub payload: serde_json::Value,
    pub attempts: u32,
    pub max_attempts: u32,
}

/// One enqueue request. `delay_secs == 0` means "claimable immediately".
#[derive(Debug, Clone)]
pub struct NewJob {
    pub guild_id: String,
    pub kind: String,
    pub dedupe_key: String,
    pub payload: serde_json::Value,
    pub delay_secs: i64,
    pub max_attempts: u32,
}

impl NewJob {
    /// A job for `kind` with an empty guild, no delay and the default attempt cap.
    pub fn new(kind: impl Into<String>, dedupe_key: impl Into<String>) -> Self {
        Self {
            guild_id: String::new(),
            kind: kind.into(),
            dedupe_key: dedupe_key.into(),
            payload: serde_json::Value::Object(Default::default()),
            delay_secs: 0,
            max_attempts: 5,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn done_is_terminal() {
        assert_eq!(next_status(1, 5, &Disposition::Done), Status::Done);
    }

    #[test]
    fn a_permanent_error_is_never_retried() {
        // Even with attempts left, a permanent failure is final.
        assert_eq!(
            next_status(1, 5, &Disposition::Permanent("bad payload".into())),
            Status::Dead
        );
    }

    #[test]
    fn a_retryable_error_goes_back_to_pending_while_attempts_remain() {
        assert_eq!(
            next_status(1, 5, &Disposition::Retryable("timeout".into())),
            Status::Pending
        );
        assert_eq!(
            next_status(4, 5, &Disposition::Retryable("timeout".into())),
            Status::Pending
        );
    }

    #[test]
    fn a_retryable_error_on_the_last_attempt_dies_rather_than_looping() {
        assert_eq!(
            next_status(5, 5, &Disposition::Retryable("timeout".into())),
            Status::Dead
        );
        assert_eq!(
            next_status(9, 5, &Disposition::Retryable("timeout".into())),
            Status::Dead
        );
    }
}
