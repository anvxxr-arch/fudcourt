package news

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Item is one RSS entry, projected onto exactly the six keys the TS route
// emitted. The projection is deliberate: the feed's <item> carries more markup
// than the board renders (categories, guid, enclosure attributes), and the
// route has always shipped these six.
//
// Tag discipline (the house rule): every one of the six is a Go string with NO
// omitempty, because the TS route initialised each to ” via `grab(...) ?? ”`.
// An absent element therefore means an empty STRING on the wire, never a
// missing key and never a null -- scripts/verify-news.py asserts presence.
type Item struct {
	Title       string `json:"title"`
	Link        string `json:"link"`
	Description string `json:"description"`
	PubDate     string `json:"pubDate"`
	Image       string `json:"image"`
	Source      string `json:"source"`
}

// Now is the injected clock (tests pin fetchedAt/timestamp).
var Now = func() int64 { return time.Now().Unix() }

var (
	// itemRe splits the document into <item>…</item> blocks. The TS route used
	// the same non-greedy global regex; a feed with no items yields no matches,
	// which is what makes "an empty feed is a 502" reachable.
	itemRe = regexp.MustCompile(`(?s)<item>(.*?)</item>`)
	// imageRe is the TS route's `/<media:content url="([^"]+)"/`.
	imageRe = regexp.MustCompile(`<media:content url="([^"]+)"`)
	// tagStrip is the TS route's `/<[^>]*>/g` HTML stripper on descriptions.
	tagStrip = regexp.MustCompile(`<[^>]*>`)
)

// textRe is the element reader for one tag name, built ONCE per tag. The
// alternation admits the CDATA spelling first so a CDATA-wrapped body is not
// truncated at its `]]>`, and the two capture groups are the CDATA and the bare
// arm -- which of them matched is what tells `""` from "absent".
func textRe(tag string) *regexp.Regexp {
	q := regexp.QuoteMeta(tag)
	return regexp.MustCompile(fmt.Sprintf(`(?s)<%s>(?:<!\[CDATA\[(.*?)\]\]>|(.*?))</%s>`, q, q))
}

// One regex per tag the projection reads: a fixed, closed set, so a caller
// cannot make the parser compile a regex per item (the feed is ~100 items).
var (
	titleRe   = textRe("title")
	linkRe    = textRe("link")
	descRe    = textRe("description")
	pubDateRe = textRe("pubDate")
)

// textOf reads one tag's inner text, unwrapping CDATA and trimming, returning
// "" when the element is absent. The TS route made the same two calls per tag
// (`stripCdata(grab(item, …))`), so an absent tag and an empty tag agree.
func textOf(re *regexp.Regexp, item string) string {
	m := re.FindStringSubmatch(item)
	if m == nil {
		return ""
	}
	if m[2] != "" {
		return strings.TrimSpace(m[2])
	}
	return strings.TrimSpace(m[1])
}

// ParseItems extracts every <item> of an RSS document into the six-key shape.
// `label` is the outlet's display name for the rows' `source` field, taken from
// the feed table so the table stays the single source of truth for it.
//
// Exported so the shape tests can drive it with recorded fixture bytes and so a
// second feed (should one ever be added) reuses one parser rather than growing
// a second, drifting one. A document with no <item> returns nil, which the
// fetcher turns into the loud "empty feed" refusal.
func ParseItems(xml, label string) []Item {
	matches := itemRe.FindAllStringSubmatch(xml, -1)
	if matches == nil {
		return nil
	}
	items := make([]Item, 0, len(matches))
	for _, m := range matches {
		block := m[1]
		items = append(items, Item{
			Title:       textOf(titleRe, block),
			Link:        textOf(linkRe, block),
			Description: description(block),
			PubDate:     textOf(pubDateRe, block),
			Image:       firstGroup(imageRe, block),
			Source:      label,
		})
	}
	return items
}

// description is the TS route's description arm: unwrap CDATA, strip HTML tags,
// then clip to 200 characters (the TS `.slice(0, 200)` is a UTF-16 slice; runes
// are used here so a multi-byte character is never cut in half).
func description(item string) string {
	m := descRe.FindStringSubmatch(item)
	if m == nil {
		return ""
	}
	raw := m[2]
	if raw == "" {
		raw = m[1]
	}
	raw = tagStrip.ReplaceAllString(raw, "")
	if r := []rune(raw); len(r) > 200 {
		raw = string(r[:200])
	}
	return strings.TrimSpace(raw)
}

// firstGroup returns capture 1 of the first match, or "".
func firstGroup(re *regexp.Regexp, s string) string {
	m := re.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}
