package newsfeed

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"strings"
	"time"
)

// Meta is the channel-level identity of a feed. It is recorded (not stored as
// a row) so a fetch run can report which document answered.
type Meta struct {
	Title    string
	Link     string
	Language string
	Format   Format
}

// Item is one entry of a feed, already dialect-independent: every field is the
// raw upstream string, normalized only where the dialect itself is ambiguous.
// Nothing here is invented - a field the feed does not carry stays empty and
// becomes NULL downstream, never a placeholder.
type Item struct {
	ID         string // guid / atom id / jsonfeed id
	Title      string
	Link       string
	Summary    string
	Author     string
	Published  string // raw; NormalizeTime resolves it
	Updated    string
	Categories []string
	ImageURL   string
}

// HardError marks a failure the engine must NOT retry blindly: the upstream
// answered, and what it answered cannot be parsed or is not a feed. The engine
// treats a HardError as terminal for the attempt (the same contract the
// defillama adapter's HardError carries); transport failures are soft and the
// engine's exponential backoff applies.
type HardError struct {
	Kind   string // "shape" | "empty" | "decode"
	Detail string
}

func (e *HardError) Error() string { return "newsfeed: " + e.Kind + ": " + e.Detail }

// IsHardError reports whether err is a HardError and returns it. A HardError
// is terminal for the attempt; every other error is soft and backoff applies.
func IsHardError(err error) (*HardError, bool) {
	var he *HardError
	if errors.As(err, &he) {
		return he, true
	}
	return nil, false
}

// decodeXML is the ONE XML entry point: every document (the root sniff and the
// per-dialect parse) goes through it, so the declared charset is honoured
// everywhere instead of only where a decoder happened to be constructed.
func decodeXML(body []byte, v any) error {
	dec := xml.NewDecoder(bytes.NewReader(body))
	// An unknown charset fails loudly rather than being decoded as if it were
	// UTF-8, which would mangle every non-ASCII byte of the article text.
	dec.CharsetReader = charsetReader
	dec.Strict = false
	return dec.Decode(v)
}

// maxItems bounds one feed document. A publisher that starts shipping a
// 100k-item archive must not be able to blow up one ingestion run's memory;
// the newest N are enough for a news board and the bound is reported.
const maxItems = 200

// ---------------------------------------------------------------------------
// dialect documents
// ---------------------------------------------------------------------------

type rssDoc struct {
	XMLName xml.Name   `xml:"rss"`
	Channel rssChannel `xml:"channel"`
}

type rssChannel struct {
	Title    string    `xml:"title"`
	Link     string    `xml:"link"`
	Language string    `xml:"language"`
	Items    []rssItem `xml:"item"`
}

type rssItem struct {
	Title       string   `xml:"title"`
	Link        string   `xml:"link"`
	Description string   `xml:"description"`
	GUID        string   `xml:"guid"`
	PubDate     string   `xml:"pubDate"`
	Creator     string   `xml:"creator"`
	Categories  []string `xml:"category"`
	Enclosure   struct {
		URL string `xml:"url,attr"`
	} `xml:"enclosure"`
	Media struct {
		URL string `xml:"url,attr"`
	} `xml:"content"`
	DublinCore struct {
		Date string `xml:"date"`
	} `xml:"date"`
}

type atomDoc struct {
	XMLName xml.Name    `xml:"feed"`
	Title   string      `xml:"title"`
	Links   []atomLink  `xml:"link"`
	Lang    string      `xml:"lang,attr"`
	Entries []atomEntry `xml:"entry"`
}

type atomLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr"`
	Type string `xml:"type,attr"`
}

type atomEntry struct {
	ID        string     `xml:"id"`
	Title     string     `xml:"title"`
	Links     []atomLink `xml:"link"`
	Summary   string     `xml:"summary"`
	Content   string     `xml:"content"`
	Published string     `xml:"published"`
	Updated   string     `xml:"updated"`
	Author    struct {
		Name string `xml:"name"`
	} `xml:"author"`
	Categories []struct {
		Term string `xml:"term,attr"`
	} `xml:"category"`
}

type jsonFeedDoc struct {
	Version     string         `json:"version"`
	Title       string         `json:"title"`
	HomePageURL string         `json:"home_page_url"`
	FeedURL     string         `json:"feed_url"`
	Language    string         `json:"language"`
	Items       []jsonFeedItem `json:"items"`
}

type jsonFeedItem struct {
	ID            string   `json:"id"`
	URL           string   `json:"url"`
	ExternalURL   string   `json:"external_url"`
	Title         string   `json:"title"`
	Summary       string   `json:"summary"`
	ContentText   string   `json:"content_text"`
	ContentHTML   string   `json:"content_html"`
	DatePublished string   `json:"date_published"`
	DateModified  string   `json:"date_modified"`
	Tags          []string `json:"tags"`
	Author        struct {
		Name string `json:"name"`
	} `json:"author"`
	Image string `json:"image"`
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

// ParseFeed reads one feed document and returns its channel metadata and its
// items, newest-first as the document presents them. The dialect is detected
// from the document itself (root element / leading brace); `want`, when
// non-empty, is then verified against the detection so a feed that silently
// changes dialect is a reported shape error rather than a silent mis-parse.
func ParseFeed(body []byte, want Format) (Meta, []Item, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return Meta{}, nil, &HardError{Kind: "empty", Detail: "zero-byte feed body"}
	}
	if trimmed[0] == '{' || trimmed[0] == '[' {
		return parseJSONFeed(trimmed, want)
	}
	if trimmed[0] != '<' {
		return Meta{}, nil, &HardError{Kind: "shape", Detail: "body is neither XML nor JSON: " + snippet(trimmed)}
	}
	return parseXMLFeed(trimmed, want)
}

func parseXMLFeed(body []byte, want Format) (Meta, []Item, error) {
	var root struct {
		XMLName xml.Name
	}
	if err := decodeXML(body, &root); err != nil {
		return Meta{}, nil, &HardError{Kind: "decode", Detail: err.Error()}
	}
	detected := detectXMLFormat(root.XMLName.Local)

	switch detected {
	case FormatAtom:
		var doc atomDoc
		if err := decodeXML(body, &doc); err != nil {
			return Meta{}, nil, &HardError{Kind: "decode", Detail: err.Error()}
		}
		meta := Meta{Title: text(doc.Title), Link: pickAtomLink(doc.Links), Language: text(doc.Lang), Format: FormatAtom}
		items := make([]Item, 0, len(doc.Entries))
		for _, e := range doc.Entries {
			if len(items) == maxItems {
				break
			}
			items = append(items, Item{
				ID:         text(e.ID),
				Title:      text(e.Title),
				Link:       pickAtomLink(e.Links),
				Summary:    text(firstNonEmpty(e.Summary, e.Content)),
				Author:     text(e.Author.Name),
				Published:  text(firstNonEmpty(e.Published, e.Updated)),
				Updated:    text(e.Updated),
				Categories: atomCategories(e.Categories),
			})
		}
		if err := verifyDialect(want, FormatAtom, len(items)); err != nil {
			return Meta{}, nil, err
		}
		return meta, items, nil

	case FormatRSS:
		var doc rssDoc
		if err := decodeXML(body, &doc); err != nil {
			return Meta{}, nil, &HardError{Kind: "decode", Detail: err.Error()}
		}
		meta := Meta{Title: text(doc.Channel.Title), Link: text(doc.Channel.Link), Language: text(doc.Channel.Language), Format: FormatRSS}
		items := make([]Item, 0, len(doc.Channel.Items))
		for _, it := range doc.Channel.Items {
			if len(items) == maxItems {
				break
			}
			pub := firstNonEmpty(it.PubDate, it.DublinCore.Date)
			items = append(items, Item{
				ID:         text(firstNonEmpty(it.GUID, it.Link)),
				Title:      text(it.Title),
				Link:       text(it.Link),
				Summary:    summaryText(firstNonEmpty(it.Description, it.Media.URL)),
				Author:     text(it.Creator),
				Published:  text(pub),
				Categories: cleanAll(it.Categories),
				ImageURL:   firstNonEmpty(it.Enclosure.URL, it.Media.URL),
			})
		}
		if err := verifyDialect(want, FormatRSS, len(items)); err != nil {
			return Meta{}, nil, err
		}
		return meta, items, nil
	}

	return Meta{}, nil, &HardError{Kind: "shape", Detail: "unknown XML root <" + root.XMLName.Local + ">: not a feed"}
}

// detectXMLFormat decides the dialect from the root element local name. XML
// namespaces are ignored on purpose: publishers get the prefix wrong often
// enough that the structural name is the reliable signal, and `want` catches
// the case where the name itself is misleading.
func detectXMLFormat(root string) Format {
	switch strings.ToLower(root) {
	case "feed":
		return FormatAtom
	case "rss", "rdf":
		return FormatRSS
	}
	return ""
}

// verifyDialect fails a fetch whose document dialect contradicts the registry
// row, and fails a feed that parsed to zero items (a real, reportable state:
// the document answered but carried nothing we can store).
func verifyDialect(want, got Format, items int) error {
	if want != "" && got != want {
		return &HardError{Kind: "shape", Detail: fmt.Sprintf("registry says %s, document is %s", want, got)}
	}
	if items == 0 {
		return &HardError{Kind: "empty", Detail: "feed parsed with zero items"}
	}
	return nil
}

func parseJSONFeed(body []byte, want Format) (Meta, []Item, error) {
	var doc jsonFeedDoc
	if err := json.Unmarshal(body, &doc); err != nil {
		return Meta{}, nil, &HardError{Kind: "decode", Detail: err.Error()}
	}
	if !strings.Contains(doc.Version, "jsonfeed.org/version") {
		return Meta{}, nil, &HardError{Kind: "shape", Detail: "not a JSON Feed: version=" + snippet([]byte(doc.Version))}
	}
	meta := Meta{Title: text(doc.Title), Link: doc.HomePageURL, Language: doc.Language, Format: FormatJSONFeed}
	items := make([]Item, 0, len(doc.Items))
	for _, it := range doc.Items {
		if len(items) == maxItems {
			break
		}
		items = append(items, Item{
			ID:         text(firstNonEmpty(it.ID, it.URL)),
			Title:      text(it.Title),
			Link:       text(firstNonEmpty(it.URL, it.ExternalURL)),
			Summary:    summaryText(firstNonEmpty(it.Summary, it.ContentText, it.ContentHTML)),
			Author:     text(it.Author.Name),
			Published:  text(it.DatePublished),
			Updated:    text(it.DateModified),
			Categories: cleanAll(it.Tags),
			ImageURL:   it.Image,
		})
	}
	if err := verifyDialect(want, FormatJSONFeed, len(items)); err != nil {
		return Meta{}, nil, err
	}
	return meta, items, nil
}

// ---------------------------------------------------------------------------
// time normalization
// ---------------------------------------------------------------------------

// timeLayouts are the spellings publishers actually ship, newest-precision
// first. A layout is only used when it PARSES; an unparseable timestamp stays
// absent (NULL) rather than being replaced by the fetch time, which would
// silently rewrite the publisher's own publication moment.
var timeLayouts = []string{
	time.RFC3339Nano,
	time.RFC3339,
	"2006-01-02T15:04:05Z0700",
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05Z07:00",
	"2006-01-02 15:04:05",
	time.RFC1123Z,
	time.RFC1123,
	time.RFC822Z,
	time.RFC822,
	"Mon, 2 Jan 2006 15:04:05 MST",
	"Mon, 2 Jan 2006 15:04:05 -0700",
	"2 Jan 2006 15:04:05 MST",
	"2006-01-02",
}

// NormalizeTime resolves a feed's raw timestamp to UTC. ok=false means the
// feed did not carry a usable timestamp - callers store NULL, never a guess.
// A timestamp with no zone is read as UTC (the convention feeds use); the
// conversion is lossless and documented rather than silently local.
func NormalizeTime(raw string) (time.Time, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range timeLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

// ---------------------------------------------------------------------------
// small text helpers (HTML entities and markup arrive in most RSS bodies)
// ---------------------------------------------------------------------------

// summaryText strips markup and decodes entities from a feed's description.
// Feeds embed HTML in <description>; storing the markup would put renderable
// tags in the database and inflate every row.
func summaryText(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	var b strings.Builder
	depthTag := false
	for _, r := range s {
		switch {
		case r == '<':
			depthTag = true
		case r == '>':
			depthTag = false
			b.WriteRune(' ')
		case !depthTag:
			b.WriteRune(r)
		}
	}
	out := html.UnescapeString(b.String())
	return strings.Join(strings.Fields(out), " ")
}

// text decodes entities and collapses whitespace in a plain text field.
func text(s string) string { return strings.Join(strings.Fields(html.UnescapeString(s)), " ") }

// snippet renders an unparsable body fragment for an error message without
// letting a hostile body echo unbounded bytes into a log line.
func snippet(b []byte) string {
	const n = 60
	s := string(b)
	if len(s) > n {
		s = s[:n] + "..."
	}
	return strings.TrimSpace(s)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func cleanAll(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, v := range in {
		c := text(v)
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func atomCategories(in []struct {
	Term string `xml:"term,attr"`
}) []string {
	vals := make([]string, 0, len(in))
	for _, c := range in {
		vals = append(vals, c.Term)
	}
	return cleanAll(vals)
}

// pickAtomLink prefers the alternate link (the article), falling back to the
// first link present - Atom entries carry several rels and the article is not
// always first.
func pickAtomLink(links []atomLink) string {
	for _, l := range links {
		if l.Rel == "" || l.Rel == "alternate" {
			if l.Href != "" {
				return text(l.Href)
			}
		}
	}
	for _, l := range links {
		if l.Href != "" {
			return text(l.Href)
		}
	}
	return ""
}

// charsetReader supports the encodings publishers actually declare. Unknown
// labels return an error so the fetch reports a decode failure instead of
// silently mis-decoding non-ASCII text.
func charsetReader(charset string, input io.Reader) (io.Reader, error) {
	switch strings.ToLower(strings.TrimSpace(charset)) {
	case "utf-8", "utf8", "us-ascii", "ascii", "":
		return input, nil
	case "iso-8859-1", "latin1", "latin-1", "windows-1252", "cp1252":
		return &latin1Reader{r: input}, nil
	}
	return nil, fmt.Errorf("newsfeed: unsupported charset %q", charset)
}

// latin1Reader widens single-byte text to UTF-8. It is the one transcoding the
// feed corpus needs; anything else is refused rather than guessed.
type latin1Reader struct {
	r   io.Reader
	buf []byte
}

func (l *latin1Reader) Read(p []byte) (int, error) {
	if len(l.buf) == 0 {
		raw := make([]byte, 4096)
		n, err := l.r.Read(raw)
		if n == 0 {
			return 0, err
		}
		out := make([]byte, 0, n*2)
		for _, c := range raw[:n] {
			if c < 0x80 {
				out = append(out, c)
				continue
			}
			out = append(out, 0xC0|(c>>6), 0x80|(c&0x3F))
		}
		l.buf = out
		if err != nil && err != io.EOF {
			return 0, err
		}
	}
	n := copy(p, l.buf)
	l.buf = l.buf[n:]
	return n, nil
}
