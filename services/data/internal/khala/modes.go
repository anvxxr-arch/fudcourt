// Package khala is the khala.io research-report family: the mode table, the
// plain-net/http fetcher, the HTML extractor and the JSON envelope.
//
// # Why ONE package per family (as internal/cryptorank now also is)
//
// That split mirrors three separate upstream artifacts: cr_fetch.py (a Python
// helper), lib/shapers.ts (TS shapers) and lib/cryptorank.ts (a TS mode table).
// Each file is a port of a distinct artifact and can drift from its own
// artifact independently. khala has ONE artifact -- a Framer-hosted static
// site -- and three modes over two source URLs, so a 3-way split would be
// ceremony: there is no second implementation to stay compatible with, and no
// independent oracle to keep the pieces apart for. The four files here
// (modes/fetch/parse/shape) are a reading aid, not a compatibility boundary.
//
// # Why plain net/http (measured 2026-09-29, /home/dwizzy/khala-probe)
//
// www.khala.io is Framer-hosted and answers a non-browser User-Agent with a
// real 200: `curl -A 'fudcourt/1.0' https://www.khala.io/` -> 200 259008 bytes
// text/html; a report page -> 200 429159-468140 bytes; the framerusercontent
// JSON -> 200. No 403, no `cf-mitigated: challenge`, no interstitial, no
// Cloudflare anywhere (framerusercontent.com is CloudFront). So the
// tls-client/chrome_131 stack internal/cryptorank needs is deliberately NOT used here: it
// would buy nothing and cost a browser-fingerprint dependency. Do not "fix"
// this into the expensive stack -- there is nothing to defeat.
//
// # Modes
//
//	reports  list, newest-first, NO dates (the list source publishes none)
//	report   one report by key=<slug>
//	latest   the newest N reports WITH per-report dates resolved (the news surface)
//
// khala.io publishes research reports only: /news, /blog, /posts, /rss.xml,
// /feed, /feed.xml, /atom.xml, /newsletter and /subscribe are ALL real 404s
// (measured). There is no news feed, so `latest` names exactly what it is
// instead of dressing reports up as news -- see shape.go's latestSlice.
package khala

import (
	"regexp"
	"strconv"
)

const (
	// Base is the site origin. Both the homepage (rows) and every report page
	// live here.
	Base = "https://www.khala.io"
	// HomeURL is the row source for reports/latest AND the canonical
	// `upstream` for those modes. homepage order is newest-first and the raw
	// HTML carries every report card even though the page shows six behind a
	// client-side "Load More".
	HomeURL = Base + "/"
	// SitemapURL is the AUXILIARY enumeration source: 11 <loc> entries
	// (/, /about, /disclaimer + the 8 reports), 1084 bytes. It is what
	// `upstreamTotal` is derived from, independently of the homepage parse.
	// It is named in `slice`, not in `upstream` (upstream stays the scalar
	// homepage URL, matching CrEnvelope's scalar `Upstream`).
	SitemapURL = Base + "/sitemap.xml"
)

// Modes is the khala mode table in declaration order. The array ships verbatim
// in the 400 unknown-mode body, so the order is part of the contract.
var Modes = []string{"reports", "report", "latest"}

// ModeCount is the number of modes (healthz prints it).
var ModeCount = len(Modes)

var known = func() map[string]bool {
	m := make(map[string]bool, len(Modes))
	for _, s := range Modes {
		m[s] = true
	}
	return m
}()

// Known reports whether mode is in the table.
func Known(mode string) bool { return known[mode] }

// KeyRe is the report-slug regex.
//
// It is NOT cryptorank.KeyRe: that one caps at 64 chars and would reject real
// khala slugs. Measured slug lengths from sitemap.xml (2026-09-29):
//
//	walrus-solving-the-ai-agent-context-memory-bottleneck-verifiable-onchain-portable-programmable  94  <- observed maximum
//	surf-data-platform-onchain-social-prediction-crypto-ai-agent-intelligence                       76
//	x402-completing-the-internets-missing-payment-layer-for-agentic-commerce                        70
//	xmaquina-onchain-market-pre-ipo-robotics-equity-spv-subdao-deus                                 64
//	bittensor-an-investment-history-from-genesis-to-dtao-tao-flow                                   61
//	openclaw-ecosystem-autonomous-software-factory                                                  46
//	bittensor-the-intelligence-olympics                                                             35
//	decentralized-robotics-landscape                                                                31
//
// Any cap below 94 400s the newest report (walrus), so the bound is 128 total
// characters. An 80-char cap would be wrong for exactly that reason.
var KeyRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,127}$`)

// ValidKey reports whether s is an acceptable report slug.
func ValidKey(s string) bool { return KeyRe.MatchString(s) }

const (
	// LimitMin/LimitMax bound mode=latest's limit. Never clamped: an
	// out-of-range value is a 400 naming the raw string.
	LimitMin = 1
	LimitMax = 50
	// DefaultLimit is mode=latest's limit when absent.
	DefaultLimit = 5
)

// Param names. `key` is the report slug (mode=report only); v1 of this family
// called it `slug`, v4 renamed it to `key`, and `slug` is now simply not a
// khala param (it is refused by the scoping rule, never silently ignored).
const (
	ParamMode  = "mode"
	ParamKey   = "key"
	ParamLimit = "limit"
	ParamFresh = "fresh"
)

// accepts is the param scoping matrix: which query params a mode accepts.
// `fresh` is accepted everywhere (it is request policy, not mode data).
var accepts = map[string]map[string]bool{
	"reports": {ParamMode: true, ParamFresh: true},
	"report":  {ParamMode: true, ParamKey: true, ParamFresh: true},
	"latest":  {ParamMode: true, ParamLimit: true, ParamFresh: true},
}

// Accepts reports whether mode accepts the query param p. An unknown param (or
// a known param sent to the wrong mode) is a 400 unexpected-param, never
// silently ignored.
func Accepts(mode, p string) bool { return accepts[mode][p] }

// UpstreamMissingKey is the 404 text for a slug upstream does not have. A
// nonexistent khala slug is a REAL upstream 404 (7384 bytes,
// `<title>Page Not Found | Framer</title>`), never a fabricated 200.
const UpstreamMissingKey = "upstream 404: no such report"

// Error strings that are part of the wire contract (the tests assert them
// verbatim).
const (
	ErrUnknownMode  = "unknown mode"
	ErrInvalidKey   = "invalid key"
	ErrInvalidLimit = "invalid limit"
	ErrMissingParam = "missing param"
	ErrUnexpected   = "unexpected param"

	DetailKeyRequired  = "key is required for mode=report (no default exists)"
	DetailKeyInvalid   = "key must match ^[a-z0-9][a-z0-9-]{0,127}$ (never clamped)"
	DetailLimitInvalid = "limit must be an integer 1..50 (never clamped)"
)

// UnexpectedParamDetail is the detail for a param a mode does not accept.
func UnexpectedParamDetail(param, mode string) string {
	return param + " is not valid for mode=" + mode
}

// KeyURL is the canonical report URL for a slug.
func KeyURL(key string) string { return Base + "/" + key }

// UpstreamURL is the canonical upstream URL of a mode: the homepage for the
// list-shaped modes (which is what they read rows from), the report page for
// mode=report. It feeds the envelope's `upstream` and the X-KH-Upstream header.
func UpstreamURL(mode, key string) string {
	if mode == "report" {
		return KeyURL(key)
	}
	return HomeURL
}

// ParseLimit validates a raw limit for mode=latest. It is strict and never
// clamps: "abc", "", "0", "-1", "51" and "1.5" are all invalid; only a plain
// base-10 integer 1..50 is accepted. The bool result says whether the parse
// succeeded; the handler echoes the raw string in the 400 body.
func ParseLimit(raw string) (int, bool) {
	// digits only: a sign, a space, "1.5" or "1e2" are all invalid, and an
	// explicit sign must not be accepted the way strconv.Atoi would.
	if raw == "" {
		return 0, false
	}
	for i := range len(raw) {
		if raw[i] < '0' || raw[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < LimitMin || n > LimitMax {
		return 0, false
	}
	return n, true
}
