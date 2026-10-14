//! Fetching a feed we have already decided we are allowed to fetch.
//!
//! Three things this layer is responsible for, all of them about NOT trusting the
//! network:
//!
//! **Every hop is vetted.** `reqwest`'s own redirect follower is turned off and
//! the loop is written here, so a `302` to `http://169.254.169.254/` is refused by
//! the same rules as the original URL. A follower would have already made the
//! request.
//!
//! **The address that was vetted is the address that is connected to.**
//! `resolve_to_addrs` replaces DNS for that one client, closing the window where a
//! name resolves to a public address for the check and a private one for the
//! connect (DNS rebinding). The cost is a client per fetch — no connection reuse
//! across polls. That is the right trade here: polls are minutes apart.
//!
//! **Nothing about the response is unbounded.** A body over `MAX_BODY_BYTES` is
//! refused while streaming, so a hostile or broken source cannot make the worker
//! allocate without limit.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use crate::feeds::guard::{self, Rejection, SystemResolver, Vetted};

/// Refuse a body larger than this. Generous for a feed, tiny next to the memory
/// of the box.
pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// Redirect hops allowed before giving up.
pub const MAX_REDIRECTS: usize = 5;

/// Whole-request timeout, including the body read.
pub const TIMEOUT_SECS: u64 = 20;

/// Sent so an operator on the other side can identify the traffic.
pub const USER_AGENT: &str = concat!("fudcourt-feeds/", env!("CARGO_PKG_VERSION"));

/// A vetting decision, as an object, so the transport can be given the real
/// guard in production and a permissive one in tests.
pub type VetFuture<'a> = Pin<Box<dyn Future<Output = Result<Vetted, Rejection>> + Send + 'a>>;

pub trait Vettor: Send + Sync {
    fn vet<'a>(&'a self, raw: &'a str) -> VetFuture<'a>;
}

/// The production vettor: the real SSRF rules, resolving through the system.
pub struct GuardVettor {
    resolver: SystemResolver,
}

impl GuardVettor {
    pub fn new() -> Self {
        Self {
            resolver: SystemResolver,
        }
    }
}

impl Default for GuardVettor {
    fn default() -> Self {
        Self::new()
    }
}

impl Vettor for GuardVettor {
    fn vet<'a>(&'a self, raw: &'a str) -> VetFuture<'a> {
        Box::pin(async move { guard::vet(raw, &self.resolver).await })
    }
}

/// What we already have from last time, for the conditional request.
#[derive(Debug, Clone, Default)]
pub struct Conditional {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

/// The result of a fetch.
#[derive(Debug)]
pub enum Fetched {
    /// The source says nothing changed. No body, no parsing.
    NotModified,
    Body {
        body: Vec<u8>,
        etag: Option<String>,
        last_modified: Option<String>,
        status: u16,
    },
}

/// Reads the response body, refusing to grow past [`MAX_BODY_BYTES`].
async fn read_bounded(mut resp: reqwest::Response, url: &str) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if out.len() + chunk.len() > MAX_BODY_BYTES {
                    return Err(format!(
                        "{url}: body exceeds {MAX_BODY_BYTES} bytes and was refused"
                    ));
                }
                out.extend_from_slice(&chunk);
            }
            Ok(None) => return Ok(out),
            Err(e) => return Err(format!("{url}: reading the body failed: {e}")),
        }
    }
}

/// The statuses that carry a `Location` we are meant to follow.
///
/// Deliberately not `is_redirection()`: `304` lives in the 3xx range and would be
/// mistaken for a redirect, which is exactly the kind of bug that turns a cached
/// poll into a hard failure.
fn is_followable(status: reqwest::StatusCode) -> bool {
    use reqwest::StatusCode as S;
    matches!(
        status,
        S::MOVED_PERMANENTLY
            | S::FOUND
            | S::SEE_OTHER
            | S::TEMPORARY_REDIRECT
            | S::PERMANENT_REDIRECT
    )
}

/// Builds a client whose DNS for one host is replaced by the addresses we vetted.
fn pinned_client(vetted: &Vetted) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // We follow redirects ourselves, so each hop gets vetted.
        .redirect(reqwest::redirect::Policy::none())
        // An ambient HTTP_PROXY would route around the pinned address.
        .no_proxy()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(10))
        // `resolve_to_addrs` replaces DNS for this host: the addresses vetted are
        // the addresses connected to, so a name that answers differently between
        // the check and the connect cannot move the request.
        .resolve_to_addrs(
            &vetted.host,
            &vetted.addrs.iter().copied().collect::<Vec<_>>(),
        )
        .build()
        .map_err(|e| format!("could not build an HTTP client: {e}"))
}

/// Fetches `url`, following redirects one vetted hop at a time.
pub struct Fetcher {
    vettor: Box<dyn Vettor>,
}

impl Fetcher {
    /// The production fetcher: every URL goes through the real guard.
    pub fn new() -> Self {
        Self {
            vettor: Box::new(GuardVettor::new()),
        }
    }

    pub async fn fetch(&self, url: &str, cond: &Conditional) -> Result<Fetched, String> {
        let mut current = url.to_string();

        for hop in 0..=MAX_REDIRECTS {
            // Vetted before a socket exists, and the addresses it returns are the
            // only ones this hop can reach.
            let vetted = self
                .vettor
                .vet(&current)
                .await
                .map_err(|rej| format!("{}: {rej}", current.trim()))?;

            let client = pinned_client(&vetted)?;
            let mut req = client.get(vetted.url.clone());
            if let Some(etag) = &cond.etag {
                req = req.header(reqwest::header::IF_NONE_MATCH, etag);
            }
            if let Some(lm) = &cond.last_modified {
                req = req.header(reqwest::header::IF_MODIFIED_SINCE, lm);
            }

            let resp = req
                .send()
                .await
                .map_err(|e| format!("{}: request failed: {e}", vetted.url))?;
            let status = resp.status();

            // `304` sits inside the 3xx range but is NOT a redirect: it is the
            // answer to our conditional request and carries no `Location`.
            if status == reqwest::StatusCode::NOT_MODIFIED {
                return Ok(Fetched::NotModified);
            }
            if is_followable(status) {
                if hop == MAX_REDIRECTS {
                    return Err(format!("{url}: more than {MAX_REDIRECTS} redirects"));
                }
                let location = resp
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| format!("{url}: {} without a Location", status.as_u16()))?;
                // A relative Location is legal and is resolved against the hop we
                // just made, not against the original URL.
                current = vetted
                    .url
                    .join(location)
                    .map_err(|e| format!("{url}: bad redirect target `{location}`: {e}"))?
                    .to_string();
                continue;
            }

            if !status.is_success() {
                return Err(format!("{}: HTTP {}", vetted.url, status.as_u16()));
            }

            let header = |name: reqwest::header::HeaderName| {
                resp.headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.to_string())
            };
            let etag = header(reqwest::header::ETAG);
            let last_modified = header(reqwest::header::LAST_MODIFIED);
            let body = read_bounded(resp, vetted.url.as_str()).await?;
            return Ok(Fetched::Body {
                body,
                etag,
                last_modified,
                status: status.as_u16(),
            });
        }

        Err(format!("{url}: redirect loop"))
    }
}

impl Default for Fetcher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, SocketAddr, TcpListener};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration as StdDuration;

    /// Vettes nothing: lets the tests drive a loopback stub through the real
    /// transport, which the production guard would (correctly) refuse.
    struct Permissive {
        /// Optional lie: answer with this address instead of a real lookup.
        redirect_to: Option<SocketAddr>,
    }

    impl Vettor for Permissive {
        fn vet<'a>(&'a self, raw: &'a str) -> VetFuture<'a> {
            let lie = self.redirect_to;
            Box::pin(async move {
                let url = url::Url::parse(raw).map_err(|e| Rejection::Scheme(e.to_string()))?;
                let host = url
                    .host_str()
                    .ok_or(Rejection::NoHost)?
                    .trim_matches(|c| c == '[' || c == ']')
                    .to_string();
                let port = url
                    .port_or_known_default()
                    .ok_or_else(|| Rejection::Scheme("no port".into()))?;
                let addrs = if let Some(addr) = lie {
                    vec![addr]
                } else if let Ok(ip) = host.parse::<IpAddr>() {
                    vec![SocketAddr::new(ip, port)]
                } else {
                    let resolved: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
                        .await
                        .map_err(|_| Rejection::Unresolvable(host.clone()))?
                        .collect();
                    resolved
                };
                Ok(Vetted {
                    url,
                    host,
                    addrs: addrs.into_iter().collect(),
                })
            })
        }
    }

    /// A one-shot-per-response TCP server, so the transport can be exercised
    /// without the network. Returns the feed URL, the join handle, and the bytes
    /// of each request that arrived (so header behaviour can be asserted).
    fn stub<F>(script: F) -> (String, thread::JoinHandle<()>, mpsc::Receiver<Vec<u8>>)
    where
        F: FnOnce(SocketAddr) -> Vec<String>,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let addr = listener.local_addr().expect("local addr");
        let responses = script(addr);
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            for response in responses {
                let (mut sock, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(_) => return,
                };
                let mut buf = vec![0u8; 16 * 1024];
                let n = std::io::Read::read(&mut sock, &mut buf).unwrap_or(0);
                let _ = tx.send(buf[..n].to_vec());
                let _ = std::io::Write::write_all(&mut sock, response.as_bytes());
                let _ = std::io::Write::flush(&mut sock);
                drop(sock);
            }
        });
        (format!("http://{addr}/feed"), handle, rx)
    }

    fn ok(body: &str, extra: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn fetcher(vettor: Permissive) -> Fetcher {
        Fetcher {
            vettor: Box::new(vettor),
        }
    }

    #[tokio::test]
    async fn a_200_comes_back_with_its_body_and_validators() {
        let (url, handle, _rx) = stub(|_| {
            vec![ok(
                "hello",
                "ETag: \"v1\"\r\nLast-Modified: Mon, 05 Oct 2026 10:00:00 GMT\r\n",
            )]
        });
        let f = fetcher(Permissive { redirect_to: None });
        match f.fetch(&url, &Conditional::default()).await {
            Ok(Fetched::Body {
                body,
                etag,
                last_modified,
                status,
            }) => {
                assert_eq!(status, 200);
                assert_eq!(String::from_utf8(body).unwrap(), "hello");
                assert_eq!(etag.as_deref(), Some("\"v1\""));
                assert_eq!(
                    last_modified.as_deref(),
                    Some("Mon, 05 Oct 2026 10:00:00 GMT")
                );
            }
            other => panic!("expected a body, got {other:?}"),
        }
        let _ = handle.join();
    }

    #[tokio::test]
    async fn a_304_is_reported_as_unchanged() {
        let (url, handle, _rx) =
            stub(|_| vec!["HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".to_string()]);
        let f = fetcher(Permissive { redirect_to: None });
        let cond = Conditional {
            etag: Some("\"v1\"".into()),
            last_modified: None,
        };
        assert!(matches!(
            f.fetch(&url, &cond).await,
            Ok(Fetched::NotModified)
        ));
        let _ = handle.join();
    }

    #[tokio::test]
    async fn our_validators_are_sent_as_conditional_headers() {
        let (url, handle, rx) =
            stub(|_| vec!["HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".to_string()]);
        let f = fetcher(Permissive { redirect_to: None });
        let cond = Conditional {
            etag: Some("\"abc\"".into()),
            last_modified: Some("Mon, 05 Oct 2026 10:00:00 GMT".into()),
        };
        let _ = f.fetch(&url, &cond).await;
        let request = rx
            .recv_timeout(StdDuration::from_secs(5))
            .expect("the server saw the request");
        let text = String::from_utf8_lossy(&request).to_lowercase();
        assert!(text.contains("if-none-match: \"abc\""), "{text}");
        assert!(
            text.contains("if-modified-since: mon, 05 oct 2026 10:00:00 gmt"),
            "{text}"
        );
        let _ = handle.join();
    }

    fn redirect(location: &str) -> String {
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\n\
             Connection: close\r\n\r\n"
        )
    }

    #[tokio::test]
    async fn a_redirect_is_followed_to_a_second_hop() {
        let (url, handle, _rx) = stub(|addr| {
            vec![
                redirect(&format!("http://{addr}/final")),
                ok("second hop", ""),
            ]
        });
        let f = fetcher(Permissive { redirect_to: None });
        match f.fetch(&url, &Conditional::default()).await {
            Ok(Fetched::Body { body, .. }) => {
                assert_eq!(String::from_utf8(body).unwrap(), "second hop")
            }
            other => panic!("expected the redirected body, got {other:?}"),
        }
        let _ = handle.join();
    }

    #[tokio::test]
    async fn a_relative_redirect_is_resolved_against_the_hop_it_came_from() {
        let (url, handle, _rx) = stub(|_| vec![redirect("/final"), ok("relative", "")]);
        let f = fetcher(Permissive { redirect_to: None });
        match f.fetch(&url, &Conditional::default()).await {
            Ok(Fetched::Body { body, .. }) => {
                assert_eq!(String::from_utf8(body).unwrap(), "relative")
            }
            other => panic!("expected the redirected body, got {other:?}"),
        }
        let _ = handle.join();
    }

    #[tokio::test]
    async fn a_redirect_loop_is_stopped_at_the_limit() {
        // More responses than the limit, so one is left unserved: the handle is
        // deliberately not joined (its thread is parked on accept).
        let (url, _handle, _rx) = stub(|addr| {
            (0..MAX_REDIRECTS + 2)
                .map(|_| redirect(&format!("http://{addr}/again")))
                .collect()
        });
        let f = fetcher(Permissive { redirect_to: None });
        let err = f.fetch(&url, &Conditional::default()).await.unwrap_err();
        assert!(err.contains("more than 5 redirects"), "got: {err}");
    }

    #[tokio::test]
    async fn a_redirect_without_a_location_is_an_error() {
        let (url, handle, _rx) = stub(|_| {
            vec!["HTTP/1.1 302 Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()]
        });
        let f = fetcher(Permissive { redirect_to: None });
        let err = f.fetch(&url, &Conditional::default()).await.unwrap_err();
        assert!(err.contains("without a Location"), "got: {err}");
        let _ = handle.join();
    }

    #[tokio::test]
    async fn a_non_2xx_is_an_error_naming_the_status() {
        let (url, handle, _rx) = stub(|_| {
            vec![
                "HTTP/1.1 503 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string(),
            ]
        });
        let f = fetcher(Permissive { redirect_to: None });
        let err = f.fetch(&url, &Conditional::default()).await.unwrap_err();
        assert!(err.contains("HTTP 503"), "got: {err}");
        let _ = handle.join();
    }

    #[tokio::test]
    async fn a_body_past_the_ceiling_is_refused() {
        let (url, _handle, _rx) = stub(|_| {
            let huge = "x".repeat(MAX_BODY_BYTES + 64);
            vec![ok(&huge, "")]
        });
        let f = fetcher(Permissive { redirect_to: None });
        let err = f.fetch(&url, &Conditional::default()).await.unwrap_err();
        assert!(err.contains("exceeds"), "got: {err}");
    }

    #[tokio::test]
    async fn the_connection_goes_to_the_vetted_address_not_a_fresh_lookup() {
        // `feed.invalid` does not resolve — it cannot, `.invalid` is reserved.
        // The fetch succeeds only because the transport connects to the address
        // the vettor named, which is exactly the property that closes the
        // resolve-then-connect window (DNS rebinding).
        let (url, handle, _rx) = stub(|_| vec![ok("pinned", "")]);
        let addr: SocketAddr = url
            .trim_start_matches("http://")
            .split('/')
            .next()
            .expect("host:port")
            .parse()
            .expect("a socket address");
        let unqualified = format!("http://feed.invalid:{}/feed", addr.port());

        let f = fetcher(Permissive {
            redirect_to: Some(addr),
        });
        match f.fetch(&unqualified, &Conditional::default()).await {
            Ok(Fetched::Body { body, .. }) => {
                assert_eq!(String::from_utf8(body).unwrap(), "pinned")
            }
            other => panic!("the pinned address was not used: {other:?}"),
        }
        let _ = handle.join();
    }
}
