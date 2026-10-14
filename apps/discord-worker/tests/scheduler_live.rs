//! Live-PostgreSQL integration tests for the scheduler.
//!
//! Skipped unless `FUDCOURT_TEST_PG_URL` is set. They run against the REAL schema
//! because the guarantees under test are database guarantees: the occurrence
//! ledger's unique constraint, the job dedupe key, the partial due index, and the
//! `next_run_at` arithmetic that a restart must not duplicate.
//!
//! Run with `--test-threads=1`: `store::due` scans every due definition, so two
//! tests ticking concurrently would see each other's rows.

use chrono::{DateTime, Duration, SubsecRound, Utc};
use fudcourt_discord_worker::scheduler::store::{self};
use fudcourt_discord_worker::scheduler::tick::{self, Tick};
use fudcourt_discord_worker::scheduler::ScheduleKind;
use fudcourt_discord_worker::storage::Pool;

async fn maybe_pool() -> Option<Pool> {
    let url = std::env::var("FUDCOURT_TEST_PG_URL").ok()?;
    Some(Pool::connect(&url, 2).await.expect("pool"))
}

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
    format!("sched-{name}-{}", std::process::id())
}

/// `Utc::now()` at the precision Postgres actually keeps. A `timestamptz` column
/// stores microseconds, so a nanosecond-precision `now()` compared against a value
/// that round-tripped through the database would differ in the last three digits —
/// a fact about the test, not about the scheduler.
fn now_us() -> DateTime<Utc> {
    Utc::now().trunc_subsecs(6)
}

/// Remove test rows. Called at the start AND the end of every test, and it purges
/// the whole `sched-` guild space rather than one guild, because `store::due` scans
/// globally: a row left behind by an earlier failed run would otherwise be
/// materialized by an unrelated test and inflate its report. These guilds are only
/// ever created by this file, so the purge cannot touch real data — but it does mean
/// the file must run single-threaded (`--test-threads=1`).
async fn cleanup(pool: &Pool, guild: &str) {
    let session = pool.acquire().await.expect("session");
    for sql in [
        "DELETE FROM jobs WHERE guild_id LIKE 'sched-%' OR guild_id = $1",
        "DELETE FROM scheduled_jobs WHERE guild_id LIKE 'sched-%' OR guild_id = $1",
    ] {
        session
            .client()
            .execute(sql, &[&guild])
            .await
            .expect("cleanup");
    }
}

/// How many jobs of `kind` this guild has.
async fn job_count(pool: &Pool, guild: &str, kind: &str) -> i64 {
    let session = pool.acquire().await.expect("session");
    session
        .client()
        .query_one(
            "SELECT count(*)::bigint FROM jobs WHERE guild_id = $1 AND kind = $2",
            &[&guild, &kind],
        )
        .await
        .expect("count jobs")
        .get(0)
}

/// How many ledger rows the definition has.
async fn occurrence_count(pool: &Pool, definition_id: i64) -> i64 {
    let session = pool.acquire().await.expect("session");
    session
        .client()
        .query_one(
            "SELECT count(*)::bigint FROM scheduled_job_runs WHERE definition_id = $1",
            &[&definition_id],
        )
        .await
        .expect("count occurrences")
        .get(0)
}

/// Create a definition already due, and return its id.
#[allow(clippy::too_many_arguments)]
async fn due_definition(
    pool: &Pool,
    guild: &str,
    name: &str,
    schedule_kind: ScheduleKind,
    schedule_expr: &str,
    timezone: &str,
    max_attempts: u32,
    due_at: DateTime<Utc>,
) -> i64 {
    let session = pool.acquire().await.expect("session");
    let def = store::NewDefinition::new(guild, name, schedule_kind, schedule_expr)
        .with_job_kind("noop")
        .in_zone(timezone)
        .with_payload(serde_json::json!({"text": "hello"}))
        .due_at(due_at)
        .with_max_attempts(max_attempts);
    store::upsert(session.client(), &def).await.expect("upsert")
}

async fn definition(pool: &Pool, id: i64) -> store::Definition {
    let session = pool.acquire().await.expect("session");
    store::by_id(session.client(), id)
        .await
        .expect("read back")
        .expect("definition exists")
}

#[tokio::test]
async fn a_due_definition_becomes_exactly_one_job() {
    let pool = pg!();
    let guild = scope("one-job");
    cleanup(&pool, &guild).await;
    let now = now_us();
    let id = due_definition(
        &pool,
        &guild,
        "reminder",
        ScheduleKind::Interval,
        "300",
        "UTC",
        3,
        now - Duration::seconds(5),
    )
    .await;

    let tick = Tick::new(pool.clone(), 60);
    let report = tick.run_once(now).await.expect("tick");

    assert_eq!(report.materialized, 1, "one occurrence materialized");
    assert_eq!(report.failed, 0);
    assert_eq!(job_count(&pool, &guild, "noop").await, 1);
    assert_eq!(occurrence_count(&pool, id).await, 1);

    // The definition moved on by exactly one interval from `now`.
    let after = definition(&pool, id).await;
    assert_eq!(after.next_run_at, Some(now + Duration::seconds(300)));
    assert_eq!(after.last_status.as_deref(), Some("ok"));
    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn replaying_the_same_occurrence_materializes_nothing_new() {
    let pool = pg!();
    let guild = scope("replay");
    cleanup(&pool, &guild).await;
    let now = now_us();
    let occurrence = now - Duration::seconds(5);
    let id = due_definition(
        &pool,
        &guild,
        "replayed",
        ScheduleKind::Interval,
        "300",
        "UTC",
        3,
        occurrence,
    )
    .await;

    let tick = Tick::new(pool.clone(), 60);
    tick.run_once(now).await.expect("first tick");

    // Force the definition back to the SAME due time, which is what a restart
    // between materializing and advancing leaves behind, and tick again.
    {
        let session = pool.acquire().await.expect("session");
        session
            .client()
            .execute(
                "UPDATE scheduled_jobs SET next_run_at = $2 WHERE id = $1",
                &[&id, &occurrence],
            )
            .await
            .expect("rewind");
    }
    let report = tick.run_once(now).await.expect("second tick");

    assert_eq!(report.materialized, 0, "the ledger refused a second job");
    assert_eq!(report.already_done, 1, "and said so");
    assert_eq!(
        job_count(&pool, &guild, "noop").await,
        1,
        "still exactly one"
    );
    assert_eq!(occurrence_count(&pool, id).await, 1);
    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn a_definition_that_is_not_due_yet_is_left_alone() {
    let pool = pg!();
    let guild = scope("not-due");
    cleanup(&pool, &guild).await;
    let now = now_us();
    let id = due_definition(
        &pool,
        &guild,
        "later",
        ScheduleKind::Interval,
        "300",
        "UTC",
        3,
        now + Duration::hours(1),
    )
    .await;

    let tick = Tick::new(pool.clone(), 60);
    let report = tick.run_once(now).await.expect("tick");

    assert_eq!(report.examined, 0, "nothing was even considered");
    assert_eq!(job_count(&pool, &guild, "noop").await, 0);
    assert_eq!(occurrence_count(&pool, id).await, 0);
    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn the_materialized_job_is_claimable_and_carries_the_payload() {
    let pool = pg!();
    let guild = scope("payload");
    cleanup(&pool, &guild).await;
    let now = now_us();
    let occurrence = now - Duration::seconds(5);
    let id = due_definition(
        &pool,
        &guild,
        "with-payload",
        ScheduleKind::Interval,
        "60",
        "UTC",
        3,
        occurrence,
    )
    .await;
    Tick::new(pool.clone(), 60)
        .run_once(now)
        .await
        .expect("tick");

    let session = pool.acquire().await.expect("session");
    let row = session
        .client()
        .query_one(
            "SELECT dedupe_key, payload, run_at, status::text FROM jobs
             WHERE guild_id = $1 AND kind = 'noop'",
            &[&guild],
        )
        .await
        .expect("job row");
    let dedupe_key: String = row.get(0);
    let payload: serde_json::Value = row.get(1);
    let run_at: DateTime<Utc> = row.get(2);
    let status: String = row.get(3);

    assert_eq!(dedupe_key, tick::occurrence_key(id, occurrence));
    assert_eq!(payload["text"], "hello");
    assert_eq!(run_at, occurrence, "the job is due at the occurrence");
    assert_eq!(status, "pending");
    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn a_once_definition_retires_after_it_fires() {
    let pool = pg!();
    let guild = scope("once");
    cleanup(&pool, &guild).await;
    let now = now_us();
    let id = due_definition(
        &pool,
        &guild,
        "one-shot",
        ScheduleKind::Once,
        &(now - Duration::seconds(5)).to_rfc3339(),
        "UTC",
        3,
        now - Duration::seconds(5),
    )
    .await;

    let report = Tick::new(pool.clone(), 60)
        .run_once(now)
        .await
        .expect("tick");
    assert_eq!(report.materialized, 1);

    let after = definition(&pool, id).await;
    assert!(!after.enabled, "a fired one-off retires instead of idling");
    assert_eq!(after.next_run_at, None);
    assert_eq!(job_count(&pool, &guild, "noop").await, 1);

    // And it stays retired on the next tick.
    let second = Tick::new(pool.clone(), 60)
        .run_once(now)
        .await
        .expect("tick");
    assert_eq!(second.examined, 0);
    assert_eq!(job_count(&pool, &guild, "noop").await, 1);
    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn a_cron_definition_advances_to_its_zones_wall_clock() {
    let pool = pg!();
    let guild = scope("cron-tz");
    cleanup(&pool, &guild).await;
    // 09:00 every day in WIB (UTC+7). Anchored on a fixed instant so the expected
    // value is arithmetic, not "whatever tomorrow is".
    let now: DateTime<Utc> = "2026-06-01T00:00:00Z".parse().unwrap();
    let id = due_definition(
        &pool,
        &guild,
        "morning",
        ScheduleKind::Cron,
        "0 9 * * *",
        "Asia/Jakarta",
        3,
        now - Duration::minutes(1),
    )
    .await;

    Tick::new(pool.clone(), 60)
        .run_once(now)
        .await
        .expect("tick");

    let after = definition(&pool, id).await;
    let expected: DateTime<Utc> = "2026-06-01T02:00:00Z".parse().unwrap();
    assert_eq!(
        after.next_run_at,
        Some(expected),
        "09:00 WIB is 02:00 UTC, and the stored value must be the instant"
    );
    assert!(after.enabled, "a cron repeats, so it stays armed");
    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn a_disabled_definition_is_never_due() {
    let pool = pg!();
    let guild = scope("disabled");
    cleanup(&pool, &guild).await;
    let now = now_us();
    let id = due_definition(
        &pool,
        &guild,
        "paused",
        ScheduleKind::Interval,
        "60",
        "UTC",
        3,
        now - Duration::seconds(5),
    )
    .await;
    {
        let session = pool.acquire().await.expect("session");
        session
            .client()
            .execute(
                "UPDATE scheduled_jobs SET enabled = false WHERE id = $1",
                &[&id],
            )
            .await
            .expect("disable");
    }

    let report = Tick::new(pool.clone(), 60)
        .run_once(now)
        .await
        .expect("tick");
    assert_eq!(report.examined, 0, "the partial index skips it entirely");
    assert_eq!(job_count(&pool, &guild, "noop").await, 0);
    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn a_broken_schedule_is_recorded_then_parked_rather_than_spinning() {
    let pool = pg!();
    let guild = scope("broken");
    cleanup(&pool, &guild).await;
    let now = now_us();
    let id = due_definition(
        &pool,
        &guild,
        "typo",
        ScheduleKind::Cron,
        "not a cron at all",
        "UTC",
        2,
        now - Duration::seconds(5),
    )
    .await;

    let tick = Tick::new(pool.clone(), 60);
    let first = tick.run_once(now).await.expect("tick");
    assert_eq!(first.failed, 1);
    assert_eq!(first.materialized, 0);

    let after = definition(&pool, id).await;
    assert_eq!(after.last_status.as_deref(), Some("error"));
    assert_eq!(after.attempts, 1);
    assert!(after.enabled, "one failure is not enough to park it");
    assert!(
        after.last_error.as_deref().unwrap_or("").contains("cron"),
        "the reason must be readable: {:?}",
        after.last_error
    );
    assert_eq!(
        after.next_run_at,
        Some(now - Duration::seconds(5)),
        "the due time is untouched, so the next tick retries it"
    );

    tick.run_once(now).await.expect("tick");
    let parked = definition(&pool, id).await;
    assert_eq!(parked.attempts, 2);
    assert!(
        !parked.enabled,
        "at max_attempts it is parked for a human instead of retried forever"
    );
    assert_eq!(job_count(&pool, &guild, "noop").await, 0);
    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn enqueueing_the_same_tick_instant_twice_queues_it_once() {
    let pool = pg!();
    let guild = scope("tick-idem");
    cleanup(&pool, &guild).await;
    let scheduled_at: DateTime<Utc> = Utc::now();

    let tick = Tick::new(pool.clone(), 60);
    let first = tick
        .enqueue_tick(&guild, scheduled_at)
        .await
        .expect("enqueue");
    let second = tick
        .enqueue_tick(&guild, scheduled_at)
        .await
        .expect("enqueue");

    assert!(first, "the first request queues the tick");
    assert!(!second, "the second is refused by the dedupe key");
    assert_eq!(job_count(&pool, &guild, tick::TICK_KIND).await, 1);

    // A different instant is a different tick, so the chain can advance.
    let later = scheduled_at + Duration::seconds(60);
    assert!(tick.enqueue_tick(&guild, later).await.expect("enqueue"));
    assert_eq!(job_count(&pool, &guild, tick::TICK_KIND).await, 2);
    cleanup(&pool, &guild).await;
}
