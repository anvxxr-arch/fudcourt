package khala

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Fixture bytes are the REAL recorded responses (curl, 2026-09-29, non-browser
// UA). They are stored uncompressed: this repo's other fixture set gzips large
// payloads, but khala's largest is 468 KB and keeping them verbatim means the
// extractor assertions can quote byte-accurate offsets and sizes without a
// decompression step in every test. Fixture sizes (bytes) as recorded:
//
//	home.html              259008
//	report-walrus.html     429159
//	report-bittensor.html  468140
//	sitemap.xml              1084
//	notfound.html            7384
//	cms-403.xml               243
func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return string(b)
}

// The 8 report slugs of the recorded homepage, newest-first (homepage order).
var wantSlugs = []string{
	"walrus-solving-the-ai-agent-context-memory-bottleneck-verifiable-onchain-portable-programmable",
	"bittensor-an-investment-history-from-genesis-to-dtao-tao-flow",
	"xmaquina-onchain-market-pre-ipo-robotics-equity-spv-subdao-deus",
	"surf-data-platform-onchain-social-prediction-crypto-ai-agent-intelligence",
	"x402-completing-the-internets-missing-payment-layer-for-agentic-commerce",
	"openclaw-ecosystem-autonomous-software-factory",
	"bittensor-the-intelligence-olympics",
	"decentralized-robotics-landscape",
}

func TestParseHomeYieldsEightReportsNewestFirst(t *testing.T) {
	cards, err := ParseHome(fixture(t, "home.html"))
	if err != nil {
		t.Fatalf("ParseHome: %v", err)
	}
	if len(cards) != 8 {
		t.Fatalf("cards=%d want 8", len(cards))
	}
	for i, want := range wantSlugs {
		if cards[i].Slug != want {
			t.Errorf("card %d slug=%q want %q", i, cards[i].Slug, want)
		}
	}
}

func TestHomeCardsCarryTitleAndSummary(t *testing.T) {
	cards, err := ParseHome(fixture(t, "home.html"))
	if err != nil {
		t.Fatalf("ParseHome: %v", err)
	}
	want := map[string][2]string{
		// measured values; title and the first 60 chars of the summary
		"walrus-solving-the-ai-agent-context-memory-bottleneck-verifiable-onchain-portable-programmable": {
			"WALRUS: SOLVING THE AI MEMORY BOTTLENECK",
			"Agents start blank at every session because context dies at session end",
		},
		"bittensor-the-intelligence-olympics": {
			"BITTENSOR: THE INTELLIGENCE OLYMPICS",
			"",
		},
		"decentralized-robotics-landscape": {
			"DECENTRALIZED ROBOTICS: LANDSCAPE AND OUTLOOK",
			"Decentralized robotics is no longer a speculative concept",
		},
	}
	for _, c := range cards {
		w, ok := want[c.Slug]
		if !ok {
			continue
		}
		if c.Title != w[0] {
			t.Errorf("%s title=%q want %q", c.Slug, c.Title, w[0])
		}
		if w[1] != "" && !strings.HasPrefix(c.Summary, w[1]) {
			t.Errorf("%s summary=%q want prefix %q", c.Slug, c.Summary, w[1])
		}
	}
}

// The homepage's LAST card anchor (measurably a distinct variant: it contains
// the whole footer, 17 <p>) must still yield the title and summary, not
// "Join 7,000+ receiving KHala research in their inbox".
func TestLastCardDoesNotLeakFooter(t *testing.T) {
	cards, err := ParseHome(fixture(t, "home.html"))
	if err != nil {
		t.Fatalf("ParseHome: %v", err)
	}
	last := cards[len(cards)-1]
	if last.Slug != "decentralized-robotics-landscape" {
		t.Fatalf("last card=%q", last.Slug)
	}
	for _, bad := range []string{"Join 7,000", "Follow on x", "@Khalaresearch", "ALL RIGHTS RESERVED", "disclaimer"} {
		if strings.Contains(last.Title, bad) || strings.Contains(last.Summary, bad) {
			t.Errorf("footer text %q leaked into last card: title=%q summary=%q", bad, last.Title, last.Summary)
		}
	}
}

// data-framer-name holds STALE PLACEHOLDER copy (measured: the walrus card's
// summary cell names an unrelated project). Nothing it carries may reach a row.
func TestNoPlaceholderTextInCards(t *testing.T) {
	raw := fixture(t, "home.html")
	cards, err := ParseHome(raw)
	if err != nil {
		t.Fatalf("ParseHome: %v", err)
	}
	// The literal measured placeholder from RESULTS.md.
	const placeholder = "Fully onchain game development platform behind Pirate Nation"
	if !strings.Contains(raw, placeholder) {
		t.Skip("placeholder text no longer in the homepage fixture; the decoy is not present to test")
	}
	for _, c := range cards {
		if strings.Contains(c.Title, "Pirate Nation") || strings.Contains(c.Summary, "Pirate Nation") {
			t.Errorf("%s leaked data-framer-name placeholder: %q / %q", c.Slug, c.Title, c.Summary)
		}
	}
}

func TestParseSitemapYieldsEightReports(t *testing.T) {
	slugs, err := ParseSitemap(fixture(t, "sitemap.xml"))
	if err != nil {
		t.Fatalf("ParseSitemap: %v", err)
	}
	if len(slugs) != 8 {
		t.Fatalf("slugs=%d want 8 (%v)", len(slugs), slugs)
	}
	for i, w := range wantSlugs {
		if slugs[i] != w {
			t.Errorf("sitemap %d=%q want %q", i, slugs[i], w)
		}
	}
}

func TestTheNinetyFourCharSlugIsAccepted(t *testing.T) {
	// Measured: the newest report's slug is 94 chars. Any cap below that (e.g.
	// the 80-char suggestion, or cryptorank.KeyRe's 64) would 400 the flagship
	// report -- this test is the regression guard for exactly that.
	slug := wantSlugs[0]
	if got := len(slug); got != 94 {
		t.Fatalf("walrus slug is %d chars, expected the measured 94", got)
	}
	if !ValidKey(slug) {
		t.Errorf("ValidKey(%q) = false; the 94-char slug MUST be accepted", slug)
	}
}

func TestParseReportWalrus(t *testing.T) {
	p, err := ParseReport(fixture(t, "report-walrus.html"))
	if err != nil {
		t.Fatalf("ParseReport: %v", err)
	}
	if p.Title != "WALRUS: SOLVING THE AI MEMORY BOTTLENECK" {
		t.Errorf("title=%q", p.Title)
	}
	// Measured: the dash spacing differs across reports -- walrus (newest) has
	// ONE space, bittensor has TWO. That is why the suffix match is \s+.
	if p.MetaTitle != "WALRUS: SOLVING THE AI MEMORY BOTTLENECK - Khala Research" {
		t.Errorf("metaTitle=%q", p.MetaTitle)
	}
	if p.Published == nil || *p.Published != "Jul 2, 2026" {
		t.Errorf("published=%v", p.Published)
	}
	if p.PublishedISO == nil || *p.PublishedISO != "2026-07-02" {
		t.Errorf("publishedISO=%v", p.PublishedISO)
	}
	if len(p.Authors) != 3 {
		t.Fatalf("authors=%d want 3 (%v)", len(p.Authors), p.Authors)
	}
	if p.Authors[0].Name != "0xSammy" || p.Authors[0].URL != "https://x.com/0xSammy" {
		t.Errorf("author0=%+v", p.Authors[0])
	}
	if len(p.Sections) != 11 {
		t.Fatalf("sections=%d want 11", len(p.Sections))
	}
	if id := p.Sections[0].ID; id == nil || *id != "key-takeaways" {
		t.Errorf("section0 id=%v", id)
	}
	if p.Sections[0].Level != 2 || p.Sections[0].Title != "KEY TAKEAWAYS" {
		t.Errorf("section0=%+v", p.Sections[0])
	}
	if p.BodyChars < MinBodyChars {
		t.Errorf("BodyChars=%d below floor %d", p.BodyChars, MinBodyChars)
	}
	t.Logf("walrus: bodyChars=%d blocks=%d sections=%d authors=%d",
		p.BodyChars, len(p.Body), len(p.Sections), len(p.Authors))
}

func TestParseReportBittensor(t *testing.T) {
	p, err := ParseReport(fixture(t, "report-bittensor.html"))
	if err != nil {
		t.Fatalf("ParseReport: %v", err)
	}
	if p.Title != "BITTENSOR: THE INTELLIGENCE OLYMPICS" {
		t.Errorf("title=%q", p.Title)
	}
	if p.Published == nil || *p.Published != "Feb 19, 2026" {
		t.Errorf("published=%v", p.Published)
	}
	if p.PublishedISO == nil || *p.PublishedISO != "2026-02-19" {
		t.Errorf("publishedISO=%v", p.PublishedISO)
	}
	// bittensor carries 4 byline authors (0xSammy, haitzu, Alex Kazoh, Lemz)
	// against walrus's 3 -- the region rule must not swallow the extra one.
	if len(p.Authors) != 4 {
		t.Fatalf("authors=%d want 4 (%v)", len(p.Authors), p.Authors)
	}
	if p.Authors[2].Name != "Alex Kazoh" {
		t.Errorf("author2=%+v", p.Authors[2])
	}
	// h3 sub-headings are real on this page: 8 h2 + 5 h3.
	h2, h3 := 0, 0
	for _, s := range p.Sections {
		switch s.Level {
		case 2:
			h2++
		case 3:
			h3++
		}
	}
	if h2 != 8 || h3 != 5 {
		t.Errorf("sections h2=%d h3=%d want 8/5", h2, h3)
	}
	t.Logf("bittensor: bodyChars=%d blocks=%d sections=%d authors=%d",
		p.BodyChars, len(p.Body), len(p.Sections), len(p.Authors))
}

// The body must be complete AND chrome-free: it carries the report prose and no
// site chrome. The sentinels below are the ones the brief names, and they are
// measured absent from the extracted body (and, in fact, absent from the
// source article container entirely).
func TestReportBodyIsCompleteAndChromeFree(t *testing.T) {
	for _, f := range []string{"report-walrus.html", "report-bittensor.html"} {
		p, err := ParseReport(fixture(t, f))
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		var all strings.Builder
		for _, b := range p.Body {
			all.WriteString(b.Text)
			all.WriteString("\n")
		}
		body := all.String()
		for _, bad := range []string{
			"Join 7,000+ receiving",
			"Follow on x",
			"@Khalaresearch",
			"table of Content",
			"aLL riGHTS RESERVED",
		} {
			if strings.Contains(body, bad) {
				t.Errorf("%s: chrome sentinel %q present in body", f, bad)
			}
		}
		// Byline must not be body text either.
		if strings.Contains(body, *p.Published) {
			t.Errorf("%s: byline date %q leaked into body", f, *p.Published)
		}
		// Completeness: the two headings every report starts with and the
		// prose under them.
		for _, want := range []string{"KEY TAKEAWAYS", "EXECUTIVE SUMMARY"} {
			if !strings.Contains(body, want) {
				t.Errorf("%s: missing %q in body", f, want)
			}
		}
		// The body must carry real prose, not just headings.
		prose := 0
		for _, b := range p.Body {
			if b.Type == "p" || b.Type == "li" {
				prose += len(b.Text)
			}
		}
		if prose < MinBodyChars {
			t.Errorf("%s: prose chars=%d below floor", f, prose)
		}
	}
}

// The body must be in DOCUMENT ORDER. The proof uses the heading ids, which
// are unique anchors: their source offsets must be strictly increasing. (A
// text-offset check is unreliable here -- the article is also embedded in the
// page's handover JSON, so a remembered first offset can be a duplicate in the
// serialised payload rather than the rendered block.)
func TestReportBodyIsInDocumentOrder(t *testing.T) {
	for _, f := range []string{"report-walrus.html", "report-bittensor.html"} {
		raw := fixture(t, f)
		p, err := ParseReport(raw)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		last := -1
		checked := 0
		for _, s := range p.Sections {
			if s.ID == nil {
				continue
			}
			idx := strings.Index(raw, `id="`+*s.ID+`"`)
			if idx < 0 {
				t.Fatalf("%s: heading id %q not found in the source", f, *s.ID)
			}
			if idx <= last {
				t.Fatalf("%s: heading %q at offset %d is not after the previous heading (%d): sections are out of document order",
					f, *s.ID, idx, last)
			}
			last = idx
			checked++
		}
		if checked != len(p.Sections) {
			t.Fatalf("%s: only %d of %d sections had a checkable id", f, checked, len(p.Sections))
		}
		// And the body must start at the article, near its first heading. It is
		// not forced to BE a heading: bittensor's article legitimately opens
		// with a `NOTE FOR READER` paragraph before `KEY TAKEAWAYS` (measured).
		firstHeading := -1
		for i, b := range p.Body {
			if strings.HasPrefix(b.Type, "h") {
				firstHeading = i
				break
			}
		}
		if firstHeading < 0 || firstHeading > 2 {
			t.Errorf("%s: first heading at block %d (want it within the first 3 blocks -- the body must start at the article)", f, firstHeading)
		}
	}
}
