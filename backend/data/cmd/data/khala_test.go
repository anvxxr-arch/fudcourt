// Wire-contract tests for the khala family (PLAN G8 / DR-006).
//
// They are OFFLINE and deterministic: the fake khala body fetcher serves the
// six recorded fixtures in internal/research/khala/testdata, so the whole handler --
// param scoping, refusals, headers, envelope -- is provable without touching
// khala.io. The live oracle run belongs to scripts/verify-khala.py.
package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/chainrank"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/coinank"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/coinglass"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/coinmarketcap"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/khala"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/llama"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/news"
)

const (
	khHomeURL    = "https://www.khala.io/"
	khSitemapURL = "https://www.khala.io/sitemap.xml"
	// khLongestSlug is the measured maximum (94 chars). The key regex must
	// accept it -- an 80- or 64-char cap would 400 the flagship report.
	khLongestSlug = "walrus-solving-the-ai-agent-context-memory-bottleneck-verifiable-onchain-portable-programmable"
)

func khFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "internal", "research", "khala", "testdata", name))
	if err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return string(b)
}

// khFetcher serves the recorded fixtures by URL so a test never touches network.
type khFetcher struct {
	t *testing.T
	// urls records every URL fetched, so cache/fresh behaviour is observable.
	urls []string
	ttls []int
	// fail, when set, is returned instead of a body (error-path tests).
	fail error
}

func (f *khFetcher) Fetch(_ context.Context, url string, ttl int) (string, khala.CacheInfo, error) {
	f.urls = append(f.urls, url)
	f.ttls = append(f.ttls, ttl)
	if f.fail != nil {
		return "", khala.CacheInfo{}, f.fail
	}
	switch {
	case url == khHomeURL:
		return khFixture(f.t, "home.html"), khala.CacheInfo{Status: 200, Cache: "HIT", FetchedAt: 1790000000}, nil
	case url == khSitemapURL:
		return khFixture(f.t, "sitemap.xml"), khala.CacheInfo{Status: 200, Cache: "HIT", FetchedAt: 1790000000}, nil
	case strings.Contains(url, "no-such-report"):
		return "", khala.CacheInfo{}, &khala.NotFoundError{URL: url, Status: 404}
	case strings.Contains(url, "bittensor-the-intelligence-olympics"):
		return khFixture(f.t, "report-bittensor.html"), khala.CacheInfo{Status: 200, Cache: "HIT", FetchedAt: 1790000000}, nil
	case strings.Contains(url, khLongestSlug):
		return khFixture(f.t, "report-walrus.html"), khala.CacheInfo{Status: 200, Cache: "HIT", FetchedAt: 1790000000}, nil
	default:
		// latest fans out over every row; the fixtures only carry two reports.
		// Re-serving the bittensor page keeps the rows' dates resolvable while
		// staying offline and deterministic.
		return khFixture(f.t, "report-bittensor.html"), khala.CacheInfo{Status: 200, Cache: "HIT", FetchedAt: 1790000000}, nil
	}
}

func khGet(t *testing.T, f *khFetcher, url string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	srv := newServer(&fakeFetcher{}, 60, khala.Service{F: f, TTL: khala.TTLDefault()}, llama.Service{}, news.Service{}, chainrank.Service{}, coinglass.Service{}, coinank.Service{}, coinmarketcap.Service{})
	srv.retryBase = 0
	srv.mux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec
}

func TestKhalaHealthzReportsBothFamilies(t *testing.T) {
	rec := khGet(t, &khFetcher{t: t}, "/healthz")
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	body := decode(t, rec)
	if body["build"] != "28 modes" {
		t.Errorf("build=%v", body["build"])
	}
	if body["khala"] != "3 modes" {
		t.Errorf("khala=%v", body["khala"])
	}
}

func TestKhalaUnknownModeIs400WithNullGot(t *testing.T) {
	// mode absent or empty -> `got` is JS null; mode present-but-unknown ->
	// `got` echoes the raw string. Never "".
	for _, url := range []string{"/api/khala", "/api/khala?mode="} {
		rec := khGet(t, &khFetcher{t: t}, url)
		if rec.Code != 400 {
			t.Fatalf("%s: status %d", url, rec.Code)
		}
		body := decode(t, rec)
		if body["error"] != "unknown mode" {
			t.Errorf("%s: error=%v", url, body["error"])
		}
		modes, ok := body["modes"].([]interface{})
		if !ok || len(modes) != 3 || modes[0] != "reports" || modes[2] != "latest" {
			t.Errorf("%s: modes=%v", url, body["modes"])
		}
		if got, present := body["got"]; !present || got != nil {
			t.Errorf("%s: got=%v (present=%v)", url, got, present)
		}
	}
	rec := khGet(t, &khFetcher{t: t}, "/api/khala?mode=lolnope")
	if rec.Code != 400 {
		t.Fatalf("status %d", rec.Code)
	}
	if got := decode(t, rec)["got"]; got != "lolnope" {
		t.Errorf("present-but-unknown got=%v", got)
	}
}

func TestKhalaParamScopingIsStrict(t *testing.T) {
	// key is only valid for report; limit only for latest; a bogus name is
	// always refused. Never silently ignored.
	cases := []string{
		"/api/khala?mode=reports&key=x",
		"/api/khala?mode=reports&limit=3",
		"/api/khala?mode=latest&key=x",
		"/api/khala?mode=report&key=bittensor-the-intelligence-olympics&limit=3",
		"/api/khala?mode=reports&slug=x",
	}
	for _, url := range cases {
		rec := khGet(t, &khFetcher{t: t}, url)
		if rec.Code != 400 {
			t.Fatalf("%s: status %d body=%s", url, rec.Code, rec.Body.String())
		}
		if got := decode(t, rec)["error"]; got != "unexpected param" {
			t.Errorf("%s: error=%v", url, got)
		}
	}
}

func TestKhalaReportRequiresAndValidatesKey(t *testing.T) {
	rec := khGet(t, &khFetcher{t: t}, "/api/khala?mode=report")
	if rec.Code != 400 || decode(t, rec)["error"] != "missing param" {
		t.Fatalf("missing key: %d %s", rec.Code, rec.Body.String())
	}
	for _, bad := range []string{"UPPER", "-leading-dash", "has%20space", strings.Repeat("a", 129)} {
		rec = khGet(t, &khFetcher{t: t}, "/api/khala?mode=report&key="+bad)
		if rec.Code != 400 || decode(t, rec)["error"] != "invalid key" {
			t.Errorf("key=%q: %d %s", bad, rec.Code, rec.Body.String())
		}
	}
	// The measured longest real slug MUST pass the regex: a smaller cap would
	// 400 the flagship report (DESIGN D11).
	if !khala.ValidKey(khLongestSlug) {
		t.Fatalf("longest real slug (%d chars) rejected by KeyRe", len(khLongestSlug))
	}
	if len(khLongestSlug) < 80 {
		t.Fatalf("the cap-shrink guard needs a >80-char slug, got %d", len(khLongestSlug))
	}
}

func TestKhalaLimitIsStrictAndNeverClamped(t *testing.T) {
	for _, raw := range []string{"abc", "0", "-1", "51", "1.5", "1e2", " 3", "3 "} {
		rec := khGet(t, &khFetcher{t: t}, "/api/khala?mode=latest&limit="+url.QueryEscape(raw))
		if rec.Code != 400 {
			t.Errorf("limit=%q: status %d (want 400)", raw, rec.Code)
			continue
		}
		body := decode(t, rec)
		if body["error"] != "invalid limit" || body["limit"] != raw {
			t.Errorf("limit=%q: body=%v", raw, body)
		}
	}
	// 1 and 50 are the inclusive bounds.
	for _, raw := range []string{"1", "50"} {
		if rec := khGet(t, &khFetcher{t: t}, "/api/khala?mode=latest&limit="+raw); rec.Code != 200 {
			t.Errorf("limit=%q: status %d", raw, rec.Code)
		}
	}
}

func TestKhalaReportsEnvelopeHidesDates(t *testing.T) {
	f := &khFetcher{t: t}
	rec := khGet(t, f, "/api/khala?mode=reports")
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	if body["kind"] != "reports" {
		t.Errorf("kind=%v", body["kind"])
	}
	if body["upstream"] != khHomeURL {
		t.Errorf("upstream=%v", body["upstream"])
	}
	if body["upstreamTotal"] != float64(8) {
		t.Errorf("upstreamTotal=%v want 8 (from sitemap, never the homepage count)", body["upstreamTotal"])
	}
	rows, ok := body["rows"].([]interface{})
	if !ok || len(rows) != 8 {
		t.Fatalf("rows=%v", body["rows"])
	}
	for i, r := range rows {
		row := r.(map[string]interface{})
		// D4: reports carries NO date keys at all -- absent, not null.
		for _, k := range []string{"published", "publishedISO"} {
			if _, present := row[k]; present {
				t.Errorf("rows[%d].%s must be ABSENT in reports mode", i, k)
			}
		}
		if row["position"] != float64(i+1) {
			t.Errorf("rows[%d].position=%v", i, row["position"])
		}
	}
	// The homepage (8 cards) and the sitemap (8 reports) agree -> no missingSlugs.
	if _, present := body["missingSlugs"]; present {
		t.Errorf("missingSlugs must be absent when both surfaces agree: %v", body["missingSlugs"])
	}
	if s, ok := body["slice"].(string); !ok || !strings.Contains(s, "sitemap.xml") {
		t.Errorf("slice must name the auxiliary enumeration: %v", body["slice"])
	}
}

func TestKhalaLatestResolvesDates(t *testing.T) {
	rec := khGet(t, &khFetcher{t: t}, "/api/khala?mode=latest&limit=2")
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	rows := body["rows"].([]interface{})
	if len(rows) != 2 {
		t.Fatalf("rows=%d want 2", len(rows))
	}
	first := rows[0].(map[string]interface{})
	if first["published"] == nil || first["publishedISO"] == nil {
		t.Errorf("latest rows must carry dates: %v", first)
	}
	// The no-news-surface disclosure is verbatim contract (DESIGN D3).
	slice := body["slice"].(string)
	if !strings.Contains(slice, "no news surface exists") || !strings.Contains(slice, "latest IS the news surface") {
		t.Errorf("slice missing the verbatim disclosure: %q", slice)
	}
}

func TestKhalaReportBodyIsStructuredBlocks(t *testing.T) {
	rec := khGet(t, &khFetcher{t: t}, "/api/khala?mode=report&key=bittensor-the-intelligence-olympics")
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	rep, ok := body["report"].(map[string]interface{})
	if !ok {
		t.Fatalf("report=%v", body["report"])
	}
	blocks, ok := rep["body"].([]interface{})
	if !ok || len(blocks) < 20 {
		t.Fatalf("body blocks=%d (want a real report)", len(blocks))
	}
	for i, b := range blocks {
		blk := b.(map[string]interface{})
		switch blk["type"] {
		case "h2", "h3", "h4", "p", "li":
		default:
			t.Fatalf("block %d has type %v", i, blk["type"])
		}
		if _, bad := blk["html"]; bad {
			t.Fatalf("block %d ships html -- the family ships no markup (D7)", i)
		}
	}
	// published is a PRESENT key holding null or a string -- never absent.
	if _, present := rep["published"]; !present {
		t.Errorf("report.published must be present (null when not found)")
	}
	// authors is always present. The landed extractor reads the byline region's
	// x.com anchors into {name,url} pairs (the bittensor page has four), so the
	// value is an array -- empty, never omitted, and never invented when the
	// page carries no byline anchor.
	authors, present := rep["authors"]
	if !present {
		t.Fatalf("report.authors must be present")
	}
	list, ok := authors.([]interface{})
	if !ok {
		t.Fatalf("authors=%v want an array", authors)
	}
	for i, a := range list {
		au, ok := a.(map[string]interface{})
		if !ok {
			t.Fatalf("authors[%d]=%v", i, a)
		}
		name, _ := au["name"].(string)
		link, _ := au["url"].(string)
		if strings.TrimSpace(name) == "" || !strings.HasPrefix(link, "https://x.com/") {
			t.Errorf("authors[%d] not a real byline anchor: %v", i, au)
		}
	}
	_ = khala.KhAuthor{}
	bodyJSON := rec.Body.String()
	if strings.Contains(bodyJSON, "<p class=\"framer-text") || strings.Contains(bodyJSON, "<div") {
		t.Errorf("upstream HTML leaked into the payload")
	}
}

func TestKhalaUpstreamMissIs404(t *testing.T) {
	rec := khGet(t, &khFetcher{t: t}, "/api/khala?mode=report&key=no-such-report-xyz")
	if rec.Code != 404 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	if body["error"] != "upstream 404: no such report" || body["upstreamStatus"] != float64(404) {
		t.Errorf("body=%v", body)
	}
	if body["kind"] != "report" {
		t.Errorf("kind=%v", body["kind"])
	}
}

func TestKhalaHardErrorIsAlarmable502(t *testing.T) {
	f := &khFetcher{t: t, fail: &khala.HardError{Kind: "layout", Status: 200, Detail: "report body is 12 chars, below the 4000-char plausibility floor"}}
	rec := khGet(t, f, "/api/khala?mode=reports")
	if rec.Code != 502 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	if !strings.Contains(body["error"].(string), "plausibility floor") {
		t.Errorf("error=%v", body["error"])
	}
	if body["upstreamStatus"] != float64(200) {
		t.Errorf("upstreamStatus=%v", body["upstreamStatus"])
	}
}

func TestKhalaTransportErrorIs502WithRealText(t *testing.T) {
	f := &khFetcher{t: t, fail: &khala.HardError{Kind: "transport", Detail: "fetch failed: dial tcp: i/o timeout"}}
	rec := khGet(t, f, "/api/khala?mode=reports")
	if rec.Code != 502 {
		t.Fatalf("status %d", rec.Code)
	}
	body := decode(t, rec)
	if !strings.Contains(body["error"].(string), "i/o timeout") {
		t.Errorf("error=%v", body["error"])
	}
	if body["upstreamStatus"] != nil {
		t.Errorf("transport failure has no upstream status, got %v", body["upstreamStatus"])
	}
}

func TestKhalaHeadersMatchBody(t *testing.T) {
	rec := khGet(t, &khFetcher{t: t}, "/api/khala?mode=report&key=bittensor-the-intelligence-olympics")
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	want := "https://www.khala.io/bittensor-the-intelligence-olympics"
	if got := rec.Header().Get("X-KH-Upstream"); got != want {
		t.Errorf("X-KH-Upstream=%q want %q", got, want)
	}
	if got := rec.Header().Get("X-KH-Cache"); got != "HIT" {
		t.Errorf("X-KH-Cache=%q", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=30" {
		t.Errorf("Cache-Control=%q", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type=%q", got)
	}
	if body := decode(t, rec); body["upstream"] != rec.Header().Get("X-KH-Upstream") {
		t.Errorf("body upstream %v != header %q", body["upstream"], rec.Header().Get("X-KH-Upstream"))
	}
}

func TestKhalaFreshPassesTTLZeroPerRequest(t *testing.T) {
	f := &khFetcher{t: t}
	if rec := khGet(t, f, "/api/khala?mode=reports"); rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if rec := khGet(t, f, "/api/khala?mode=reports&fresh=1"); rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	// first call: homepage + sitemap at the default TTL; second at 0.
	got := make([]int, 0, len(f.ttls))
	for _, v := range f.ttls {
		got = append(got, v)
	}
	if len(got) != 4 {
		t.Fatalf("ttls=%v want 4 entries", got)
	}
	if got[0] != khala.TTLDefault() || got[1] != khala.TTLDefault() {
		t.Errorf("ordinary request ttls=%v", got[:2])
	}
	if got[2] != 0 || got[3] != 0 {
		t.Errorf("fresh=1 ttls=%v", got[2:])
	}
}

func TestKhalaMethodNotAllowed(t *testing.T) {
	rec := httptest.NewRecorder()
	srv := newServer(&fakeFetcher{}, 60, khala.Service{F: &khFetcher{t: t}}, llama.Service{}, news.Service{}, chainrank.Service{}, coinglass.Service{}, coinank.Service{}, coinmarketcap.Service{})
	srv.mux().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/khala?mode=reports", nil))
	if rec.Code != 405 {
		t.Fatalf("status %d", rec.Code)
	}
	if decode(t, rec)["error"] != "method not allowed" {
		t.Errorf("body=%s", rec.Body.String())
	}
}
