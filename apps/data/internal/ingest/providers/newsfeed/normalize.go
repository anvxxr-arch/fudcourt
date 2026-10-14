package newsfeed

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// trackingParams are the query keys stripped during canonicalization. They
// identify a campaign, never an article; two URLs that differ only here are
// the same article (dedup Level 1).
var trackingParams = map[string]bool{
	"utm_source": true, "utm_medium": true, "utm_campaign": true,
	"utm_term": true, "utm_content": true, "utm_id": true, "utm_name": true,
	"fbclid": true, "gclid": true, "dclid": true, "msclkid": true,
	"mc_cid": true, "mc_eid": true, "_ga": true, "_gl": true,
	"ref": true, "source": true, "src": true, "spm": true, "cmpid": true,
}

// canonicalURL normalizes an article URL for identity: the scheme and host
// are lowercased, the default port and fragment are dropped, tracking
// parameters are removed, and the remaining query is sorted so parameter
// order cannot mint a second identity for one article. The path is left
// verbatim — it is the publisher's identity for the article, not ours.
func canonicalURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return raw
	}
	u.Scheme = strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	if p := u.Port(); p != "" && !((u.Scheme == "http" && p == "80") || (u.Scheme == "https" && p == "443")) {
		host = host + ":" + p
	}
	u.Host = host
	u.Fragment = ""
	if u.RawQuery != "" {
		q := u.Query()
		for k := range q {
			if trackingParams[strings.ToLower(k)] {
				q.Del(k)
			}
		}
		u.RawQuery = q.Encode()
	}
	return u.String()
}

// contentHash is the digest identity for an article that carries no
// publisher id: the canonical URL plus the headline, so a syndicated copy on
// another path is still distinct while a re-fetch of the same row is not.
func contentHash(canonical, title string) string {
	sum := sha256.Sum256([]byte(canonical + "\x00" + title))
	return hex.EncodeToString(sum[:])
}

// timeLayouts are the wire formats observed across the verified feeds,
// widest first. RSS uses RFC1123Z (GMT offsets); Atom uses RFC3339; the
// remaining entries cover the common publisher drift.
var timeLayouts = []string{
	time.RFC1123Z,
	time.RFC1123,
	time.RFC822Z,
	time.RFC822,
	time.RFC3339Nano,
	time.RFC3339,
	"Mon, 2 Jan 2006 15:04:05 -0700",
	"Mon, 2 Jan 2006 15:04:05 MST",
	"2006-01-02T15:04:05-0700",
	"2006-01-02 15:04:05 -0700",
	"2006-01-02 15:04:05",
	"2006-01-02",
}

// parseTimeFlex parses a feed timestamp into UTC. An unrecognised or empty
// value returns ok=false: absence is absence, never a fabricated epoch.
func parseTimeFlex(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range timeLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	// Numeric epoch seconds (some JSON feeds).
	if isDigits(s) {
		var secs int64
		for _, c := range s {
			secs = secs*10 + int64(c-'0')
		}
		if secs > 0 && secs < 1<<42 {
			return time.Unix(secs, 0).UTC(), true
		}
	}
	return time.Time{}, false
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// nonEmpty returns a pointer to s, or nil when s is blank — the Writer's
// nullable fields carry absence as nil, never as "".
func nonEmpty(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}

// toArticle maps one raw feed item to a canonical article row. Every
// derived field is deterministic from the wire plus the source row: nothing
// is invented, and absence stays absent (nil), never a fabricated value.
// RetrievedAt is the ingestion clock, never the feed's pubDate — the
// validator rejects retrieved_at beyond now+5min, and the feed's own
// timestamp belongs in PublishedAt.
func toArticle(it rawItem, src Source, now time.Time) canon.Article {
	url := canonicalURL(it.URL)
	pid := strings.TrimSpace(it.ExtID)
	if pid == "" {
		pid = contentHash(url, it.Title)
	}
	articleID := canon.ArticleKey(providerName, pid)

	a := canon.Article{
		ArticleID:   articleID,
		Headline:    strings.TrimSpace(it.Title),
		Summary:     nonEmpty(it.Summary),
		URL:         url,
		Publisher:   nonEmpty(src.Label),
		Language:    nonEmpty(src.Language),
		Topics:      deriveTopics(it, src),
		Assets:      assetsIn(it.Title, it.Summary),
		Source:      providerName,
		RetrievedAt: now.UTC(),
	}
	if t, ok := parseTimeFlex(it.PublishedAt); ok {
		a.PublishedAt = &t
	}
	return a
}

// deriveTopics merges the feed's own categories with the source's declared
// topic tags, deduped and order-stable.
func deriveTopics(it rawItem, src Source) []string {
	seen := make(map[string]bool, len(it.Topics)+len(src.Topics))
	out := make([]string, 0, len(it.Topics)+len(src.Topics))
	for _, t := range append(append([]string{}, src.Topics...), it.Topics...) {
		t = strings.TrimSpace(t)
		if t == "" || seen[strings.ToLower(t)] {
			continue
		}
		seen[strings.ToLower(t)] = true
		out = append(out, t)
	}
	return out
}

// assetTerms are the canonical asset ids the classifier recognizes, keyed by
// the lowercase surface form it matches on word boundaries.
var assetTerms = map[string]string{
	"bitcoin": "BTC", "btc": "BTC",
	"ethereum": "ETH", "ether": "ETH", "eth": "ETH",
	"solana": "SOL", "sol": "SOL",
	"xrp": "XRP", "ripple": "XRP",
	"cardano": "ADA", "ada": "ADA",
	"dogecoin": "DOGE", "doge": "DOGE",
	"bnb": "BNB", "binance coin": "BNB",
	"tether": "USDT", "usdt": "USDT",
	"usdc":     "USDC",
	"litecoin": "LTC", "ltc": "LTC",
	"tron": "TRX", "trx": "TRX",
	"avalanche": "AVAX", "avax": "AVAX",
	"polkadot": "DOT", "dot": "DOT",
	"chainlink": "LINK", "link": "LINK",
	"polygon": "MATIC", "matic": "MATIC",
	"uniswap": "UNI", "aave": "AAVE",
}

// assetsIn extracts canonical asset ids mentioned on word boundaries. This
// is a deterministic rule pass, not a model call: it tags what the headline
// and summary plainly name, and nothing else.
func assetsIn(parts ...string) []string {
	text := " " + strings.ToLower(strings.Join(parts, " ")) + " "
	seen := make(map[string]bool)
	out := []string{}
	for term, id := range assetTerms {
		if seen[id] {
			continue
		}
		if containsWord(text, term) {
			seen[id] = true
			out = append(out, id)
		}
	}
	sortStrings(out)
	return out
}

// containsWord reports whether term appears in text delimited by
// non-alphanumeric characters (text is already lowercased and padded).
func containsWord(text, term string) bool {
	idx := 0
	for {
		j := strings.Index(text[idx:], term)
		if j < 0 {
			return false
		}
		j += idx
		before := byte(' ')
		if j > 0 {
			before = text[j-1]
		}
		end := j + len(term)
		after := byte(' ')
		if end < len(text) {
			after = text[end]
		}
		if !isAlnum(before) && !isAlnum(after) {
			return true
		}
		idx = j + 1
	}
}

func isAlnum(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

// sortStrings is a tiny insertion sort: the asset list is under twenty
// entries, and this keeps the file free of an extra import.
func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
