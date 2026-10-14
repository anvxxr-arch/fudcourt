//! The worker's one Discord REST surface.
//!
//! WHY THERE IS ONE POSTER AND NOT TWO. The feeds delivery and the scheduler's
//! message delivery POST the same request to the same pinned host, and the part
//! that is easy to get subtly wrong is not the JSON — it is the CLASSIFICATION of
//! Discord's answer. `429` and `5xx` mean "later"; every other `4xx` means the
//! request itself is wrong, and repeating it burns attempts until the job is
//! parked. Two copies of that rule drift, and the drift is invisible until a
//! message is either retried forever or dropped without a single retry. So there
//! is one poster, one classification, and one place that bounds Discord's own
//! error text before it reaches a log line or a database column.
//!
//! The base URL is pinned rather than configured: there is no deployment in which
//! pointing the bot token at another host is correct, and a redirectable base is a
//! way to leak the token. Tests inject one through [`DiscordPoster::with_base`].

use std::time::Duration;

/// Discord's REST root.
pub const API_BASE: &str = "https://discord.com/api/v10";

/// One request's budget before it counts as a retryable failure.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// How much of Discord's error body is kept for the operator.
const MAX_DETAIL_CHARS: usize = 300;

/// A delivery failure, classified by whether repeating it can help.
#[derive(Debug)]
pub enum DeliveryError {
    Permanent(String),
    Retryable(String),
}

impl From<String> for DeliveryError {
    fn from(e: String) -> Self {
        DeliveryError::Retryable(e)
    }
}

/// Classify a NON-success answer.
///
/// `429` (rate limited) and `5xx` (Discord's own trouble) are the two answers that
/// mean "later". Everything else in `4xx` means the request is wrong — a bad
/// channel, a missing permission, a revoked token — and repeating it changes
/// nothing, so the job is parked for an operator instead of spinning.
pub fn classify(status: u16, detail: &str) -> DeliveryError {
    if status == 429 || (500..=599).contains(&status) {
        DeliveryError::Retryable(format!("Discord answered {status}: {detail}"))
    } else {
        DeliveryError::Permanent(format!("Discord rejected the message ({status}): {detail}"))
    }
}

/// Bound a string by CHARACTERS. Discord's error text is attacker-adjacent (it can
/// echo a body we sent), and it ends up in a log line and a `last_error` column
/// sized by what an operator can actually read.
fn bounded(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

/// Discord's error text, bounded. Never the request, so the token cannot ride along.
async fn detail_of(resp: reqwest::Response) -> String {
    match resp.text().await {
        Ok(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                "no body".to_string()
            } else {
                bounded(trimmed, MAX_DETAIL_CHARS)
            }
        }
        Err(_) => "unreadable body".to_string(),
    }
}

/// Posts messages as the bot.
pub struct DiscordPoster {
    http: reqwest::Client,
    token: String,
    api_base: String,
}

impl DiscordPoster {
    /// The production poster: the pinned base, the real token.
    pub fn new(token: impl Into<String>) -> Self {
        Self::with_base(token, API_BASE)
    }

    /// A poster with an explicit base. Tests only — production has one base, and
    /// this exists so the transport can be exercised over loopback.
    pub fn with_base(token: impl Into<String>, api_base: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            http,
            token: token.into(),
            api_base: api_base.into(),
        }
    }

    /// `POST /channels/{channel_id}/messages`.
    ///
    /// The CALLER builds `body`: what goes inside the message (an embed for a feed
    /// item, plain content for a scheduled message) is the caller's business. The
    /// endpoint, the auth header and the classification of the answer are this
    /// function's, and that is the whole reason it exists once.
    pub async fn post_message(
        &self,
        channel_id: &str,
        body: &serde_json::Value,
    ) -> Result<(), DeliveryError> {
        let url = format!("{}/channels/{}/messages", self.api_base, channel_id);
        let resp = self
            .http
            .post(&url)
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bot {}", self.token),
            )
            .json(body)
            .send()
            .await
            .map_err(|e| DeliveryError::Retryable(format!("posting to Discord failed: {e}")))?;

        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        let detail = detail_of(resp).await;
        Err(classify(status.as_u16(), &detail))
    }
}

/// A loopback HTTP server that answers with canned bytes, so the transport is
/// exercised for real without touching the network. Two modules need it now, so it
/// lives here rather than being copied into each test module.
#[cfg(test)]
pub(crate) mod stub {
    use std::net::{SocketAddr, TcpListener};
    use std::sync::mpsc;
    use std::thread;

    /// Serve `responses` in order, one connection each. Returns the base URL to hand
    /// to [`super::DiscordPoster::with_base`], the join handle, and the raw bytes of
    /// every request that arrived — so headers and bodies can be asserted.
    pub fn serve(
        responses: Vec<String>,
    ) -> (String, thread::JoinHandle<()>, mpsc::Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let addr: SocketAddr = listener.local_addr().expect("local addr");
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            for response in responses {
                let (mut sock, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(_) => return,
                };
                let request = read_request(&mut sock);
                let _ = tx.send(request);
                let _ = std::io::Write::write_all(&mut sock, response.as_bytes());
                let _ = std::io::Write::flush(&mut sock);
            }
        });
        (format!("http://{addr}"), handle, rx)
    }

    /// Read one request in full. A single fixed-size read can cut a POST short and
    /// make an assertion flaky, so the declared body length is honoured.
    fn read_request(sock: &mut std::net::TcpStream) -> Vec<u8> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match std::io::Read::read(sock, &mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
            if let Some(head_end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head_end = head_end + 4;
                match declared_length(&buf[..head_end]) {
                    Some(len) if buf.len() >= head_end + len => break,
                    Some(_) => {}
                    None => break,
                }
            }
            if buf.len() > 1 << 20 {
                break;
            }
        }
        buf
    }

    fn declared_length(head: &[u8]) -> Option<usize> {
        let text = String::from_utf8_lossy(head).to_ascii_lowercase();
        let idx = text.find("content-length:")?;
        text[idx + "content-length:".len()..]
            .lines()
            .next()?
            .trim()
            .parse()
            .ok()
    }

    /// A canned answer with a JSON body.
    pub fn json(status: u16, reason: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// A canned `200 OK`.
    pub fn ok(body: &str) -> String {
        json(200, "OK", body)
    }
}

#[cfg(test)]
mod tests {
    use super::stub;
    use super::*;

    #[test]
    fn a_429_and_a_5xx_are_retryable_while_other_4xx_are_not() {
        assert!(matches!(
            classify(429, "slow down"),
            DeliveryError::Retryable(_)
        ));
        assert!(matches!(classify(500, "oops"), DeliveryError::Retryable(_)));
        assert!(matches!(classify(503, "oops"), DeliveryError::Retryable(_)));
        for status in [400, 401, 403, 404, 405] {
            assert!(
                matches!(classify(status, "no"), DeliveryError::Permanent(_)),
                "{status} must be permanent: repeating it cannot help"
            );
        }
    }

    #[test]
    fn a_classified_failure_keeps_discords_own_words_and_its_status() {
        match classify(403, "Missing Permissions") {
            DeliveryError::Permanent(m) => {
                assert!(m.contains("403"), "{m}");
                assert!(m.contains("Missing Permissions"), "{m}");
            }
            other => panic!("expected Permanent, got {other:?}"),
        }
    }

    #[test]
    fn the_error_text_is_bounded_by_characters_not_bytes() {
        // Multi-byte, so a byte slice would cut a character in half.
        let long = "é".repeat(MAX_DETAIL_CHARS + 50);
        assert_eq!(
            bounded(&long, MAX_DETAIL_CHARS).chars().count(),
            MAX_DETAIL_CHARS
        );
        assert_eq!(bounded("short", MAX_DETAIL_CHARS), "short");
    }

    #[tokio::test]
    async fn a_post_carries_the_bot_header_the_right_path_and_the_body() {
        let (base, handle, rx) = stub::serve(vec![stub::ok(r#"{"id":"1"}"#)]);
        let poster = DiscordPoster::with_base("secret-token", &base);
        let body = serde_json::json!({"content": "hi", "allowed_mentions": {"parse": []}});
        poster
            .post_message("123456789012345678", &body)
            .await
            .expect("a 200 is success");

        let request = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the stub saw the request");
        let text = String::from_utf8_lossy(&request);
        assert!(
            text.starts_with("POST /channels/123456789012345678/messages"),
            "{text}"
        );
        assert!(
            text.to_ascii_lowercase()
                .contains("authorization: bot secret-token"),
            "{text}"
        );
        assert!(text.contains(r#""content":"hi""#), "{text}");
        let _ = handle.join();
    }

    #[tokio::test]
    async fn a_403_comes_back_permanent_with_discords_own_message() {
        let (base, handle, _rx) = stub::serve(vec![stub::json(
            403,
            "Forbidden",
            r#"{"message":"Missing Permissions","code":50013}"#,
        )]);
        let poster = DiscordPoster::with_base("t", &base);
        match poster
            .post_message("123456789012345678", &serde_json::json!({"content": "x"}))
            .await
        {
            Err(DeliveryError::Permanent(m)) => {
                assert!(m.contains("Missing Permissions"), "{m}");
                assert!(m.contains("50013"), "the body is kept, not replaced: {m}");
            }
            other => panic!("expected Permanent, got {other:?}"),
        }
        let _ = handle.join();
    }

    #[tokio::test]
    async fn a_429_comes_back_retryable() {
        let (base, handle, _rx) = stub::serve(vec![stub::json(
            429,
            "Too Many Requests",
            r#"{"retry_after":1.2}"#,
        )]);
        let poster = DiscordPoster::with_base("t", &base);
        match poster
            .post_message("123456789012345678", &serde_json::json!({"content": "x"}))
            .await
        {
            Err(DeliveryError::Retryable(m)) => assert!(m.contains("429"), "{m}"),
            other => panic!("expected Retryable, got {other:?}"),
        }
        let _ = handle.join();
    }

    #[tokio::test]
    async fn an_unreachable_host_is_retryable_not_permanent() {
        // Port 1 on loopback: nothing listens, so the transport fails. That is a
        // "later" answer, never a reason to park the job.
        let poster = DiscordPoster::with_base("t", "http://127.0.0.1:1");
        match poster
            .post_message("123456789012345678", &serde_json::json!({"content": "x"}))
            .await
        {
            Err(DeliveryError::Retryable(_)) => {}
            other => panic!("expected Retryable, got {other:?}"),
        }
    }
}
