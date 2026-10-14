//! Live-PostgreSQL integration tests for the job runtime.
//!
//! Skipped unless `FUDCOURT_TEST_PG_URL` is set, so the default `cargo test` stays
//! hermetic and CI needs no database. They run against the REAL schema
//! (`db/schema/pg-schema.sql`) because the whole point is to prove the SQL: the
//! claim CTE, the finish CTE, the reaper, and the unique-constraint idempotency.

use std::collections::HashSet;

use fudcourt_discord_worker::jobs::{Backoff, Disposition, NewJob, Status};
use fudcourt_discord_worker::storage::{jobs, Pool};

/// Connect, or `None` when the test database is not configured.
async fn maybe_pool() -> Option<Pool> {
    let url = std::env::var("FUDCOURT_TEST_PG_URL").ok()?;
    Some(Pool::connect(&url, 2).await.expect("pool"))
}

/// Skip the test body when there is no test database.
macro_rules! pg {
    () => {
        match maybe_pool().await {
            Some(pool) => pool,
            None => {
                eprintln!("skipping: FUDCOURT_TEST_PG_URL is unset");
                return;
            }
        }
    };
}

/// A guild id unique to one test, so tests never see each other's rows.
fn scope(name: &str) -> String {
    format!("test-{name}-{}", std::process::id())
}

/// Remove the test's rows. `job_runs` cascades from `jobs`.
async fn cleanup(pool: &Pool, guild: &str) {
    let session = pool.acquire().await.expect("session");
    session
        .client()
        .execute("DELETE FROM jobs WHERE guild_id = $1", &[&guild])
        .await
        .expect("cleanup");
}

async fn enqueue(pool: &Pool, job: &NewJob) -> Option<i64> {
    let session = pool.acquire().await.expect("session");
    jobs::enqueue(session.client(), job).await.expect("enqueue")
}

async fn load(pool: &Pool, id: i64) -> jobs::JobRow {
    let session = pool.acquire().await.expect("session");
    jobs::load(session.client(), id)
        .await
        .expect("load")
        .expect("row exists")
}

#[tokio::test]
async fn enqueue_is_idempotent_on_the_dedupe_key() {
    let pool = pg!();
    let guild = scope("dedupe");
    cleanup(&pool, &guild).await;

    let job = NewJob {
        guild_id: guild.clone(),
        ..NewJob::new("noop", "same-work")
    };
    let first = enqueue(&pool, &job).await;
    assert!(first.is_some(), "the first enqueue inserts");

    // The second enqueue is a no-op, not a second row and not an error.
    let second = enqueue(&pool, &job).await;
    assert!(second.is_none(), "a re-enqueue must not insert");

    // A different kind with the same key is a different job.
    let other = NewJob {
        guild_id: guild.clone(),
        ..NewJob::new("health.ping", "same-work")
    };
    assert!(enqueue(&pool, &other).await.is_some());

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn a_claim_is_exclusive_and_bumps_attempts_at_claim_time() {
    let pool = pg!();
    let guild = scope("claim");
    cleanup(&pool, &guild).await;

    let id = enqueue(
        &pool,
        &NewJob {
            guild_id: guild.clone(),
            ..NewJob::new("noop", "one")
        },
    )
    .await
    .expect("inserted");

    let session = pool.acquire().await.expect("session");
    let first = jobs::claim(session.client(), "w1").await.expect("claim");
    let first = first.expect("a due job is claimed");
    assert_eq!(first.job.id, id);
    assert_eq!(first.job.attempts, 1, "attempts is burned at claim time");

    // A running job is invisible to the next claim, from the same worker or not.
    let second = jobs::claim(session.client(), "w2").await.expect("claim");
    assert!(second.is_none(), "a claimed job is not re-claimed");

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn concurrent_workers_never_claim_the_same_job() {
    let pool = pg!();
    let guild = scope("concurrent");
    cleanup(&pool, &guild).await;

    for n in 0..8 {
        enqueue(
            &pool,
            &NewJob {
                guild_id: guild.clone(),
                ..NewJob::new("noop", format!("job-{n}"))
            },
        )
        .await
        .expect("inserted");
    }

    // 8 racers against 8 jobs: SKIP LOCKED must hand out 8 DISTINCT ids.
    let mut tasks = Vec::new();
    for n in 0..8 {
        let pool = pool.clone();
        tasks.push(tokio::spawn(async move {
            let session = pool.acquire().await.expect("session");
            jobs::claim(session.client(), &format!("w{n}"))
                .await
                .expect("claim")
                .map(|c| c.job.id)
        }));
    }

    let mut seen = HashSet::new();
    let mut claimed = 0;
    for task in tasks {
        if let Some(id) = task.await.expect("task") {
            claimed += 1;
            assert!(seen.insert(id), "job {id} was claimed twice");
        }
    }
    assert_eq!(claimed, 8, "every job should be claimed exactly once");

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn a_future_run_at_is_not_claimable_yet() {
    let pool = pg!();
    let guild = scope("future");
    cleanup(&pool, &guild).await;

    let id = enqueue(
        &pool,
        &NewJob {
            guild_id: guild.clone(),
            delay_secs: 3600,
            ..NewJob::new("noop", "later")
        },
    )
    .await
    .expect("inserted");

    let session = pool.acquire().await.expect("session");
    assert!(
        jobs::claim(session.client(), "w1")
            .await
            .expect("claim")
            .is_none(),
        "a job scheduled in the future is not due"
    );
    assert_eq!(load(&pool, id).await.status, "pending");
    assert_eq!(load(&pool, id).await.attempts, 0);

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn success_is_terminal_and_recorded_in_history() {
    let pool = pg!();
    let guild = scope("success");
    cleanup(&pool, &guild).await;

    let id = enqueue(
        &pool,
        &NewJob {
            guild_id: guild.clone(),
            ..NewJob::new("noop", "ok")
        },
    )
    .await
    .expect("inserted");

    let session = pool.acquire().await.expect("session");
    let claim = jobs::claim(session.client(), "w1")
        .await
        .expect("claim")
        .expect("claimed");
    let status = jobs::finish(
        session.client(),
        "w1",
        &claim,
        &Disposition::Done,
        &Backoff::default(),
    )
    .await
    .expect("finish");
    assert_eq!(status, Some(Status::Done));

    let runs = jobs::runs(session.client(), id).await.expect("runs");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].outcome.as_deref(), Some("succeeded"));
    assert_eq!(runs[0].worker, "w1");

    // Done is terminal: nothing can claim it again.
    assert!(jobs::claim(session.client(), "w2")
        .await
        .expect("claim")
        .is_none());
    assert_eq!(load(&pool, id).await.status, "done");

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn a_retryable_failure_returns_to_pending_with_a_delay() {
    let pool = pg!();
    let guild = scope("retry");
    cleanup(&pool, &guild).await;

    let id = enqueue(
        &pool,
        &NewJob {
            guild_id: guild.clone(),
            max_attempts: 3,
            ..NewJob::new("noop", "flaky")
        },
    )
    .await
    .expect("inserted");

    let session = pool.acquire().await.expect("session");
    let claim = jobs::claim(session.client(), "w1")
        .await
        .expect("claim")
        .expect("claimed");
    let status = jobs::finish(
        session.client(),
        "w1",
        &claim,
        &Disposition::Retryable("upstream 503".into()),
        &Backoff::default(),
    )
    .await
    .expect("finish");
    assert_eq!(
        status,
        Some(Status::Pending),
        "retryable goes back to pending"
    );

    let row = load(&pool, id).await;
    assert_eq!(row.status, "pending");
    assert_eq!(row.attempts, 1);
    assert_eq!(row.last_error.as_deref(), Some("upstream 503"));
    assert!(row.locked_by.is_none(), "the claim is released on retry");

    // The backoff made it not-yet-due, so it is not claimable immediately.
    assert!(jobs::claim(session.client(), "w2")
        .await
        .expect("claim")
        .is_none());

    let runs = jobs::runs(session.client(), id).await.expect("runs");
    assert_eq!(runs[0].outcome.as_deref(), Some("retryable"));

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn a_permanent_failure_dies_immediately_even_with_attempts_left() {
    let pool = pg!();
    let guild = scope("permanent");
    cleanup(&pool, &guild).await;

    let id = enqueue(
        &pool,
        &NewJob {
            guild_id: guild.clone(),
            max_attempts: 9,
            ..NewJob::new("noop", "hopeless")
        },
    )
    .await
    .expect("inserted");

    let session = pool.acquire().await.expect("session");
    let claim = jobs::claim(session.client(), "w1")
        .await
        .expect("claim")
        .expect("claimed");
    let status = jobs::finish(
        session.client(),
        "w1",
        &claim,
        &Disposition::Permanent("payload is not valid JSON".into()),
        &Backoff::default(),
    )
    .await
    .expect("finish");
    assert_eq!(status, Some(Status::Dead));
    assert_eq!(load(&pool, id).await.status, "dead");
    assert!(
        jobs::claim(session.client(), "w2")
            .await
            .expect("claim")
            .is_none(),
        "a dead job is never retried"
    );

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn exhausting_attempts_on_a_retryable_failure_dies() {
    let pool = pg!();
    let guild = scope("exhausted");
    cleanup(&pool, &guild).await;

    let id = enqueue(
        &pool,
        &NewJob {
            guild_id: guild.clone(),
            max_attempts: 2,
            ..NewJob::new("noop", "always-flaky")
        },
    )
    .await
    .expect("inserted");

    let session = pool.acquire().await.expect("session");
    // Attempt 1 → retryable, still pending.
    let claim = jobs::claim(session.client(), "w1")
        .await
        .expect("claim")
        .expect("claimed");
    assert_eq!(
        jobs::finish(
            session.client(),
            "w1",
            &claim,
            &Disposition::Retryable("boom".into()),
            &Backoff {
                base_secs: 0,
                factor: 1,
                max_secs: 0,
            },
        )
        .await
        .expect("finish"),
        Some(Status::Pending)
    );

    // Attempt 2 (the last) → retryable, but attempts are spent: dead.
    let claim = jobs::claim(session.client(), "w2")
        .await
        .expect("claim")
        .expect("claimed");
    assert_eq!(claim.job.attempts, 2);
    assert_eq!(
        jobs::finish(
            session.client(),
            "w2",
            &claim,
            &Disposition::Retryable("boom again".into()),
            &Backoff::default(),
        )
        .await
        .expect("finish"),
        Some(Status::Dead)
    );
    assert_eq!(load(&pool, id).await.status, "dead");

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn the_reaper_reclaims_a_job_whose_worker_vanished() {
    let pool = pg!();
    let guild = scope("reap");
    cleanup(&pool, &guild).await;

    let id = enqueue(
        &pool,
        &NewJob {
            guild_id: guild.clone(),
            max_attempts: 5,
            ..NewJob::new("noop", "abandoned")
        },
    )
    .await
    .expect("inserted");

    // Claim it, then simulate the worker dying: the row stays 'running' and the
    // claim goes stale. No `finish` is ever called for it.
    let session = pool.acquire().await.expect("session");
    let claim = jobs::claim(session.client(), "doomed")
        .await
        .expect("claim")
        .expect("claimed");

    session
        .client()
        .execute(
            "UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = $1",
            &[&id],
        )
        .await
        .expect("age the claim");

    let reclaimed = jobs::reap(session.client(), 300).await.expect("reap");
    assert_eq!(reclaimed, vec![(id, "pending".to_string())]);

    let row = load(&pool, id).await;
    assert_eq!(row.status, "pending", "the abandoned job is runnable again");
    assert!(row.locked_by.is_none());

    // The interrupted attempt is visible as `crashed`, not silently lost.
    let runs = jobs::runs(session.client(), id).await.expect("runs");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].outcome.as_deref(), Some("crashed"));
    assert_eq!(runs[0].attempt, claim.job.attempts);

    // And it is claimable again.
    assert!(jobs::claim(session.client(), "w-next")
        .await
        .expect("claim")
        .is_some());

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn the_reaper_dead_letters_a_job_that_cannot_afford_another_attempt() {
    let pool = pg!();
    let guild = scope("reap-dead");
    cleanup(&pool, &guild).await;

    let id = enqueue(
        &pool,
        &NewJob {
            guild_id: guild.clone(),
            max_attempts: 1,
            ..NewJob::new("noop", "doomed")
        },
    )
    .await
    .expect("inserted");

    let session = pool.acquire().await.expect("session");
    let claim = jobs::claim(session.client(), "doomed")
        .await
        .expect("claim")
        .expect("claimed");
    assert_eq!(claim.job.attempts, 1, "the only attempt is already spent");

    session
        .client()
        .execute(
            "UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = $1",
            &[&id],
        )
        .await
        .expect("age the claim");

    let reclaimed = jobs::reap(session.client(), 300).await.expect("reap");
    assert_eq!(reclaimed, vec![(id, "dead".to_string())]);
    assert_eq!(load(&pool, id).await.status, "dead");

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn only_the_claiming_worker_can_finish_a_job() {
    let pool = pg!();
    let guild = scope("owner");
    cleanup(&pool, &guild).await;

    let id = enqueue(
        &pool,
        &NewJob {
            guild_id: guild.clone(),
            ..NewJob::new("noop", "owned")
        },
    )
    .await
    .expect("inserted");

    let session = pool.acquire().await.expect("session");
    let claim = jobs::claim(session.client(), "w-owner")
        .await
        .expect("claim")
        .expect("claimed");

    // A stale completion from a worker that lost the claim must be a no-op: the
    // row is untouched and the return is None.
    let stolen = jobs::finish(
        session.client(),
        "w-imposter",
        &claim,
        &Disposition::Done,
        &Backoff::default(),
    )
    .await
    .expect("finish");
    assert!(stolen.is_none(), "a non-owner cannot close the attempt");
    assert_eq!(load(&pool, id).await.status, "running");

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn the_reaper_does_not_touch_a_fresh_claim() {
    let pool = pg!();
    let guild = scope("reap-fresh");
    cleanup(&pool, &guild).await;

    let id = enqueue(
        &pool,
        &NewJob {
            guild_id: guild.clone(),
            ..NewJob::new("noop", "fresh")
        },
    )
    .await
    .expect("inserted");

    let session = pool.acquire().await.expect("session");
    jobs::claim(session.client(), "w1")
        .await
        .expect("claim")
        .expect("claimed");

    // A 300s stale window must not reclaim a claim made a moment ago, or the
    // reaper would double-run every slow job.
    let reclaimed = jobs::reap(session.client(), 300).await.expect("reap");
    assert!(reclaimed.is_empty(), "a fresh claim is not stale");
    assert_eq!(load(&pool, id).await.status, "running");

    cleanup(&pool, &guild).await;
}
