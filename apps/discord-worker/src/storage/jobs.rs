//! Job-table access.
//!
//! Every operation here is ONE statement. That is deliberate: a data-modifying
//! CTE is atomic by itself, so there is no explicit `BEGIN`/`COMMIT` to get
//! wrong, no transaction held open across an `.await`, and no way for the
//! `jobs` row and its `job_runs` history to disagree — they are written by the
//! same statement or not at all.

use serde_json::Value;
use tokio_postgres::Client;

use crate::jobs::{Backoff, ClaimedJob, Disposition, NewJob, Status};

/// A claimed job plus the `job_runs` row opened for it.
#[derive(Debug, Clone)]
pub struct Claim {
    pub job: ClaimedJob,
    pub run_id: i64,
}

/// Read-back shape for tests and inspection.
#[derive(Debug, Clone)]
pub struct JobRow {
    pub id: i64,
    pub status: String,
    pub attempts: u32,
    pub max_attempts: u32,
    pub locked_by: Option<String>,
    pub last_error: Option<String>,
}

/// One execution-history row.
#[derive(Debug, Clone)]
pub struct RunRow {
    pub attempt: u32,
    pub worker: String,
    pub outcome: Option<String>,
    pub error: Option<String>,
}

/// Enqueue a job. Returns `None` when a job with the same
/// `(guild_id, kind, dedupe_key)` already exists.
///
/// That `None` IS the idempotency: a re-enqueue of the same logical work is a
/// no-op enforced by a unique constraint, not by reading first and racing.
pub async fn enqueue(client: &Client, job: &NewJob) -> Result<Option<i64>, String> {
    let row = client
        .query_opt(
            "INSERT INTO jobs (guild_id, kind, dedupe_key, payload, run_at, max_attempts)
             VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::double precision), $6)
             ON CONFLICT (guild_id, kind, dedupe_key) DO NOTHING
             RETURNING id",
            &[
                &job.guild_id,
                &job.kind,
                &job.dedupe_key,
                &job.payload,
                &(job.delay_secs as f64),
                &(job.max_attempts as i32),
            ],
        )
        .await
        .map_err(|e| format!("enqueue: {e}"))?;
    Ok(row.map(|r| r.get::<_, i64>(0)))
}

/// Claim one job for `worker`, or `None` when nothing is due.
///
/// The `SELECT ... FOR UPDATE SKIP LOCKED` picks a row and locks it only for the
/// duration of this statement; the lock is gone before the handler runs, so a
/// slow job never blocks another worker. `attempts` is bumped here — at claim
/// time — so a worker that dies mid-job still burns the attempt.
pub async fn claim(client: &Client, worker: &str) -> Result<Option<Claim>, String> {
    let row = client
        .query_opt(
            "WITH picked AS (
                 SELECT id FROM jobs
                 WHERE status = 'pending' AND run_at <= now()
                 ORDER BY run_at, id
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1
             ), claimed AS (
                 UPDATE jobs
                 SET status = 'running', locked_by = $1, locked_at = now(),
                     attempts = attempts + 1, updated_at = now()
                 WHERE id IN (SELECT id FROM picked)
                 RETURNING id, guild_id, kind, dedupe_key, payload, attempts, max_attempts
             ), opened AS (
                 INSERT INTO job_runs (job_id, attempt, worker, outcome)
                 SELECT id, attempts, $1, NULL FROM claimed
                 RETURNING id AS run_id, job_id
             )
             SELECT c.id, c.guild_id, c.kind, c.dedupe_key, c.payload,
                    c.attempts, c.max_attempts, o.run_id
             FROM claimed c JOIN opened o ON o.job_id = c.id",
            &[&worker],
        )
        .await
        .map_err(|e| format!("claim: {e}"))?;

    Ok(row.map(|r| Claim {
        job: ClaimedJob {
            id: r.get(0),
            guild_id: r.get(1),
            kind: r.get(2),
            dedupe_key: r.get(3),
            payload: r.get::<_, Value>(4),
            attempts: r.get::<_, i32>(5) as u32,
            max_attempts: r.get::<_, i32>(6) as u32,
        },
        run_id: r.get(7),
    }))
}

/// Close out an attempt: record the outcome in history and move the job to its
/// next status in the same statement.
///
/// The `locked_by = $7` predicate means only the worker that holds the claim can
/// finish it: if the claim was reaped and re-issued, a late completion from the
/// old worker is a harmless no-op that returns `None` instead of clobbering the
/// new owner.
pub async fn finish(
    client: &Client,
    worker: &str,
    claim: &Claim,
    disposition: &Disposition,
    backoff: &Backoff,
) -> Result<Option<Status>, String> {
    let (outcome, error): (&str, Option<&str>) = match disposition {
        Disposition::Done => ("succeeded", None),
        Disposition::Retryable(msg) => ("retryable", Some(msg.as_str())),
        Disposition::Permanent(msg) => ("permanent", Some(msg.as_str())),
    };
    let next = crate::jobs::next_status(claim.job.attempts, claim.job.max_attempts, disposition);
    let delay = backoff.delay_secs(claim.job.attempts) as f64;

    let row = client
        .query_opt(
            "WITH closed AS (
                 UPDATE job_runs SET outcome = $1, error = $2, finished_at = now()
                 WHERE id = $3 RETURNING job_id
             )
             UPDATE jobs
             SET status = $4,
                 run_at = now() + make_interval(secs => $5::double precision),
                 last_error = $2,
                 locked_by = NULL, locked_at = NULL, updated_at = now()
             WHERE id = $6 AND locked_by = $7 AND id IN (SELECT job_id FROM closed)
             RETURNING status",
            &[
                &outcome,
                &error,
                &claim.run_id,
                &next.as_str(),
                &delay,
                &claim.job.id,
                &worker,
            ],
        )
        .await
        .map_err(|e| format!("finish: {e}"))?;

    Ok(row.map(|r| Status::from_db(r.get::<_, String>(0).as_str())))
}

/// Reclaim jobs whose worker vanished: a `running` job untouched for longer than
/// `stale_secs` goes back to `pending` (or to `dead` when its attempts are
/// spent), and the open history row is closed as `crashed`.
///
/// This is the recovery path for "the worker crashed after claiming a job".
pub async fn reap(client: &Client, stale_secs: i64) -> Result<Vec<(i64, String)>, String> {
    let rows = client
        .query(
            "WITH stale AS (
                 SELECT id FROM jobs
                 WHERE status = 'running'
                   AND locked_at < now() - make_interval(secs => $1::double precision)
                 FOR UPDATE SKIP LOCKED
             ), closed AS (
                 UPDATE job_runs
                 SET outcome = 'crashed', error = COALESCE(error, 'worker died mid-attempt'),
                     finished_at = now()
                 WHERE outcome IS NULL AND job_id IN (SELECT id FROM stale)
                 RETURNING job_id
             )
             UPDATE jobs
             SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
                 locked_by = NULL, locked_at = NULL, updated_at = now(),
                 last_error = COALESCE(last_error, 'stale claim reclaimed')
             WHERE id IN (SELECT id FROM stale)
             RETURNING id, status",
            &[&(stale_secs as f64)],
        )
        .await
        .map_err(|e| format!("reap: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|r| (r.get::<_, i64>(0), r.get::<_, String>(1)))
        .collect())
}

/// Count of jobs in each status, for the startup log and the dashboard.
pub async fn counts(client: &Client) -> Result<Vec<(String, i64)>, String> {
    let rows = client
        .query(
            "SELECT status, count(*) FROM jobs GROUP BY status ORDER BY status",
            &[],
        )
        .await
        .map_err(|e| format!("counts: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|r| (r.get::<_, String>(0), r.get::<_, i64>(1)))
        .collect())
}

/// Load one job's current state (tests, inspection).
pub async fn load(client: &Client, id: i64) -> Result<Option<JobRow>, String> {
    let row = client
        .query_opt(
            "SELECT id, status, attempts, max_attempts, locked_by, last_error
             FROM jobs WHERE id = $1",
            &[&id],
        )
        .await
        .map_err(|e| format!("load: {e}"))?;
    Ok(row.map(|r| JobRow {
        id: r.get(0),
        status: r.get(1),
        attempts: r.get::<_, i32>(2) as u32,
        max_attempts: r.get::<_, i32>(3) as u32,
        locked_by: r.get(4),
        last_error: r.get(5),
    }))
}

/// A job's execution history, newest attempt first (tests, inspection).
pub async fn runs(client: &Client, job_id: i64) -> Result<Vec<RunRow>, String> {
    let rows = client
        .query(
            "SELECT attempt, worker, outcome, error FROM job_runs
             WHERE job_id = $1 ORDER BY attempt DESC, id DESC",
            &[&job_id],
        )
        .await
        .map_err(|e| format!("runs: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|r| RunRow {
            attempt: r.get::<_, i32>(0) as u32,
            worker: r.get(1),
            outcome: r.get(2),
            error: r.get(3),
        })
        .collect())
}
