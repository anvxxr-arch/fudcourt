package newsfeed

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// trackingParams are stripped from every stored link. They identify a visit,
// not the article: keeping them would fork one article into several rows
// (Level-1 dedup) and leak campaign attribution of whoever fetched first.
var trackingParams = map[string]bool{
	"utm_source": true, "utm_medium": true, "utm_campaign": true, "utm_term": true,
	"utm_content": true, "utm_id": true, "utm_name": true, "utm_reader": true,
	"fbclid": true, "gclid": true, "gbraid": true, "wbraid": true, "dclid": true,
	"mc_cid": true, "mc_eid": true, "igshid": true, "ref": true, "ref_src": true,
	"source": true, "at_medium": true, "at_campaign": true, "__twitter_impression": true,
	"guccounter": true, "guce_referrer": true, "guce_referrer_sig": true,
	"smid": true, "partner": true, "share_id": true, "_hsenc": true, "_hsmi": true,
}

// canonicalURL resolves a feed's link against the feed's own homepage and
// normalizes it into the dedup key (Level 1): absolute, lowercase scheme and
// host, no fragment, no tracking parameters, no default port. Query parameters
// that are not tracking (e.g. an id a CMS needs) are preserved - dropping them
// would merge distinct articles.
func canonicalURL(raw, homepage string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	base, berr := url.Parse(homepage)
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	if berr == nil && base != nil {
		u = base.ResolveReference(u)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	u.Scheme = "https"
	u.Host = strings.ToLower(u.Host)
	if u.Port() == "80" || u.Port() == "443" {
		u.Host = u.Hostname()
	}
	u.Fragment = ""
	u.RawFragment = ""
	q := u.Query()
	for k := range q {
		if trackingParams[strings.ToLower(k)] {
			q.Del(k)
		}
	}
	if len(q) == 0 {
		u.RawQuery = ""
	} else {
		u.RawQuery = q.Encode()
	}
	out := u.String()
	// A bare host is not an article link.
	if u.Path == "" || u.Path == "/" {
		return ""
	}
	return out
}

// contentHash fingerprints the text of one item (Level 3): the same wire story
// re-published under two URLs collapses to one hash. It hashes the normalized
// headline + summary, never the raw body, so an entity or a whitespace change
// in the feed's HTML does not read as new content.
func contentHash(headline, summary string) string {
	sum := sha256.Sum256([]byte(normKey(headline) + "\n" + normKey(summary)))
	return hex.EncodeToString(sum[:])
}

func normKey(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(s)), " ")
}

// Units returns the dedup unit of one item: the canonical URL plus its content
// hash. Two items in ONE feed that share a URL or a hash are the same story.
type Units struct {
	URL  string
	Hash string
}

// assetVocab maps a matched token to its canonical symbol. Matching is
// word-bounded and case-insensitive; the vocabulary is deliberately short and
// explicit (deterministic rules first - no model is consulted to tag an
// article). A symbol absent from this map is simply not tagged.
var assetVocab = map[string]string{
	"btc": "BTC", "bitcoin": "BTC", "xbt": "BTC",
	"eth": "ETH", "ethereum": "ETH", "ether": "ETH",
	"sol": "SOL", "solana": "SOL",
	"xrp": "XRP", "ripple": "XRP",
	"bnb": "BNB", "binance coin": "BNB",
	"ada": "ADA", "cardano": "ADA",
	"doge": "DOGE", "dogecoin": "DOGE",
	"avax": "AVAX", "avalanche": "AVAX",
	"link": "LINK", "chainlink": "LINK",
	"dot": "DOT", "polkadot": "DOT",
	"matic": "POL", "polygon": "POL", "pol": "POL",
	"ltc": "LTC", "litecoin": "LTC",
	"trx": "TRX", "tron": "TRX",
	"usdt": "USDT", "tether": "USDT",
	"usdc": "USDC",
	"ton":  "TON", "toncoin": "TON",
	"sui": "SUI", "apt": "APT", "aptos": "APT",
	"arb": "ARB", "arbitrum": "ARB",
	"op": "OP", "optimism": "OP",
	"near": "NEAR", "atom": "ATOM", "cosmos": "ATOM",
	"xlm": "XLM", "stellar": "XLM",
	"hbar": "HBAR", "hedera": "HBAR",
	"icp": "ICP", "fil": "FIL", "filecoin": "FIL",
	"inj": "INJ", "injective": "INJ",
	"sei": "SEI", "tia": "TIA", "celestia": "TIA",
	"hype": "HYPE", "hyperliquid": "HYPE",
}

// maxAssetsPerArticle bounds the tag list one article may carry.
const maxAssetsPerArticle = 8

// assetsIn extracts canonical symbols from free text using word boundaries, so
// "ada" inside "adapt" is not a Cardano sighting.
func assetsIn(text string) []string {
	if text == "" {
		return nil
	}
	lower := strings.ToLower(text)
	found := map[string]bool{}
	for token, symbol := range assetVocab {
		if wordBounded(lower, token) {
			found[symbol] = true
		}
	}
	out := make([]string, 0, len(found))
	for s := range found {
		out = append(out, s)
	}
	sort.Strings(out)
	if len(out) > maxAssetsPerArticle {
		out = out[:maxAssetsPerArticle]
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// wordBounded reports whether token appears in text bounded by non-alphanumeric
// characters on both sides.
func wordBounded(text, token string) bool {
	from := 0
	for {
		i := strings.Index(text[from:], token)
		if i < 0 {
			return false
		}
		start := from + i
		end := start + len(token)
		leftOK := start == 0 || !isAlphaNum(text[start-1])
		rightOK := end >= len(text) || !isAlphaNum(text[end])
		if leftOK && rightOK {
			return true
		}
		from = start + 1
		if from >= len(text) {
			return false
		}
	}
}

func isAlphaNum(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

// maxTopicsPerArticle bounds the topic list.
const maxTopicsPerArticle = 12

// topicsFrom keeps the feed's own categories, lowercased and deduped. The
// publisher's taxonomy is the honest one; this adapter does not invent a
// category for an item that carries none.
func topicsFrom(categories []string) []string {
	if len(categories) == 0 {
		return nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(categories))
	for _, c := range categories {
		t := normKey(c)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
		if len(out) == maxTopicsPerArticle {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// publisherOf is the publisher label stored with an article: the registrable
// host of the source's homepage ("coindesk.com"), which is stable across feed
// titles and is what a reader recognizes.
func publisherOf(feed Feed) string {
	u, err := url.Parse(feed.Homepage)
	if err != nil || u.Host == "" {
		return feed.Label
	}
	return strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
}

// articleFromItem is the normalization step (Level 4 of the pipeline): one feed
// item becomes one canonical Article, or is rejected when it lacks the
// minimum identity an article needs (a headline and a link). Rejection is
// counted by the caller, never silently dropped and never faked with a blank.
//
// Timestamps: published_at is the PUBLISHER's moment, normalized to UTC, and
// stays NULL when the feed carries an unparsable one. retrieved_at is the
// ingestion moment - the two are never conflated.
func articleFromItem(feed Feed, it Item, now time.Time) (canon.Article, Units, bool) {
	headline := strings.TrimSpace(it.Title)
	link := canonicalURL(it.Link, feed.Homepage)
	if headline == "" || link == "" {
		return canon.Article{}, Units{}, false
	}
	summary := strings.TrimSpace(it.Summary)
	hash := contentHash(headline, summary)

	// Level 2 (external id): the publisher's own identifier when the feed
	// carries one, else the canonical URL - deterministic either way, so a
	// correction to the same story upserts instead of duplicating it.
	external := strings.TrimSpace(it.ID)
	if external == "" {
		external = link
	}

	article := canon.Article{
		ArticleID: canon.MintID(canon.KindArticle, canon.ArticleKey(feed.Slug, external)),
		Headline:  headline,
		URL:       link,
		Topics:    topicsFrom(it.Categories),
		Assets:    assetsIn(headline + " " + summary),
		// Provider carries the SOURCE slug (the registry row), not the package
		// name: news_article's provider column is the only per-source
		// discriminator a reader can filter on, and the slug is stable.
		Source:      feed.Slug,
		RetrievedAt: now,
	}
	if summary != "" {
		article.Summary = &summary
	}
	if it.Author != "" || feed.Label != "" {
		pub := publisherOf(feed)
		article.Publisher = &pub
	}
	if lang := strings.TrimSpace(feed.Language); lang != "" {
		article.Language = &lang
	}
	if t, ok := NormalizeTime(firstNonEmpty(it.Published, it.Updated)); ok {
		article.PublishedAt = &t
	}
	units := Units{URL: link, Hash: hash}
	return article, units, true
}
