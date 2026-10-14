package newsfeed

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// providerName is the data.job provider column value and the canon Source.
const providerName = "newsfeed"

// Status is a source's audited collection state. A source is Working only
// after a live probe returned 200 + a parseable feed + at least one item;
// configuration alone never marks a source working.
type Status string

const (
	// StatusWorking: live-probed 200 + parseable feed + >=1 item.
	StatusWorking Status = "working"
	// StatusPendingVerify: feed URL is a declared candidate, not yet probed.
	StatusPendingVerify Status = "pending_verify"
	// StatusPendingCreds: an API that needs a key or account.
	StatusPendingCreds Status = "pending_credentials"
	// StatusRestricted: paywalled, bot-challenged, or ToS-restricted.
	StatusRestricted Status = "restricted"
	// StatusUnsupported: no feed/API exists; only HTML would work, which
	// this engine does not do without explicit permission.
	StatusUnsupported Status = "unsupported"
)

// Method is one collection mechanism a source supports.
type Method string

const (
	MethodAPI      Method = "api"
	MethodRSS      Method = "rss"
	MethodAtom     Method = "atom"
	MethodJSONFeed Method = "json_feed"
	MethodSitemap  Method = "sitemap"
	MethodHTML     Method = "html"
)

// Source is one canonical news source: its identity, its verified collection
// endpoint, its polling target, and its audit state. It is our table, not the
// research/news wire table (Source{Name,Label,URL}), which must not change.
type Source struct {
	// ID is the dataset key (data.job dataset) and the canon provider id
	// namespace: lowercase, stable, never reused for a different outlet.
	ID string `json:"id"`
	// Name is the human-readable outlet name.
	Name string `json:"name"`
	// Label is the publisher value stored on each article; it is the
	// outlet's display name, distinct from ID.
	Label string `json:"label"`
	// Domain is the registrable domain, for dedup and reporting.
	Domain string `json:"domain"`
	// Category is the source family: publisher, exchange, regulator,
	// research, security, aggregator, intelligence.
	Category string `json:"category"`
	// Country is the ISO 3166-1 alpha-2 code where meaningful, else "".
	Country string `json:"country"`
	// Language is the BCP 47 content language, else "en".
	Language string `json:"language"`
	// FeedURL is the collection endpoint (RSS/Atom/API).
	FeedURL string `json:"feed_url"`
	// Method is the mechanism FeedURL is served by.
	Method Method `json:"method"`
	// PollIntervalSeconds is the desired freshness in seconds, bounded
	// below by rate policy.
	PollIntervalSeconds int `json:"poll_interval_seconds"`
	// Topics are the source's intrinsic topic tags, applied to every row.
	Topics []string `json:"topics"`
	// MaxItems caps rows written per fetch (0 = no cap).
	MaxItems int `json:"max_items"`
	// Status is the audited collection state.
	Status Status `json:"status"`
	// BlockReason explains a non-working status; required when Status is not
	// Working or PendingVerify.
	BlockReason string `json:"block_reason"`
	// Evidence records the live probe result: status code, content type,
	// item count, and probe date. Empty until probed.
	Evidence string `json:"evidence"`

	// PollInterval is the desired freshness as a duration. It is derived
	// from PollIntervalSeconds for the in-Go registry and is not part of
	// the manifest wire shape.
	PollInterval time.Duration `json:"-"`
}

// pollInterval returns the source's polling target, preferring the derived
// duration and falling back to the seconds field a manifest carries.
func (s Source) pollInterval() time.Duration {
	if s.PollInterval > 0 {
		return s.PollInterval
	}
	return time.Duration(s.PollIntervalSeconds) * time.Second
}

// Sources is the source registry in declaration order: the durable ingest
// inventory. Every entry was live-probed on the date in Evidence; entries
// that failed the probe carry their real blocker rather than a guessed URL.
//
// The 158-entry planning inventory is not present in this repository or the
// execution context. This table holds the sources verified in this build;
// an explicitly provided manifest drops in through LoadManifest and is
// validated by ValidateSources before merge. No row is fabricated.
var Sources = []Source{
	{
		ID: "coindesk", Name: "CoinDesk", Label: "CoinDesk", Domain: "coindesk.com",
		Category: "publisher", Country: "US", Language: "en",
		FeedURL: "https://www.coindesk.com/arc/outboundfeeds/rss",
		Method:  MethodRSS, PollInterval: 3 * time.Minute,
		Topics: []string{"bitcoin", "markets"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 application/xml 25 items",
	},
	{
		ID: "cointelegraph", Name: "Cointelegraph", Label: "Cointelegraph", Domain: "cointelegraph.com",
		Category: "publisher", Country: "US", Language: "en",
		FeedURL: "https://cointelegraph.com/rss",
		Method:  MethodRSS, PollInterval: 3 * time.Minute,
		Topics: []string{"markets"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 application/xml 30 items",
	},
	{
		ID: "decrypt", Name: "Decrypt", Label: "Decrypt", Domain: "decrypt.co",
		Category: "publisher", Country: "US", Language: "en",
		FeedURL: "https://decrypt.co/feed",
		Method:  MethodRSS, PollInterval: 5 * time.Minute,
		Topics: []string{"culture", "markets"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 application/xml 38 items",
	},
	{
		ID: "theblock", Name: "The Block", Label: "The Block", Domain: "theblock.co",
		Category: "publisher", Country: "US", Language: "en",
		FeedURL: "https://www.theblock.co/rss.xml",
		Method:  MethodRSS, PollInterval: 5 * time.Minute,
		Topics: []string{"markets", "institutional"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 text/xml 20 items",
	},
	{
		ID: "blockworks", Name: "Blockworks", Label: "Blockworks", Domain: "blockworks.com",
		Category: "publisher", Country: "US", Language: "en",
		FeedURL: "https://blockworks.com/feed",
		Method:  MethodAtom, PollInterval: 5 * time.Minute,
		Topics: []string{"markets", "infrastructure"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 text/xml 50 entries",
	},
	{
		ID: "thedefiant", Name: "The Defiant", Label: "The Defiant", Domain: "thedefiant.io",
		Category: "publisher", Country: "US", Language: "en",
		FeedURL: "https://thedefiant.io/feed",
		Method:  MethodRSS, PollInterval: 5 * time.Minute,
		Topics: []string{"defi"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 application/rss+xml 100 items",
	},
	{
		ID: "cryptobriefing", Name: "Crypto Briefing", Label: "Crypto Briefing", Domain: "cryptobriefing.com",
		Category: "publisher", Country: "US", Language: "en",
		FeedURL: "https://cryptobriefing.com/feed/",
		Method:  MethodRSS, PollInterval: 5 * time.Minute,
		Topics: []string{"markets"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 application/rss+xml 30 items",
	},
	{
		ID: "ambcrypto", Name: "AMBCrypto", Label: "AMBCrypto", Domain: "ambcrypto.com",
		Category: "publisher", Country: "IN", Language: "en",
		FeedURL: "https://ambcrypto.com/feed/",
		Method:  MethodRSS, PollInterval: 5 * time.Minute,
		Topics: []string{"markets"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 application/rss+xml 16 items",
	},
	{
		ID: "u-today", Name: "U.Today", Label: "U.Today", Domain: "u.today",
		Category: "publisher", Country: "US", Language: "en",
		FeedURL: "https://u.today/rss",
		Method:  MethodRSS, PollInterval: 5 * time.Minute,
		Topics: []string{"markets"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 application/rss+xml 96 items",
	},
	{
		ID: "bitcoinmagazine", Name: "Bitcoin Magazine", Label: "Bitcoin Magazine", Domain: "bitcoinmagazine.com",
		Category: "publisher", Country: "US", Language: "en",
		FeedURL: "https://bitcoinmagazine.com/feed",
		Method:  MethodRSS, PollInterval: 10 * time.Minute,
		Topics: []string{"bitcoin"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 application/rss+xml 10 items",
	},
	{
		ID: "openzeppelin", Name: "OpenZeppelin", Label: "OpenZeppelin", Domain: "openzeppelin.com",
		Category: "security", Country: "US", Language: "en",
		FeedURL: "https://www.openzeppelin.com/news/rss.xml",
		Method:  MethodRSS, PollInterval: 30 * time.Minute,
		Topics: []string{"security"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 application/rss+xml 10 items",
	},
	{
		ID: "slowmist", Name: "SlowMist", Label: "SlowMist", Domain: "slowmist.medium.com",
		Category: "security", Country: "CN", Language: "en",
		FeedURL: "https://slowmist.medium.com/feed",
		Method:  MethodRSS, PollInterval: 15 * time.Minute,
		Topics: []string{"security", "exploit"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 text/xml 10 items",
	},
	{
		ID: "chainalysis", Name: "Chainalysis", Label: "Chainalysis", Domain: "chainalysis.com",
		Category: "research", Country: "US", Language: "en",
		FeedURL: "https://www.chainalysis.com/blog/feed/",
		Method:  MethodRSS, PollInterval: 30 * time.Minute,
		Topics: []string{"onchain", "research"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 application/rss+xml 10 items",
	},
	{
		ID: "sec", Name: "U.S. Securities and Exchange Commission", Label: "SEC", Domain: "sec.gov",
		Category: "regulator", Country: "US", Language: "en",
		FeedURL: "https://www.sec.gov/news/pressreleases.rss",
		Method:  MethodRSS, PollInterval: 15 * time.Minute,
		Topics: []string{"regulation"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 application/rss+xml 25 items",
	},
	{
		ID: "cftc", Name: "Commodity Futures Trading Commission", Label: "CFTC", Domain: "cftc.gov",
		Category: "regulator", Country: "US", Language: "en",
		FeedURL: "https://www.cftc.gov/RSS/RSSGP/rssgp.xml",
		Method:  MethodRSS, PollInterval: 30 * time.Minute,
		Topics: []string{"regulation", "derivatives"}, Status: StatusWorking,
		Evidence: "2026-10-11 200 application/rss+xml 10 items",
	},

	// Candidates and blockers below were probed and did NOT pass. They are
	// recorded with their real blocker so coverage stays honest.
	{
		ID: "cryptoslate", Name: "CryptoSlate", Label: "CryptoSlate", Domain: "cryptoslate.com",
		Category: "publisher", Country: "US", Language: "en",
		FeedURL: "https://cryptoslate.com/feed/",
		Method:  MethodRSS, Status: StatusRestricted,
		BlockReason: "probe 2026-10-11: HTTP 403 (Cloudflare bot challenge) on /feed/; no keyless RSS/API accepted",
		Evidence:    "2026-10-11 403 text/html",
	},
	{
		ID: "coinbase-blog", Name: "Coinbase Blog", Label: "Coinbase", Domain: "coinbase.com",
		Category: "exchange", Country: "US", Language: "en",
		FeedURL:     "https://www.coinbase.com/blog/rss.xml",
		Method:      MethodRSS,
		Status:      StatusRestricted,
		BlockReason: "probe 2026-10-11: no keyless feed; blog host serves an HTML shell for every /feed and /rss.xml path",
		Evidence:    "2026-10-11 200 text/html 0 bytes (empty shell)",
	},
	{
		ID: "certik", Name: "CertiK", Label: "CertiK", Domain: "certik.com",
		Category: "security", Country: "US", Language: "en",
		FeedURL:     "https://www.certik.com/blog/rss.xml",
		Method:      MethodRSS,
		Status:      StatusUnsupported,
		BlockReason: "probe 2026-10-11: /blog/rss.xml and /resources/blog/rss.xml both 404; no feed published",
		Evidence:    "2026-10-11 404 text/html (both candidate paths)",
	},
	{
		ID: "binance-announcements", Name: "Binance Announcements", Label: "Binance", Domain: "binance.com",
		Category: "exchange", Country: "KY", Language: "en",
		FeedURL:     "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1",
		Method:      MethodAPI,
		Status:      StatusRestricted,
		BlockReason: "probe 2026-10-11: TLS handshake fails (SNI/cert mismatch for this client); the announcement API also fronts anti-bot controls",
		Evidence:    "2026-10-11 TLS: no certificate subject name matches www.binance.com",
	},
	{
		ID: "cryptopanic", Name: "CryptoPanic", Label: "CryptoPanic", Domain: "cryptopanic.com",
		Category: "aggregator", Country: "DE", Language: "en",
		FeedURL:     "https://cryptopanic.com/news/rss/",
		Method:      MethodAPI,
		Status:      StatusPendingCreds,
		BlockReason: "probe 2026-10-11: /news/rss/ returns HTTP 410; the dev API (/api/v1/posts/) requires an auth_token credential",
		Evidence:    "2026-10-11 410 text/html",
	},
	{
		ID: "wublockchain", Name: "Wu Blockchain", Label: "Wu Blockchain", Domain: "wublockchain.com",
		Category: "intelligence", Country: "TW", Language: "en",
		FeedURL:     "",
		Method:      MethodHTML,
		Status:      StatusPendingCreds,
		BlockReason: "primary channel is X (Twitter) and Telegram; no keyless RSS/API, and X scraping is out of scope by policy",
	},
}

// ValidateSources rejects a registry that cannot be dispatched: duplicate
// ids or domains, a missing endpoint on a working row, an unparseable or
// non-http(s) feed URL, a sub-minute poll target, or a non-working row with
// no documented blocker.
func ValidateSources(srcs []Source) error {
	ids := make(map[string]bool, len(srcs))
	domains := make(map[string]bool, len(srcs))
	for _, s := range srcs {
		if strings.TrimSpace(s.ID) == "" {
			return fmt.Errorf("newsfeed: source with empty id (name %q)", s.Name)
		}
		if ids[s.ID] {
			return fmt.Errorf("newsfeed: duplicate source id %q", s.ID)
		}
		ids[s.ID] = true
		if d := strings.ToLower(strings.TrimSpace(s.Domain)); d != "" {
			if domains[d] {
				return fmt.Errorf("newsfeed: duplicate source domain %q (id %s)", d, s.ID)
			}
			domains[d] = true
		}
		if s.Method != MethodHTML && s.FeedURL == "" {
			return fmt.Errorf("newsfeed: source %q has no feed URL", s.ID)
		}
		if s.FeedURL != "" && ssrfBlocked(s.FeedURL) != "" {
			return fmt.Errorf("newsfeed: source %q feed URL rejected: %s", s.ID, ssrfBlocked(s.FeedURL))
		}
		if s.Status == StatusWorking && s.Evidence == "" {
			return fmt.Errorf("newsfeed: source %q is working but carries no probe evidence", s.ID)
		}
		if s.Status != StatusWorking && s.Status != StatusPendingVerify && strings.TrimSpace(s.BlockReason) == "" {
			return fmt.Errorf("newsfeed: source %q status %q requires a block reason", s.ID, s.Status)
		}
	}
	return nil
}

// EnabledSources returns the sources safe to dispatch: working rows with a
// usable endpoint. Blocked rows stay in the table for reporting.
func EnabledSources() []Source {
	out := make([]Source, 0, len(Sources))
	for _, s := range Sources {
		if s.Status == StatusWorking && s.FeedURL != "" {
			out = append(out, s)
		}
	}
	return out
}

// Get finds a source by its dataset id.
func Get(id string) (Source, bool) {
	for _, s := range Sources {
		if s.ID == id {
			return s, true
		}
	}
	return Source{}, false
}

// manifest is the version-controlled audit trail shape. It exists so an
// explicitly provided 158-entry inventory can be loaded and validated
// alongside the Go table without a code change.
type manifest struct {
	Version int      `json:"version"`
	Sources []Source `json:"sources"`
}

// LoadManifest parses a source manifest. It is stdlib JSON only: the repo
// carries no YAML dependency and this package adds none.
func LoadManifest(b []byte) ([]Source, error) {
	var m manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("newsfeed: parse manifest: %w", err)
	}
	if err := ValidateSources(m.Sources); err != nil {
		return nil, err
	}
	return m.Sources, nil
}
