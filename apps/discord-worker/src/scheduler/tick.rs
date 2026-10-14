//! The tick: materialize the occurrences that are due, then get out of the way.
//!
//! **The tick schedules its own successor first.** The next tick's identity is
//! derived from this tick's own scheduled time (`scheduled_at + interval`), not from
//! `now`, so a retry of the same tick produces the same key and collides instead of
//! forking a second chain. Enqueueing the successor *before* doing any work means a
//! tick that panics, hangs or dead-letters cannot break the chain — the next tick is
//! already in the queue, and if the worker was down past its `run_at` it is simply
//! claimed as soon as the worker starts.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;

use crate::handlers::{HandlerFuture, JobHandler};
use crate::jobs::{ClaimedJob, Disposition, NewJob};
use crate::logging::{self, fields as log_fields};
use crate::scheduler::schedule::Schedule;
use crate::scheduler::store::{self, Materialized};
use crate::storage::{jobs, Pool};

/// The job kind the runner registers for the tick.
pub const TICK_KIND: &str = "scheduler.tick";

/// How many due definitions one tick will materialize. Bounded so a tick cannot run
/// unboundedly long; anything left over is picked up by the next tick, and the
/// ledger means nothing is materialized twice in the meantime.
pub const TICK_BATCH: i64 = 200;

/// The deterministic identity of a tick occurrence.
pub fn tick_key(scheduled_at: DateTime<Utc>) -> String {
    format!("tick:{}", scheduled_at.timestamp_millis())
}

/// The deterministic identity of a materialized definition occurrence.
pub fn occurrence_key(definition_id: i64, occurrence: DateTime<Utc>) -> String {
    format!("sched:{definition_id}:{}", occurrence.timestamp_millis())
}

/// What one tick did. Returned so the caller (and the tests) can assert on it
/// rather than on log output.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TickReport {
    /// Definitions examined.
    pub examined: u32,
    /// Occurrences newly turned into jobs.
    pub materialized: u32,
    /// Occurrences that were already materialized (re-tick, race, or a restart
    /// between materializing and advancing). Harmless.
    pub already_done: u32,
    /// Definitions whose schedule could not be evaluated this tick.
    pub failed: u32,
    /// Definitions that had no anchor and were given one. Nothing was delivered:
    /// this is the first occurrence being computed, not an occurrence firing.
    pub anchored: u32,
}

pub struct Tick {
    pool: Pool,
    interval_secs: i64,
}

impl Tick {
    pub fn new(pool: Pool, interval_secs: i64) -> Arc<Self> {
        Arc::new(Self {
            pool,
            interval_secs,
        })
    }

    /// The payload for a tick scheduled at `scheduled_at`.
    pub fn payload(&self, scheduled_at: DateTime<Utc>) -> serde_json::Value {
        serde_json::json!({
            "scheduled_at": scheduled_at.to_rfc3339(),
            "interval_secs": self.interval_secs,
        })
    }

    /// Queue a tick at `scheduled_at`. Idempotent: the key is the scheduled time, so
    /// asking twice for the same tick enqueues once.
    pub async fn enqueue_tick(
        &self,
        guild_id: &str,
        scheduled_at: DateTime<Utc>,
    ) -> Result<bool, String> {
        let session = self.pool.acquire().await?;
        let job = NewJob {
            guild_id: guild_id.to_string(),
            kind: TICK_KIND.to_string(),
            dedupe_key: tick_key(scheduled_at),
            payload: self.payload(scheduled_at),
            delay_secs: (scheduled_at - Utc::now()).num_seconds().max(0),
            max_attempts: 3,
        };
        let id = jobs::enqueue(session.client(), &job).await?;
        Ok(id.is_some())
    }

    /// Materialize every due definition.
    pub async fn run_once(&self, now: DateTime<Utc>) -> Result<TickReport, String> {
        let session = self.pool.acquire().await?;
        let definitions = store::due(session.client(), TICK_BATCH).await?;
        let mut report = TickReport {
            examined: definitions.len() as u32,
            ..Default::default()
        };

        for definition in definitions {
            let outcome = self
                .materialize_one(session.client(), &definition, now)
                .await;
            match outcome {
                Ok(Materialized::Fresh) => report.materialized += 1,
                Ok(Materialized::AlreadyDone) => report.already_done += 1,
                Ok(Materialized::Anchored) => report.anchored += 1,
                Err(error) => {
                    report.failed += 1;
                    // Leave `next_run_at` exactly as it was: the definition stays due
                    // and is retried on the next tick, `attempts` climbs, and once it
                    // reaches `max_attempts` `advance` parks it. A broken schedule
                    // therefore costs one evaluation per tick, not a spin, and lands
                    // in front of a human with `last_error` set.
                    if let Err(e) = store::advance(
                        session.client(),
                        definition.id,
                        definition.next_run_at,
                        "error",
                        Some(&error),
                        false,
                    )
                    .await
                    {
                        logging::error(
                            "could not record a scheduler failure",
                            log_fields(vec![
                                ("definition", definition.id.into()),
                                ("error", e.into()),
                            ]),
                        );
                    }
                }
            }
        }
        Ok(report)
    }

    async fn materialize_one(
        &self,
        client: &tokio_postgres::Client,
        definition: &store::Definition,
        now: DateTime<Utc>,
    ) -> Result<Materialized, String> {
        let timezone: Tz = definition
            .timezone
            .parse()
            .map_err(|_| format!("unknown timezone `{}`", definition.timezone))?;
        let schedule = Schedule::parse(
            definition.schedule_kind,
            &definition.schedule_expr,
            &definition.timezone,
        )?;
        // No anchor yet, so there is no occurrence to materialize: this tick computes
        // the FIRST one and stores it. The process that writes definitions (the Go api
        // behind the dashboard) has no timezone database and no cron parser, so it
        // leaves `next_run_at` NULL rather than growing a second implementation of
        // "next occurrence" that could disagree with this one — the tick is the only
        // place a schedule is ever evaluated, which is what makes the dashboard's
        // "next run" the same answer the worker acts on.
        let Some(occurrence) = definition.next_run_at else {
            let next = schedule.next_after(now, timezone)?.ok_or_else(|| {
                "no future occurrence to anchor: a `once` instant that has already passed is \
                 skipped, not fired late"
                    .to_string()
            })?;
            store::anchor(client, definition.id, next).await?;
            return Ok(Materialized::Anchored);
        };

        let key = occurrence_key(definition.id, occurrence);
        let outcome = store::materialize(client, definition, occurrence, &key).await?;

        let next = schedule.next_after(now, timezone)?;
        // A `once` schedule that has fired has no successor: retire it rather than
        // leaving a row that is permanently not-due.
        let disable = matches!(schedule, Schedule::Once(_)) && next.is_none();
        store::advance(client, definition.id, next, "ok", None, disable).await?;
        Ok(outcome)
    }
}

/// The runner entry point: it is a handler like any other, so scheduled work is
/// claimed, retried and dead-lettered by exactly the same code as everything else.
pub fn handler(tick: Arc<Tick>, guild_id: String) -> Arc<dyn JobHandler> {
    // The return type is spelled out because it is a `dyn` future: without it the
    // closure returns a concrete `async` block and cannot be coerced into the
    // handler table. Everything captured here is owned, so `'static` is honest.
    Arc::new(move |job: ClaimedJob| -> HandlerFuture {
        let tick = Arc::clone(&tick);
        let guild_id = guild_id.clone();
        Box::pin(async move {
            let scheduled_at = job
                .payload
                .get("scheduled_at")
                .and_then(|v| v.as_str())
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(Utc::now);
            let interval = job
                .payload
                .get("interval_secs")
                .and_then(|v| v.as_i64())
                .unwrap_or(tick.interval_secs);

            // Successor FIRST: nothing below can break the chain.
            let next_at = scheduled_at + Duration::seconds(interval);
            if let Err(e) = tick.enqueue_tick(&guild_id, next_at).await {
                return Disposition::Retryable(format!("could not schedule the next tick: {e}"));
            }

            match tick.run_once(Utc::now()).await {
                Ok(report) => {
                    logging::info_map(
                        "scheduler tick",
                        log_fields(vec![
                            ("examined", report.examined.into()),
                            ("materialized", report.materialized.into()),
                            ("already_done", report.already_done.into()),
                            ("anchored", report.anchored.into()),
                            ("failed", report.failed.into()),
                        ]),
                    );
                    // A definition that failed is retried by the NEXT tick, not by
                    // re-running this one, so the tick itself stays successful.
                    Disposition::Done
                }
                Err(e) => Disposition::Retryable(e),
            }
        })
    })
}
