package newsfeed

import (
	"strings"
	"testing"
	"time"
)

// Fixtures are canned upstream documents: the parser is proved without a
// network, which is what makes these tests deterministic in CI.
const rssFixture = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Example News</title>
    <link>https://example.com</link>
    <language>en</language>
    <item>
      <title>Bitcoin &amp; ETH rally as ETF inflows hit $2.1B</title>
      <link>https://example.com/a/bitcoin-eth-rally?utm_source=rss&amp;utm_medium=feed&amp;id=42</link>
      <description>&lt;p&gt;Spot &lt;b&gt;ETF&lt;/b&gt; inflows reached &lt;em&gt;$2.1B&lt;/em&gt; this week&#8217;s close.&lt;/p&gt;</description>
      <guid isPermaLink="false">example-1001</guid>
      <pubDate>Sat, 11 Oct 2026 09:15:00 +0000</pubDate>
      <category>Markets</category>
      <category>markets</category>
      <dc:creator>Jane Doe</dc:creator>
      <enclosure url="https://example.com/img/1.jpg" type="image/jpeg"/>
    </item>
    <item>
      <title>Solana outage post-mortem published</title>
      <link>https://example.com/b/solana-outage</link>
      <description>Validators published a post-mortem.</description>
      <guid>example-1002</guid>
      <pubDate>Sat, 11 Oct 2026 08:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`

const atomFixture = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <title>Blockworks</title>
  <link href="https://blockworks.co" rel="alternate"/>
  <link href="https://blockworks.co/feed" rel="self"/>
  <entry>
    <title>Layer 2 fees fall 40% after upgrade</title>
    <id>urn:blockworks:2001</id>
    <link rel="self" href="https://blockworks.co/feed/2001"/>
    <link rel="alternate" href="https://blockworks.co/news/l2-fees-fall"/>
    <summary>Base and Arbitrum fees fell after the upgrade.</summary>
    <published>2026-10-11T07:30:00Z</published>
    <updated>2026-10-11T07:45:00Z</updated>
    <author><name>Ana Silva</name></author>
    <category term="Layer 2"/>
  </entry>
</feed>`

const jsonFeedFixture = `{
  "version": "https://jsonfeed.org/version/1.1",
  "title": "Example JSON Feed",
  "home_page_url": "https://example.org",
  "feed_url": "https://example.org/feed.json",
  "language": "en",
  "items": [
    {
      "id": "3001",
      "url": "https://example.org/p/3001",
      "title": "Stablecoin bill advances in committee",
      "summary": "The committee voted 12-9.",
      "date_published": "2026-10-11T06:00:00Z",
      "tags": ["Regulation", "Stablecoins"],
      "author": {"name": "R. Lee"}
    }
  ]
}`

func TestParseFeedRSS(t *testing.T) {
	meta, items, err := ParseFeed([]byte(rssFixture), FormatRSS)
	if err != nil {
		t.Fatalf("parse rss: %v", err)
	}
	if meta.Format != FormatRSS || meta.Language != "en" {
		t.Fatalf("meta = %+v", meta)
	}
	if len(items) != 2 {
		t.Fatalf("items = %d, want 2", len(items))
	}
	first := items[0]
	if first.ID != "example-1001" {
		t.Errorf("guid = %q, want example-1001", first.ID)
	}
	if !strings.Contains(first.Title, "&") {
		t.Errorf("entity not decoded: %q", first.Title)
	}
	// The description's markup is stripped and its entities decoded: the raw
	// HTML must never reach the database.
	if strings.ContainsAny(first.Summary, "<>") {
		t.Errorf("summary still carries markup: %q", first.Summary)
	}
	if !strings.Contains(first.Summary, "ETF") || !strings.Contains(first.Summary, "$2.1B") {
		t.Errorf("summary lost text: %q", first.Summary)
	}
	if first.Author != "Jane Doe" {
		t.Errorf("author = %q", first.Author)
	}
	if got := len(first.Categories); got != 2 {
		t.Errorf("categories = %v", first.Categories)
	}
	if first.ImageURL != "https://example.com/img/1.jpg" {
		t.Errorf("image = %q", first.ImageURL)
	}
	if _, ok := NormalizeTime(first.Published); !ok {
		t.Errorf("pubDate not parsable: %q", first.Published)
	}
}

func TestParseFeedAtom(t *testing.T) {
	meta, items, err := ParseFeed([]byte(atomFixture), FormatAtom)
	if err != nil {
		t.Fatalf("parse atom: %v", err)
	}
	if meta.Format != FormatAtom || meta.Language != "en-US" {
		t.Fatalf("meta = %+v", meta)
	}
	if len(items) != 1 {
		t.Fatalf("items = %d", len(items))
	}
	// rel=alternate must win over rel=self: the self link is the feed API.
	if items[0].Link != "https://blockworks.co/news/l2-fees-fall" {
		t.Errorf("link = %q", items[0].Link)
	}
	if items[0].Author != "Ana Silva" || items[0].Categories[0] != "Layer 2" {
		t.Errorf("entry = %+v", items[0])
	}
}

func TestParseFeedJSONFeed(t *testing.T) {
	meta, items, err := ParseFeed([]byte(jsonFeedFixture), FormatJSONFeed)
	if err != nil {
		t.Fatalf("parse jsonfeed: %v", err)
	}
	if meta.Format != FormatJSONFeed || meta.Language != "en" {
		t.Fatalf("meta = %+v", meta)
	}
	if len(items) != 1 || items[0].ID != "3001" || items[0].Author != "R. Lee" {
		t.Fatalf("items = %+v", items)
	}
}

func TestParseFeedDetectsDialectAndVerifiesIt(t *testing.T) {
	// No declared dialect: detection alone resolves it.
	if _, _, err := ParseFeed([]byte(atomFixture), ""); err != nil {
		t.Fatalf("atom with empty want: %v", err)
	}
	// A registry row that says rss while the document is atom is a reported
	// shape error, not a silent mis-parse.
	_, _, err := ParseFeed([]byte(atomFixture), FormatRSS)
	he, ok := IsHardError(err)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestParseFeedFailures(t *testing.T) {
	cases := []struct {
		name string
		body string
		kind string
	}{
		{"empty body", "", "empty"},
		{"not xml or json", "hello world", "shape"},
		{"malformed xml", "<rss><channel><item></channel>", "decode"},
		{"unknown root", "<html><body>x</body></html>", "shape"},
		{"valid but zero items", `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>`, "empty"},
		{"not a json feed", `{"version":"1.0","items":[]}`, "shape"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := ParseFeed([]byte(tc.body), "")
			he, ok := IsHardError(err)
			if !ok {
				t.Fatalf("want HardError, got %v", err)
			}
			if he.Kind != tc.kind {
				t.Fatalf("kind = %q, want %q (%v)", he.Kind, tc.kind, he)
			}
		})
	}
}

func TestParseFeedLatin1(t *testing.T) {
	// A declared single-byte encoding with a non-ASCII byte (0xE9 = e-acute).
	body := append([]byte(`<?xml version="1.0" encoding="iso-8859-1"?><rss version="2.0"><channel><title>t</title><item><title>Soci`),
		0xE9)
	body = append(body, []byte(`t`+"é"+`</title><link>https://example.com/x</link></item></channel></rss>`)...)
	_, items, err := ParseFeed(body, FormatRSS)
	if err != nil {
		t.Fatalf("latin1 parse: %v", err)
	}
	if len(items) != 1 || !strings.Contains(items[0].Title, "é") {
		t.Fatalf("latin1 text mangled: %+v", items)
	}
}

func TestParseFeedUnsupportedCharsetFailsLoudly(t *testing.T) {
	body := `<?xml version="1.0" encoding="shift_jis"?><rss version="2.0"><channel><title>t</title></channel></rss>`
	if _, _, err := ParseFeed([]byte(body), ""); err == nil {
		t.Fatal("an unsupported declared charset must fail, not decode as UTF-8")
	}
}

func TestNormalizeTime(t *testing.T) {
	want := time.Date(2026, 10, 11, 9, 15, 0, 0, time.UTC)
	cases := map[string]bool{
		"Sat, 11 Oct 2026 09:15:00 +0000": true,
		"2026-10-11T09:15:00Z":            true,
		"2026-10-11 09:15:00":             true,
		"2026-10-11T09:15:00+00:00":       true,
		"Sun, 11 Oct 2026 09:15:00 GMT":   true,
		"not a date":                      false,
		"":                                false,
	}
	for in, ok := range cases {
		got, gotOK := NormalizeTime(in)
		if gotOK != ok {
			t.Errorf("NormalizeTime(%q) ok = %v, want %v", in, gotOK, ok)
		}
		if gotOK && !got.Equal(want) {
			t.Errorf("NormalizeTime(%q) = %s, want %s", in, got.UTC(), want)
		}
	}
}

func TestCanonicalURL(t *testing.T) {
	cases := []struct{ in, home, want string }{
		{"https://example.com/a?utm_source=rss&utm_medium=feed&id=42", "https://example.com", "https://example.com/a?id=42"},
		{"https://example.com/a#comments", "https://example.com", "https://example.com/a"},
		{"/rel/path", "https://example.com/blog", "https://example.com/rel/path"},
		{"https://example.com/", "https://example.com", ""},
		{"https://example.com", "https://example.com", ""},
		{"ftp://example.com/a", "https://example.com", ""},
		{"", "https://example.com", ""},
		{"https://EXAMPLE.com:443/a", "https://example.com", "https://example.com/a"},
	}
	for _, tc := range cases {
		if got := canonicalURL(tc.in, tc.home); got != tc.want {
			t.Errorf("canonicalURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestContentHash(t *testing.T) {
	a := contentHash("Bitcoin  rallies", "text here")
	b := contentHash("bitcoin rallies", "TEXT here")
	if a != b {
		t.Fatal("hash must ignore case and whitespace: the same story re-published must collapse")
	}
	if a == contentHash("bitcoin rallies", "different text") {
		t.Fatal("different text must not share a hash")
	}
}

func TestAssetsInIsWordBounded(t *testing.T) {
	// "adapt" must not be read as ADA, "optimism" as the OP ticker is a real
	// ambiguity the vocabulary resolves by spelling, not by guessing.
	if got := assetsIn("we must adapt to change"); len(got) != 0 {
		t.Fatalf("adapt matched: %v", got)
	}
	got := assetsIn("Bitcoin and ethereum rose while SOL fell")
	want := []string{"BTC", "ETH", "SOL"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("assets = %v, want %v", got, want)
	}
	if len(assetsIn(strings.Repeat("btc eth sol ada doge xrp bnb ltc trx ton sui apt ", 3))) > maxAssetsPerArticle {
		t.Fatal("asset list must stay bounded")
	}
}

func TestTopicsFrom(t *testing.T) {
	got := topicsFrom([]string{"Markets", "markets", "  ", "DeFi"})
	if strings.Join(got, ",") != "markets,defi" {
		t.Fatalf("topics = %v", got)
	}
	if topicsFrom(nil) != nil {
		t.Fatal("an item with no categories must have no topics, not an empty slice")
	}
}
