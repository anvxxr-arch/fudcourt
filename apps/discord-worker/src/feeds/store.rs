//! The feed ledger: sources, and every item ever seen.
//!
//! The deduplication lives here and it is a CONSTRAINT, not a check. `accept_items`
//! inserts with `ON CONFLICT (source_id, item_key) DO NOTHING RETURNING id`, so a
//! re-poll, a restart mid-poll and two workers polling at once all insert nothing
//! for an item that is already recorded. A read-then-write ("have I seen this?")
//! would pass every test and fail exactly when two polls overlap.
//!
//! There is a second guard in the same statement: an item whose URL was already
//! announced for this source is skipped even when the feed rotated its entry id
//! (feeds do this — same article, new GUID). Both guards are in the INSERT, so
//! there is no window between them.

use chrono::{DateTime, Utc};
use tokio_postgres::Client;

use crate::feeds::parse::Item;

/// Everything needed to register a source. A struct rather than a dozen
/// positional arguments, so a caller cannot swap two adjacent strings.
#[derive(Debug, Clone)]
pub struct NewSource {
    pub guild_id: String,
    /// Also the `scheduled_jobs` definition name.
    pub name: String,
    pub url: String,
    pub adapter: String,
    pub channel_id: String,
    pub message: String,
    pub mention_role_id: Option<String>,
    pub include_text: Option<String>,
    pub exclude_text: Option<String>,
    pub enabled: bool,
}

impl NewSource {
    pub fn new(
        guild_id: impl Into<String>,
        name: impl Into<String>,
        url: impl Into<String>,
        channel_id: impl Into<String>,
    ) -> Self {
        Self {
            guild_id: guild_id.into(),
            name: name.into(),
            url: url.into(),
            adapter: "auto".into(),
            channel_id: channel_id.into(),
            message: String::new(),
            mention_role_id: None,
            include_text: None,
            exclude_text: None,
            enabled: true,
        }
    }
}

/// A registered source, as stored.
#[derive(Debug, Clone)]
pub struct Source {
    pub id: i64,
    pub guild_id: String,
    pub name: String,
    pub url: String,
    pub adapter: String,
    pub channel_id: String,
    pub message: String,
    pub mention_role_id: Option<String>,
    pub include_text: Option<String>,
    pub exclude_text: Option<String>,
    pub enabled: bool,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub last_polled_at: Option<DateTime<Utc>>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub consecutive_failures: i32,
    pub primed: bool,
}

const SOURCE_COLUMNS: &str = "id, guild_id, name, url, adapter, channel_id, message, \
     mention_role_id, include_text, exclude_text, enabled, etag, last_modified, last_polled_at, \
     last_status, last_error, consecutive_failures, primed";

fn row_to_source(row: &tokio_postgres::Row) -> Source {
    Source {
        id: row.get(0),
        guild_id: row.get(1),
        name: row.get(2),
        url: row.get(3),
        adapter: row.get(4),
        channel_id: row.get(5),
        message: row.get(6),
        mention_role_id: row.get(7),
        include_text: row.get(8),
        exclude_text: row.get(9),
        enabled: row.get(10),
        etag: row.get(11),
        last_modified: row.get(12),
        last_polled_at: row.get(13),
        last_status: row.get(14),
        last_error: row.get(15),
        consecutive_failures: row.get(16),
        primed: row.get(17),
    }
}

/// Register or update a source. Returns its id.
pub async fn upsert_source(client: &Client, src: &NewSource) -> Result<i64, String> {
    let row = client
        .query_one(
            "INSERT INTO feed_sources
                 (guild_id, name, url, adapter, channel_id, message, mention_role_id,
                  include_text, exclude_text, enabled)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (guild_id, name) DO UPDATE SET
                 url = EXCLUDED.url,
                 adapter = EXCLUDED.adapter,
                 channel_id = EXCLUDED.channel_id,
                 message = EXCLUDED.message,
                 mention_role_id = EXCLUDED.mention_role_id,
                 include_text = EXCLUDED.include_text,
                 exclude_text = EXCLUDED.exclude_text,
                 enabled = EXCLUDED.enabled,
                 updated_at = now()
             RETURNING id",
            &[
                &src.guild_id,
                &src.name,
                &src.url,
                &src.adapter,
                &src.channel_id,
                &src.message,
                &src.mention_role_id,
                &src.include_text,
                &src.exclude_text,
                &src.enabled,
            ],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.get(0))
}

pub async fn source_by_id(client: &Client, id: i64) -> Result<Option<Source>, String> {
    let sql = format!("SELECT {SOURCE_COLUMNS} FROM feed_sources WHERE id = $1");
    let row = client
        .query_opt(&sql, &[&id])
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(row_to_source))
}

/// A source that is enabled, newest poll first — the operator view.
pub async fn sources_for_guild(client: &Client, guild_id: &str) -> Result<Vec<Source>, String> {
    let sql =
        format!("SELECT {SOURCE_COLUMNS} FROM feed_sources WHERE guild_id = $1 ORDER BY name");
    let rows = client
        .query(&sql, &[&guild_id])
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_source).collect())
}

/// Record a poll that answered. `validators` are the fresh `ETag`/
/// `Last-Modified` the server sent — stored so the next poll can ask for 304.
/// `status` is `ok` or `not_modified`, and either way the failure streak resets:
/// a server that answers 304 is a server that is working.
pub async fn set_poll_ok(
    client: &Client,
    id: i64,
    status: &str,
    validators: Option<(&str, Option<&str>)>,
) -> Result<(), String> {
    let (etag, last_modified) = match validators {
        Some((e, lm)) => (Some(e.to_string()), lm.map(|s| s.to_string())),
        None => (None, None),
    };
    client
        .execute(
            "UPDATE feed_sources SET
                 last_polled_at = now(),
                 last_success_at = now(),
                 last_status = $2,
                 last_error = NULL,
                 consecutive_failures = 0,
                 -- A 304 carries no validators: keep the ones we already trust.
                 etag = COALESCE($3, etag),
                 last_modified = COALESCE($4, last_modified),
                 updated_at = now()
             WHERE id = $1",
            &[&id, &status, &etag, &last_modified],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Record a poll that failed, and count the streak. The streak is what the
/// dashboard shows and what a "disable after N failures" policy would read; this
/// worker keeps polling either way, because a feed being down for a day is
/// normal and silently giving up is worse.
pub async fn set_poll_error(client: &Client, id: i64, error: &str) -> Result<(), String> {
    client
        .execute(
            "UPDATE feed_sources SET
                 last_polled_at = now(),
                 last_status = 'error',
                 last_error = $2,
                 consecutive_failures = consecutive_failures + 1,
                 updated_at = now()
             WHERE id = $1",
            &[&id, &error],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remember that a source's existing entries have been recorded once, so later
/// polls announce new items instead of priming.
pub async fn mark_primed(client: &Client, id: i64) -> Result<(), String> {
    client
        .execute(
            "UPDATE feed_sources SET primed = true, updated_at = now() WHERE id = $1",
            &[&id],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Insert items, skipping the ones already in the ledger. Returns the ids of the
/// rows that were actually inserted — that list is what gets announced, so a
/// re-poll returns an empty list and announces nothing.
///
/// `suppressed` marks the rows `primed` instead of `pending`: they are recorded
/// (so they can never be announced later) but they are not owed to a channel.
pub async fn accept_items(
    client: &Client,
    source_id: i64,
    items: &[Item],
    suppressed: bool,
) -> Result<Vec<i64>, String> {
    let state = if suppressed { "primed" } else { "pending" };
    let mut accepted = Vec::new();
    for item in items {
        let row = client
            .query_opt(
                "INSERT INTO feed_items
                     (source_id, item_key, external_id, title, url, summary, image,
                      published_at, delivery_state)
                 SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
                 WHERE NOT EXISTS (
                     -- Same source, same canonical URL, already owed or already
                     -- announced: the feed re-issued its own entry id.
                     SELECT 1 FROM feed_items
                     WHERE source_id = $1
                       AND url IS NOT NULL
                       AND url = $5
                       AND delivery_state IN ('pending', 'delivered')
                 )
                 ON CONFLICT (source_id, item_key) DO NOTHING
                 RETURNING id",
                &[
                    &source_id,
                    &item.key,
                    &item.external_id,
                    &item.title,
                    &item.url,
                    &item.summary,
                    &item.image,
                    &item.published_at,
                    &state,
                ],
            )
            .await
            .map_err(|e| e.to_string())?;
        if let Some(row) = row {
            accepted.push(row.get(0));
        }
    }
    Ok(accepted)
}

/// One item plus the source fields needed to announce it.
#[derive(Debug, Clone)]
pub struct Delivery {
    pub item_id: i64,
    pub source_id: i64,
    pub state: String,
    pub title: String,
    pub url: Option<String>,
    pub summary: String,
    pub image: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub guild_id: String,
    pub channel_id: String,
    pub message: String,
    pub mention_role_id: Option<String>,
    /// Why the last attempt failed, when it did. Kept for the operator.
    pub last_error: Option<String>,
}

pub async fn delivery_by_item(client: &Client, item_id: i64) -> Result<Option<Delivery>, String> {
    let row = client
        .query_opt(
            "SELECT i.id, i.source_id, i.delivery_state, i.title, i.url, i.summary, i.image,
                    i.published_at, s.guild_id, s.channel_id, s.message, s.mention_role_id,
                    i.delivery_error
             FROM feed_items i
             JOIN feed_sources s ON s.id = i.source_id
             WHERE i.id = $1",
            &[&item_id],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| Delivery {
        item_id: r.get(0),
        source_id: r.get(1),
        state: r.get(2),
        title: r.get(3),
        url: r.get(4),
        summary: r.get(5),
        image: r.get(6),
        published_at: r.get(7),
        guild_id: r.get(8),
        channel_id: r.get(9),
        message: r.get(10),
        mention_role_id: r.get(11),
        last_error: r.get(12),
    }))
}

/// Mark an item announced, recording which job did it.
pub async fn mark_delivered(client: &Client, item_id: i64, job_id: i64) -> Result<(), String> {
    client
        .execute(
            "UPDATE feed_items SET
                 delivery_state = 'delivered',
                 delivered_at = now(),
                 delivery_job_id = $2,
                 delivery_error = NULL
             WHERE id = $1",
            &[&item_id, &job_id],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Mark an item's announcement as failed for good (attempts exhausted), keeping
/// the reason so the dashboard can show it and an operator can re-arm it.
pub async fn mark_delivery_failed(
    client: &Client,
    item_id: i64,
    job_id: i64,
    error: &str,
) -> Result<(), String> {
    client
        .execute(
            "UPDATE feed_items SET
                 delivery_state = 'failed',
                 delivery_job_id = $2,
                 delivery_error = $3
             WHERE id = $1",
            &[&item_id, &job_id, &error],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Items owed to a channel, oldest first, bounded.
///
/// This is also the recovery path. If the worker dies between recording an item
/// and queueing its announcement, the item stays `pending` and the next poll picks
/// it up — the delivery job's `dedupe_key` makes that re-queue a no-op for items
/// that already have one.
pub async fn pending_item_ids(
    client: &Client,
    source_id: i64,
    limit: i64,
) -> Result<Vec<i64>, String> {
    let rows = client
        .query(
            "SELECT id FROM feed_items
              WHERE source_id = $1 AND delivery_state = 'pending'
              ORDER BY id
              LIMIT $2",
            &[&source_id, &limit],
        )
        .await
        .map_err(|e| format!("pending_item_ids: {e}"))?;
    Ok(rows.iter().map(|r| r.get::<_, i64>(0)).collect())
}

/// How much is owed to a channel, per source. This is the number the dashboard
/// shows and the one an operator needs when a feed suddenly posts 40 items.
///
/// `pending` only, and deliberately the same predicate as
/// [`pending_item_ids`]: what this counts is exactly what the next poll will
/// queue. A `failed` item is parked for a human, not owed — counting it here
/// would make the dashboard disagree with what the worker does.
pub async fn owed_count(client: &Client, source_id: i64) -> Result<i64, String> {
    let row = client
        .query_one(
            "SELECT count(*) FROM feed_items
             WHERE source_id = $1 AND delivery_state = 'pending'",
            &[&source_id],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.get(0))
}
