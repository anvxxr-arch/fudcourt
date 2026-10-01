package khala

import (
	"context"
	"fmt"
	"time"
)

// This file mirrors internal/cryptorank/types.go's tag discipline exactly, because
// that file states the house rule: `undefined` in TS means "absent from
// JSON.stringify" and maps to `omitempty`; `| null` is a present null and must
// NOT be omitted.
//
// The one place khala's fields must be read carefully:
//
//   - KhRow.published / KhRow.publishedISO are `omitempty`, i.e. ABSENT in
//     mode=reports (whose source publishes no dates at all) and present on
//     mode=latest rows. That is deliberately different from a `null`: an absent
//     key says "this mode does not report dates", a null would claim "we looked
//     and found none". Only latest looks.
//   - KhReport.published / publishedISO are also `omitempty`, but they ARE
//     populated (or left nil) by mode=report, which always does the lookup --
//     so a nil there is a real "no byline date found", and the `slice` string
//     says that in words. They are pointers so a present value is a string and
//     an absent one is not the empty string.
//   - KhReport.authors is `*[]KhAuthor`: nil (absent) is impossible here
//     because the field is always set by the shaper -- it is `&[]` (JSON null)
//     when no byline anchor exists, which is what the contract wants (never an
//     invented list, never omitted).

// KhRow is one report row of the list modes (reports, latest).
//
// Position is 1-based and reflects the homepage's newest-first order.
type KhRow struct {
	Position     int     `json:"position"`
	Slug         string  `json:"slug"`
	URL          string  `json:"url"`
	Title        string  `json:"title"`
	Summary      string  `json:"summary"`
	Published    *string `json:"published,omitempty"`
	PublishedISO *string `json:"publishedISO,omitempty"`
}

// KhReport is the payload of mode=report. Nesting it as a pointer field on the
// envelope mirrors CrEnvelope's `Detail *CrCoinDetail` / `Chain *CrChainInfo`.
type KhReport struct {
	Slug         string      `json:"slug"`
	URL          string      `json:"url"`
	Title        string      `json:"title"`
	MetaTitle    string      `json:"metaTitle"`
	Published    *string     `json:"published,omitempty"`
	PublishedISO *string     `json:"publishedISO,omitempty"`
	Authors      *[]KhAuthor `json:"authors"`
	Sections     []KhSection `json:"sections"`
	Body         []KhBlock   `json:"body"`
}

// KhEnvelope is the khala response envelope.
//
// `upstream` is a scalar string, matching CrEnvelope.Upstream. reports/latest
// read a SECOND source (sitemap.xml) to get upstreamTotal, but that source is
// disclosure in `slice`, not a second entry in `upstream`: `upstream` names the
// resource the payload is about (the homepage), and widening it to an array
// would diverge from the cryptorank envelope for no gain.
//
// There is no `derived` field: like CrEnvelope, khala carries provenance in
// `slice` (CrEnvelope.Slice is exactly that field), and every mode here
// populates it.
type KhEnvelope struct {
	Kind          string    `json:"kind"`
	Upstream      string    `json:"upstream"`
	FetchedAt     int64     `json:"fetchedAt"`
	Cache         string    `json:"cache"`
	Count         int       `json:"count"`
	UpstreamTotal *int      `json:"upstreamTotal,omitempty"`
	Slice         *string   `json:"slice,omitempty"`
	MissingSlugs  []string  `json:"missingSlugs,omitempty"`
	Rows          []KhRow   `json:"rows,omitempty"`
	Report        *KhReport `json:"report,omitempty"`
}

// CacheInfoValue renders a CacheInfo the way the wire wants it.
func CacheInfoValue(c CacheInfo) string {
	if c.Cache == "" {
		return "MISS"
	}
	return c.Cache
}

// ListSlice is the provenance sentence for the list modes: it names the row
// source, the auxiliary enumeration behind upstreamTotal, and -- when the
// homepage parse missed sitemap slugs -- says so together with the names.
func ListSlice(homeRows, upstreamTotal int, missing []string) string {
	s := fmt.Sprintf(
		"%d rows in homepage order (newest first); upstreamTotal=%d from the auxiliary %s enumeration",
		homeRows, upstreamTotal, SitemapURL)
	if len(missing) > 0 {
		s += fmt.Sprintf("; homepage parse missed %d sitemap slug(s): %s", len(missing), joinList(missing))
	}
	return s
}

// LatestSlice is the disclosure for mode=latest. The first sentence is the
// VERBATIM house label: khala.io publishes research reports only and has no
// news surface (/news, /rss.xml, /feed are real 404s, measured 2026-09-29), so
// latest names exactly what it is instead of dressing reports up as news.
func LatestSlice(n int, served int, upstreamTotal int) string {
	return fmt.Sprintf(
		"khala.io publishes research reports only; no news surface exists (/news /rss.xml /feed all 404, measured 2026-09-29) -- latest IS the news surface; "+
			"per-row published/publishedISO resolved by fetching %d report page(s) (disk-cached, ETag-revalidated), newest-first; %d of %d upstream report(s) served",
		n, served, upstreamTotal)
}

// ReportsSlice is mode=reports' slice.
func ReportsSlice(upstreamTotal, served int, missing []string) string {
	s := fmt.Sprintf(
		"rows from the homepage %s in newest-first order; upstreamTotal=%d from the auxiliary %s enumeration; %d of %d upstream report(s) served",
		HomeURL, upstreamTotal, SitemapURL, served, upstreamTotal)
	if len(missing) > 0 {
		s += fmt.Sprintf("; homepage parse missed %d sitemap slug(s): %s", len(missing), joinList(missing))
	}
	return s
}

// ReportSlice is mode=report's slice. It names the publishedISO derivation when
// a date was parsed, and says so honestly when none was.
func ReportSlice(slug string, published, iso *string) string {
	switch {
	case published != nil && iso != nil:
		return fmt.Sprintf("publishedISO %q derived from published %q (text byline in the report header, matched by shape not by a style attribute); body flattened from the %q container in document order",
			*iso, *published, bodyAnchorName)
	case published != nil:
		return fmt.Sprintf("published %q was found but publishedISO could not be derived; body flattened from the %q container in document order",
			*published, bodyAnchorName)
	default:
		return fmt.Sprintf("no date-shaped byline matched in the report header, so published/publishedISO are null (never synthesised from the site-build comment); body flattened from the %q container in document order",
			bodyAnchorName)
	}
}

// ListEnvelope builds the reports/latest envelope.
func ListEnvelope(mode, upstream, cache string, fetchedAt int64, upstreamTotal int, slice string, rows []KhRow, missing []string) KhEnvelope {
	n := upstreamTotal
	return KhEnvelope{
		Kind:          mode,
		Upstream:      upstream,
		FetchedAt:     fetchedAt,
		Cache:         cache,
		Count:         len(rows),
		UpstreamTotal: &n,
		Slice:         &slice,
		MissingSlugs:  missing,
		Rows:          rows,
	}
}

// ReportEnvelope builds the report envelope.
func ReportEnvelope(upstream, cache string, fetchedAt int64, slice string, r *KhReport) KhEnvelope {
	// upstreamTotal is omitted for a single report: there is no total to state.
	return KhEnvelope{
		Kind:      "report",
		Upstream:  upstream,
		FetchedAt: fetchedAt,
		Cache:     cache,
		Count:     1,
		Slice:     &slice,
		Report:    r,
	}
}

// BuildReport maps a parsed page onto the wire report object. The title/summary
// come from the page's own <title>/og:title, not from the homepage card: the
// two can disagree after a republish and the page is the authority here.
func BuildReport(slug string, p *ParsedReport) *KhReport {
	authors := p.Authors
	if authors == nil {
		authors = []KhAuthor{}
	}
	sections := p.Sections
	if sections == nil {
		sections = []KhSection{}
	}
	body := p.Body
	if body == nil {
		body = []KhBlock{}
	}
	return &KhReport{
		Slug:         slug,
		URL:          KeyURL(slug),
		Title:        p.Title,
		MetaTitle:    p.MetaTitle,
		Published:    p.Published,
		PublishedISO: p.PublishedISO,
		Authors:      &authors,
		Sections:     sections,
		Body:         body,
	}
}

// ---- Service: fetch -> parse -> shape --------------------------------------
//
// The orchestrator lives in this file rather than in a fifth file because the
// package's four files are the reading aid agreed in the package doc; adding a
// service.go would make the file count a second, competing convention for no
// benefit. Everything here is envelope assembly over the fetch/parse layers.

// BodyFetcher is the slice of *Fetcher the Service needs; an interface so the
// HTTP layer can inject a fake (the wire contract is provable without network).
type BodyFetcher interface {
	Fetch(ctx context.Context, url string, ttl int) (string, CacheInfo, error)
}

// Service ties a fetcher to the mode semantics. TTL is the per-request cache
// TTL in seconds (0 for ?fresh=1), never shared mutable state.
type Service struct {
	F   BodyFetcher
	TTL int
}

// List builds the reports/latest envelope.
//
// rows come from the homepage (newest-first, every report card is in the raw
// HTML); upstreamTotal comes from the AUXILIARY sitemap.xml, never from the
// homepage count, so the two enumerations can disagree visibly via
// slice/missingSlugs instead of being averaged into one number.
//
// limit > 0 is only used by mode=latest; mode=reports serves every row.
func (s *Service) List(ctx context.Context, mode string, limit int) (KhEnvelope, error) {
	home, info, err := s.F.Fetch(ctx, HomeURL, s.TTL)
	if err != nil {
		return KhEnvelope{}, err
	}
	cards, err := ParseHome(home)
	if err != nil {
		// An empty/failed row set is loud: never count:0.
		return KhEnvelope{}, &HardError{Kind: "layout", Detail: err.Error(), URL: HomeURL}
	}
	sm, _, err := s.F.Fetch(ctx, SitemapURL, s.TTL)
	if err != nil {
		return KhEnvelope{}, err
	}
	sitemapSlugs, err := ParseSitemap(sm)
	if err != nil {
		return KhEnvelope{}, &HardError{Kind: "layout", Detail: err.Error(), URL: SitemapURL}
	}
	missing := missingSlugs(sitemapSlugs, cards)
	if mode == "latest" && limit < 1 {
		limit = DefaultLimit
	}
	rows := make([]KhRow, 0, len(cards))
	for i, c := range cards {
		if mode == "latest" && i >= limit {
			break
		}
		rows = append(rows, KhRow{
			Position: i + 1,
			Slug:     c.Slug,
			URL:      KeyURL(c.Slug),
			Title:    c.Title,
			Summary:  c.Summary,
		})
	}
	if mode == "latest" {
		if err := s.resolveDates(ctx, rows); err != nil {
			return KhEnvelope{}, err
		}
	}
	slice := ReportsSlice(len(sitemapSlugs), len(rows), missing)
	if mode == "latest" {
		slice = LatestSlice(len(rows), len(rows), len(sitemapSlugs))
	}
	return ListEnvelope(mode, HomeURL, CacheInfoValue(info), info.FetchedAt, len(sitemapSlugs), slice, rows, missing), nil
}

// Report builds the single-report envelope.
func (s *Service) Report(ctx context.Context, key string) (KhEnvelope, error) {
	url := KeyURL(key)
	body, info, err := s.F.Fetch(ctx, url, s.TTL)
	if err != nil {
		return KhEnvelope{}, err
	}
	p, err := ParseReport(body)
	if err != nil {
		if he, ok := IsHardError(err); ok {
			he.URL = url
			return KhEnvelope{}, he
		}
		return KhEnvelope{}, err
	}
	slice := ReportSlice(key, p.Published, p.PublishedISO)
	return ReportEnvelope(url, CacheInfoValue(info), info.FetchedAt, slice, BuildReport(key, p)), nil
}

// resolveDates fills published/publishedISO on latest's rows by fetching each
// report page (disk-cached and ETag-revalidated, so a repeat is cheap) and
// running the same byline extractor mode=report uses.
//
// A page that parses but carries no date-shaped byline leaves the row's date
// fields nil -- honest absence, never another report's date. A page that fails
// to fetch or fails the layout floor is a loud error for the whole request: a
// transport failure is not "no date", and silently nulling it would make the
// two cases indistinguishable to the consumer.
func (s *Service) resolveDates(ctx context.Context, rows []KhRow) error {
	for i := range rows {
		body, _, err := s.F.Fetch(ctx, rows[i].URL, s.TTL)
		if err != nil {
			return err
		}
		p, err := ParseReport(body)
		if err != nil {
			if he, ok := IsHardError(err); ok {
				he.URL = rows[i].URL
				return he
			}
			return err
		}
		rows[i].Published = p.Published
		rows[i].PublishedISO = p.PublishedISO
	}
	return nil
}

// missingSlugs lists sitemap slugs the homepage parse did not produce, in
// sitemap order. Non-empty means the payload must say so (slice + missingSlugs);
// rows are never padded or fabricated to close the gap.
func missingSlugs(sitemapSlugs []string, cards []khCard) []string {
	have := make(map[string]bool, len(cards))
	for _, c := range cards {
		have[c.Slug] = true
	}
	var out []string
	for _, s := range sitemapSlugs {
		if !have[s] {
			out = append(out, s)
		}
	}
	return out
}

// Now is the injected clock (tests pin fetchedAt).
var Now = func() int64 { return time.Now().Unix() }

func joinList(ss []string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += ", "
		}
		out += s
	}
	return out
}
