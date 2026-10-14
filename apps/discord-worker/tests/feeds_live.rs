//! Live-PostgreSQL integration tests for the feed ledger.
//!
//! Skipped unless `FUDCOURT_TEST_PG_URL` is set. They run against the REAL schema
//! because the guarantees under test are DATABASE guarantees: the ledger's
//! `(source_id, item_key)` unique constraint, the same-link guard, and the
//! `pending` backlog a restart must not re-announce.
//!
//! Run with `--test-threads=1`, like the scheduler's live suite.

use fudcourt_discord_worker::feeds::parse::Item;
use fudcourt_discord_worker::feeds::store::{self, NewSource};
use fudcourt_discord_worker::storage::Pool;
use tokio_postgres::Client;

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

/// A real `jobs` row, because `feed_items.delivery_job_id` is a foreign key: the
/// ledger deliberately cannot claim that an announcement came from a job that
/// never existed.
async fn seed_job(client: &Client, guild: &str, key: &str) -> i64 {
    client
        .query_one(
            "INSERT INTO jobs (guild_id, kind, dedupe_key, payload)
             VALUES ($1, 'feed.deliver', $2, '{}'::jsonb)
             RETURNING id",
            &[&guild, &key],
        )
        .await
        .expect("seed job")
        .get(0)
}

/// A guild id unique to this process, so two runs never share a ledger.
fn scope(name: &str) -> String {
    format!("feed-{name}-{}", std::process::id())
}

/// Purge the whole `feed-` space, not one guild: `upsert_source` is keyed on
/// `(guild_id, name)` and a failed earlier run can leave rows behind.
async fn cleanup(pool: &Pool, guild: &str) {
    let session = pool.acquire().await.expect("session");
    for sql in [
        "DELETE FROM jobs WHERE guild_id LIKE 'feed-%' OR guild_id = $1",
        "DELETE FROM feed_sources WHERE guild_id LIKE 'feed-%' OR guild_id = $1",
    ] {
        let _ = session.client().execute(sql, &[&guild]).await;
    }
}

fn new_source(guild: &str, name: &str) -> NewSource {
    NewSource {
        guild_id: guild.to_string(),
        name: name.to_string(),
        url: "https://example.com/feed.xml".to_string(),
        adapter: "rss".to_string(),
        channel_id: "100200300".to_string(),
        message: "{title}\n{url}".to_string(),
        mention_role_id: Some("400500600".to_string()),
        include_text: None,
        exclude_text: None,
        enabled: true,
    }
}

fn item(key: &str, url: Option<&str>) -> Item {
    Item {
        key: key.to_string(),
        external_id: None,
        title: format!("title of {key}"),
        url: url.map(str::to_string),
        summary: "the body".to_string(),
        image: None,
        published_at: None,
    }
}

#[tokio::test]
async fn the_same_item_is_recorded_once_however_often_the_feed_is_polled() {
    let pool = pg!();
    let guild = scope("dedupe");
    cleanup(&pool, &guild).await;
    let session = pool.acquire().await.expect("session");
    let client = session.client();

    let src = store::upsert_source(client, &new_source(&guild, "dedupe"))
        .await
        .expect("upsert");
    let items = vec![item("id:1", Some("https://example.com/1"))];

    let first = store::accept_items(client, src, &items, false)
        .await
        .expect("first");
    let second = store::accept_items(client, src, &items, false)
        .await
        .expect("second");

    assert_eq!(first.len(), 1, "the first poll records the item");
    assert!(
        second.is_empty(),
        "a restart that re-polls the same feed must record nothing"
    );
    assert_eq!(
        store::owed_count(client, src).await.expect("owed"),
        1,
        "and the item is still owed exactly once"
    );

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn an_item_that_only_changed_its_id_is_still_suppressed() {
    let pool = pg!();
    let guild = scope("relink");
    cleanup(&pool, &guild).await;
    let session = pool.acquire().await.expect("session");
    let client = session.client();

    let src = store::upsert_source(client, &new_source(&guild, "relink"))
        .await
        .expect("upsert");
    let link = Some("https://example.com/same-story");
    store::accept_items(client, src, &[item("id:a", link)], false)
        .await
        .expect("first");

    let second = store::accept_items(client, src, &[item("id:b", link)], false)
        .await
        .expect("second");

    assert!(
        second.is_empty(),
        "a feed that rewrites its ids must not re-announce the same link"
    );

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn the_first_poll_absorbs_an_existing_backlog_silently() {
    let pool = pg!();
    let guild = scope("prime");
    cleanup(&pool, &guild).await;
    let session = pool.acquire().await.expect("session");
    let client = session.client();

    let src = store::upsert_source(client, &new_source(&guild, "prime"))
        .await
        .expect("upsert");
    let backlog = vec![
        item("id:1", Some("https://example.com/1")),
        item("id:2", Some("https://example.com/2")),
    ];

    let accepted = store::accept_items(client, src, &backlog, true)
        .await
        .expect("accept");

    assert_eq!(accepted.len(), 2, "the ledger still records what it saw");
    assert!(
        store::pending_item_ids(client, src, 50)
            .await
            .expect("pending")
            .is_empty(),
        "adding a feed must not dump its twenty most recent posts into the channel"
    );
    assert_eq!(store::owed_count(client, src).await.expect("owed"), 0);

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn a_primed_source_owes_the_new_item_and_delivery_settles_it() {
    let pool = pg!();
    let guild = scope("deliver");
    cleanup(&pool, &guild).await;
    let session = pool.acquire().await.expect("session");
    let client = session.client();

    let src = store::upsert_source(client, &new_source(&guild, "deliver"))
        .await
        .expect("upsert");
    let accepted =
        store::accept_items(client, src, &[item("id:9", Some("https://e.com/9"))], false)
            .await
            .expect("accept");
    assert_eq!(accepted.len(), 1);

    let owed = store::pending_item_ids(client, src, 50)
        .await
        .expect("owed");
    assert_eq!(
        owed, accepted,
        "discovery order, and only this source's items"
    );

    // The join the sender relies on: item fields plus the source's channel and
    // template, resolved in one query.
    let row = store::delivery_by_item(client, owed[0])
        .await
        .expect("delivery")
        .expect("the row exists");
    assert_eq!(row.channel_id, "100200300");
    assert_eq!(row.message, "{title}\n{url}");
    assert_eq!(row.mention_role_id.as_deref(), Some("400500600"));
    assert_eq!(row.title, "title of id:9");
    assert_eq!(row.state, "pending");

    let job = seed_job(client, &guild, "deliver-9").await;
    store::mark_delivered(client, owed[0], job)
        .await
        .expect("mark");
    assert_eq!(store::owed_count(client, src).await.expect("owed"), 0);

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn a_retry_after_a_successful_send_settles_nothing_twice() {
    let pool = pg!();
    let guild = scope("retry");
    cleanup(&pool, &guild).await;
    let session = pool.acquire().await.expect("session");
    let client = session.client();

    let src = store::upsert_source(client, &new_source(&guild, "retry"))
        .await
        .expect("upsert");
    let ids = store::accept_items(client, src, &[item("id:1", None)], false)
        .await
        .expect("accept");

    let first_job = seed_job(client, &guild, "retry-1").await;
    let second_job = seed_job(client, &guild, "retry-2").await;
    store::mark_delivered(client, ids[0], first_job)
        .await
        .expect("first");
    store::mark_delivered(client, ids[0], second_job)
        .await
        .expect("a second mark must be harmless");

    let row = store::delivery_by_item(client, ids[0])
        .await
        .expect("delivery")
        .expect("row");
    assert_eq!(row.state, "delivered");
    assert!(
        store::pending_item_ids(client, src, 50)
            .await
            .expect("pending")
            .is_empty(),
        "a delivered item is never owed again"
    );

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn a_permanent_delivery_failure_is_recorded_with_its_reason() {
    let pool = pg!();
    let guild = scope("failed");
    cleanup(&pool, &guild).await;
    let session = pool.acquire().await.expect("session");
    let client = session.client();

    let src = store::upsert_source(client, &new_source(&guild, "failed"))
        .await
        .expect("upsert");
    let ids = store::accept_items(client, src, &[item("id:1", None)], false)
        .await
        .expect("accept");

    let job = seed_job(client, &guild, "failed-1").await;
    store::mark_delivery_failed(client, ids[0], job, "404: unknown channel")
        .await
        .expect("mark failed");

    let row = store::delivery_by_item(client, ids[0])
        .await
        .expect("delivery")
        .expect("row");
    assert_eq!(row.state, "failed");
    let note = row.last_error.expect("the reason is kept for the operator");
    assert!(note.contains("unknown channel"), "{note}");
    assert_eq!(
        store::owed_count(client, src).await.expect("owed"),
        0,
        "a failed delivery stops being owed, so it cannot spin forever"
    );

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn the_poll_validators_round_trip_and_a_failure_is_counted() {
    let pool = pg!();
    let guild = scope("validators");
    cleanup(&pool, &guild).await;
    let session = pool.acquire().await.expect("session");
    let client = session.client();

    let src = store::upsert_source(client, &new_source(&guild, "validators"))
        .await
        .expect("upsert");

    store::set_poll_ok(
        client,
        src,
        "ok",
        Some(("W/\"abc\"", Some("Mon, 05 Oct 2026 10:00:00 GMT"))),
    )
    .await
    .expect("ok");
    let after_ok = store::source_by_id(client, src)
        .await
        .expect("read")
        .expect("row");
    assert_eq!(after_ok.etag.as_deref(), Some("W/\"abc\""));
    assert_eq!(
        after_ok.last_modified.as_deref(),
        Some("Mon, 05 Oct 2026 10:00:00 GMT")
    );
    assert_eq!(after_ok.last_status.as_deref(), Some("ok"));
    assert_eq!(after_ok.consecutive_failures, 0);

    store::set_poll_error(client, src, "timed out")
        .await
        .expect("err");
    store::set_poll_error(client, src, "timed out")
        .await
        .expect("err");
    let after_err = store::source_by_id(client, src)
        .await
        .expect("read")
        .expect("row");
    assert_eq!(after_err.consecutive_failures, 2, "failures accumulate");
    assert_eq!(after_err.last_error.as_deref(), Some("timed out"));

    // A success clears the streak but keeps the last error visible.
    store::set_poll_ok(client, src, "ok", None)
        .await
        .expect("ok");
    let recovered = store::source_by_id(client, src)
        .await
        .expect("read")
        .expect("row");
    assert_eq!(recovered.consecutive_failures, 0);
    assert_eq!(recovered.last_status.as_deref(), Some("ok"));

    cleanup(&pool, &guild).await;
}

#[tokio::test]
async fn deleting_a_source_takes_its_ledger_with_it() {
    let pool = pg!();
    let guild = scope("cascade");
    cleanup(&pool, &guild).await;
    let session = pool.acquire().await.expect("session");
    let client = session.client();

    let src = store::upsert_source(client, &new_source(&guild, "cascade"))
        .await
        .expect("upsert");
    store::accept_items(client, src, &[item("id:1", None), item("id:2", None)], true)
        .await
        .expect("accept");

    let before: i64 = client
        .query_one(
            "SELECT count(*) FROM feed_items WHERE source_id = $1",
            &[&src],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(before, 2, "both items are in the ledger");

    client
        .execute("DELETE FROM feed_sources WHERE id = $1", &[&src])
        .await
        .expect("delete");

    let after: i64 = client
        .query_one(
            "SELECT count(*) FROM feed_items WHERE source_id = $1",
            &[&src],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(
        after, 0,
        "removing a feed must not leave its ledger behind forever"
    );

    cleanup(&pool, &guild).await;
}
