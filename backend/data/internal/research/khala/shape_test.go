package khala

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research"
)

// fixtureFetcher serves the recorded fixtures by URL; it is the Service-level
// analogue of the handler's fake fetcher (no network, deterministic).
type fixtureFetcher struct {
	t *testing.T
	// override lets a test swap one URL's body (drift/no-date cases).
	override map[string]string
	calls    []string
}

func (f *fixtureFetcher) Fetch(_ context.Context, url string, ttl int) (string, CacheInfo, error) {
	f.calls = append(f.calls, url)
	if b, ok := f.override[url]; ok {
		if b == "" {
			return "", CacheInfo{}, &NotFoundError{URL: url, Status: 404}
		}
		return b, CacheInfo{Status: 200, Cache: "MISS", FetchedAt: 1759147200}, nil
	}
	switch url {
	case HomeURL:
		return fixture(f.t, "home.html"), CacheInfo{Status: 200, Cache: "MISS", FetchedAt: 1759147200}, nil
	case SitemapURL:
		return fixture(f.t, "sitemap.xml"), CacheInfo{Status: 200, Cache: "MISS", FetchedAt: 1759147200}, nil
	}
	for _, s := range wantSlugs {
		if url == KeyURL(s) {
			switch s {
			case wantSlugs[0]:
				return fixture(f.t, "report-walrus.html"), CacheInfo{Status: 200, Cache: "MISS", FetchedAt: 1759147200}, nil
			case "bittensor-the-intelligence-olympics":
				return fixture(f.t, "report-bittensor.html"), CacheInfo{Status: 200, Cache: "MISS", FetchedAt: 1759147200}, nil
			}
			// Only two report pages were recorded; the others answer with the
			// walrus page, which is enough for envelope-shape assertions.
			return fixture(f.t, "report-walrus.html"), CacheInfo{Status: 200, Cache: "MISS", FetchedAt: 1759147200}, nil
		}
	}
	return "", CacheInfo{}, &HardError{Kind: "status", Status: 404, URL: url, Detail: "no fixture"}
}

func newService(t *testing.T, ov map[string]string) (*Service, *fixtureFetcher) {
	ff := &fixtureFetcher{t: t, override: ov}
	return &Service{F: ff, TTL: 900}, ff
}

func TestReportsEnvelope(t *testing.T) {
	s, _ := newService(t, nil)
	env, err := s.List(context.Background(), "reports", 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if env.Kind != "reports" {
		t.Errorf("kind=%q", env.Kind)
	}
	if env.Upstream != HomeURL {
		t.Errorf("upstream=%q want the homepage", env.Upstream)
	}
	if env.Count != 8 || len(env.Rows) != 8 {
		t.Fatalf("count=%d rows=%d want 8", env.Count, len(env.Rows))
	}
	if env.UpstreamTotal == nil || *env.UpstreamTotal != 8 {
		t.Errorf("upstreamTotal=%v want 8 (from the sitemap)", env.UpstreamTotal)
	}
	if env.MissingSlugs != nil {
		t.Errorf("missingSlugs=%v want absent when the sources agree", env.MissingSlugs)
	}
	for i, r := range env.Rows {
		if r.Position != i+1 {
			t.Errorf("row %d position=%d", i, r.Position)
		}
		if r.Slug != wantSlugs[i] {
			t.Errorf("row %d slug=%q want %q", i, r.Slug, wantSlugs[i])
		}
		if r.URL != KeyURL(r.Slug) {
			t.Errorf("row %d url=%q", i, r.URL)
		}
		if r.Title == "" || r.Summary == "" {
			t.Errorf("row %d missing title/summary: %q / %q", i, r.Title, r.Summary)
		}
		if r.Published != nil || r.PublishedISO != nil {
			t.Errorf("row %d carries dates in mode=reports (the source has none)", i)
		}
	}
	if env.Slice == nil || !strings.Contains(*env.Slice, SitemapURL) {
		t.Errorf("slice=%v must name the auxiliary sitemap source", env.Slice)
	}
}

// The wire contract for mode=reports: the date keys must be ABSENT, not null.
func TestReportsRowsOmitDateKeys(t *testing.T) {
	s, _ := newService(t, nil)
	env, err := s.List(context.Background(), "reports", 0)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"published"`) || strings.Contains(string(raw), `"publishedISO"`) {
		t.Errorf("mode=reports must omit the date keys entirely (an absent key says 'this mode has no dates'; a null would claim a lookup happened):\n%s", research.SliceBodyEllipsis(string(raw), 400, "..."))
	}
	// And the report payload key is absent too.
	if strings.Contains(string(raw), `"report"`) {
		t.Errorf("mode=reports must not carry a report key")
	}
	if !strings.Contains(string(raw), `"rows"`) {
		t.Errorf("mode=reports must carry rows")
	}
}

// A homepage parse that misses a sitemap slug must SAY SO: slice names the gap
// and missingSlugs lists it. Never pad, never fabricate a row.
func TestReportsMissingSlugIsDisclosedNotPadded(t *testing.T) {
	home := fixture(t, "home.html")
	// Point EVERY card anchor for the newest slug at a NON-card href. The slug
	// appears three times in the raw HTML (SSR'd hero, card, and the Framer
	// search index), and only the two anchors are card-shaped, so the
	// replacement must also be anchor-shaped -- and must NOT be a legal slug
	// itself, or ParseHome would emit a row for the replacement and the count
	// would stay put. `#zzz-not-a-report` is rejected by cardSlug (no `./`
	// prefix), so the card is genuinely removed.
	truncated := strings.ReplaceAll(home, `href="./`+wantSlugs[0]+`"`, `href="#zzz-not-a-report"`)
	if truncated == home {
		t.Fatal("could not find the card anchors for the newest slug")
	}
	s, _ := newService(t, map[string]string{HomeURL: truncated})
	env, err := s.List(context.Background(), "reports", 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if env.Count != 7 {
		t.Fatalf("count=%d want 7 (one card removed)", env.Count)
	}
	if env.UpstreamTotal == nil || *env.UpstreamTotal != 8 {
		t.Errorf("upstreamTotal=%v want 8 (the sitemap still enumerates 8)", env.UpstreamTotal)
	}
	if len(env.MissingSlugs) != 1 || env.MissingSlugs[0] != wantSlugs[0] {
		t.Fatalf("missingSlugs=%v want [%s]", env.MissingSlugs, wantSlugs[0])
	}
	if env.Slice == nil || !strings.Contains(*env.Slice, wantSlugs[0]) {
		t.Errorf("slice must name the missed slug: %v", env.Slice)
	}
	for _, r := range env.Rows {
		if r.Slug == wantSlugs[0] {
			t.Errorf("the missed slug must not be padded back into rows")
		}
	}
}

// An empty homepage row set is a LOUD failure, never count:0.
func TestEmptyHomepageIsLoud(t *testing.T) {
	s, _ := newService(t, map[string]string{HomeURL: "<html><body>no cards here</body></html>"})
	_, err := s.List(context.Background(), "reports", 0)
	he, ok := IsHardError(err)
	if !ok {
		t.Fatalf("err=%v (%T) want a HardError", err, err)
	}
	if he.Kind != "layout" {
		t.Errorf("kind=%q want layout", he.Kind)
	}
}

func TestReportEnvelope(t *testing.T) {
	slug := wantSlugs[0]
	s, _ := newService(t, nil)
	env, err := s.Report(context.Background(), slug)
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if env.Kind != "report" {
		t.Errorf("kind=%q", env.Kind)
	}
	if env.Upstream != KeyURL(slug) {
		t.Errorf("upstream=%q", env.Upstream)
	}
	if env.UpstreamTotal != nil {
		t.Errorf("upstreamTotal=%v must be absent for a single report", env.UpstreamTotal)
	}
	if env.Rows != nil {
		t.Errorf("rows must be absent for mode=report")
	}
	r := env.Report
	if r == nil {
		t.Fatal("report payload missing")
	}
	if r.Slug != slug || r.URL != KeyURL(slug) {
		t.Errorf("slug/url=%q/%q", r.Slug, r.URL)
	}
	if r.Title != "WALRUS: SOLVING THE AI MEMORY BOTTLENECK" {
		t.Errorf("title=%q", r.Title)
	}
	if r.MetaTitle != "WALRUS: SOLVING THE AI MEMORY BOTTLENECK - Khala Research" {
		t.Errorf("metaTitle=%q", r.MetaTitle)
	}
	if r.Published == nil || *r.Published != "Jul 2, 2026" || r.PublishedISO == nil || *r.PublishedISO != "2026-07-02" {
		t.Errorf("published=%v/%v", r.Published, r.PublishedISO)
	}
	if r.Authors == nil || len(*r.Authors) != 3 {
		t.Fatalf("authors=%v want 3", r.Authors)
	}
	if len(r.Sections) != 11 || r.Sections[0].Title != "KEY TAKEAWAYS" {
		t.Errorf("sections=%d %+v", len(r.Sections), r.Sections[0])
	}
	if len(r.Body) < 100 {
		t.Errorf("body blocks=%d", len(r.Body))
	}
	if env.Slice == nil || !strings.Contains(*env.Slice, "2026-07-02") {
		t.Errorf("slice must name the publishedISO derivation: %v", env.Slice)
	}
	if env.Count != 1 {
		t.Errorf("count=%d want 1", env.Count)
	}
}

// authors: null is a legal value (never an invented list).
func TestReportAuthorsNullWhenNoneFound(t *testing.T) {
	slug := wantSlugs[0]
	// Strip every x.com anchor from the header region by removing the host.
	page := strings.ReplaceAll(fixture(t, "report-walrus.html"), "https://x.com/", "https://example.com/")
	s, _ := newService(t, map[string]string{KeyURL(slug): page})
	env, err := s.Report(context.Background(), slug)
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if env.Report.Authors == nil {
		t.Fatal("authors must be a present pointer")
	}
	if len(*env.Report.Authors) != 0 {
		t.Errorf("authors=%v want empty", *env.Report.Authors)
	}
	raw, err := json.Marshal(env.Report)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"authors":[]`) {
		t.Errorf("no-authors report must render authors as [] not a fabrication: %s", research.SliceBodyEllipsis(string(raw), 200, "..."))
	}
}

// LAYOUT DRIFT: a page whose body container was renamed (or removed) must be a
// loud 502-class error, never a 200 with an empty body.
func TestLayoutDriftIsLoud(t *testing.T) {
	slug := wantSlugs[0]
	drifted := strings.Replace(fixture(t, "report-walrus.html"), `data-framer-name="ArticleRichText"`, `data-framer-name="Renamed"`, 1)
	s, _ := newService(t, map[string]string{KeyURL(slug): drifted})
	_, err := s.Report(context.Background(), slug)
	he, ok := IsHardError(err)
	if !ok {
		t.Fatalf("err=%v (%T) want a layout HardError", err, err)
	}
	if he.Kind != "layout" {
		t.Errorf("kind=%q want layout", he.Kind)
	}
	if !strings.Contains(he.Detail, "body container") {
		t.Errorf("detail must name the missing structure: %q", he.Detail)
	}
}

// Truncation drift: a page whose article is cut short must trip the measured
// plausibility floor rather than serve a partial body. The container is kept
// whole (so it is found) and everything after its first heading is dropped.
func TestTruncatedBodyTripsTheFloor(t *testing.T) {
	slug := wantSlugs[0]
	raw := fixture(t, "report-walrus.html")
	// Keep the container opening tag + the first heading's COMPLETE subtree
	// (text + closing tag), then close the document. Cutting at the heading's
	// `id="key-takeaways"` attribute would leave an empty <h2></h2> that
	// bodyBlocks drops, which trips the "no blocks" guard instead of the floor
	// this test is about. Exactly one block must survive so the floor decides.
	i := strings.Index(raw, `data-framer-name="ArticleRichText"`)
	closeH := strings.Index(raw[i:], `</h2>`)
	if i < 0 || closeH < 0 {
		t.Fatal("could not locate the article container in the fixture")
	}
	cut := i + closeH + len(`</h2>`)
	drifted := raw[:cut] + `</div></div></div></body></html>`
	s, _ := newService(t, map[string]string{KeyURL(slug): drifted})
	_, err := s.Report(context.Background(), slug)
	he, ok := IsHardError(err)
	if !ok {
		t.Fatalf("err=%v (%T) want a layout HardError", err, err)
	}
	if he.Kind != "layout" {
		t.Errorf("kind=%q want layout", he.Kind)
	}
	if !strings.Contains(he.Detail, "plausibility floor") {
		t.Errorf("detail=%q must name the floor", he.Detail)
	}
}

// Ambiguous dates: two date-shaped bylines are a refusal, not a coin flip.
func TestAmbiguousDateIsLoud(t *testing.T) {
	slug := wantSlugs[0]
	raw := fixture(t, "report-walrus.html")
	// Inject a second date-shaped <p> into the header region (before the body
	// container's first heading).
	i := strings.Index(raw, `<div class="framer-decsvl rt-lightbox"`)
	raw = raw[:i] + `<p class="framer-text">Jan 1, 2020</p>` + raw[i:]
	s, _ := newService(t, map[string]string{KeyURL(slug): raw})
	_, err := s.Report(context.Background(), slug)
	he, ok := IsHardError(err)
	if !ok {
		t.Fatalf("err=%v (%T) want a HardError", err, err)
	}
	if !strings.Contains(he.Detail, "ambiguous") {
		t.Errorf("detail=%q must name the ambiguity", he.Detail)
	}
}

// No date at all is honest null, never a synthesised value from the build
// comment (`<!-- Published Jul 2, 2026 … -->` is identical on every page).
func TestMissingBylineIsHonestNull(t *testing.T) {
	slug := wantSlugs[0]
	raw := fixture(t, "report-walrus.html")
	// Empty the byline paragraph (its text node is the only date-shaped one).
	raw = strings.Replace(raw, `class="framer-text">Jul 2, 2026</p>`, `class="framer-text"></p>`, 1)
	if strings.Contains(raw, ">Jul 2, 2026</p>") {
		t.Skip("byline markup changed; cannot construct the no-date case")
	}
	s, _ := newService(t, map[string]string{KeyURL(slug): raw})
	env, err := s.Report(context.Background(), slug)
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if env.Report.Published != nil || env.Report.PublishedISO != nil {
		t.Errorf("published=%v/%v want null", env.Report.Published, env.Report.PublishedISO)
	}
	if env.Slice == nil || !strings.Contains(*env.Slice, "null") {
		t.Errorf("slice must say the date was absent: %v", env.Slice)
	}
	// The site-build comment is still in the page and must NOT have been used.
	if strings.Contains(raw, "Published Jul 2, 2026") && env.Report.Published != nil {
		t.Errorf("the build-time comment leaked into published")
	}
}

// The build comment is identical on every page, so using it would date every
// report the same -- prove the extractor ignores it even when it is the only
// date-shaped string on the page.
func TestBuildCommentIsNeverUsedAsADate(t *testing.T) {
	slug := wantSlugs[0]
	raw := fixture(t, "report-walrus.html")
	i := strings.Index(raw, `<!-- Published `)
	if i < 0 {
		t.Skip("no build comment in the fixture")
	}
	if !strings.Contains(raw[i:i+80], "2026") {
		t.Skip("build comment does not carry a date")
	}
	// Remove the byline (located by its OWN text, not by the shared
	// `--font-selector:…Ubuntu Sans Regular` prefix, which matches the hero
	// title paragraph first) and leave the build comment: the result must be
	// null.
	const byline = `class="framer-text">Jul 2, 2026</p>`
	if !strings.Contains(raw, byline) {
		t.Skip("byline markup changed")
	}
	raw = strings.Replace(raw, byline, `class="framer-text"></p>`, 1)
	s, _ := newService(t, map[string]string{KeyURL(slug): raw})
	env, err := s.Report(context.Background(), slug)
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if env.Report.Published != nil {
		t.Errorf("published=%v; the build comment must never be used as a report date", *env.Report.Published)
	}
}

// mode=latest: limit slices rows, every served row carries a resolved date, and
// the slice carries the verbatim house label.
func TestLatestResolvesDatesAndHonoursLimit(t *testing.T) {
	s, ff := newService(t, nil)
	env, err := s.List(context.Background(), "latest", 2)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if env.Kind != "latest" || env.Count != 2 || len(env.Rows) != 2 {
		t.Fatalf("count=%d rows=%d", env.Count, len(env.Rows))
	}
	if env.UpstreamTotal == nil || *env.UpstreamTotal != 8 {
		t.Errorf("upstreamTotal=%v want 8", env.UpstreamTotal)
	}
	for i, r := range env.Rows {
		if r.Published == nil || r.PublishedISO == nil {
			t.Errorf("row %d has no resolved date: %+v", i, r)
		}
	}
	if *env.Rows[0].Published != "Jul 2, 2026" || *env.Rows[0].PublishedISO != "2026-07-02" {
		t.Errorf("row0 date=%v/%v", *env.Rows[0].Published, *env.Rows[0].PublishedISO)
	}
	const label = "khala.io publishes research reports only; no news surface exists (/news /rss.xml /feed all 404, measured 2026-09-29) -- latest IS the news surface"
	if env.Slice == nil || !strings.Contains(*env.Slice, label) {
		t.Errorf("slice=%q must carry the verbatim house label", *env.Slice)
	}
	// The dates cost N page fetches: exactly the rows served.
	n := 0
	for _, c := range ff.calls {
		if strings.HasPrefix(c, Base+"/") && !strings.HasSuffix(c, "/sitemap.xml") {
			n++
		}
	}
	// 1 homepage + 2 report pages.
	if n != 3 {
		t.Errorf("upstream fetches=%d want 3 (homepage + 2 report pages)", n)
	}
}

func TestLatestDefaultLimitIsFive(t *testing.T) {
	s, _ := newService(t, nil)
	env, err := s.List(context.Background(), "latest", DefaultLimit)
	if err != nil {
		t.Fatal(err)
	}
	if env.Count != 5 {
		t.Errorf("count=%d want the default 5", env.Count)
	}
}

// A report page with no date leaves THAT row's dates absent (honest), never
// filled from a neighbouring report.
func TestLatestRowWithoutDateStaysEmpty(t *testing.T) {
	noDate := strings.ReplaceAll(fixture(t, "report-walrus.html"),
		`>Jul 2, 2026</p>`, "></p>")
	if strings.Contains(noDate, ">Jul 2, 2026</p>") {
		t.Skip("byline markup changed")
	}
	s, _ := newService(t, map[string]string{KeyURL(wantSlugs[0]): noDate})
	env, err := s.List(context.Background(), "latest", 3)
	if err != nil {
		t.Fatal(err)
	}
	if env.Rows[0].Published != nil {
		t.Errorf("row0 published=%v want nil", *env.Rows[0].Published)
	}
	if env.Rows[1].Published == nil {
		t.Errorf("row1 must still carry its own date")
	}
	raw, err := json.Marshal(env.Rows[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"published"`) {
		t.Errorf("a row with no resolved date must omit the keys: %s", raw)
	}
}

func TestUpstreamURLPerMode(t *testing.T) {
	if got := UpstreamURL("reports", ""); got != HomeURL {
		t.Errorf("reports upstream=%q", got)
	}
	if got := UpstreamURL("latest", ""); got != HomeURL {
		t.Errorf("latest upstream=%q", got)
	}
	if got := UpstreamURL("report", "abc"); got != Base+"/abc" {
		t.Errorf("report upstream=%q", got)
	}
}

func TestReportNotFoundPropagates(t *testing.T) {
	s, _ := newService(t, map[string]string{KeyURL("no-such-report-xyz"): ""})
	_, err := s.Report(context.Background(), "no-such-report-xyz")
	var nf *NotFoundError
	if !errors.As(err, &nf) {
		t.Fatalf("err=%v (%T) want *NotFoundError", err, err)
	}
}
