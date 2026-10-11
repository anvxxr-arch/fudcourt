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
// EVIDENCE RULE: a row exists only if a real request to this host returned a
// document the shared parser accepts. Measured 2026-10-11 (UA `FUDCourtBot/1.0`,
// HTTP 200 + XML/JSON body) against a 158-entry publisher inventory: 151 unique
// hosts, of which 57 answered with a parsable feed (1,854 items in that sweep)
// and 94 answered no feed on any common path nor any <link rel="alternate">
// advertisement -- those are registered as unsupported in the coverage matrix
// (docs/architecture/news-ingestion.md), never invented here. `cryptoslate`
// answered 403 with a Cloudflare `Just a moment...` interstitial and stays
// restricted: NOT dropped, NOT proxied around, NOT pretended to work.
//
// The sweep is also a test: it is how the missing-BOM defect in ParseFeed was
// found (federalreserve.gov/feeds/press_all.xml opens with EF BB BF).
//
// No endpoint in this file is inferred from documentation or from a pattern that
// merely looks right -- including this file's own history: the first sweep
// guessed `blockworks.co/feed`, the site answered 308, and the fix was to
// correct the row rather than to weaken the same-host redirect guard.
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
	// StatusRestricted: reachable host, but the publisher refuses this client
	// -- a bot wall / anti-bot interstitial, or its own robots.txt directive
	// covering the feed path. Not bypassed, EVER: a restricted row keeps its
	// URL and its measured reason so the wall stays visible, and stops
	// collecting (Enabled() excludes it).
	StatusRestricted Status = "restricted"
	// StatusPendingCredentials: the publisher offers an API that needs an
	// issued key this deployment does not hold.
	StatusPendingCredentials Status = "pending_credentials"
	// StatusUnsupported: no machine-readable feed at the registered address --
	// the publisher serves HTML only, offers nothing at any path tried, or the
	// path now resolves to a different publisher (both are measurements, and
	// StatusDetail carries which one).
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
	Category    string // publisher class: news | aggregator | data | regulator | exchange | market | security | research | protocol
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
	{Slug: "ambcrypto", Label: "AMBCrypto RSS", Homepage: "https://ambcrypto.com", URL: "https://ambcrypto.com/feed/", Format: FormatRSS, Category: "news", Country: "IN", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusRestricted, StatusDetail: "ambcrypto.com/robots.txt is `User-agent: *` + `Disallow: /feed/` -- the publisher's own directive covers the feed path, so this row stops collecting (measured 2026-10-11). The sitemap it advertises instead (sitemap_index.xml) is the permitted route; not implemented", Schedule: 0, Priority: 9},
	{Slug: "thedefiant", Label: "The Defiant JSON feed", Homepage: "https://thedefiant.io", URL: "https://thedefiant.io/api/feed", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusRestricted, StatusDetail: "thedefiant.io/robots.txt is `User-Agent: *` + `Disallow: /api/*` -- the feed sits on a disallowed path, so this row stops collecting (measured 2026-10-11). The sitemap it advertises instead (sitemap/news.xml) is the permitted route; not implemented", Schedule: 0, Priority: 9},
	{Slug: "dlnews", Label: "DL News RSS", Homepage: "https://www.dlnews.com", URL: "https://www.dlnews.com/arc/outboundfeeds/rss/", Format: FormatRSS, Category: "news", Country: "GB", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 5 * time.Minute, Priority: 4},
	{Slug: "protos", Label: "Protos RSS", Homepage: "https://protos.com", URL: "https://protos.com/feed/", Format: FormatRSS, Category: "news", Country: "GB", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 6},
	{Slug: "bitcoinmagazine", Label: "Bitcoin Magazine RSS", Homepage: "https://bitcoinmagazine.com", URL: "https://bitcoinmagazine.com/.rss/full/", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 6},
	{Slug: "cryptopotato", Label: "CryptoPotato RSS", Homepage: "https://cryptopotato.com", URL: "https://cryptopotato.com/feed/", Format: FormatRSS, Category: "news", Country: "CY", Language: "en", Reliability: 2, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 6},
	{Slug: "dailyhodl", Label: "The Daily Hodl RSS", Homepage: "https://dailyhodl.com", URL: "https://dailyhodl.com/feed/", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 2, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 6},
	{Slug: "rekt", Label: "Rekt.news exploits feed", Homepage: "https://rekt.news", URL: "https://rekt.news/rss/feed.xml", Format: FormatRSS, Category: "security", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 5},

	// ---- news publishers, second sweep (measured 2026-10-11: 200 + a parsable feed) ----
	{Slug: "bankless", Label: "Bankless RSS", Homepage: "https://bankless.com", URL: "https://bankless.com/feed", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 4},
	{Slug: "bitcoinist", Label: "Bitcoinist RSS", Homepage: "https://bitcoinist.com", URL: "https://bitcoinist.com/feed/", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 5},
	{Slug: "blockchainmedia", Label: "Blockchain Media Indonesia RSS", Homepage: "https://blockchainmedia.id", URL: "https://blockchainmedia.id/feed/", Format: FormatRSS, Category: "news", Country: "ID", Language: "id", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 5},
	{Slug: "blockmedia", Label: "Blockmedia RSS", Homepage: "https://blockmedia.co.kr", URL: "https://blockmedia.co.kr/feed/", Format: FormatRSS, Category: "news", Country: "KR", Language: "ko", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 5 * time.Minute, Priority: 5},
	{Slug: "chaincatcher", Label: "ChainCatcher RSS", Homepage: "https://chaincatcher.com", URL: "https://chaincatcher.com/rss.xml", Format: FormatRSS, Category: "news", Country: "CN", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 5 * time.Minute, Priority: 4},
	{Slug: "coindeskjapan", Label: "CoinDesk Japan RSS", Homepage: "https://coindeskjapan.com", URL: "https://coindeskjapan.com/feed/", Format: FormatRSS, Category: "news", Country: "JP", Language: "ja", Reliability: 4, License: "feed-redistribution", Status: StatusUnsupported, StatusDetail: "the registered path now 302s off-host (coindeskjapan.com/feed/ -> www.coindeskjapan.com -> www.nadanews.com), so following it would collect a different publisher under this slug; the same-host guard refuses it and the row stops collecting (measured 2026-10-11)", Schedule: 0, Priority: 9},
	{Slug: "coingape", Label: "CoinGape RSS", Homepage: "https://coingape.com", URL: "https://coingape.com/feed/", Format: FormatRSS, Category: "news", Country: "IN", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 5},
	{Slug: "coinjournal", Label: "CoinJournal RSS", Homepage: "https://coinjournal.net", URL: "https://coinjournal.net/feed/", Format: FormatRSS, Category: "news", Country: "GB", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 5},
	{Slug: "coinpedia", Label: "Coinpedia RSS", Homepage: "https://coinpedia.org", URL: "https://coinpedia.org/feed/", Format: FormatRSS, Category: "news", Country: "IN", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 5},
	{Slug: "coinpost", Label: "CoinPost RSS", Homepage: "https://coinpost.jp", URL: "https://coinpost.jp/rss.xml", Format: FormatRSS, Category: "news", Country: "JP", Language: "ja", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 5 * time.Minute, Priority: 4},
	{Slug: "crypto-news-flash", Label: "Crypto News Flash RSS", Homepage: "https://crypto-news-flash.com", URL: "https://crypto-news-flash.com/feed/", Format: FormatRSS, Category: "news", Country: "DE", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 5},
	{Slug: "cryptobriefing", Label: "Crypto Briefing RSS", Homepage: "https://cryptobriefing.com", URL: "https://cryptobriefing.com/feed/", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 5},
	{Slug: "cryptonews", Label: "CryptoNews RSS", Homepage: "https://cryptonews.com", URL: "https://cryptonews.com/feed/", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 5},
	{Slug: "newsbtc", Label: "NewsBTC RSS", Homepage: "https://newsbtc.com", URL: "https://newsbtc.com/feed/", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 5 * time.Minute, Priority: 5},
	{Slug: "panews", Label: "PANews RSS", Homepage: "https://panewslab.com", URL: "https://panewslab.com/rss.xml", Format: FormatRSS, Category: "news", Country: "CN", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 5 * time.Minute, Priority: 4},
	{Slug: "tokocrypto", Label: "Tokocrypto News RSS", Homepage: "https://news.tokocrypto.com", URL: "https://news.tokocrypto.com/feed/", Format: FormatRSS, Category: "news", Country: "ID", Language: "id", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 5},
	{Slug: "unchained", Label: "Unchained RSS", Homepage: "https://unchainedcrypto.com", URL: "https://unchainedcrypto.com/feed/", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 4},
	{Slug: "utoday", Label: "U.Today RSS", Homepage: "https://u.today", URL: "https://u.today/rss", Format: FormatRSS, Category: "news", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 5 * time.Minute, Priority: 5},
	{Slug: "wu-blockchain", Label: "Wu Blockchain Substack RSS", Homepage: "https://wublock.substack.com", URL: "https://wublock.substack.com/feed", Format: FormatRSS, Category: "news", Country: "CN", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 4},
	// ---- official / regulator announcements (public records; redistribution is the point) ----
	{Slug: "cftc", Label: "CFTC general press releases", Homepage: "https://cftc.gov", URL: "https://cftc.gov/RSS/RSSGP/rssgp.xml", Format: FormatRSS, Category: "regulator", Country: "US", Language: "en", Reliability: 5, License: "public-record", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 3},
	{Slug: "eba", Label: "EBA news", Homepage: "https://eba.europa.eu", URL: "https://eba.europa.eu/rss.xml", Format: FormatRSS, Category: "regulator", Country: "EU", Language: "en", Reliability: 5, License: "public-record", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 3},
	{Slug: "esma", Label: "ESMA news", Homepage: "https://esma.europa.eu", URL: "https://esma.europa.eu/rss.xml", Format: FormatRSS, Category: "regulator", Country: "EU", Language: "en", Reliability: 5, License: "public-record", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 3},
	{Slug: "fca", Label: "UK FCA news", Homepage: "https://fca.org.uk", URL: "https://fca.org.uk/news/rss.xml", Format: FormatRSS, Category: "regulator", Country: "GB", Language: "en", Reliability: 5, License: "public-record", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 3},
	{Slug: "federalreserve", Label: "Federal Reserve press releases", Homepage: "https://federalreserve.gov", URL: "https://federalreserve.gov/feeds/press_all.xml", Format: FormatRSS, Category: "regulator", Country: "US", Language: "en", Reliability: 5, License: "public-record", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 3},
	{Slug: "ofac", Label: "OFAC recent actions", Homepage: "https://ofac.treasury.gov", URL: "https://ofac.treasury.gov/rss.xml", Format: FormatRSS, Category: "regulator", Country: "US", Language: "en", Reliability: 5, License: "public-record", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 3},
	{Slug: "sec", Label: "SEC press releases", Homepage: "https://sec.gov", URL: "https://sec.gov/news/pressreleases.rss", Format: FormatRSS, Category: "regulator", Country: "US", Language: "en", Reliability: 5, License: "public-record", Status: StatusActive, Schedule: 10 * time.Minute, Priority: 3},
	// ---- market, ETF-flow and institutional desks ----
	{Slug: "cboe", Label: "Cboe insights RSS", Homepage: "https://cboe.com", URL: "https://cboe.com/insights/rss/", Format: FormatRSS, Category: "market", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 5},
	{Slug: "cnbc", Label: "CNBC top news RSS", Homepage: "https://cnbc.com", URL: "https://cnbc.com/id/100003114/device/rss/rss.html", Format: FormatRSS, Category: "market", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 5},
	{Slug: "etfcom", Label: "ETF.com RSS", Homepage: "https://etf.com", URL: "https://etf.com/rss.xml", Format: FormatRSS, Category: "market", Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 5},
	{Slug: "etfgi", Label: "ETFGI RSS", Homepage: "https://etfgi.com", URL: "https://etfgi.com/rss.xml", Format: FormatRSS, Category: "market", Country: "GB", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: time.Hour, Priority: 6},
	{Slug: "farside", Label: "Farside Investors RSS", Homepage: "https://farside.co.uk", URL: "https://farside.co.uk/feed", Format: FormatRSS, Category: "market", Country: "GB", Language: "en", Reliability: 3, License: "feed-redistribution", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 5},
	{Slug: "ft", Label: "Financial Times headlines RSS", Homepage: "https://ft.com", URL: "https://ft.com/rss/", Format: FormatRSS, Category: "market", Country: "GB", Language: "en", Reliability: 5, License: "feed-headline-only", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 5},
	// ---- security research and incident responders ----
	{Slug: "chainalysis", Label: "Chainalysis blog RSS", Homepage: "https://chainalysis.com", URL: "https://chainalysis.com/feed/", Format: FormatRSS, Category: "security", Country: "US", Language: "en", Reliability: 5, License: "feed-redistribution", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 4},
	{Slug: "halborn", Label: "Halborn RSS", Homepage: "https://halborn.com", URL: "https://halborn.com/feed.xml", Format: FormatRSS, Category: "security", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 5},
	{Slug: "immunefi", Label: "Immunefi blog RSS", Homepage: "https://immunefi.com", URL: "https://immunefi.com/blog/feed", Format: FormatRSS, Category: "security", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 15 * time.Minute, Priority: 4},
	// ---- research desks ----
	{Slug: "a16zcrypto", Label: "a16z Crypto RSS", Homepage: "https://a16zcrypto.com", URL: "https://a16zcrypto.com/feed", Format: FormatRSS, Category: "research", Country: "US", Language: "en", Reliability: 5, License: "feed-redistribution", Status: StatusActive, Schedule: time.Hour, Priority: 6},
	{Slug: "coingecko", Label: "CoinGecko Learn Atom feed (served by FeedBurner)", Homepage: "https://coingecko.com", URL: "https://feeds.feedburner.com/CoingeckoBuzz", Format: FormatAtom, Category: "research", Country: "SG", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 30 * time.Minute, Priority: 6},
	{Slug: "multicoin", Label: "Multicoin Capital RSS", Homepage: "https://multicoin.capital", URL: "https://multicoin.capital/rss.xml", Format: FormatRSS, Category: "research", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: time.Hour, Priority: 6},
	// ---- protocol, developer and governance blogs ----
	{Slug: "bitcoinops", Label: "Bitcoin Optech Atom feed", Homepage: "https://bitcoinops.org", URL: "https://bitcoinops.org/feed.xml", Format: FormatAtom, Category: "protocol", Country: "US", Language: "en", Reliability: 5, License: "feed-redistribution", Status: StatusActive, Schedule: time.Hour, Priority: 6},
	{Slug: "ethereum-blog", Label: "Ethereum Foundation blog RSS", Homepage: "https://blog.ethereum.org", URL: "https://blog.ethereum.org/feed.xml", Format: FormatRSS, Category: "protocol", Country: "CH", Language: "en", Reliability: 5, License: "feed-redistribution", Status: StatusActive, Schedule: 30 * time.Minute, Priority: 5},
	{Slug: "ethmagicians", Label: "Ethereum Magicians latest", Homepage: "https://ethereum-magicians.org", URL: "https://ethereum-magicians.org/latest.rss", Format: FormatRSS, Category: "protocol", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 30 * time.Minute, Priority: 6},
	{Slug: "ethresear", Label: "Ethereum Research latest", Homepage: "https://ethresear.ch", URL: "https://ethresear.ch/latest.rss", Format: FormatRSS, Category: "protocol", Country: "US", Language: "en", Reliability: 5, License: "feed-redistribution", Status: StatusActive, Schedule: 30 * time.Minute, Priority: 6},
	{Slug: "lido", Label: "Lido blog RSS", Homepage: "https://blog.lido.fi", URL: "https://blog.lido.fi/feed", Format: FormatRSS, Category: "protocol", Country: "CH", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 30 * time.Minute, Priority: 6},
	{Slug: "solana-news", Label: "Solana news RSS", Homepage: "https://solana.com", URL: "https://solana.com/news/rss.xml", Format: FormatRSS, Category: "protocol", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 30 * time.Minute, Priority: 5},
	// ---- data-platform blogs ----
	{Slug: "dune-blog", Label: "Dune blog RSS", Homepage: "https://dune.com", URL: "https://dune.com/blog/feed", Format: FormatRSS, Category: "data", Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution", Status: StatusActive, Schedule: 30 * time.Minute, Priority: 6},
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
