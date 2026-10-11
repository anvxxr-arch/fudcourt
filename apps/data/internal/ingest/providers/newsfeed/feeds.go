// Package newsfeed is the multi-source news adapter: one config row per
// publisher feed, one generic fetch/parse path for all of them.
//
// WHY A REGISTRY AND NOT A PACKAGE PER SOURCE: the sources differ in their
// URL, their dialect (RSS 2.0 / Atom / JSON Feed) and their cadence — not in
// their extraction mechanism. A new feed is a row in Feeds, never a new
// package. The engine drives one job per row (Dataset "feed", Subject = the
// row's slug), so a feed can be enabled, disabled, scheduled and monitored
// independently without touching this file's neighbours.
//
// EVIDENCE RULE: a row exists only if a real request from this host returned a
// feed. Measured 2026-10-11 (UA `FUDCourtBot/1.0`, HTTP 200 + XML/JSON body):
// 15 of the 16 candidates below; `cryptoslate` answered 403 with a Cloudflare
// `Just a moment...` interstitial and is registered as restricted, NOT dropped
// and NOT pretended to work. No endpoint in this file is inferred from
// documentation.
package newsfeed

import (
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// Format is the feed dialect the transport must speak. It is declared, never
// sniffed at run time: a feed that starts answering a different dialect is a
// registry change (and a test failure), not a silent behaviour change.
type Format string

const (
	FormatRSS      Format = "rss"
	FormatAtom     Format = "atom"
	FormatJSONFeed Format = "jsonfeed"
)

// Status is the adapter lifecycle state of one source. Only StatusActive rows
// are seeded as enabled jobs; every other state is still registered (so the
// admin surface can show WHY a source is not collecting) and is never counted
// as working.
type Status string

const (
	// StatusActive: the feed answered a real request and is collected.
	StatusActive Status = "active"
	// StatusRestricted: reachable host, but access control refuses this
	// client (bot wall / anti-bot interstitial). Not bypassed, ever.
	StatusRestricted Status = "restricted"
	// StatusPendingCredentials: the publisher offers an API that needs an
	// issued key this deployment does not hold.
	StatusPendingCredentials Status = "pending_credentials"
	// StatusUnsupported: no machine-readable feed exists; the publisher
	// only serves HTML.
	StatusUnsupported Status = "unsupported"
)

// Feed is one publisher feed: the version-controlled registry row that a
// data.job row is seeded from.
type Feed struct {
	Slug        string // stable source_id; the job's Subject and the dedup key
	Label       string // human name of the FEED (not of the publisher)
	Homepage    string
	URL         string // the feed endpoint actually requested
	Format      Format
	Category    string // publisher class: news | exchange | regulator | research | security | onchain | protocol
	Country     string // publisher's primary country (ISO 3166-1 alpha-2)
	Language    string // BCP-47 of the feed's own text
	Reliability int    // 1..5, editorial tier (a ranking hint, never a fact claim)
	License     string // reuse terms that apply to the stored fields
	Status      Status
	// StatusDetail carries the measured reason for a non-active status.
	StatusDetail string
	// Schedule is the desired polling cadence for this source.
	Schedule time.Duration
	Priority int // engine dispatch priority (lower runs first)
}

// Feeds is the registry. Ordering is by publisher class, then label.
//
// License values are deliberately conservative: this adapter stores headline,
// summary, link, timestamps and the feed's own categories — the fields an RSS
// feed publishes FOR redistribution. It never stores full article bodies for
// sources whose terms do not grant it.
var Feeds = []Feed{
	// ---- news publishers (measured 200, RSS 2.0 unless noted) ----
	{Slug: "cointelegraph", Label: "Cointelegraph RSS", Homepage: "https://cointelegraph.com", URL: "https://cointelegraph.com/rss", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 3 * time.Minute, Priority: 3},
	{Slug: "cointelegraph-bitcoin", Label: "Cointelegraph Bitcoin tag", Homepage: "https://cointelegraph.com/tags/bitcoin", URL: "https://cointelegraph.com/rss/tag/bitcoin", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 5 * time.Minute, Priority: 5},
	{Slug: "coindesk", Label: "CoinDesk RSS", Homepage: "https://www.coindesk.com", URL: "https://www.coindesk.com/arc/outboundfeeds/rss/", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 5, License: "feed-redistribution", Status: StatusActive, Schedule: 3 * time.Minute, Priority: 3},
	{Slug: "decrypt", Label: "Decrypt RSS", Homepage: "https://decrypt.co", URL: "https://decrypt.co/feed", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 3 * time.Minute, Priority: 4},
	{Slug: "theblock", Label: "The Block RSS", Homepage: "https://www.theblock.co", URL: "https://www.theblock.co/rss.xml", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 5, License: "feed-redistribution", Status: StatusActive, Schedule: 3 * time.Minute, Priority: 3},
	{Slug: "blockworks", Label: "Blockworks Atom feed", Homepage: "https://blockworks.com", URL: "https://blockworks.com/feed", Format: FormatAtom, Category: "news", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 5 * time.Minute, Priority: 4},
	{Slug: "beincrypto", Label: "BeInCrypto RSS", Homepage: "https://beincrypto.com", URL: "https://beincrypto.com/feed/", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 5 * time.Minute, Priority: 5},
	{Slug: "ambcrypto", Label: "AMBCrypto RSS", Homepage: "https://ambcrypto.com", URL: "https://ambcrypto.com/feed/", Format: FormatRSS, Category: "news", Country: "IN", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 5 * time.Minute, Priority: 5},
	{Slug: "thedefiant", Label: "The Defiant RSS", Homepage: "https://thedefiant.io", URL: "https://thedefiant.io/api/feed", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 5 * time.Minute, Priority: 5},
	{Slug: "dlnews", Label: "DL News RSS", Homepage: "https://www.dlnews.com", URL: "https://www.dlnews.com/arc/outboundfeeds/rss/", Format: FormatRSS, Category: "news", Country: "GB", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 5 * time.Minute, Priority: 4},
	{Slug: "protos", Label: "Protos RSS", Homepage: "https://protos.com", URL: "https://protos.com/feed/", Format: FormatRSS, Category: "news", Country: "GB", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 6},
	{Slug: "bitcoinmagazine", Label: "Bitcoin Magazine RSS", Homepage: "https://bitcoinmagazine.com", URL: "https://bitcoinmagazine.com/.rss/full/", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 6},
	{Slug: "cryptopotato", Label: "CryptoPotato RSS", Homepage: "https://cryptopotato.com", URL: "https://cryptopotato.com/feed/", Format: FormatRSS, Category: "news", Country: "CY", Language: "en", Reliability: 2, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 6},
	{Slug: "dailyhodl", Label: "The Daily Hodl RSS", Homepage: "https://dailyhodl.com", URL: "https://dailyhodl.com/feed/", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 2, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 6},
	{Slug: "rekt", Label: "Rekt.news exploits feed", Homepage: "https://rekt.news", URL: "https://rekt.news/rss/feed.xml", Format: FormatRSS, Category: "security", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 5},

	// ---- restricted: registered so the wall is visible, never proxied around ----
	{Slug: "cryptoslate", Label: "CryptoSlate RSS", Homepage: "https://cryptoslate.com", URL: "https://cryptoslate.com/feed/", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusRestricted, StatusDetail: "HTTP 403 + Cloudflare `Just a moment...` interstitial to a non-browser client (measured 2026-10-11); not bypassed", Schedule: 0, Priority: 9},
}

// Lookup resolves a feed by its slug (the job Subject).
func Lookup(slug string) (Feed, bool) {
	for _, f := range Feeds {
		if f.Slug == slug {
			return f, true
		}
	}
	return Feed{}, false
}

// Enabled returns the active feeds: the only ones whose jobs are seeded
// enabled. Restricted / credential-pending / unsupported rows are registered
// and reportable, and are never collected.
func Enabled() []Feed {
	out := make([]Feed, 0, len(Feeds))
	for _, f := range Feeds {
		if f.Status == StatusActive {
			out = append(out, f)
		}
	}
	return out
}

// SourceRows projects the registry into the rows the startup projection writes
// into data.news_source. Only registry membership travels here: per-source
// health is NOT duplicated into that table (it is read from data.job and
// data.ingestion_run for provider "newsfeed", subject = the slug).
func SourceRows() []ingest.SourceRow {
	out := make([]ingest.SourceRow, 0, len(Feeds))
	for _, f := range Feeds {
		out = append(out, ingest.SourceRow{
			Slug:         f.Slug,
			Label:        f.Label,
			Homepage:     f.Homepage,
			FeedURL:      f.URL,
			FeedFormat:   string(f.Format),
			Category:     f.Category,
			Country:      f.Country,
			Language:     f.Language,
			Reliability:  f.Reliability,
			License:      f.License,
			Status:       string(f.Status),
			StatusDetail: f.StatusDetail,
			Enabled:      f.Status == StatusActive,
			PollSeconds:  int(f.Schedule.Seconds()),
		})
	}
	return out
}

// Counts is the registry tally the admin surface reports: registered rows by
// status. It counts the registry, never a claim about collection.
func Counts() map[Status]int {
	m := map[Status]int{}
	for _, f := range Feeds {
		m[f.Status]++
	}
	return m
}
