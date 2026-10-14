//! The scheduler: durable, timezone-explicit, restart-safe.
//!
//! A definition (`scheduled_jobs`) is *materialized* into an ordinary job
//! (`jobs`). That single decision is what makes the rest fall out for free: the
//! claim path is already atomic, retry/backoff already exists, a dead job is
//! already parked rather than spun on, and `job_runs` is already the execution
//! log. The scheduler adds no second delivery mechanism and no second source of
//! truth for status.
//!
//! Idempotency is enforced twice, both in the database:
//! 1. `scheduled_job_runs (definition_id, occurrence_at)` — an occurrence can be
//!    materialized once, even across a restart or two racing workers.
//! 2. `jobs (guild_id, kind, dedupe_key)` — where the key encodes the occurrence.
//!
//! The reaper, the drain and the backoff are all the phase-9 runtime's.

pub mod message;
pub mod schedule;
pub mod store;
pub mod tick;

pub use schedule::Schedule;

/// Which schedule shape a definition uses. Stored as text and constrained by a
/// CHECK on the table, so an unknown value cannot reach this enum from the
/// database; `from_db` still has to answer, and answers conservatively.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleKind {
    Once,
    Interval,
    Cron,
}

impl ScheduleKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScheduleKind::Once => "once",
            ScheduleKind::Interval => "interval",
            ScheduleKind::Cron => "cron",
        }
    }

    /// Parse what the dashboard sent. Returns a message the UI can show.
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "once" => Ok(ScheduleKind::Once),
            "interval" => Ok(ScheduleKind::Interval),
            "cron" => Ok(ScheduleKind::Cron),
            other => Err(format!(
                "unknown schedule kind `{other}` (expected one of: once, interval, cron)"
            )),
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "once" => ScheduleKind::Once,
            "interval" => ScheduleKind::Interval,
            // A cron expression is the only shape that repeats on a wall clock, and
            // the CHECK constraint means `cron` is what is left.
            _ => ScheduleKind::Cron,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_kinds_round_trip() {
        for kind in [
            ScheduleKind::Once,
            ScheduleKind::Interval,
            ScheduleKind::Cron,
        ] {
            assert_eq!(ScheduleKind::from_db(kind.as_str()), kind);
            assert_eq!(ScheduleKind::parse(kind.as_str()).unwrap(), kind);
        }
    }

    #[test]
    fn schedule_kind_parsing_is_case_and_whitespace_insensitive() {
        assert_eq!(ScheduleKind::parse("  CRON ").unwrap(), ScheduleKind::Cron);
    }

    #[test]
    fn an_unknown_schedule_kind_names_the_alternatives() {
        let err = ScheduleKind::parse("every-day").unwrap_err();
        assert!(err.contains("once, interval, cron"), "got: {err}");
    }
}
