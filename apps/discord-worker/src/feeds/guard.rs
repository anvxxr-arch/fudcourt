//! SSRF vetting: deciding whether a URL may be fetched at all.
//!
//! A feed URL is attacker-controlled text — an admin pastes it, or a public feed
//! 302s somewhere new — and this worker sits on a LAN with Postgres, the api and
//! cloud metadata reachable over loopback and link-local. So a URL is vetted
//! *before* a socket is opened, and the vetting **returns the address the socket
//! is pinned to**. Checking and connecting cannot be two separate steps: a name
//! that answered with a public address during the check can answer `127.0.0.1`
//! when the client resolves it again (DNS rebinding). Whatever this module
//! approves is what gets connected to, by address.
//!
//! Host parsing is `url`'s, not this module's. That matters more than it sounds:
//! the WHATWG host parser already folds the legacy IPv4 spellings —
//! `http://2130706433/`, `http://0x7f000001/`, `http://127.1/` — into
//! `127.0.0.1`, so they are caught by the address check instead of by a bespoke
//! regex per bypass.

use std::collections::BTreeSet;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;

use ipnet::IpNet;
use url::{Host, Url};

/// Ports a feed may live on: the web, plus the two self-hosted conventions worth
/// supporting. There is no "any port" escape hatch, because a feed URL that
/// points at `:9200` or `:6379` is not a feed.
pub const ALLOWED_PORTS: [u16; 4] = [80, 443, 8080, 8443];

/// Nothing outside the public internet is a feed. IPv4 first.
const BLOCKED_V4: &[&str] = &[
    "0.0.0.0/8",       // "this network" — 0.0.0.0 alone is unroutable
    "10.0.0.0/8",      // private
    "100.64.0.0/10",   // CGNAT: carrier-internal, not public
    "127.0.0.0/8",     // loopback
    "169.254.0.0/16",  // link-local — 169.254.169.254 is the metadata service
    "172.16.0.0/12",   // private
    "192.0.0.0/24",    // IETF protocol assignments
    "192.0.2.0/24",    // documentation
    "192.88.99.0/24",  // 6to4 relay anycast
    "192.168.0.0/16",  // private
    "198.18.0.0/15",   // benchmarking
    "198.51.100.0/24", // documentation
    "203.0.113.0/24",  // documentation
    "224.0.0.0/4",     // multicast
    "240.0.0.0/4",     // reserved, includes 255.255.255.255
];

/// The IPv6 equivalents. Ranges that EMBED an IPv4 address (`::ffff:`, 6to4,
/// NAT64) are deliberately absent: blanket-blocking them would reject a
/// legitimate public address, so those are unwrapped and the embedded v4 is
/// judged instead (see `embedded_v4`).
const BLOCKED_V6: &[&str] = &[
    "::/128",        // unspecified
    "::1/128",       // loopback
    "100::/64",      // discard-only
    "2001:db8::/32", // documentation
    "2001::/32",     // Teredo — tunnels over an unverified v4 endpoint
    "fc00::/7",      // unique local
    "fe80::/10",     // link-local
    "ff00::/8",      // multicast
];

/// Why a URL was refused. Every variant is a distinct rule with its own test, so
/// a refusal in the log names the rule instead of saying "bad url".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    /// Not `http`/`https` — `file:`, `gopher:`, `data:` and friends.
    Scheme(String),
    /// `user:pass@host`: credentials this worker must never forward or log.
    Credentials,
    /// A percent sign in the hostname. Nothing legitimate has one, and it is how
    /// a parser-confusion bypass is spelled. (`url` usually decodes these into an
    /// address first, which the address check then catches; this is the backstop
    /// for the spellings it does not.)
    EncodedHost,
    /// A host with a single label — `localhost`, `intranet`, or whatever
    /// `http:///rss` collapses to. A resolver will happily look a single label up
    /// through a search domain, which is how a URL reaches a host that was never
    /// named. A feed lives on an FQDN or a literal address.
    NotQualified(String),
    /// No host at all (`http:///x`).
    NoHost,
    /// A port outside [`ALLOWED_PORTS`].
    Port(u16),
    /// The host resolved to nothing.
    Unresolvable(String),
    /// A resolved address inside a non-public range.
    Private(IpAddr),
}

impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Rejection::Scheme(s) => write!(f, "scheme `{s}` is not http(s)"),
            Rejection::Credentials => write!(f, "URL carries credentials"),
            Rejection::EncodedHost => write!(f, "hostname is percent-encoded"),
            Rejection::NotQualified(h) => write!(
                f,
                "`{h}` is not a qualified name; a single label can resolve through a search domain"
            ),
            Rejection::NoHost => write!(f, "URL has no host"),
            Rejection::Port(p) => write!(f, "port {p} is not in {ALLOWED_PORTS:?}"),
            Rejection::Unresolvable(h) => write!(f, "`{h}` did not resolve"),
            Rejection::Private(ip) => write!(f, "{ip} is not a public address"),
        }
    }
}

/// A URL that passed vetting, together with the exact addresses it may be
/// reached at. The fetcher pins these; it must not resolve the name again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vetted {
    /// The normalized URL (scheme and host lowercased by `url`).
    pub url: Url,
    /// The host as parsed, without brackets for a literal IPv6.
    pub host: String,
    /// Every address the host resolved to, all of them public.
    pub addrs: BTreeSet<SocketAddr>,
}

impl Vetted {
    /// The `Host` header value: a hostname, or a bracketed literal address.
    pub fn host_header(&self) -> String {
        match self.url.host() {
            Some(Host::Ipv6(_)) => format!("[{}]", self.host),
            _ => self.host.clone(),
        }
    }
}

/// Resolving is the one part of vetting that needs the outside world, and it is
/// behind a trait so the rule matrix can be tested against a fixed table instead
/// of against DNS.
pub type ResolveFuture<'a> =
    Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>>;

pub trait Resolver: Send + Sync {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a>;
}

/// The real resolver: the system's, via tokio.
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a> {
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((host, port)).await?;
            Ok(addrs.collect())
        })
    }
}

/// What the URL says, without touching the network: scheme, credentials, host
/// shape and port. Split out so a caller can refuse obvious junk before paying
/// for a lookup, and so these rules are testable synchronously.
pub fn vet_shape(raw: &str) -> Result<(Url, u16), Rejection> {
    let url = Url::parse(raw).map_err(|e| Rejection::Scheme(e.to_string()))?;

    match url.scheme() {
        "http" | "https" => {}
        other => return Err(Rejection::Scheme(other.to_string())),
    }

    if !url.username().is_empty() || url.password().is_some() {
        return Err(Rejection::Credentials);
    }

    let host = match url.host() {
        Some(h) => h,
        None => return Err(Rejection::NoHost),
    };

    if let Host::Domain(name) = &host {
        if name.contains('%') {
            return Err(Rejection::EncodedHost);
        }
        // A single label is not a feed host: it is `localhost`, an intranet
        // shortname, or the leftover of `http:///rss`. Any of those resolves
        // through a search domain to a machine nobody asked for.
        if name.split('.').filter(|label| !label.is_empty()).count() < 2 {
            return Err(Rejection::NotQualified(name.to_string()));
        }
    }

    // `Url::port_or_known_default` is populated for http/https, so this is the
    // effective port — an explicit `:443` and an implicit one are the same port
    // and both allowed.
    let port = url.port_or_known_default().ok_or(Rejection::NoHost)?;
    if !ALLOWED_PORTS.contains(&port) {
        return Err(Rejection::Port(port));
    }

    Ok((url, port))
}

/// The address the blocklist actually judged.
///
/// For a v6 address that carries a v4 one (v4-mapped, 6to4, NAT64) that is the
/// embedded v4, because that is the address a reader needs to see. Reporting
/// `::ffff:127.0.0.1` in a refusal log sends an operator looking for a v6 problem
/// that does not exist.
pub fn judged(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => embedded_v4(v6).map(IpAddr::V4).unwrap_or(ip),
        IpAddr::V4(_) => ip,
    }
}

/// True for any address that is not a public internet address.
///
/// A v6 address that carries a v4 one (v4-mapped, 6to4, NAT64) is judged by that
/// v4: `::ffff:127.0.0.1` is loopback no matter how it is spelled, while
/// `::ffff:93.184.216.34` is a public address and not blocked. Blanket-blocking
/// the mapped range would reject that second one wrongly.
pub fn is_blocked(ip: IpAddr) -> bool {
    match judged(ip) {
        IpAddr::V4(v4) => v4_blocked(v4),
        IpAddr::V6(v6) => v6_nets().iter().any(|n| n.contains(&IpAddr::V6(v6))),
    }
}

fn v4_blocked(v4: Ipv4Addr) -> bool {
    v4_nets().iter().any(|n| n.contains(&IpAddr::V4(v4)))
}

fn v4_nets() -> Vec<IpNet> {
    BLOCKED_V4.iter().filter_map(|c| c.parse().ok()).collect()
}

fn v6_nets() -> Vec<IpNet> {
    BLOCKED_V6.iter().filter_map(|c| c.parse().ok()).collect()
}

/// The IPv4 address an IPv6 address is carrying, if it is carrying one:
/// v4-mapped `::ffff:a.b.c.d`, 6to4 `2002:AABB:CCDD::/16`, or NAT64
/// `64:ff9b::/96` / `64:ff9b:1::/48`.
fn embedded_v4(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(v4) = v6.to_ipv4_mapped() {
        return Some(v4);
    }
    let o = v6.octets();
    // 6to4: next 32 bits are the v4 it tunnels to.
    if o[0] == 0x20 && o[1] == 0x02 {
        return Some(Ipv4Addr::new(o[2], o[3], o[4], o[5]));
    }
    // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48) prefixes
    // carry the v4 in the last 32 bits.
    let nat64_wkp = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];
    let nat64_local = [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01];
    if o[..12] == nat64_wkp || o[..6] == nat64_local {
        return Some(Ipv4Addr::new(o[12], o[13], o[14], o[15]));
    }
    None
}

/// Full vetting: shape rules, then resolution, then every address.
///
/// EVERY resolved address must be public. A host that answers with one public
/// and one loopback address is refused, not half-trusted: the client picks
/// among the addresses it is given, so "one of them is fine" is not a property
/// this module can hand over.
pub async fn vet(raw: &str, resolver: &dyn Resolver) -> Result<Vetted, Rejection> {
    let (url, port) = vet_shape(raw)?;
    let host = match url.host() {
        Some(Host::Domain(name)) => name.to_string(),
        Some(Host::Ipv4(a)) => a.to_string(),
        Some(Host::Ipv6(a)) => a.to_string(),
        None => return Err(Rejection::NoHost),
    };

    // A literal address needs no lookup, and asking the resolver about it would
    // be a way to lose the check.
    if let Some(literal) = match url.host() {
        Some(Host::Ipv4(a)) => Some(IpAddr::V4(a)),
        Some(Host::Ipv6(a)) => Some(IpAddr::V6(a)),
        _ => None,
    } {
        if is_blocked(literal) {
            return Err(Rejection::Private(judged(literal)));
        }
        let mut addrs = BTreeSet::new();
        addrs.insert(SocketAddr::new(literal, port));
        return Ok(Vetted { url, host, addrs });
    }

    let resolved = resolver
        .resolve(&host, port)
        .await
        .map_err(|_| Rejection::Unresolvable(host.clone()))?;
    if resolved.is_empty() {
        return Err(Rejection::Unresolvable(host));
    }

    let mut addrs = BTreeSet::new();
    for addr in resolved {
        if is_blocked(addr.ip()) {
            return Err(Rejection::Private(judged(addr.ip())));
        }
        addrs.insert(addr);
    }

    Ok(Vetted { url, host, addrs })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A resolver with a fixed table, so the rule matrix is a test of the RULES
    /// and not of whatever DNS answers today.
    struct Static(HashMap<String, Vec<IpAddr>>);

    impl Static {
        fn new(pairs: &[(&str, &[&str])]) -> Self {
            let map = pairs
                .iter()
                .map(|(host, ips)| {
                    let addrs = ips.iter().map(|s| s.parse().expect("test ip")).collect();
                    ((*host).to_string(), addrs)
                })
                .collect();
            Static(map)
        }
    }

    impl Resolver for Static {
        fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a> {
            let found = self.0.get(host).cloned();
            Box::pin(async move {
                match found {
                    Some(ips) if !ips.is_empty() => Ok(ips
                        .into_iter()
                        .map(|ip| SocketAddr::new(ip, port))
                        .collect()),
                    _ => Err(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "no such host",
                    )),
                }
            })
        }
    }

    /// A resolver that answers with a public address for anything, so a test
    /// that is about the URL's own shape never depends on the table.
    fn any_public() -> Static {
        Static::new(&[("feed.example", &["93.184.216.34"])])
    }

    fn rejected(raw: &str) -> Rejection {
        vet_shape(raw).expect_err(&format!("{raw} should have been refused"))
    }

    #[test]
    fn only_http_and_https_are_fetchable() {
        for raw in [
            "file:///etc/passwd",
            "gopher://127.0.0.1:70/_x",
            "data:text/html,<script>x</script>",
            "javascript:alert(1)",
            "ftp://example.com/x",
        ] {
            match rejected(raw) {
                Rejection::Scheme(_) => {}
                other => panic!("{raw} was refused as {other:?}, not as a scheme"),
            }
        }
    }

    #[test]
    fn credentials_in_the_url_are_refused() {
        // They would be forwarded as an Authorization header and then logged.
        assert_eq!(
            rejected("https://user:pass@feed.example/rss"),
            Rejection::Credentials
        );
        assert_eq!(
            rejected("https://token@feed.example/rss"),
            Rejection::Credentials
        );
    }

    #[test]
    fn only_the_web_ports_are_allowed() {
        for raw in [
            "http://feed.example:9200/",
            "http://feed.example:6379/",
            "http://feed.example:22/",
            "http://feed.example:25/",
            "https://feed.example:8443/", // allowed
            "http://feed.example:8080/",  // allowed
        ] {
            let result = vet_shape(raw);
            let expected_allowed = raw.contains(":8443") || raw.contains(":8080");
            assert_eq!(
                result.is_ok(),
                expected_allowed,
                "{raw} → {:?}",
                result.err()
            );
        }
    }

    #[test]
    fn the_effective_port_is_what_is_checked() {
        // An explicit :443 and no port at all are the same port, and both pass.
        for raw in ["https://feed.example/rss", "https://feed.example:443/rss"] {
            let (url, port) = vet_shape(raw).expect(raw);
            assert_eq!(port, 443);
            assert_eq!(url.port_or_known_default(), Some(443));
        }
    }

    #[tokio::test]
    async fn a_percent_encoded_host_is_caught_by_the_address_it_decodes_to() {
        // `url` percent-decodes the host before parsing it, so `%31%32%37.0.0.1`
        // arrives here as the ADDRESS 127.0.0.1 and is refused by the address
        // check. The `EncodedHost` rule stays as the backstop for a spelling
        // `url` leaves as a domain.
        match vet("http://%31%32%37.0.0.1/rss", &any_public()).await {
            Err(Rejection::Private(ip)) => assert!(ip.is_loopback(), "got {ip}"),
            other => panic!("refused as {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_single_label_host_is_refused() {
        // `http:///rss` collapses to the host `rss` (not to "no host"), and a
        // single label is looked up through the resolver's search domains — which
        // is how a feed URL reaches a machine nobody named. `localhost` is the
        // same class of name, so it is refused for the same reason.
        for raw in ["http:///rss", "http://localhost/rss", "http://intranet/rss"] {
            match vet_shape(raw) {
                Err(Rejection::NotQualified(host)) => {
                    assert!(!host.contains('.'), "got {host}");
                }
                other => panic!("{raw} → {other:?}, expected a single-label refusal"),
            }
        }
    }

    #[tokio::test]
    async fn the_legacy_ipv4_spellings_all_land_on_loopback() {
        // The WHATWG parser folds these into 127.0.0.1 for us; the assertion is
        // that the ADDRESS check catches them, so no bespoke bypass regex is
        // needed. `http://2130706433/` is the decimal form of 127.0.0.1.
        for raw in [
            "http://2130706433/rss",
            "http://0x7f000001/rss",
            "http://127.1/rss",
            "http://127.0.0.1/rss",
        ] {
            match vet(raw, &any_public()).await {
                Err(Rejection::Private(ip)) => assert!(ip.is_loopback(), "{raw} → {ip}"),
                other => panic!("{raw} → {other:?}, expected a loopback refusal"),
            }
        }
    }

    #[tokio::test]
    async fn private_ipv4_literals_are_refused() {
        for raw in [
            "http://10.0.0.1/rss",
            "http://172.16.0.1/rss",
            "http://172.31.255.254/rss",
            "http://192.168.1.1/rss",
            "http://169.254.169.254/latest/meta-data/", // the metadata service
            "http://100.64.0.1/rss",                    // CGNAT
            "http://0.0.0.0/rss",
            "http://224.0.0.1/rss",
            "http://255.255.255.255/rss",
            "http://198.18.0.1/rss",
            "http://203.0.113.5/rss",
        ] {
            match vet(raw, &any_public()).await {
                Err(Rejection::Private(_)) => {}
                other => panic!("{raw} → {other:?}, expected a private-address refusal"),
            }
        }
    }

    #[tokio::test]
    async fn a_public_ipv4_literal_is_fetchable() {
        let vetted = vet("http://93.184.216.34/rss", &any_public())
            .await
            .expect("a public address is a legitimate feed host");
        assert_eq!(vetted.addrs.len(), 1);
        assert!(vetted.addrs.iter().next().unwrap().ip().is_ipv4());
    }

    #[tokio::test]
    async fn private_ipv6_literals_are_refused() {
        for raw in [
            "http://[::1]/rss",
            "http://[fe80::1]/rss",
            "http://[fc00::1]/rss",
            "http://[fd12:3456::1]/rss",
            "http://[2001:db8::1]/rss",
            "http://[ff02::1]/rss",
            "http://[::]/rss", // unspecified
        ] {
            match vet(raw, &any_public()).await {
                Err(Rejection::Private(_)) => {}
                other => panic!("{raw} → {other:?}, expected a private-address refusal"),
            }
        }
    }

    #[tokio::test]
    async fn a_v6_address_is_judged_by_the_v4_it_carries() {
        // Blocking all of `::ffff:0:0/96` would also block a legitimate public
        // v4-mapped address, so the embedded address is what gets judged.
        match vet("http://[::ffff:127.0.0.1]/rss", &any_public()).await {
            Err(Rejection::Private(ip)) => assert!(ip.is_loopback()),
            other => panic!("→ {other:?}"),
        }
        assert!(
            vet("http://[::ffff:93.184.216.34]/rss", &any_public())
                .await
                .is_ok(),
            "a v4-mapped PUBLIC address is still public"
        );
    }

    #[tokio::test]
    async fn tunneling_prefixes_cannot_smuggle_a_private_address() {
        // 6to4 carries the v4 in bytes 2..6, NAT64 in the last 4 bytes; both spell
        // 127.0.0.1 without ever looking like one.
        for raw in [
            "http://[2002:7f00:1::]/rss",   // 6to4 → 127.0.0.1
            "http://[64:ff9b::7f00:1]/rss", // NAT64 well-known → 127.0.0.1
            "http://[2002:a00:1::]/rss",    // 6to4 → 10.0.0.1
        ] {
            match vet(raw, &any_public()).await {
                Err(Rejection::Private(_)) => {}
                other => panic!("{raw} → {other:?}, expected a private-address refusal"),
            }
        }
    }

    #[test]
    fn the_range_matrix_is_what_the_docs_claim() {
        let blocked = [
            "10.1.2.3",
            "172.16.0.1",
            "172.31.0.1",
            "192.168.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.1.2.3",
            "198.19.0.1",
            "192.0.2.1",
            "240.0.0.1",
            "::1",
            "fe80::abcd",
            "fc00::1",
            "2001:db8::1",
            "ff00::1",
            "100::1",
            "2001::1",
        ];
        for ip in blocked {
            assert!(
                is_blocked(ip.parse().expect("ip")),
                "{ip} should be blocked"
            );
        }
        let allowed = [
            "93.184.216.34",
            "8.8.8.8",
            "1.1.1.1",
            "172.15.0.1",
            "172.32.0.1",
            "11.0.0.1",
            "2606:2800:220:1:248:1893:25c8:1946",
            "2a00:1450:4001:81c::200e",
        ];
        for ip in allowed {
            assert!(
                !is_blocked(ip.parse().expect("ip")),
                "{ip} should be allowed"
            );
        }
    }

    #[tokio::test]
    async fn a_name_that_resolves_only_to_private_is_refused() {
        let r = Static::new(&[("internal.example", &["10.0.0.5", "10.0.0.6"])]);
        match vet("https://internal.example/rss", &r).await {
            Err(Rejection::Private(ip)) => assert!(!ip.is_loopback()),
            other => panic!("→ {other:?}"),
        }
    }

    #[tokio::test]
    async fn one_private_address_is_enough_to_refuse_the_whole_name() {
        // A client picks among the addresses it is handed, so "one of them is
        // fine" is not a property this module can hand over. A rebinding attack
        // looks exactly like this.
        let r = Static::new(&[("sneaky.example", &["93.184.216.34", "127.0.0.1"])]);
        match vet("https://sneaky.example/rss", &r).await {
            Err(Rejection::Private(ip)) => assert!(ip.is_loopback()),
            other => panic!("→ {other:?}, expected the loopback answer to refuse it"),
        }
    }

    #[tokio::test]
    async fn a_name_that_does_not_resolve_is_refused() {
        let r = Static::new(&[]);
        match vet("https://nope.example/rss", &r).await {
            Err(Rejection::Unresolvable(host)) => assert_eq!(host, "nope.example"),
            other => panic!("→ {other:?}"),
        }
    }

    #[tokio::test]
    async fn vetting_hands_over_the_addresses_the_socket_must_use() {
        // This is the anti-rebinding contract: the caller connects to THESE
        // addresses, so the second lookup a rebinding attack depends on never
        // happens. The port is the URL's effective port.
        let r = Static::new(&[("feed.example", &["93.184.216.34", "93.184.216.35"])]);
        let vetted = vet("https://feed.example/rss", &r).await.expect("public");
        let ips: Vec<String> = vetted.addrs.iter().map(|a| a.ip().to_string()).collect();
        assert_eq!(ips, vec!["93.184.216.34", "93.184.216.35"]);
        assert!(vetted.addrs.iter().all(|a| a.port() == 443));
        assert_eq!(vetted.host_header(), "feed.example");
    }

    #[test]
    fn the_host_header_brackets_a_v6_literal() {
        let (url, _) = vet_shape("https://[2606:2800:220:1:248:1893:25c8:1946]/rss").expect("v6");
        let vetted = Vetted {
            url,
            host: "2606:2800:220:1:248:1893:25c8:1946".into(),
            addrs: BTreeSet::new(),
        };
        assert_eq!(vetted.host_header(), "[2606:2800:220:1:248:1893:25c8:1946]");
    }

    #[tokio::test]
    async fn a_redirect_target_is_vetted_by_the_same_rules() {
        // The fetcher re-vets every `Location`, so a public feed that redirects
        // into private space is refused by exactly this call.
        for target in [
            "http://127.0.0.1:8080/admin",
            "http://169.254.169.254/latest/meta-data/",
            "file:///etc/passwd",
        ] {
            assert!(
                vet(target, &any_public()).await.is_err(),
                "{target} must not survive the redirect hop"
            );
        }
    }
}
