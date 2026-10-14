//! `/healthz` and `/readyz`, hand-rolled over tokio TCP.
//!
//! A private, loopback-only liveness surface does not justify an HTTP framework
//! and its dependency tree. `/healthz` answers from process state alone (never
//! touching the database, so it cannot be the thing that reports the worker
//! unhealthy because the database is slow). `/readyz` does one cheap
//! `SELECT 1`-class probe, which is the honest answer to "can this worker do its
//! job right now".

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::logging::{self, fields};
use crate::storage::Pool;

/// Serve health checks until the task is dropped. Bind failures are reported,
/// not fatal: a worker with no health port must still run its jobs.
pub async fn serve(listener: TcpListener, pool: Pool) {
    logging::info_map(
        "health listener up",
        fields(vec![(
            "addr",
            serde_json::Value::from(
                listener
                    .local_addr()
                    .map(|a| a.to_string())
                    .unwrap_or_else(|_| "unknown".into()),
            ),
        )]),
    );
    loop {
        let (mut socket, _peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                logging::warn(
                    "health accept failed",
                    fields(vec![("error", serde_json::Value::from(e.to_string()))]),
                );
                continue;
            }
        };
        let pool = pool.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            let read = match socket.read(&mut buf).await {
                Ok(n) => n,
                Err(_) => return,
            };
            let request = String::from_utf8_lossy(&buf[..read]);
            let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();

            let (status, body) = match path.as_str() {
                // Liveness: process state only.
                "/healthz" => (200u16, "{\"status\":\"ok\"}".to_string()),
                // Readiness: one cheap probe of the real dependency.
                "/readyz" => match readyz(&pool).await {
                    Ok(()) => (200, "{\"status\":\"ready\"}".to_string()),
                    Err(e) => (
                        503,
                        format!("{{\"status\":\"unready\",\"error\":{}}}", json_string(&e)),
                    ),
                },
                _ => (404, "{\"error\":\"not_found\"}".to_string()),
            };

            let response = format!(
                "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {len}\r\nconnection: close\r\n\r\n{body}",
                reason = if status == 200 { "OK" } else { "Service Unavailable" },
                len = body.len(),
                body = body
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });
    }
}

/// Is the database reachable? One round trip, nothing more.
async fn readyz(pool: &Pool) -> Result<(), String> {
    let session = pool.acquire().await?;
    session
        .client()
        .simple_query("SELECT 1")
        .await
        .map(|_| ())
        .map_err(|e| format!("database: {e}"))
}

/// Minimal JSON string escaping, so an error message cannot break the envelope.
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_string_escapes_quotes_and_control_characters() {
        assert_eq!(json_string("a\"b"), "\"a\\\"b\"");
        assert_eq!(json_string("a\nb"), "\"a\\nb\"");
        assert_eq!(json_string("tab\there"), "\"tab\\there\"");
    }

    #[test]
    fn json_string_leaves_plain_text_alone() {
        assert_eq!(
            json_string("database: connection refused"),
            "\"database: connection refused\""
        );
    }

    #[test]
    fn json_string_escapes_below_space_as_unicode() {
        assert_eq!(json_string("\u{1}"), "\"\\u0001\"");
    }
}
