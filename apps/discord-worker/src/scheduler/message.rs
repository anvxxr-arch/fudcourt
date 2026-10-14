//! `discord.message` — a message an operator scheduled from the dashboard.
//!
//! A `scheduled_jobs` definition whose `job_kind` is [`MESSAGE_KIND`] is
//! materialized by the scheduler's tick into an ordinary job, so a scheduled
//! message is claimed, retried, backed off and dead-lettered by exactly the runtime
//! everything else uses. This module is only the `kind` -> code half.
//!
//! WHY THE PAYLOAD IS TWO FIELDS WIDE. `{"channel_id", "content"}` is the whole
//! contract. Every additional thing a scheduled message could carry (an embed, a
//! file, a thread target, a mention list) is new surface in a payload a dashboard
//! writes, and each one is a thing an operator can already do by hand. Widening it
//! is a deliberate change, not a default.
//!
//! THE ONE SAFETY RULE THAT IS NOT OPTIONAL: a scheduled message can never ping.
//! It is sent with `allowed_mentions: {"parse": []}`, so a stored `@everyone`
//! renders as plain text instead of notifying the server. The dashboard is the
//! author, but the stored content outlives whoever wrote it, and "this message
//! cannot mention anyone" is a property of the SENDER, not of the text.

use std::sync::Arc;

use crate::discord::{DeliveryError, DiscordPoster};
use crate::handlers::{HandlerFuture, JobHandler};
use crate::jobs::{ClaimedJob, Disposition};

/// The job kind a scheduled message is materialized as. Also the default
/// `scheduled_jobs.job_kind`, which is why it is the one kind this worker both
/// schedules and executes.
pub const MESSAGE_KIND: &str = "discord.message";

/// Discord's own cap is 2000 characters; the limit here is under it so a future
/// version that prepends anything (a mention prefix, a footer) cannot tip a valid
/// payload over the boundary in production.
pub const MAX_CONTENT_CHARS: usize = 1900;

/// Posts one scheduled message.
pub struct Message {
    poster: DiscordPoster,
    /// The guild this worker serves. A job carrying a different one is refused
    /// rather than posted: the queue is shared, and "some other guild's job" must
    /// never become a message in this guild's channel.
    guild_id: String,
}

impl Message {
    /// The production sender: the real token, the pinned API base.
    pub fn new(token: impl Into<String>, guild_id: impl Into<String>) -> Self {
        Self {
            poster: DiscordPoster::new(token),
            guild_id: guild_id.into(),
        }
    }

    /// A sender over an explicit poster. Tests inject a loopback base.
    pub fn with_poster(poster: DiscordPoster, guild_id: impl Into<String>) -> Self {
        Self {
            poster,
            guild_id: guild_id.into(),
        }
    }

    /// Send the message. `Ok` means Discord accepted it; anything else carries the
    /// classification the runner needs to decide between a retry and a park.
    pub async fn send(&self, channel_id: &str, content: &str) -> Result<(), DeliveryError> {
        self.poster
            .post_message(channel_id, &message_body(content))
            .await
    }
}

/// The JSON body for `POST /channels/{id}/messages`.
///
/// `parse: []` is the entire mention policy: nothing in the content is parsed as a
/// mention, so neither a stray `@everyone` nor a raw role id can notify anyone.
pub fn message_body(content: &str) -> serde_json::Value {
    serde_json::json!({
        "content": content,
        "allowed_mentions": { "parse": [] },
    })
}

/// Read the payload contract, or name what is wrong with it.
///
/// Every failure here is PERMANENT by construction: a payload that does not name a
/// channel will not start naming one on the third attempt, so retrying it would
/// only delay the operator finding out. The messages are operator-facing text, as
/// the dashboard shows them verbatim.
pub fn parse_payload(payload: &serde_json::Value) -> Result<(String, String), String> {
    let channel_id = payload
        .get("channel_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let content = payload
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if channel_id.is_empty() {
        return Err("payload has no channel_id".to_string());
    }
    if !is_snowflake(&channel_id) {
        return Err(format!(
            "channel_id `{channel_id}` is not a Discord channel id"
        ));
    }
    if content.trim().is_empty() {
        return Err("payload has no content".to_string());
    }
    let chars = content.chars().count();
    if chars > MAX_CONTENT_CHARS {
        return Err(format!(
            "content is {chars} characters; the limit is {MAX_CONTENT_CHARS}"
        ));
    }
    Ok((channel_id, content))
}

/// A Discord snowflake is a decimal id. Both the dashboard and the API keep ids as
/// TEXT (a JSON number would lose the precision), and this is the last place that
/// can refuse something that is not an id before Discord answers 404 or 400.
pub fn is_snowflake(s: &str) -> bool {
    (17..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// The runner entry point for [`MESSAGE_KIND`].
pub fn handler(message: Arc<Message>) -> Arc<dyn JobHandler> {
    Arc::new(move |job: ClaimedJob| -> HandlerFuture {
        let message = Arc::clone(&message);
        Box::pin(async move {
            // A job for another guild is not ours to post. Only refused when the job
            // states a guild at all: an empty one is a hand-made row, and the
            // channel in its payload is still this worker's to reach.
            if !job.guild_id.is_empty() && job.guild_id != message.guild_id {
                return Disposition::Permanent(format!(
                    "job belongs to guild {} but this worker serves {}",
                    job.guild_id, message.guild_id
                ));
            }
            let (channel_id, content) = match parse_payload(&job.payload) {
                Ok(parts) => parts,
                Err(e) => return Disposition::Permanent(e),
            };
            match message.send(&channel_id, &content).await {
                Ok(()) => Disposition::Done,
                Err(DeliveryError::Permanent(e)) => Disposition::Permanent(e),
                Err(DeliveryError::Retryable(e)) => Disposition::Retryable(e),
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discord::stub;

    const CHANNEL: &str = "123456789012345678";

    fn job(guild_id: &str, payload: serde_json::Value) -> ClaimedJob {
        ClaimedJob {
            id: 1,
            guild_id: guild_id.to_string(),
            kind: MESSAGE_KIND.to_string(),
            dedupe_key: "sched:1:1".to_string(),
            payload,
            attempts: 1,
            max_attempts: 5,
        }
    }

    fn good_payload() -> serde_json::Value {
        serde_json::json!({"channel_id": CHANNEL, "content": "Standup in 10 minutes"})
    }

    #[test]
    fn a_valid_payload_yields_the_channel_and_the_text() {
        let (channel, content) = parse_payload(&good_payload()).expect("valid");
        assert_eq!(channel, CHANNEL);
        assert_eq!(content, "Standup in 10 minutes");
    }

    #[test]
    fn a_snowflake_is_decimal_and_17_to_20_digits() {
        assert!(is_snowflake(CHANNEL));
        for bad in ["", "123", "abc123456789012345", "12345678901234567890x"] {
            assert!(!is_snowflake(bad), "{bad} must not be a snowflake");
        }
    }

    #[test]
    fn every_malformed_payload_names_what_is_wrong() {
        let cases = [
            (serde_json::json!({"content": "x"}), "channel_id"),
            (
                serde_json::json!({"channel_id": "  ", "content": "x"}),
                "channel_id",
            ),
            (
                serde_json::json!({"channel_id": "not-an-id", "content": "x"}),
                "not a Discord channel id",
            ),
            (serde_json::json!({"channel_id": CHANNEL}), "content"),
            (
                serde_json::json!({"channel_id": CHANNEL, "content": "   "}),
                "content",
            ),
        ];
        for (payload, expected) in cases {
            let err = parse_payload(&payload).unwrap_err();
            assert!(err.contains(expected), "{payload}: got {err}");
        }
    }

    #[test]
    fn content_over_the_limit_is_refused_by_counting_characters() {
        // Multi-byte, so a byte-length check would refuse this too early and a
        // naive one would let 1900 accented characters through as 3800 bytes.
        let payload = serde_json::json!({
            "channel_id": CHANNEL,
            "content": "é".repeat(MAX_CONTENT_CHARS + 1),
        });
        let err = parse_payload(&payload).unwrap_err();
        assert!(err.contains("characters"), "got: {err}");

        let at_limit = serde_json::json!({
            "channel_id": CHANNEL,
            "content": "é".repeat(MAX_CONTENT_CHARS),
        });
        assert!(
            parse_payload(&at_limit).is_ok(),
            "exactly at the limit is valid"
        );
    }

    #[test]
    fn extra_payload_fields_are_ignored_rather_than_refused() {
        // A dashboard that grows a field before this worker is redeployed must not
        // turn every existing message into a permanent failure.
        let payload = serde_json::json!({
            "channel_id": CHANNEL,
            "content": "hi",
            "thread_id": "1",
            "embeds": [],
        });
        assert!(parse_payload(&payload).is_ok());
    }

    #[test]
    fn a_scheduled_message_can_never_ping() {
        let body = message_body("@everyone @here <@&123456789012345678> hi");
        assert_eq!(body["allowed_mentions"]["parse"], serde_json::json!([]));
        assert!(
            body["allowed_mentions"].get("roles").is_none(),
            "an empty parse list is the whole policy: {body}"
        );
        assert_eq!(body["content"], "@everyone @here <@&123456789012345678> hi");
        assert!(body.get("embeds").is_none());
    }

    #[tokio::test]
    async fn a_successful_post_is_done() {
        let (base, handle, rx) = stub::serve(vec![stub::ok(r#"{"id":"9"}"#)]);
        let message = Message::with_poster(DiscordPoster::with_base("t", &base), "guild-1");
        let h = handler(Arc::new(message));
        let outcome = h.handle(job("guild-1", good_payload())).await;
        assert!(matches!(outcome, Disposition::Done), "{outcome:?}");

        let request = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the stub saw the request");
        let text = String::from_utf8_lossy(&request);
        assert!(text.contains("Standup in 10 minutes"), "{text}");
        assert!(text.contains(r#""parse":[]"#), "no mentions parsed: {text}");
        let _ = handle.join();
    }

    #[tokio::test]
    async fn a_malformed_payload_is_permanent_and_never_reaches_discord() {
        // No stub at all: if this posted, the connection would fail and the
        // disposition would be Retryable, so the assertion proves the early exit.
        let message = Message::with_poster(
            DiscordPoster::with_base("t", "http://127.0.0.1:1"),
            "guild-1",
        );
        let h = handler(Arc::new(message));
        let outcome = h
            .handle(job("guild-1", serde_json::json!({"content": "no channel"})))
            .await;
        match outcome {
            Disposition::Permanent(m) => assert!(m.contains("channel_id"), "{m}"),
            other => panic!("expected Permanent, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_job_for_another_guild_is_refused_rather_than_posted() {
        let message = Message::with_poster(
            DiscordPoster::with_base("t", "http://127.0.0.1:1"),
            "guild-1",
        );
        let h = handler(Arc::new(message));
        let outcome = h.handle(job("guild-999", good_payload())).await;
        match outcome {
            Disposition::Permanent(m) => {
                assert!(m.contains("guild-999") && m.contains("guild-1"), "{m}");
            }
            other => panic!("expected Permanent, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_403_is_permanent_and_a_429_is_retryable() {
        for (response, want_permanent) in [
            (
                stub::json(403, "Forbidden", r#"{"message":"Missing Permissions"}"#),
                true,
            ),
            (stub::json(429, "Too Many Requests", r#"{}"#), false),
        ] {
            let (base, handle, _rx) = stub::serve(vec![response]);
            let message = Message::with_poster(DiscordPoster::with_base("t", &base), "guild-1");
            let h = handler(Arc::new(message));
            let outcome = h.handle(job("guild-1", good_payload())).await;
            match (outcome, want_permanent) {
                (Disposition::Permanent(_), true) | (Disposition::Retryable(_), false) => {}
                (other, _) => panic!("wrong classification: {other:?}"),
            }
            let _ = handle.join();
        }
    }
}
