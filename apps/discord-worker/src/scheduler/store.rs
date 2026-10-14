//! Scheduler persistence: definitions, the due scan, and materialization.
//!
//! Every write here is one statement. Materialization is a single data-modifying
//! CTE that inserts the occurrence ledger row, the job row, and the link between
//! them — so an occurrence is either fully materialized or not at all, with no
//! window in which the process could die between two statements.

use chrono::{DateTime, Utc};
use tokio_postgres::Client;

use crate::scheduler::ScheduleKind;

/// A schedule definition, as stored.
#[derive(Debug, Clone)]
pub struct Definition {
    pub id: i64,
    pub guild_id: String,
    pub name: String,
    pub job_kind: String,
    pub schedule_kind: ScheduleKind,
    pub schedule_expr: String,
    pub timezone: String,
    pub payload: serde_json::Value,
    pub enabled: bool,
    pub next_run_at: Option<DateTime<Utc>>,
    /// Health of the last MATERIALIZATION attempt, not of the delivery: `ok` or
    /// `error`. Delivery outcomes live in `job_runs`, reachable through the
    /// occurrence ledger.
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub attempts: u32,
    pub max_attempts: u32,
}

/// The outcome of one materialization attempt, for the tick loop's bookkeeping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Materialized {
    /// The ledger row and the job row were both created now.
    Fresh,
    /// This occurrence had already been materialized (a re-tick, a race, or a
    /// restart between materializing and advancing). Not an error: advancing the
    /// definition is exactly what has to happen.
    AlreadyDone,
}

const DEFINITION_COLUMNS: &str = "id, guild_id, name, job_kind, schedule_kind, schedule_expr, \
     timezone, payload, enabled, next_run_at, last_status, last_error, attempts, max_attempts";

/// A definition to store. A struct rather than eleven positional arguments: at that
/// width a caller can silently swap two adjacent string fields, and the compiler
/// cannot tell.
#[derive(Debug, Clone)]
pub struct NewDefinition {
    pub guild_id: String,
    pub name: String,
    pub job_kind: String,
    pub schedule_kind: ScheduleKind,
    pub schedule_expr: String,
    pub timezone: String,
    pub payload: serde_json::Value,
    pub enabled: bool,
    pub next_run_at: Option<DateTime<Utc>>,
    pub max_attempts: u32,
}

impl NewDefinition {
    /// Everything the dashboard would collect, with the defaults it would prefill.
    pub fn new(
        guild_id: impl Into<String>,
        name: impl Into<String>,
        schedule_kind: ScheduleKind,
        schedule_expr: impl Into<String>,
    ) -> Self {
        Self {
            guild_id: guild_id.into(),
            name: name.into(),
            job_kind: "discord.message".to_string(),
            schedule_kind,
            schedule_expr: schedule_expr.into(),
            timezone: "UTC".to_string(),
            payload: serde_json::json!({}),
            enabled: true,
            next_run_at: None,
            max_attempts: 5,
        }
    }

    pub fn in_zone(mut self, timezone: impl Into<String>) -> Self {
        self.timezone = timezone.into();
        self
    }

    pub fn with_job_kind(mut self, kind: impl Into<String>) -> Self {
        self.job_kind = kind.into();
        self
    }

    pub fn with_payload(mut self, payload: serde_json::Value) -> Self {
        self.payload = payload;
        self
    }

    pub fn due_at(mut self, at: DateTime<Utc>) -> Self {
        self.next_run_at = Some(at);
        self
    }

    pub fn with_max_attempts(mut self, attempts: u32) -> Self {
        self.max_attempts = attempts;
        self
    }
}

fn row_to_definition(row: &tokio_postgres::Row) -> Definition {
    Definition {
        id: row.get(0),
        guild_id: row.get(1),
        name: row.get(2),
        job_kind: row.get(3),
        schedule_kind: ScheduleKind::from_db(row.get::<_, String>(4).as_str()),
        schedule_expr: row.get(5),
        timezone: row.get(6),
        payload: row.get(7),
        enabled: row.get(8),
        next_run_at: row.get(9),
        last_status: row.get(10),
        last_error: row.get(11),
        attempts: row.get::<_, i32>(12) as u32,
        max_attempts: row.get::<_, i32>(13) as u32,
    }
}

/// Insert or update a definition, keyed by `(guild_id, name)`. `next_run_at` is
/// supplied by the caller, which computed it from the same `now` the tick uses, so
/// there is exactly one definition of "due".
pub async fn upsert(client: &Client, def: &NewDefinition) -> Result<i64, String> {
    let row = client
        .query_one(
            "INSERT INTO scheduled_jobs
                 (guild_id, name, job_kind, schedule_kind, schedule_expr, timezone, payload,
                  enabled, next_run_at, max_attempts)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (guild_id, name) DO UPDATE SET
                 job_kind      = EXCLUDED.job_kind,
                 schedule_kind = EXCLUDED.schedule_kind,
                 schedule_expr = EXCLUDED.schedule_expr,
                 timezone      = EXCLUDED.timezone,
                 payload       = EXCLUDED.payload,
                 enabled       = EXCLUDED.enabled,
                 next_run_at   = EXCLUDED.next_run_at,
                 max_attempts  = EXCLUDED.max_attempts,
                 attempts      = 0,
                 last_error    = NULL,
                 updated_at    = now()
             RETURNING id",
            &[
                &def.guild_id,
                &def.name,
                &def.job_kind,
                &def.schedule_kind.as_str(),
                &def.schedule_expr,
                &def.timezone,
                &def.payload,
                &def.enabled,
                &def.next_run_at,
                &(def.max_attempts as i32),
            ],
        )
        .await
        .map_err(|e| format!("upsert scheduled job: {e}"))?;
    Ok(row.get(0))
}

/// The definitions that are due now, oldest first.
///
/// No `FOR UPDATE SKIP LOCKED` here on purpose: outside an explicit transaction the
/// row lock is released the moment the statement returns, so it would buy nothing
/// and merely look like protection. Exclusivity comes from the occurrence ledger's
/// unique constraint in [`materialize`], which is stronger — it holds across
/// separate statements, separate connections and separate processes.
pub async fn due(client: &Client, limit: i64) -> Result<Vec<Definition>, String> {
    let sql = format!(
        "SELECT {DEFINITION_COLUMNS} FROM scheduled_jobs
         WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now()
         ORDER BY next_run_at, id
         LIMIT $1"
    );
    let rows = client
        .query(&sql, &[&limit])
        .await
        .map_err(|e| format!("scan due scheduled jobs: {e}"))?;
    Ok(rows.iter().map(row_to_definition).collect())
}

/// Read one definition back. Used by the tick to re-read after a race, and by the
/// dashboard-facing API later.
pub async fn by_id(client: &Client, id: i64) -> Result<Option<Definition>, String> {
    let sql = format!("SELECT {DEFINITION_COLUMNS} FROM scheduled_jobs WHERE id = $1");
    let row = client
        .query_opt(&sql, &[&id])
        .await
        .map_err(|e| format!("read scheduled job: {e}"))?;
    Ok(row.as_ref().map(row_to_definition))
}

/// Materialize one occurrence into the job queue.
///
/// Three writes, one statement, two independent unique constraints:
/// - the ledger insert (`definition_id, occurrence_at`) makes the occurrence unique
///   even across a restart or two racing workers;
/// - the job insert (`guild_id, kind, dedupe_key`) makes the *work* unique.
///
/// If the ledger insert conflicts, nothing is inserted and the caller learns the
/// occurrence was already handled — which is a success, not a failure, because the
/// caller's next step (advancing the definition) is the same either way.
pub async fn materialize(
    client: &Client,
    definition: &Definition,
    occurrence: DateTime<Utc>,
    dedupe_key: &str,
) -> Result<Materialized, String> {
    let row = client
        .query_one(
            "WITH occ AS (
                 INSERT INTO scheduled_job_runs (definition_id, occurrence_at)
                 VALUES ($1, $2)
                 ON CONFLICT (definition_id, occurrence_at) DO NOTHING
                 RETURNING id
             ), job AS (
                 INSERT INTO jobs (guild_id, kind, dedupe_key, payload, run_at, max_attempts)
                 SELECT $3, $4, $5, $6, $2, $7 FROM occ
                 ON CONFLICT (guild_id, kind, dedupe_key) DO NOTHING
                 RETURNING id
             ), link AS (
                 UPDATE scheduled_job_runs SET job_id = (SELECT id FROM job)
                 WHERE id = (SELECT id FROM occ)
                 RETURNING id
             )
             SELECT (SELECT count(*) FROM occ)::int AS inserted",
            &[
                &definition.id,
                &occurrence,
                &definition.guild_id,
                &definition.job_kind,
                &dedupe_key,
                &definition.payload,
                &(definition.max_attempts as i32),
            ],
        )
        .await
        .map_err(|e| format!("materialize occurrence: {e}"))?;
    let inserted: i32 = row.get(0);
    Ok(if inserted == 1 {
        Materialized::Fresh
    } else {
        Materialized::AlreadyDone
    })
}

/// Move a definition on after an occurrence.
///
/// `attempts` counts **consecutive materialization failures** (an unparseable cron,
/// a schedule with no next occurrence), not deliveries — delivery retries are the
/// job queue's, and keeping two counters for one concept is how they drift apart.
/// When the failures reach `max_attempts` the definition is parked (`enabled =
/// false`) instead of being retried forever, and the dashboard shows `last_error`.
/// A success resets the counter.
pub async fn advance(
    client: &Client,
    definition_id: i64,
    next_run_at: Option<DateTime<Utc>>,
    status: &str,
    error: Option<&str>,
    disable: bool,
) -> Result<(), String> {
    client
        .execute(
            "UPDATE scheduled_jobs SET
                 next_run_at = $2,
                 last_run_at = CASE WHEN $3 = 'ok' THEN now() ELSE last_run_at END,
                 last_status = $3,
                 last_error  = $4,
                 attempts    = CASE WHEN $3 = 'ok' THEN 0
                                    ELSE LEAST(attempts + 1, max_attempts) END,
                 enabled     = CASE
                                   WHEN $5 THEN false
                                   WHEN $3 = 'ok' THEN enabled
                                   WHEN attempts + 1 >= max_attempts THEN false
                                   ELSE enabled
                               END,
                 updated_at  = now()
             WHERE id = $1",
            &[&definition_id, &next_run_at, &status, &error, &disable],
        )
        .await
        .map_err(|e| format!("advance scheduled job: {e}"))?;
    Ok(())
}
