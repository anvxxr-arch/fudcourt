//! The HTTP surface: a bounded HTTP/1.1 server with `Content-Length` framing,
//! one request per connection, and exactly the routes the contract names.
//!
//! WHY HAND-ROLLED: see the binary's header. This file is the whole cost of that
//! decision, kept in one place so the routing, the framing and the refusals are
//! readable in one screen each.

use std::io::ErrorKind;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::reconcile;
use crate::persistence::db::Db;

/// Hard cap on one request's head, so a client that never sends CRLFCRLF cannot
/// pin memory. 8 KiB is ~100x the largest realistic head (a GET with a Host and
/// an Accept header).
const MAX_HEAD: usize = 8 * 1024;

/// One parsed request: method, path, and nothing else (this service takes no
/// query, no body and no headers that affect its answer).
struct Request {
    method: String,
    path: String,
}

/// Read and parse one request head from the stream.
///
/// Returns `Ok(None)` for a cleanly closed connection with no request (a probe),
/// which the caller treats as "nothing to answer".
async fn read_request(s: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    loop {
        if buf.len() >= MAX_HEAD {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "request head too large",
            ));
        }
        let mut chunk = [0u8; 512];
        let n = s.read(&mut chunk).await?;
        if n == 0 {
            if buf.is_empty() {
                return Ok(None);
            }
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        // The head ends at the first CRLFCRLF. Everything after it is a body,
        // which this service ignores: it accepts no body on any route.
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let Some(start) = lines.next() else {
        return Ok(None);
    };
    let mut parts = start.split(' ');
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    if method.is_empty() || target.is_empty() {
        return Ok(None);
    }
    // Strip the query: no route reads one, and a caller that sends `?x=1` must
    // still be routed on the path (the same tolerance every HTTP server has).
    let path = target.split('?').next().unwrap_or_default().to_string();
    Ok(Some(Request { method, path }))
}

/// Write one response. `Content-Length` framing; `no-store` so a proxy in front
/// of this service cannot serve a stale reconciliation.
async fn respond(s: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let payload = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status = status,
        reason = reason(status),
        len = payload.len(),
    );
    s.write_all(head.as_bytes()).await?;
    s.write_all(&payload).await?;
    s.flush().await?;
    Ok(())
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "Unknown",
    }
}

/// Answer one parsed request. Kept separate from the socket work so the routing
/// table is unit-testable with no listener.
pub async fn route(db: &Db, method: &str, path: &str) -> (u16, Value) {
    if method != "GET" && method != "HEAD" {
        return (405, json!({"error": "method not allowed"}));
    }
    match path {
        "/healthz" => {
            // The row count is a real liveness signal: it proves the service can
            // reach Turso, not merely that the process is up.
            match reconcile::load(db).await {
                Ok((rows, _summary, _wallets)) => (
                    200,
                    json!({"ok": true, "service": "reconcile", "rows": rows.len()}),
                ),
                Err(e) => (500, json!({"error": e})),
            }
        }
        "/api/reconcile" => match reconcile::load(db).await {
            Ok((rows, summary, wallets)) => {
                (200, reconcile::body(&rows, &wallets, &summary, "rust"))
            }
            // A database failure is a loud 500 with the real reason -- never a
            // 200 with `{rows: []}`, which would read as "everything reconciles".
            Err(e) => (500, json!({"error": e})),
        },
        _ => (404, json!({"error": "not found"})),
    }
}

/// Bind and serve forever. One task per connection; a malformed request closes
/// its own connection without touching the process.
pub async fn serve(addr: &str, db: Db) -> Result<(), String> {
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;
    let local = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?;
    eprintln!("fudcourt-reconciled listening on {local} (rust reconcile service; DR-014)");
    loop {
        let (mut stream, _peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                // A per-connection accept error must not kill the service.
                eprintln!("fudcourt-reconciled: accept: {e}");
                continue;
            }
        };
        let db = db.clone();
        tokio::spawn(async move {
            match read_request(&mut stream).await {
                Ok(Some(req)) => {
                    let (status, body) = route(&db, &req.method, &req.path).await;
                    let _ = respond(&mut stream, status, &body).await;
                }
                Ok(None) => {}
                Err(_) => {
                    let _ = respond(&mut stream, 500, &json!({"error": "bad request"})).await;
                }
            }
            let _ = stream.shutdown().await;
        });
    }
}
