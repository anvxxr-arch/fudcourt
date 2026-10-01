package khala

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html"
)

// MinBodyChars is the layout-drift floor for a report body.
//
// It is measured, not guessed. The flattened `<p>` text of the whole page is
// 43804 chars for report-walrus.html (429159 bytes) and 34251 for
// report-bittensor.html (468140 bytes); the body container alone contributes
// 43365 and 33828 chars. A page whose extraction lands under this floor is not
// a shorter report -- it is a page whose markup changed, and the house rule is
// that an empty/partial upstream is never a valid answer, so it becomes a loud
// 502. 4000 is ~1 part in 8 of the smallest real body: far below any genuine
// report, far above what a chrome-only or header-only parse could produce
// (walrus's byline+title region is ~200 chars, the nav ~30, the footer ~400).
const MinBodyChars = 4000

// BodyStartURL is the article container's anchor. The selector is the
// `data-framer-name` on the wrapper div of the article's rich text
// (`<div class="framer-decsvl rt-lightbox" data-framer-name="ArticleRichText">`).
//
// Why this and not a class: `framer-decsvl` / `rt-lightbox` / `framer-text` /
// `framer-styles-preset-*` are Framer-generated and change on every republish,
// and `data-framer-name` elsewhere on the site is *documented stale
// placeholder copy* (a card's data-framer-name holds unrelated marketing text).
// "ArticleRichText" is the author's own label for this block, so it is the most
// semantic, least volatile hook on the page. It is nonetheless the one fragile
// assumption here, which is why a miss is a loud layout HardError and never an
// empty report -- see MinBodyChars and ParseReport.
const bodyAnchorName = "ArticleRichText"

var (
	// dateRe is the byline date shape. khala prints exactly `Mon D, YYYY`
	// (e.g. "Jul 2, 2026"), and the ISO date is derived deterministically.
	dateRe = regexp.MustCompile(`^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}$`)
	// titleSuffix is stripped from <title>/og:title. The site prints a DOUBLE
	// space before the dash ("WALRUS: SOLVING THE AI MEMORY BOTTLENECK  - Khala
	// Research"), so both spellings are handled.
	titleSuffixRe = regexp.MustCompile(`\s+-\s+Khala Research$`)
	// titleTagRe/metaTitleRe pull the two spellings of the page title.
	titleTagRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	ogTitleRe  = regexp.MustCompile(`(?is)<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']`)
	ogTitleRe2 = regexp.MustCompile(`(?is)<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']`)
)

// khCard is one parsed homepage card.
type khCard struct {
	Slug    string
	Title   string
	Summary string
}

// ParseHome extracts the report cards from the homepage.
//
// Anchor: `<a class="framer-zchvb0 framer-lux5qc" href="./<slug>">`. Measured
// on the recorded homepage (259008 bytes): 14 such anchors covering the 8
// reports, each report appearing twice (SSR'd hero + card, and the two
// "Load More" ones are already in the raw HTML). The card's title and summary
// are its first two non-empty `<p class="framer-text">`; measured per card:
// 2 paragraphs for 12 of the 14 anchors, 3 for one duplicate (a hidden variant
// with one extra paragraph) and 17 for the last card -- whose remaining 15
// paragraphs are the site footer ("Join 7,000+ receiving KHala research in
// their inbox", "Follow on x", "@Khalaresearch", the copyright line), which is
// why the first two are taken and the rest ignored.
//
// `data-framer-name` is deliberately never read: it holds stale placeholder
// copy (measured: the walrus card's summary cell carries marketing text about a
// different project entirely).
func ParseHome(raw string) ([]khCard, error) {
	doc, err := html.Parse(strings.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("homepage is not parseable HTML: %w", err)
	}
	var out []khCard
	seen := map[string]bool{}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "a" {
			href := attr(n, "href")
			if slug, ok := cardSlug(href); ok && !seen[slug] {
				paras := paraTexts(n)
				if len(paras) >= 2 {
					// Dedupe by slug keeps the first occurrence, which is the
					// newest-first order the page renders in.
					seen[slug] = true
					out = append(out, khCard{Slug: slug, Title: paras[0], Summary: paras[1]})
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	if len(out) == 0 {
		return nil, fmt.Errorf("homepage has no report cards (link markup changed?)")
	}
	return out, nil
}

// cardSlug accepts a `href="./<slug>"` report link. It is the card anchor, not
// every `./` link: "../" and "./#" and the empty href are not slugs, and
// about/disclaimer are site pages rather than reports.
func cardSlug(href string) (string, bool) {
	if !strings.HasPrefix(href, "./") || strings.HasPrefix(href, "../") {
		return "", false
	}
	slug := strings.TrimPrefix(href, "./")
	if slug == "" || slug == "about" || slug == "disclaimer" {
		return "", false
	}
	if strings.ContainsAny(slug, "/?#") {
		return "", false
	}
	return slug, ValidKey(slug)
}

// ParseSitemap returns the report slugs in a sitemap.xml, in document order.
// The sitemap is the independent enumeration: 11 <loc> entries
// (/, /about, /disclaimer + the 8 reports), 1084 bytes.
func ParseSitemap(raw string) ([]string, error) {
	doc, err := html.Parse(strings.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("sitemap is not parseable XML: %w", err)
	}
	var slugs []string
	seen := map[string]bool{}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "loc" {
			u := strings.TrimSpace(text(n))
			if slug, ok := sitemapSlug(u); ok && !seen[slug] {
				seen[slug] = true
				slugs = append(slugs, slug)
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	if len(slugs) == 0 {
		return nil, fmt.Errorf("sitemap has no report <loc> entries")
	}
	return slugs, nil
}

// sitemapSlug accepts `https://www.khala.io/<slug>` for a report slug. The
// three site pages are excluded: khala's content type is research reports, and
// /about + /disclaimer are not reports.
func sitemapSlug(u string) (string, bool) {
	prefix := Base + "/"
	if !strings.HasPrefix(u, prefix) {
		return "", false
	}
	slug := strings.TrimPrefix(u, prefix)
	if slug == "" || slug == "about" || slug == "disclaimer" {
		return "", false
	}
	if strings.ContainsAny(slug, "/?#") {
		return "", false
	}
	return slug, ValidKey(slug)
}

// KhBlock is one body block. Type is one of h2|h3|h4|p|li; id is set only on
// headings (khala gives every heading a kebab id, e.g. "key-takeaways").
type KhBlock struct {
	Type string  `json:"type"`
	ID   *string `json:"id,omitempty"`
	Text string  `json:"text"`
}

// KhSection is one heading of the report body, in DOM order.
type KhSection struct {
	ID    *string `json:"id,omitempty"`
	Level int     `json:"level"`
	Title string  `json:"title"`
}

// KhAuthor is a byline anchor on x.com/twitter.com.
type KhAuthor struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// ParsedReport is the extraction result before the envelope wraps it.
type ParsedReport struct {
	Title        string
	MetaTitle    string
	Published    *string
	PublishedISO *string
	Authors      []KhAuthor
	Sections     []KhSection
	Body         []KhBlock
	// BodyChars is the flattened body length (the drift-floor unit).
	BodyChars int
}

// ParseReport extracts one report page.
//
// Boundaries, all measured against the two recorded pages (walrus 429159 B,
// bittensor 468140 B):
//
//   - Body: from the first heading inside the `ArticleRichText` container to
//     the end of that container. The container is where the article stops:
//     the footer ("Join 7,000+ receiving KHala research in their inbox",
//     "Follow on x", "@Khalaresearch", the copyright line, the disclaimer link)
//     lives OUTSIDE it, and so do the nav ("home"/"about") and the
//     "table of Content" label -- measured: none of `Join 7,000`, `Follow on
//     x`, `Table of Content`, `@Khalaresearch` or `Copyright` occurs anywhere
//     in the container's text on either page. The byline/authors block is also
//     outside it (the authors' x.com anchors sit before the container).
//   - Footer safety net: if a container ever does include the footer, the body
//     is cut at the first block containing `Join 7,000+ receiving` (see
//     footerMark), so the house rule holds even if the container boundary
//     moves.
//   - Date: by TEXT regex over the header region (title -> first body heading),
//     never by the `rgba(255, 255, 255, 0.6)` style attribute. That style is a
//     Framer restyle-breakable CSS detail; the printed `Mon D, YYYY` is the
//     content. Exactly one match is required: zero -> null, more than one ->
//     an error naming the ambiguity (never pick one arbitrarily).
//   - Authors: `<a href>` whose host is x.com/twitter.com within the header
//     region (after the title, before the first body heading). Measured: 3
//     authors on walrus, 4 on bittensor -- and 0 such links are body links.
//     Document-wide there are also 4 footer `@Khalaresearch` links and, on
//     bittensor, 6 in-body x.com links; the region restriction excludes all of
//     them.
func ParseReport(raw string) (*ParsedReport, error) {
	doc, err := html.Parse(strings.NewReader(raw))
	if err != nil {
		return nil, &HardError{Kind: "layout", Detail: "report page is not parseable HTML"}
	}
	container := findByName(doc, bodyAnchorName)
	if container == nil {
		return nil, &HardError{
			Kind:   "layout",
			Detail: fmt.Sprintf("report page has no %q body container (Framer markup changed?)", bodyAnchorName),
		}
	}
	title := metaTitle(raw)
	published, publishedISO, err := extractDate(doc, container)
	if err != nil {
		return nil, err
	}
	blocks := bodyBlocks(doc, container)
	if len(blocks) == 0 {
		return nil, &HardError{Kind: "layout", Detail: "report body has no blocks (headings/paragraphs missing)"}
	}
	sections := sectionsOf(blocks)
	if len(sections) == 0 {
		return nil, &HardError{Kind: "layout", Detail: "report body has no headings (no sections found)"}
	}
	chars := bodyChars(blocks)
	if chars < MinBodyChars {
		return nil, &HardError{
			Kind: "layout",
			Detail: fmt.Sprintf(
				"report body is %d chars, below the %d-char plausibility floor (measured real bodies: 43365 and 33828 chars) -- layout drift, not a short report",
				chars, MinBodyChars),
		}
	}
	return &ParsedReport{
		Title:        title,
		MetaTitle:    fullTitle(raw),
		Published:    published,
		PublishedISO: publishedISO,
		Authors:      extractAuthors(doc, container),
		Sections:     sections,
		Body:         blocks,
		BodyChars:    chars,
	}, nil
}

// extractDate finds the byline date in the header region by text shape.
func extractDate(doc *html.Node, container *html.Node) (*string, *string, error) {
	var found []string
	for n := range iterAll(doc) {
		if n == container {
			break // header region is everything before the body container
		}
		if n.Type != html.ElementNode || n.Data != "p" {
			continue
		}
		t := collapse(text(n))
		if dateRe.MatchString(t) {
			found = append(found, t)
		}
	}
	switch len(found) {
	case 0:
		// Honest absence: no byline marker matched. Never synthesise a date
		// from the `<!-- Published Jul 2, 2026, 2:53 PM UTC -->` site-build
		// comment -- that is the Framer build time and is identical on /about
		// and /disclaimer too, so using it would date every report the same.
		return nil, nil, nil
	case 1:
		t, err := time.Parse("Jan 2, 2006", found[0])
		if err != nil {
			return nil, nil, &HardError{Kind: "layout", Detail: "byline date did not parse: " + found[0]}
		}
		iso := t.Format("2006-01-02")
		return &found[0], &iso, nil
	default:
		return nil, nil, &HardError{
			Kind:   "layout",
			Detail: fmt.Sprintf("report has %d date-shaped bylines (%s) -- ambiguous, refusing to pick one", len(found), strings.Join(found, ", ")),
		}
	}
}

// extractAuthors collects x.com/twitter.com anchors in the header region.
func extractAuthors(doc *html.Node, container *html.Node) []KhAuthor {
	var out []KhAuthor
	seen := map[string]bool{}
	for n := range iterAll(doc) {
		if n == container {
			break
		}
		if n.Type != html.ElementNode || n.Data != "a" {
			continue
		}
		href := attr(n, "href")
		if !isSocialURL(href) {
			continue
		}
		name := collapse(text(n))
		if name == "" || seen[href] {
			continue
		}
		seen[href] = true
		out = append(out, KhAuthor{Name: name, URL: href})
	}
	return out
}

// isSocialURL restricts to the two hosts khala uses for bylines. A profile
// anchor and an in-body citation are the same shape (both x.com/<path>), so the
// host test alone cannot separate them -- the header-region walk does that.
func isSocialURL(href string) bool {
	for _, p := range []string{"https://x.com/", "https://twitter.com/", "http://x.com/", "http://twitter.com/"} {
		if strings.HasPrefix(href, p) {
			return true
		}
	}
	return false
}

// footerMark is the safety-net cut: the site footer's first line. If a future
// republish folds the footer into the article container, the body stops here.
const footerMark = "Join 7,000+ receiving"

// navMark is the "table of Content" label that sits above the article as site
// chrome (it is outside the container, but a moved layout must still not leak
// it into the body).
const navMark = "table of Content"

// bodyBlocks walks the container in document order and returns the block
// elements, flattening inline markup (<em>/<strong>/<a>) to their text.
//
// Flattening is a deliberate design choice: the body becomes a boring JSON
// contract (h2/h3/h4/p/li + text) instead of third-party HTML shipped into the
// web app, so the consumer needs no sanitizer. It costs the inline emphasis
// runs and nothing else -- every character of prose is kept.
//
// Only the FIRST heading in each block-bearing subtree is emitted: khala nests
// `<p>` inside `<li>` (`<li data-preset-tag="p"><p class="framer-text">…`), so a
// naive walk yields every bullet body twice (once as li, once as p). Taking the
// outer element and descending only into non-block children gives one block per
// bullet/paragraph, which is why the measured block set is 160 for walrus and
// 365 for bittensor rather than double that.
func bodyBlocks(doc *html.Node, container *html.Node) []KhBlock {
	var out []KhBlock
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type != html.ElementNode {
				continue
			}
			switch c.Data {
			case "script", "style", "svg", "path", "img", "iframe", "link", "button", "br":
				continue
			}
			if isBlock(c) {
				t := collapse(blockText(c))
				if t == "" {
					continue
				}
				// Footer safety net (see footerMark).
				if strings.Contains(t, footerMark) {
					return
				}
				// Skip the nav/ToC label wherever it appears.
				if t == navMark || t == footerMark {
					continue
				}
				b := KhBlock{Type: c.Data, Text: t}
				if id := attr(c, "id"); id != "" {
					b.ID = &id
				}
				out = append(out, b)
				continue // do not also emit the nested duplicates
			}
			walk(c)
		}
	}
	walk(container)
	return out
}

func isBlock(n *html.Node) bool {
	switch n.Data {
	case "h1", "h2", "h3", "h4", "h5", "h6", "p", "li":
		return true
	}
	return false
}

// blockText is the element's text with inline runs separated by a space where
// markup broke a word boundary (measured need: `<strong>…software. </strong>`
// then a plain run reads as "software.Midjourney" without the boundary join).
func blockText(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			switch c.Type {
			case html.TextNode:
				b.WriteString(c.Data)
			case html.ElementNode:
				switch c.Data {
				case "script", "style":
					continue
				case "br":
					b.WriteString(" ")
					continue
				}
				// A <p> nested inside <li> is the same prose, not an
				// inline run: keep its spacing implicit (the li's own text).
				b.WriteString(" ")
				walk(c)
				b.WriteString(" ")
			}
		}
	}
	walk(n)
	return collapse(b.String())
}

func sectionsOf(blocks []KhBlock) []KhSection {
	var out []KhSection
	for _, b := range blocks {
		switch b.Type {
		case "h2", "h3", "h4":
			out = append(out, KhSection{ID: b.ID, Level: int(b.Type[1] - '0'), Title: b.Text})
		}
	}
	return out
}

func bodyChars(blocks []KhBlock) int {
	n := 0
	for _, b := range blocks {
		n += len(b.Text)
	}
	return n
}

// metaTitle returns the human title: <title> (or og:title) with the
// " - Khala Research" suffix removed.
//
// Measured: the dash spacing is NOT stable across reports. The bittensor page
// prints `BITTENSOR: THE INTELLIGENCE OLYMPICS  - Khala Research` (two spaces)
// while the NEWER walrus page prints `WALRUS: SOLVING THE AI MEMORY BOTTLENECK
// - Khala Research` (one space) -- so \s+ is required, and a literal "  - "
// match would silently stop working on the newer reports. fullTitle keeps the
// raw spacing for metaTitle.
func metaTitle(raw string) string {
	if m := titleTagRe.FindStringSubmatch(raw); m != nil {
		return strings.TrimSpace(titleSuffixRe.ReplaceAllString(collapse(html.UnescapeString(m[1])), ""))
	}
	if full := fullTitle(raw); full != "" {
		return strings.TrimSpace(titleSuffixRe.ReplaceAllString(full, ""))
	}
	return ""
}

// fullTitle returns the RAW <title> text, suffix and double space intact (the
// envelope's metaTitle).
//
// It must NOT collapse whitespace: khala.io's own `<title>` carries TWO spaces
// before the suffix (`… EQUITY  - Khala Research`, measured 2026-09-29), and
// `metaTitle` is asserted against that exact page string by
// scripts/verify-khala.py. Collapsing here made the field disagree with the
// page it claims to quote.
func fullTitle(raw string) string {
	if m := titleTagRe.FindStringSubmatch(raw); m != nil {
		return html.UnescapeString(m[1])
	}
	for _, rx := range []*regexp.Regexp{ogTitleRe, ogTitleRe2} {
		if m := rx.FindStringSubmatch(raw); m != nil {
			return html.UnescapeString(m[1])
		}
	}
	return ""
}

// ---- small DOM helpers -----------------------------------------------------
func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func findByName(n *html.Node, name string) *html.Node {
	for e := range iterAll(n) {
		if e.Type == html.ElementNode && attr(e, "data-framer-name") == name {
			return e
		}
	}
	return nil
}

func findFirst(n *html.Node, tag string) *html.Node {
	for e := range iterAll(n) {
		if e.Type == html.ElementNode && e.Data == tag {
			return e
		}
	}
	return nil
}

// iterAll yields every node in document order (depth first).
func iterAll(root *html.Node) func(yield func(*html.Node) bool) {
	return func(yield func(*html.Node) bool) {
		var walk func(*html.Node) bool
		walk = func(n *html.Node) bool {
			if !yield(n) {
				return false
			}
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				if !walk(c) {
					return false
				}
			}
			return true
		}
		walk(root)
	}
}

// text is the concatenated text of a node (block level: no added separators,
// callers collapse whitespace).
func text(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		if x.Type == html.TextNode {
			b.WriteString(x.Data)
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}

// paraTexts returns the non-empty <p> texts directly inside a card anchor, in
// document order.
func paraTexts(a *html.Node) []string {
	var out []string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.Data == "p" {
				if t := collapse(blockText(c)); t != "" {
					out = append(out, t)
				}
			}
			walk(c)
		}
	}
	walk(a)
	return out
}

func collapse(s string) string { return strings.Join(strings.Fields(s), " ") }
