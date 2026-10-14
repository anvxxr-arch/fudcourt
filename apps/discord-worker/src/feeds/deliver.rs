//! Announcing one item: the only place the worker talks to Discord.
//!
//! Why the worker posts directly (and not the bot process): it keeps the whole
//! feature inside one crate and one environment variable, instead of adding a
//! second process, a new internal API route and an outbox table. The bot stays a
//! gateway client. The trade-off is that the delivery token is readable by the
//! worker — which is already the case for everything else on this host.
//!
//! **What is not trusted here is the feed.** Everything that ends up in the
//! message is either fed through `allowed_mentions` restricted to explicitly
//! configured roles, or neutralised at parse time. A feed author cannot ping
//! `@everyone` through us.

use std::sync::Arc;

use crate::discord::DiscordPoster;
use crate::feeds::parse;
use crate::feeds::store::{self, Delivery};
use crate::handlers::{HandlerFuture, JobHandler};
use crate::jobs::{ClaimedJob, Disposition};
use crate::logging::{self, fields as log_fields};
use crate::storage::Pool;

// The transport and the classification of Discord's answer live in
// [`crate::discord`], because the scheduler's message delivery posts through the
// same code and a second copy of "429 means later" is how one of the two ends up
// wrong. Re-exported so this module's surface reads as it did before the
// extraction.
pub use crate::discord::{DeliveryError, API_BASE};

/// Discord rejects an embed title past this.
pub const MAX_TITLE_CHARS: usize = 256;

/// An embed description cap, well under Discord's 4096.
pub const MAX_DESCRIPTION_CHARS: usize = 1024;

/// Fills the configured message template.
///
/// Only these placeholders are understood — a feed value is never treated as a
/// template, so a payload containing `{args}` renders literally instead of
/// reaching into anything.
pub fn render_message(template: &str, d: &Delivery) -> String {
    let url = d.url.as_deref().unwrap_or("");
    template
        .replace("{title}", &d.title)
        .replace("{url}", url)
        .replace("{link}", url)
        .replace("{summary}", &d.summary)
}

/// The JSON body for `POST /channels/{id}/messages`.
///
/// `mentions` is what the caller is allowed to ping, and it is always an explicit
/// list: an empty list means no mention is parsed anywhere in the message.
pub fn message_body(d: &Delivery, rendered: &str) -> serde_json::Value {
    let mut content = String::new();
    let mut allowed = serde_json::json!({"parse": []});

    if let Some(role) = d.mention_role_id.as_deref().filter(|r| !r.is_empty()) {
        content.push_str(&format!("<@&{role}> "));
        allowed = serde_json::json!({"parse": [], "roles": [role]});
    }
    content.push_str(rendered);

    let mut embed = serde_json::json!({
        "title": parse::truncate_chars(d.title.as_str(), MAX_TITLE_CHARS),
    });
    if let Some(url) = d.url.as_deref() {
        embed["url"] = serde_json::Value::from(url);
    }
    if !d.summary.is_empty() {
        embed["description"] =
            serde_json::Value::from(parse::truncate_chars(&d.summary, MAX_DESCRIPTION_CHARS));
    }
    if let Some(image) = d.image.as_deref() {
        embed["image"] = serde_json::json!({ "url": image });
    }
    if let Some(at) = d.published_at {
        embed["timestamp"] = serde_json::Value::from(at.to_rfc3339());
    }

    serde_json::json!({
        "content": content,
        "embeds": [embed],
        "allowed_mentions": allowed,
    })
}

/// Posts announcements to Discord.
pub struct Deliver {
    pool: Pool,
    poster: DiscordPoster,
}

impl Deliver {
    /// The production sender: the real API base, the real token.
    pub fn new(pool: Pool, token: String) -> Self {
        Self {
            pool,
            poster: DiscordPoster::new(token),
        }
    }

    /// Announce one item.
    ///
    /// The state check makes a retry cheap and safe *after* a successful mark. A
    /// crash between the POST and the mark still re-posts on retry: Discord has no
    /// idempotency key here, so the guarantee is at-least-once, and that is stated
    /// rather than pretended.
    pub async fn deliver(&self, job_id: i64, item_id: i64) -> Result<(), DeliveryError> {
        let delivery = {
            let session = self.pool.acquire().await?;
            store::delivery_by_item(session.client(), item_id).await?
        };
        let Some(d) = delivery else {
            return Err(DeliveryError::Permanent(format!(
                "no feed item with id {item_id}"
            )));
        };
        if d.state == "delivered" {
            return Ok(());
        }

        let body = message_body(&d, &render_message(&d.message, &d));
        if let Err(e) = self.poster.post_message(&d.channel_id, &body).await {
            // A PERMANENT rejection is recorded before it is returned, so the
            // dashboard shows why a channel went quiet instead of only a dead job.
            // A retryable one is not recorded: the retry may still succeed, and a
            // `failed` row takes the item out of `owed` for good.
            if let DeliveryError::Permanent(note) = &e {
                if let Ok(session) = self.pool.acquire().await {
                    if let Err(e) =
                        store::mark_delivery_failed(session.client(), item_id, job_id, note).await
                    {
                        logging::warn(
                            "could not record a failed delivery",
                            log_fields(vec![("error", serde_json::Value::from(e))]),
                        );
                    }
                }
            }
            return Err(e);
        }

        let session = self.pool.acquire().await?;
        store::mark_delivered(session.client(), item_id, job_id).await?;
        Ok(())
    }
}

/// The runner entry point for [`DELIVER_KIND`](crate::feeds::DELIVER_KIND).
pub fn handler(deliver: Arc<Deliver>) -> Arc<dyn JobHandler> {
    Arc::new(move |job: ClaimedJob| -> HandlerFuture {
        let deliver = Arc::clone(&deliver);
        Box::pin(async move {
            let Some(item_id) = job.payload.get("item_id").and_then(|v| v.as_i64()) else {
                return Disposition::Permanent("feed.deliver payload has no item_id".to_string());
            };
            match deliver.deliver(job.id, item_id).await {
                Ok(()) => Disposition::Done,
                Err(DeliveryError::Permanent(e)) => Disposition::Permanent(e),
                Err(DeliveryError::Retryable(e)) => Disposition::Retryable(e),
            }
        })
    })
}
