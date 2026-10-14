package newsfeed

import (
	"bytes"
	"encoding/xml"
	"strings"
)

// rawItem is one parsed feed entry before normalization. Absent fields stay
// zero: this layer never invents a value the wire did not carry.
type rawItem struct {
	ExtID       string
	URL         string
	Title       string
	Summary     string
	Author      string
	PublishedAt string
	Topics      []string
}

// The struct fields below are plain strings on purpose. Go's encoding/xml
// fills a plain string field with the element's character data AND any CDATA
// payload verbatim; the `,innerxml` and `,chardata` tag flags are rejected by
// this toolchain, and a plain string field does not capture nested element
// markup. Feeds deliver their HTML either escaped or inside CDATA — both land
// in the field — so stripTags downstream covers the real cases, and a body
// that uses raw nested markup yields an honest empty summary.
//
// Go matches elements on local name when no namespace is pinned, so
// dc:creator and dc:date land on Creator/Date without a namespace block.

type rssDoc struct {
	XMLName xml.Name   `xml:"rss"`
	Channel rssChannel `xml:"channel"`
}

type rssChannel struct {
	Items []rssItem `xml:"item"`
}

type rssItem struct {
	Title       string   `xml:"title"`
	Link        string   `xml:"link"`
	Description string   `xml:"description"`
	PubDate     string   `xml:"pubDate"`
	Date        string   `xml:"date"`
	Guid        string   `xml:"guid"`
	Creator     string   `xml:"creator"`
	Categories  []string `xml:"category"`
}

type atomDoc struct {
	XMLName xml.Name    `xml:"feed"`
	Entries []atomEntry `xml:"entry"`
}

type atomEntry struct {
	Title      string     `xml:"title"`
	Links      []atomLink `xml:"link"`
	Summary    string     `xml:"summary"`
	Content    string     `xml:"content"`
	Published  string     `xml:"published"`
	Updated    string     `xml:"updated"`
	ID         string     `xml:"id"`
	AuthorName string     `xml:"author>name"`
	Categories []atomCat  `xml:"category"`
}

type atomLink struct {
	Rel  string `xml:"rel,attr"`
	Href string `xml:"href,attr"`
}

type atomCat struct {
	Term string `xml:"term,attr"`
}

// parseFeed sniffs the document root and dispatches to the RSS or Atom
// decoder. An unrecognised root returns an empty result with an empty kind,
// not an error: the caller turns "not a feed" into its own honest verdict.
func parseFeed(body []byte) ([]rawItem, string, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, "", nil
	}
	switch rootElement(trimmed) {
	case "rss":
		items, err := parseRSS(trimmed)
		return items, "rss", err
	case "feed":
		items, err := parseAtom(trimmed)
		return items, "atom", err
	default:
		return nil, "", nil
	}
}

// rootElement returns the lowercase local name of the first start element,
// skipping the prolog, comments, and doctype.
func rootElement(b []byte) string {
	d := xml.NewDecoder(bytes.NewReader(b))
	for {
		tok, err := d.Token()
		if err != nil {
			return ""
		}
		if se, ok := tok.(xml.StartElement); ok {
			return strings.ToLower(se.Name.Local)
		}
	}
}

// parseRSS decodes an RSS 2.0/1.0 document into raw items.
func parseRSS(b []byte) ([]rawItem, error) {
	var doc rssDoc
	if err := xml.Unmarshal(b, &doc); err != nil {
		return nil, err
	}
	out := make([]rawItem, 0, len(doc.Channel.Items))
	for _, it := range doc.Channel.Items {
		pub := cleanText(it.PubDate)
		if pub == "" {
			pub = cleanText(it.Date)
		}
		topics := make([]string, 0, len(it.Categories))
		for _, c := range it.Categories {
			if t := cleanText(c); t != "" {
				topics = append(topics, t)
			}
		}
		out = append(out, rawItem{
			ExtID:       cleanText(it.Guid),
			URL:         cleanText(it.Link),
			Title:       cleanText(it.Title),
			Summary:     cleanText(it.Description),
			Author:      cleanText(it.Creator),
			PublishedAt: pub,
			Topics:      topics,
		})
	}
	return out, nil
}

// parseAtom decodes an Atom 1.0 document into raw items. The article URL is
// the first link whose rel is empty or "alternate"; rel="self" is the feed.
func parseAtom(b []byte) ([]rawItem, error) {
	var doc atomDoc
	if err := xml.Unmarshal(b, &doc); err != nil {
		return nil, err
	}
	out := make([]rawItem, 0, len(doc.Entries))
	for _, e := range doc.Entries {
		var link string
		for _, l := range e.Links {
			if l.Rel == "" || l.Rel == "alternate" {
				link = strings.TrimSpace(l.Href)
				break
			}
		}
		pub := cleanText(e.Published)
		if pub == "" {
			pub = cleanText(e.Updated)
		}
		summary := e.Summary
		if strings.TrimSpace(summary) == "" {
			summary = e.Content
		}
		topics := make([]string, 0, len(e.Categories))
		for _, c := range e.Categories {
			if t := cleanText(c.Term); t != "" {
				topics = append(topics, t)
			}
		}
		out = append(out, rawItem{
			ExtID:       cleanText(e.ID),
			URL:         link,
			Title:       cleanText(e.Title),
			Summary:     cleanText(summary),
			Author:      cleanText(e.AuthorName),
			PublishedAt: pub,
			Topics:      topics,
		})
	}
	return out, nil
}

// stripTags removes element markup from a fragment, leaving text content.
// Feeds wrap CDATA payloads in HTML; the summary we store is text, never a
// re-serialized document.
func stripTags(s string) string {
	if !strings.ContainsAny(s, "<>") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	depth := 0
	for i := range len(s) {
		switch s[i] {
		case '<':
			depth++
		case '>':
			if depth > 0 {
				depth--
			}
		default:
			if depth == 0 {
				b.WriteByte(s[i])
			}
		}
	}
	return b.String()
}

// cleanText unescapes the common XML entities, strips markup, and collapses
// runs of whitespace so a stored summary is a single readable line.
func cleanText(s string) string {
	s = stripTags(s)
	s = strings.NewReplacer(
		"&amp;", "&",
		"&lt;", "<",
		"&gt;", ">",
		"&quot;", `"`,
		"&#39;", "'",
		"&apos;", "'",
		"&nbsp;", " ",
	).Replace(s)
	return strings.Join(strings.Fields(s), " ")
}
