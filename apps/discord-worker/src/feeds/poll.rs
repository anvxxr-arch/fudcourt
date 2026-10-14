//! One poll of one source: fetch, decide what is new, queue the announcements.
//!
//! The order of operations is the whole design:
//!
//! 1. Read the source, then **release the connection** before the HTTP request.
//!    A poll can take seconds; holding a pool slot (let alone a transaction)
//!    across it is how a worker starves itself.
//! 2. Fetch conditionally (`If-None-Match` / `If-Modified-Since`), so a quiet
//!    feed costs a 304 and nothing else.
//! 3. Insert into the ledger through `accept_items`. The returned ids ARE the
//!    new items — the decision "already seen" is a unique constraint, so a
//!    duplicate poll (a retry, a restart, two workers) inserts nothing.
//! 4. Queue one `feed.deliver` per owed item, then drain **the whole pending
//!    backlog**, not just this batch. That is the crash recovery: an item whose
//!    announcement was never queued stays `pending` and is picked up next poll.
//! 5. A source's **first** poll records everything without announcing it, so
//!    adding a feed does not dump twenty old posts into the channel.

use std::sync::Arc;

use crate::feeds::fetch::{Conditional, Fetched, Fetcher};
use crate::feeds::parse::{self, Item};
use crate::feeds::{store, PollOutcome, DELIVER_KIND};
use crate::handlers::{HandlerFuture, JobHandler};
use crate::jobs::{ClaimedJob, Disposition, NewJob};
use crate::logging::{self, fields as log_fields};
use crate::storage::jobs;
use crate::storage::Pool;

/// How many owed items one poll will queue. Bounds the work a single tick does
/// after a long outage, while still draining steadily.
pub const DELIVERY_BATCH: i64 = 100;

/// A poll failure we already know is pointless to retry.
#[derive(Debug)]
pub enum PollError {
    /// Retrying this will never help: the payload names no source, or the source
    /// is gone.
    Permanent(String),
    /// Everything else: network, parse, database. Worth another attempt.
    Retryable(String),
}

impl From<String> for PollError {
    fn from(e: String) -> Self {
        PollError::Retryable(e)
    }
}

/// The poll side of the pipeline, as one object so the handler closure captures a
/// single owned value.
pub struct Poll {
    pool: Pool,
    fetcher: Fetcher,
    /// Every job needs an owner; this is the one guild the bot serves.
    guild_id: String,
}

impl Poll {
    pub fn new(pool: Pool, guild_id: String) -> Self {
        Self {
            pool,
            fetcher: Fetcher::new(),
            guild_id,
        }
    }

    /// Does `include_text` / `exclude_text` let this item through?
    ///
    /// Matching is case-insensitive over title and summary. An unset filter means
    /// "no opinion", not "match nothing".
    fn keep(source: &store::Source, item: &Item) -> bool {
        let haystack = format!("{} {}", item.title, item.summary).to_lowercase();
        if let Some(needle) = source.include_text.as_deref() {
            if !needle.is_empty() && !haystack.contains(&needle.to_lowercase()) {
                return false;
            }
        }
        if let Some(needle) = source.exclude_text.as_deref() {
            if !needle.is_empty() && haystack.contains(&needle.to_lowercase()) {
                return false;
            }
        }
        true
    }
}

impl Poll {
    /// One poll, start to finish.
    pub async fn poll_once(&self, source_id: i64) -> Result<PollOutcome, PollError> {
        // Read the source and let the connection go: the HTTP request below can
        // take seconds and must not hold a pool slot.
        let source = {
            let session = self.pool.acquire().await?;
            store::source_by_id(session.client(), source_id).await?
        };
        let Some(source) = source else {
            return Err(PollError::Permanent(format!(
                "no feed source with id {source_id}"
            )));
        };
        if !source.enabled {
            return Ok(PollOutcome::Skipped("the source is disabled".into()));
        }

        let conditional = Conditional {
            etag: source.etag.clone(),
            last_modified: source.last_modified.clone(),
        };
        let (body, etag, last_modified) = match self.fetcher.fetch(&source.url, &conditional).await
        {
            Ok(Fetched::NotModified) => {
                let session = self.pool.acquire().await?;
                // A server answering 304 is a server that works: the streak resets
                // and the validators we already hold stay trusted.
                store::set_poll_ok(session.client(), source.id, "not_modified", None).await?;
                return Ok(PollOutcome::NotModified);
            }
            Ok(Fetched::Body {
                body,
                etag,
                last_modified,
                ..
            }) => (body, etag, last_modified),
            Err(e) => {
                self.note_failure(source.id, &e).await;
                return Err(PollError::Retryable(e));
            }
        };

        let parsed = match parse::items_from(&body, parse::MAX_ITEMS_PER_POLL) {
            Ok(items) => items,
            Err(e) => {
                self.note_failure(source.id, &e).await;
                return Err(PollError::Retryable(e));
            }
        };
        let parsed_len = parsed.len();
        let items: Vec<Item> = parsed
            .into_iter()
            .filter(|item| Self::keep(&source, item))
            .collect();
        let filtered = parsed_len - items.len();

        // The first successful poll is an absorption, not an announcement.
        let suppressed = !source.primed;

        let session = self.pool.acquire().await?;
        let client = session.client();
        let accepted = store::accept_items(client, source.id, &items, suppressed).await?;
        let known = items.len() - accepted.len();
        let primed = if suppressed { accepted.len() } else { 0 };
        if suppressed {
            store::mark_primed(client, source.id).await?;
        }

        // Queue the announcements: this batch, plus anything an earlier poll left
        // owed. `dedupe_key` is per item, so a re-queue of an item that already has
        // a job inserts nothing.
        let mut queued = 0usize;
        if !suppressed {
            for item_id in store::pending_item_ids(client, source.id, DELIVERY_BATCH).await? {
                let job = NewJob {
                    guild_id: self.guild_id.clone(),
                    kind: DELIVER_KIND.to_string(),
                    dedupe_key: format!("feed.deliver:{}:{}", source.id, item_id),
                    payload: serde_json::json!({
                        "source_id": source.id,
                        "item_id": item_id,
                    }),
                    delay_secs: 0,
                    max_attempts: 5,
                };
                if jobs::enqueue(client, &job).await?.is_some() {
                    queued += 1;
                }
            }
        }

        // Last, so a crash mid-way leaves the source un-primed/un-updated and the
        // next poll repeats the work safely.
        store::set_poll_ok(
            client,
            source.id,
            "ok",
            etag.as_deref().map(|e| (e, last_modified.as_deref())),
        )
        .await?;

        logging::info_map(
            "feed polled",
            log_fields(vec![
                ("source", serde_json::Value::from(source.name.clone())),
                ("new", serde_json::Value::from(accepted.len() as u64)),
                ("known", serde_json::Value::from(known as u64)),
                ("filtered", serde_json::Value::from(filtered as u64)),
                ("queued", serde_json::Value::from(queued as u64)),
                ("primed", serde_json::Value::from(primed as u64)),
            ]),
        );

        Ok(PollOutcome::Changed {
            new: accepted.len(),
            known,
            filtered,
            primed,
        })
    }

    /// Record a failed poll. A failure that cannot even be recorded is only logged:
    /// the original error is the one worth reporting.
    async fn note_failure(&self, source_id: i64, error: &str) {
        let recorded = match self.pool.acquire().await {
            Ok(session) => store::set_poll_error(session.client(), source_id, error).await,
            Err(e) => Err(e),
        };
        if let Err(e) = recorded {
            logging::warn(
                "the failed poll could not be recorded",
                log_fields(vec![("error", serde_json::Value::from(e))]),
            );
        }
    }
}

/// The runner entry point for [`POLL_KIND`](crate::feeds::POLL_KIND).
pub fn handler(poll: Arc<Poll>) -> Arc<dyn JobHandler> {
    Arc::new(move |job: ClaimedJob| -> HandlerFuture {
        let poll = Arc::clone(&poll);
        Box::pin(async move {
            let Some(source_id) = job.payload.get("source_id").and_then(|v| v.as_i64()) else {
                return Disposition::Permanent("feed.poll payload has no source_id".to_string());
            };
            match poll.poll_once(source_id).await {
                Ok(PollOutcome::Skipped(reason)) => {
                    logging::info_map(
                        "feed poll skipped",
                        log_fields(vec![
                            ("source_id", serde_json::Value::from(source_id)),
                            ("reason", serde_json::Value::from(reason)),
                        ]),
                    );
                    Disposition::Done
                }
                Ok(_) => Disposition::Done,
                Err(PollError::Permanent(e)) => Disposition::Permanent(e),
                Err(PollError::Retryable(e)) => Disposition::Retryable(e),
            }
        })
    })
}
