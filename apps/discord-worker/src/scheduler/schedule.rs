//! Schedule arithmetic: when the next occurrence is, in an explicit timezone.
//!
//! Every definition carries a timezone, so the answer cannot be computed in UTC and
//! labelled. The `cron` crate has no notion of a zone, so the cron path reads the
//! current wall-clock in the target zone, feeds that as though it were UTC, takes
//! the next match, and then resolves the resulting naive wall-clock back into the
//! zone. DST therefore becomes a boundary decision that [`resolve_local`] makes
//! explicitly instead of leaving to chance.
//!
//! **No backfill, by decision.** `next_after` always computes the next occurrence
//! strictly after `now`, so a worker that was down for an hour resumes at the next
//! scheduled time instead of dumping every missed occurrence at once. For a bot
//! that posts reminders and digests, a burst of stale messages is a worse failure
//! than a skipped one, and the idempotency guarantees below do not depend on it.

use std::str::FromStr;

use chrono::{DateTime, Duration, LocalResult, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;

use crate::scheduler::ScheduleKind;

/// The longest DST transition gap in the tz database is two hours (Lord Howe is 30
/// minutes, most zones an hour); three hours of head-room covers any zone even if a
/// future transition widens.
const MAX_GAP_MINUTES: i64 = 180;

/// A parsed, ready-to-evaluate schedule.
#[derive(Debug, Clone, PartialEq)]
pub enum Schedule {
    /// Fires once at an absolute instant.
    Once(DateTime<Utc>),
    /// Fires every N seconds, counted from the previous occurrence.
    Interval(i64),
    /// Fires on a cron expression, evaluated in the definition's timezone.
    Cron(Box<cron::Schedule>),
}

impl Schedule {
    /// Build a schedule from the stored `schedule_kind` / `schedule_expr` /
    /// `timezone` triple. Every failure is a message a human can act on, because
    /// the dashboard shows it verbatim.
    pub fn parse(kind: ScheduleKind, expr: &str, timezone: &str) -> Result<Self, String> {
        let expr = expr.trim();
        if expr.is_empty() {
            return Err("schedule expression is empty".to_string());
        }
        // Validate the zone even for schedules that do not need it, so a typo is
        // rejected at write time rather than silently ignored forever.
        timezone
            .parse::<Tz>()
            .map_err(|_| format!("unknown timezone `{timezone}`"))?;

        match kind {
            ScheduleKind::Once => {
                let at = DateTime::parse_from_rfc3339(expr)
                    .map_err(|e| format!("`{expr}` is not an RFC 3339 timestamp: {e}"))?
                    .with_timezone(&Utc);
                Ok(Schedule::Once(at))
            }
            ScheduleKind::Interval => {
                let secs: i64 = expr
                    .parse()
                    .map_err(|_| format!("`{expr}` is not a whole number of seconds"))?;
                if secs < 1 {
                    return Err(format!("interval must be at least 1 second, got {secs}"));
                }
                Ok(Schedule::Interval(secs))
            }
            ScheduleKind::Cron => {
                // The `cron` crate counts a leading SECONDS field, so a standard
                // 5-field crontab ("0 9 * * *") is rejected as malformed. The
                // 5-field form is what every human and every crontab on the box
                // writes, and it is what the dashboard's cron field will collect,
                // so seconds are supplied here rather than pushed onto whoever
                // writes the schedule.
                let normalized = match expr.split_whitespace().count() {
                    5 => format!("0 {expr}"),
                    6 | 7 => expr.to_string(),
                    other => {
                        return Err(format!(
                            "`{expr}` has {other} fields; expected 5 (min hour dom mon dow) \
                             or 6/7 with a leading seconds field"
                        ))
                    }
                };
                let schedule = cron::Schedule::from_str(&normalized)
                    .map_err(|e| format!("`{expr}` is not a cron expression: {e}"))?;
                Ok(Schedule::Cron(Box::new(schedule)))
            }
        }
    }

    /// The next occurrence strictly after `now`, or `None` when there is none (a
    /// `once` schedule already in the past).
    pub fn next_after(
        &self,
        now: DateTime<Utc>,
        timezone: Tz,
    ) -> Result<Option<DateTime<Utc>>, String> {
        match self {
            Schedule::Once(at) => Ok((*at > now).then_some(*at)),
            // Anchored on `now` on purpose: the grid restarts from the last
            // materialization, so downtime shortens nothing and duplicates nothing.
            Schedule::Interval(secs) => Ok(Some(now + Duration::seconds(*secs))),
            Schedule::Cron(schedule) => {
                let now_local = now.with_timezone(&timezone).naive_local();
                // Feed the local wall-clock through the parser as if it were UTC:
                // the expression is matched against wall-clock fields, not instants.
                let as_utc = Utc.from_utc_datetime(&now_local);
                match schedule.after(&as_utc).next() {
                    // Hand back the naive value: it is a wall-clock reading, not an
                    // instant, until `resolve_local` says which instant it means.
                    Some(next) => resolve_local(timezone, next.naive_utc()).map(Some),
                    None => Err(format!(
                        "cron expression has no future occurrence after {now_local}"
                    )),
                }
            }
        }
    }
}

/// Turn a wall-clock reading in `timezone` into an instant, with an explicit policy
/// for the two days a year that are not 24 hours long.
///
/// - **Unambiguous**: use it.
/// - **Ambiguous** (fall-back, the same wall-clock happens twice): take the
///   **earliest** instant, so the choice is deterministic and a schedule can never
///   drift a day because a DST change made it unrecognisable.
/// - **Nonexistent** (spring-forward gap): the wall-clock does not exist, so
///   advance to the first instant at which it does. Firing at the gap's end is the
///   only outcome that neither skips the occurrence silently nor invents a time.
pub fn resolve_local(timezone: Tz, naive: NaiveDateTime) -> Result<DateTime<Utc>, String> {
    match timezone.from_local_datetime(&naive) {
        LocalResult::Single(dt) => Ok(dt.with_timezone(&Utc)),
        LocalResult::Ambiguous(earliest, _latest) => Ok(earliest.with_timezone(&Utc)),
        LocalResult::None => {
            for minutes in 1..=MAX_GAP_MINUTES {
                let candidate = naive + Duration::minutes(minutes);
                if let LocalResult::Single(dt) = timezone.from_local_datetime(&candidate) {
                    return Ok(dt.with_timezone(&Utc));
                }
            }
            Err(format!(
                "no instant exists near {naive} in {timezone} (DST gap wider than {MAX_GAP_MINUTES} minutes)"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    fn zone(name: &str) -> Tz {
        name.parse().expect("test zone must exist")
    }

    fn cron(expr: &str) -> Schedule {
        Schedule::parse(ScheduleKind::Cron, expr, "UTC").unwrap()
    }

    #[test]
    fn a_once_schedule_fires_at_its_instant() {
        let s =
            Schedule::parse(ScheduleKind::Once, "2026-06-01T02:00:00Z", "Asia/Jakarta").unwrap();
        assert_eq!(
            s.next_after(utc(2026, 5, 31, 0, 0), zone("Asia/Jakarta"))
                .unwrap(),
            Some(utc(2026, 6, 1, 2, 0))
        );
    }

    #[test]
    fn a_once_schedule_in_the_past_has_no_next_occurrence() {
        let s = Schedule::parse(ScheduleKind::Once, "2026-06-01T02:00:00Z", "UTC").unwrap();
        assert_eq!(
            s.next_after(utc(2026, 6, 2, 0, 0), zone("UTC")).unwrap(),
            None
        );
    }

    #[test]
    fn an_interval_restarts_from_now_so_downtime_never_backfills() {
        // Down for a week: the next occurrence is one interval away, not 604_800.
        let s = Schedule::parse(ScheduleKind::Interval, "300", "UTC").unwrap();
        let now = utc(2026, 6, 1, 0, 0);
        assert_eq!(
            s.next_after(now, zone("UTC")).unwrap(),
            Some(utc(2026, 6, 1, 0, 5))
        );
    }

    #[test]
    fn a_cron_fires_at_the_wall_clock_of_its_declared_zone() {
        // 09:00 in WIB (UTC+7) is 02:00 UTC. Computing in UTC would have fired at
        // 09:00 UTC — seven hours late for everyone reading the schedule.
        let s = cron("0 9 * * *");
        assert_eq!(
            s.next_after(utc(2026, 6, 1, 0, 0), zone("Asia/Jakarta"))
                .unwrap(),
            Some(utc(2026, 6, 1, 2, 0))
        );
    }

    #[test]
    fn the_same_expression_in_two_zones_is_two_different_instants() {
        let s = cron("0 9 * * *");
        let utc_next = s.next_after(utc(2026, 6, 1, 0, 0), zone("UTC")).unwrap();
        let wib_next = s
            .next_after(utc(2026, 6, 1, 0, 0), zone("Asia/Jakarta"))
            .unwrap();
        assert_ne!(utc_next, wib_next, "the timezone must change the answer");
        assert_eq!(utc_next, Some(utc(2026, 6, 1, 9, 0)));
    }

    #[test]
    fn a_cron_runs_on_the_local_calendar_not_a_fixed_offset() {
        // 09:00 WIB the day after a US DST change is still 09:00 WIB: the offset of
        // the SCHEDULE's zone is what matters, and Jakarta has no DST at all.
        let s = cron("0 9 * * *");
        let next = s
            .next_after(utc(2026, 3, 7, 3, 0), zone("Asia/Jakarta"))
            .unwrap()
            .unwrap();
        assert_eq!(next, utc(2026, 3, 8, 2, 0));
    }

    #[test]
    fn a_wall_clock_inside_the_spring_forward_gap_lands_at_the_gap_end() {
        // America/New_York, 2026-03-08: 02:00 -> 03:00, so 02:30 never happens.
        // The occurrence must not be dropped and must not invent a time: it fires
        // the moment the clock reaches 03:00 EDT (= 07:00 UTC).
        let s = cron("30 2 * * *");
        let next = s
            .next_after(utc(2026, 3, 8, 5, 0), zone("America/New_York"))
            .unwrap()
            .unwrap();
        assert_eq!(next, utc(2026, 3, 8, 7, 0));
    }

    #[test]
    fn a_wall_clock_inside_the_fall_back_hour_takes_the_first_occurrence() {
        // America/New_York, 2026-11-01: 01:30 happens twice. Picking the first
        // (EDT, 05:30 UTC) keeps the choice deterministic, so a schedule can never
        // silently drift an hour because a DST change made it ambiguous.
        let s = cron("30 1 * * *");
        let next = s
            .next_after(utc(2026, 11, 1, 4, 0), zone("America/New_York"))
            .unwrap()
            .unwrap();
        assert_eq!(next, utc(2026, 11, 1, 5, 30));
    }

    #[test]
    fn an_unknown_timezone_is_rejected_by_name() {
        let err = Schedule::parse(ScheduleKind::Cron, "0 9 * * *", "Mars/Olympus").unwrap_err();
        assert!(err.contains("Mars/Olympus"), "got: {err}");
    }

    #[test]
    fn a_malformed_expression_names_what_was_wrong_with_it() {
        let cases = [
            (ScheduleKind::Once, "tomorrow", "RFC 3339"),
            (ScheduleKind::Interval, "hourly", "whole number of seconds"),
            (ScheduleKind::Interval, "0", "at least 1 second"),
            (ScheduleKind::Cron, "99 99 * * *", "cron expression"),
        ];
        for (kind, expr, expected) in cases {
            let err = Schedule::parse(kind, expr, "UTC").unwrap_err();
            assert!(
                err.contains(expected),
                "`{expr}` should have mentioned {expected}, got: {err}"
            );
        }
    }

    #[test]
    fn an_empty_expression_is_rejected_before_it_reaches_the_parser() {
        let err = Schedule::parse(ScheduleKind::Cron, "   ", "UTC").unwrap_err();
        assert!(err.contains("empty"), "got: {err}");
    }

    #[test]
    fn a_cron_with_no_future_occurrence_is_an_error_not_a_silent_stop() {
        // 31 February never happens; the definition must say so rather than going
        // quiet and looking healthy.
        let s = cron("0 0 31 2 *");
        let err = s
            .next_after(utc(2026, 1, 1, 0, 0), zone("UTC"))
            .unwrap_err();
        assert!(err.contains("no future occurrence"), "got: {err}");
    }

    #[test]
    fn a_five_field_crontab_is_accepted_and_means_the_same_as_seconds_zero() {
        // "0 9 * * *" and "0 0 9 * * *" must be the same schedule: the first is
        // what a human writes, the second is what the parser demands.
        let five = Schedule::parse(ScheduleKind::Cron, "0 9 * * *", "UTC").unwrap();
        let six = Schedule::parse(ScheduleKind::Cron, "0 0 9 * * *", "UTC").unwrap();
        let now = utc(2026, 6, 1, 0, 0);
        assert_eq!(
            five.next_after(now, zone("UTC")).unwrap(),
            six.next_after(now, zone("UTC")).unwrap()
        );
    }

    #[test]
    fn a_field_count_that_is_neither_five_nor_six_or_seven_is_named() {
        let err = Schedule::parse(ScheduleKind::Cron, "0 9 * *", "UTC").unwrap_err();
        assert!(err.contains("has 4 fields"), "got: {err}");
    }
}
