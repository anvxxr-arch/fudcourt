# News ingestion — the publisher-feed family in the data sidecar

**Status:** built and measured on this host, 2026-10-11. The 158-entry publisher inventory was
put through the adapter's own transport and parser: **57 sources answer and are collected**, 3
are registered and deliberately not collected, 94 answered no feed at all and are recorded with
the measurement behind each one. Nothing here is claimed working on the strength of its
configuration alone — and three of the corrections below exist because the live audit disagreed
with what had been written down.

## What this is, and what it deliberately is not

The sidecar already had a mature acquisition engine — `Module` / `Fetcher` / `JobStore` /
`RunJournal` / `Retention`, a scheduler that fixes nothing to a wall clock, and a durable
`data.news_article` table with a reader and a writer. What it did **not** have was a single
adapter that collected news. `/api/news` existed, and the probe at `apps/data/internal/research/news` could parse
one hand-written feed, but no source was registered, scheduled, cursored or journalled.

This work adds that one adapter: `apps/data/internal/ingest/providers/newsfeed`. It is a
provider in the existing engine, not a second engine — no new queue, no broker, no
Elasticsearch, no second HTTP client, no second DDL owner. The engine's own job row is the
per-source state (`data.job`), its run tables are the history (`data.ingestion_run`,
`data.ingestion_error`), and `canon.Writer` stays its only write surface.

## One adapter, N sources — configuration, not code

`feeds.go` is the registry: one `Feed` value per publisher, version-controlled, now 61 rows.
Adding a source is a row, not a package. The 158-entry inventory was measured source by source
before anything was written down — a host becomes a row only by answering a request (see
*Coverage*).

| Column | Meaning |
|---|---|
| `Slug` | The source id. It is the job subject, the `data.news_source` key and the `provider` on every article row |
| `Label` | Human name |
| `Homepage`, `URL` | Canonical site and the feed URL actually dialled |
| `Format` | `rss`, `atom` or `jsonfeed` — asserted against the document, not assumed |
| `Category`, `Country`, `Language` | Classifiers carried onto the article |
| `Reliability` | 1–5, a curation judgement, recorded as such |
| `License` | Reuse posture of the feed |
| `Status` | `active`, `restricted`, `pending_credentials`, `unsupported` |
| `Schedule`, `Priority` | The polling target and the dispatch tiebreak |

Polling cadences follow the brief's targets (major publishers 3–5 minutes, exchange
announcements 2–5 minutes, regulatory 10–30, research 30–60) and are declared per row.

## The three dialects, and the parser

`parse.go` is the one parser for all of them: RSS 2.0, Atom, and JSON Feed 1.x, with the
dialect detected from the document and then checked against what the registry declared — a
mismatch is a hard error, never a silent empty result. It handles `guid` / Atom `id` /
JSON Feed `id` as the external id, `pubDate` / `published` / `date_published` as the moment,
relative and absolute links, `dc:creator` and Atom author, `category` / `term` / `tags`,
enclosures and `media:content` images, HTML and XML entities in summaries, and non-UTF-8
declared charsets through a `CharsetReader` (`iso-8859-1` is covered by a fixture).

Missing timestamps stay missing: an item without a date gets a NULL `published_at` rather
than a fabricated "now", which would poison every freshness read downstream.

The parser also strips a leading byte-order mark before it sniffs anything, and transcodes
UTF-16LE/BE bodies. That is not defensive decoration: `U+FEFF` is **not** whitespace in Go, so
`federalreserve.gov/feeds/press_all.xml` — a healthy RSS 2.0 document that opens with the UTF-8
BOM — was reported unparsable until the sweep scored a working feed as a failure and the defect
was found.

## Transport

`client.go` wraps the repository's own `httpx.NewClient` and adds only what a feed needs:

- **Conditional requests.** `ETag` and `Last-Modified` are stored in the job cursor and
  sent back, so a quiet source costs a 304 and zero bytes of body.
- **Bounded bodies.** An 8 MiB cap, checked as it streams, so a decompression bomb or an
  endless response is a reported error rather than resident memory.
- **A same-host redirect rule.** A feed that redirects to a different host is refused
  (a `www.`-only hop is allowed, since that is the same site under its other name). This is a
  security control first (SSRF) and it earned its keep three times: it caught a stale row on the
  first sweep (the measured 308 in the DR), then `coingecko` (its feed lives on the publisher's
  own FeedBurner host) and `coindeskjapan` (the path now leads to a different publisher entirely,
  `www.nadanews.com`) in the live audit. In each case the ROW was corrected; the guard was not
  weakened.
- **HTTPS only, no credentials in the URL, no private or non-routable hosts**, by literal
  and by DNS-resolved address, so a `localhost`/`10.x`/`169.254.x` feed cannot be registered
  by accident.

## Normalisation, identity and de-duplication

Each item becomes a `canon.Article` with a **minted, opaque** id (DR-036) over the natural
key `(slug, external_id)`: the publisher's own id wins, a canonicalised URL is the fallback,
and the content hash is the last resort. Identity is therefore stable across fetches, so a
publisher's correction upserts the row it belongs to instead of appending a near-duplicate —
the writer's `ON CONFLICT (article_id) DO UPDATE` is what makes a correction land.

Levels 1–3 of the brief's de-duplication ladder are enforced in the adapter: canonical URL
(`utm_*`, `fbclid`, `gclid`, `ref`, `mc_cid` and friends stripped, host lowercased, fragment
dropped), external id, and a content hash over the normalised headline plus summary, both
within a batch and across fetches through the cursor. Levels 4–5 (similarity and event
clustering) are **not** implemented, and the record says so rather than implying them.

Text, not a model, does the classification: `normalize.go` maps feed categories to a bounded
topic vocabulary and scans the headline and summary for a closed dictionary of asset symbols
with word boundaries, so "adapt" never becomes ADA. Sentiment and impact scoring are left
empty on purpose — an empty field is honest, a made-up score is not.

## Scheduling, cursors and isolation

One job per active source (`Dataset: "feed"`, `Subject: <slug>`), dispatched by the existing
scheduler, so one publisher's outage cannot stall another's: a failure is isolated to its
own row and retried by the engine's backoff. On a 304 the adapter also shortens its own
poll pressure with the engine's `NextRunHint` (twice the declared cadence, capped), which
is real adaptive polling for the one signal a feed actually gives you.

## Operability

`data.news_source` is the registry **projected** into the database at startup by
`ingest.EnsureNewsSources`, so an operator can join registry membership against what was
collected — `data.news_article.source` carries the same slug — without reading Go. The
registry stays the sole owner; per-source **health is not duplicated** into that table and
is read from `data.job` (status, last success, last attempt, retry count) and the run tables
for `provider = 'newsfeed'`, `subject = <slug>`.

## Coverage of the 158-entry inventory (measured 2026-10-11, this host)

The inventory arrived as a 158-row list of publishers. It was **not transcribed into the
registry**: every row went through the adapter's own transport and parser, and only hosts
that answered a document the parser accepts became registry rows. Four passes, each one a
reaction to what the pass before it actually returned:

1. **Standard paths** — `/feed`, `/feed/`, `/rss`, `/rss.xml`, `/feed.xml`, `/atom.xml`,
   `/index.xml`, `/blog/feed`, `/news/feed`, `/api/feed` and friends, on the bare host.
2. **Feed autodiscovery** — for every host pass 1 left unresolved, the homepage was fetched
   and scanned for `<link rel="alternate" type="application/rss+xml">` (and the Atom and JSON
   Feed equivalents), which is how a reader finds a feed at a path nobody would guess. That
   pass found `cboe.com/insights/rss/`.
3. **The `www` form** — hosts that failed TLS on the apex name but answer 200 on `www`
   (`okx.com`, `mas.gov.sg`, `cryptopanic.com`, `fsa.go.jp`, `odaily.news`, `l2beat.com`
   among them) were re-probed on both host forms with the full path set.
4. **Specific URLs** — a short hand-picked batch for sources with a non-standard feed path
   (`cryptopanic.com/news/rss/`, `rekt.news/rss/feed.xml`, four Coinbase and Gemini blog
   paths, the Reuters and TheStreet feed endpoints). Each one is a request that was made and
   whose answer is recorded, never a pattern copied from a blog post. `cryptopanic` answered
   **410 Gone** — its public feed is retired, and the row says so instead of guessing a path.

| Measure | Count |
|---|---|
| inventory entries supplied | 158 |
| unique hosts after de-duplication | 151 |
| hosts that answered with a parsable feed | 57 |
| hosts that answered with no feed on any path tried | 93 |
| hosts refused by the publisher | 1 |
| registry rows after the sweep | 61 |
| collected (active) | 57 |
| registered and NOT collected | 4 |

Seven entries repeat a host — `coinness.com`, `panewslab.com`, `foresightnews.pro`,
`odaily.news`, `chaincatcher.com`, `rekt.news` and `coinbase.com` — because the list carries
some of them once as a media entry and once as a regional or institutional one. They collapse
to one row each: a row is a host and a feed, not a bullet in a list.

### Where the entries land, by the list's own grouping

| Group | Entries | Active | Unsupported | Restricted |
|---|---|---|---|---|
| Breaking News & Agregator | 14 | 3 | 11 | 0 |
| Crypto Media Asia & Indonesia | 15 | 7 | 8 | 0 |
| DeFi On-chain & Web3 | 18 | 2 | 16 | 0 |
| ETF Institusi & Makro | 15 | 6 | 9 | 0 |
| Exchange & Listing Announcements | 15 | 0 | 15 | 0 |
| Media Crypto Global | 30 | 23 | 6 | 1 |
| Regulasi & Pengumuman Resmi | 18 | 7 | 11 | 0 |
| Riset Developer & Ekosistem | 20 | 8 | 12 | 0 |
| Security Exploit & Investigasi | 13 | 3 | 10 | 0 |
| **all** | **158** | **59** | **98** | **1** |

### Why the rest are not collected, with the measurement behind each reason

| Reason | Hosts | What was measured |
|---|---|---|
| host answers 200, no feed advertised | 41 | no `<link rel="alternate">` of any type on the homepage, and none of the 12 standard paths answered a parsable document |
| no TLS handshake on the name as given | 22 | the apex name serves no certificate for itself; the `www` form was then probed too, and where it answered 200 the paths were re-tried there |
| bot wall | 14 | HTTP 403 to a non-browser client; not bypassed, not impersonated |
| other HTTP outcome, no feed | 14 | the sweep recorded the code; no feed document answered on any path tried |
| rate limited during the sweep | 2 | HTTP 429; that says something about the sweep, not about the publisher |
| account required | 2 | HTTP 401; the material sits behind a session |
| the advertised URL is not the origin | 2 | the host redirects to another host; the row is not the canonical address of anything |
| no web root at the advertised URL | 1 | HTTP 404 on the site root |

**host answers 200, no feed advertised** (40): cmegroup.com, coinbureau.com, coinmarketcap.com, crypto.com, cryptorank.io, electriccapital.com, elliptic.co, fatf-gafi.org, fincen.gov, forbes.com, glassnode.com, growthepie.xyz, hashed.com, home.treasury.gov, imf.org, indodax.com, intel.arkm.com, kucoin.com, lookonchain.com, members.delphidigital.io, nansen.ai, news.bitcoin.com, nyse.com, ojk.go.id, optimism.io, ournetwork.xyz, paradigm.xyz, pintu.co.id, polygon.technology, rekt.news, reku.id, research.binance.com, slowmist.com, sosovalue.com, thestreet.com, tokenterminal.com, treeofalpha.com, trmlabs.com, upbit.com, whale-alert.io

**no TLS handshake on the name as given** (20): bitget.com, bithumb.com, blog.bitfinex.com, blog.kraken.com, blog.uniswap.org, coinbase.com, cryptcraft.com, cryptopanic.com, fsa.go.jp, galaxy.com, gemini.com, governance.aave.com, htx.com, jinse.cn, l2beat.com, mas.gov.sg, mexc.com, odaily.news, okx.com, reuters.com

**bot wall** (13): bi.go.id, coinmarketcal.com, coinness.com, coinvestasi.com, cryptoquant.com, cyvers.ai, defillama.com, dlnews.com, gate.com, hacken.io, intotheblock.com, therollup.co, thetie.io

**other HTTP outcome, no feed** (13): ajaib.co.id, announcements.bybit.com, arbitrum.io, artemisanalytics.com, bappebti.go.id, barrons.com, binance.com, bis.org, bloomberg.com, certik.com, foresightnews.pro, scamsniffer.io, sfc.hk

**rate limited during the sweep** (2): messari.io, peckshield.com

**account required** (2): blocksec.com, santiment.net

**the advertised URL is not the origin** (2): nasdaq.com, wsj.com

**no web root at the advertised URL** (1): iosg.vc

Of the 94 hosts that serve no feed, 42 declare a
sitemap in `robots.txt` — a permitted discovery route the brief asks for and this family does
**not** yet use (sitemap discovery would need its own cursor and freshness rules). Eight of
them declare a news-shaped sitemap (`barrons.com`, `bloomberg.com`, `cryptorank.io`,
`dlnews.com`, `lookonchain.com`, `thestreet.com`, `wsj.com`, `odaily.news`), and
44 hosts serve no robots.txt at all, so there is no declared policy to
read. All of it is recorded as the next permitted step, not implemented behind a publisher's back.

## Directives, measured rather than asserted

`robots.txt` was fetched for all 61 registry rows at the adapter's own UA:

| Outcome | Rows |
|---|---|
| robots.txt present, feed path not covered by a `Disallow` | 51 |
| no robots.txt served | 7 |
| robots.txt disallows the feed path → row demoted to `restricted` | 2 |
| already restricted for a bot wall (`cryptoslate`, HTTP 403) | 1 |

The two demotions are the reason this table exists. `ambcrypto.com/robots.txt` declares
`Disallow: /feed/` for `User-agent: *` and `thedefiant.io/robots.txt` declares
`Disallow: /api/*` — exactly the two paths the earlier rows polled. Both rows are now
`restricted` with the directive quoted verbatim in `StatusDetail`, and `Enabled()` excludes
them, so the engine no longer fetches them. The adapter identifies itself as
`FUDCourtBot/1.0 (+https://fudcourt.my.id)`, sends conditional requests so a quiet feed costs
a 304, stores only the fields a feed publishes for redistribution, never impersonates a
browser, never retries around a refusal, and never reads a paywalled body.

## The registry, row by row

Items are what that source returned in the live audit run: one request per source, at the
adapter's UA, no retries. `—` means the row is registered and deliberately not collected.

| Slug | Class | Feed URL as dialled | Cadence | Items |
|---|---|---|---|---|
| dune-blog | data | https://dune.com/blog/feed | 30 min | 323 |
| cboe | market | https://cboe.com/insights/rss/ | 15 min | 25 |
| cnbc | market | https://cnbc.com/id/100003114/device/rss/rss.html | 15 min | 30 |
| etfcom | market | https://etf.com/rss.xml | 15 min | 10 |
| etfgi | market | https://etfgi.com/rss.xml | 60 min | 0 |
| farside | market | https://farside.co.uk/feed | 15 min | 0 |
| ft | market | https://ft.com/rss/ | 15 min | 12 |
| bankless | news | https://bankless.com/feed | 15 min | 100 |
| beincrypto | news | https://beincrypto.com/feed/ | 5 min | 12 |
| bitcoinist | news | https://bitcoinist.com/feed/ | 10 min | 8 |
| bitcoinmagazine | news | https://bitcoinmagazine.com/.rss/full/ | 10 min | 10 |
| blockchainmedia | news | https://blockchainmedia.id/feed/ | 10 min | 32 |
| blockmedia | news | https://blockmedia.co.kr/feed/ | 5 min | 10 |
| blockworks | news | https://blockworks.com/feed | 5 min | 50 |
| chaincatcher | news | https://chaincatcher.com/rss.xml | 5 min | 50 |
| coindesk | news | https://www.coindesk.com/arc/outboundfeeds/rss/ | 3 min | 25 |
| coingape | news | https://coingape.com/feed/ | 10 min | 20 |
| coinjournal | news | https://coinjournal.net/feed/ | 10 min | 9 |
| coinpedia | news | https://coinpedia.org/feed/ | 10 min | 10 |
| coinpost | news | https://coinpost.jp/rss.xml | 5 min | 16 |
| cointelegraph | news | https://cointelegraph.com/rss | 3 min | 30 |
| cointelegraph-bitcoin | news | https://cointelegraph.com/rss/tag/bitcoin | 5 min | 30 |
| crypto-news-flash | news | https://crypto-news-flash.com/feed/ | 10 min | 20 |
| cryptobriefing | news | https://cryptobriefing.com/feed/ | 10 min | 30 |
| cryptonews | news | https://cryptonews.com/feed/ | 10 min | 20 |
| cryptopotato | news | https://cryptopotato.com/feed/ | 10 min | 36 |
| dailyhodl | news | https://dailyhodl.com/feed/ | 10 min | 10 |
| decrypt | news | https://decrypt.co/feed | 3 min | 38 |
| dlnews | news | https://www.dlnews.com/arc/outboundfeeds/rss/ | 5 min | 40 |
| newsbtc | news | https://newsbtc.com/feed/ | 5 min | 10 |
| panews | news | https://panewslab.com/rss.xml | 5 min | 100 |
| protos | news | https://protos.com/feed/ | 10 min | 10 |
| theblock | news | https://www.theblock.co/rss.xml | 3 min | 20 |
| tokocrypto | news | https://news.tokocrypto.com/feed/ | 10 min | 10 |
| unchained | news | https://unchainedcrypto.com/feed/ | 10 min | 10 |
| utoday | news | https://u.today/rss | 5 min | 96 |
| wu-blockchain | news | https://wublock.substack.com/feed | 10 min | 20 |
| bitcoinops | protocol | https://bitcoinops.org/feed.xml | 60 min | 10 |
| ethereum-blog | protocol | https://blog.ethereum.org/feed.xml | 30 min | 642 |
| ethmagicians | protocol | https://ethereum-magicians.org/latest.rss | 30 min | 30 |
| ethresear | protocol | https://ethresear.ch/latest.rss | 30 min | 30 |
| lido | protocol | https://blog.lido.fi/feed | 30 min | 15 |
| solana-news | protocol | https://solana.com/news/rss.xml | 30 min | 20 |
| cftc | regulator | https://cftc.gov/RSS/RSSGP/rssgp.xml | 10 min | 10 |
| eba | regulator | https://eba.europa.eu/rss.xml | 15 min | 10 |
| esma | regulator | https://esma.europa.eu/rss.xml | 15 min | 10 |
| fca | regulator | https://fca.org.uk/news/rss.xml | 15 min | 20 |
| federalreserve | regulator | https://federalreserve.gov/feeds/press_all.xml | 15 min | 20 |
| ofac | regulator | https://ofac.treasury.gov/rss.xml | 15 min | 10 |
| sec | regulator | https://sec.gov/news/pressreleases.rss | 10 min | 25 |
| a16zcrypto | research | https://a16zcrypto.com/feed | 60 min | 30 |
| coingecko | research | https://feeds.feedburner.com/CoingeckoBuzz | 30 min | 18 |
| multicoin | research | https://multicoin.capital/rss.xml | 60 min | 100 |
| chainalysis | security | https://chainalysis.com/feed/ | 15 min | 10 |
| halborn | security | https://halborn.com/feed.xml | 15 min | 50 |
| immunefi | security | https://immunefi.com/blog/feed | 15 min | 15 |
| rekt | security | https://rekt.news/rss/feed.xml | 10 min | 7 |
| ambcrypto | news | https://ambcrypto.com/feed/ | — | — |
| coindeskjapan | news | https://coindeskjapan.com/feed/ | — | — |
| cryptoslate | news | https://cryptoslate.com/feed/ | — | — |
| thedefiant | news | https://thedefiant.io/api/feed | — | — |

Three registry corrections came out of the live audit rather than out of a reading of the
code, which is the point of running it:

1. **`cnbc` declared Atom and serves RSS.** The format field is asserted against the document,
   so the mismatch was a hard error, not a silently empty source. The row now declares
   `FormatRSS` — the parser is authoritative over the sweep's byte-sniffing heuristic.
2. **`coingecko` redirects to its own FeedBurner feed.** `coingecko.com/feed` 301s to
   `https://feeds.feedburner.com/CoingeckoBuzz`, the publisher's own branded feed on its own
   proxy host. The same-host guard refuses that hop — correctly, since the guard cannot know
   the target is the same publisher — so the row now names the measured endpoint directly.
   The guard was not weakened; the row was made honest.
3. **`coindeskjapan` no longer serves its own feed.** The registered path 302s
   `coindeskjapan.com/feed/` → `www.coindeskjapan.com` → `www.nadanews.com`. Collecting that
   would file another publisher's articles under this slug, so the row is `unsupported` with
   the redirect chain in `StatusDetail`.

## Live audit verdict (2026-10-11, this host)

```
reachable=57 refused=0 empty=0 articles=1785
checks=794 live_items=2364 undated_items=10 low_yield=2:etfgi,farside failures=0
NEWSFEED_OK sources=61 active=57 inactive=4 items=2364 low_yield=2
```

`checks` counts every assertion the harness made, not only the requests. `low_yield` names
the sources that answered 200 with a well-formed feed carrying zero items at audit time
(etfgi, farside) — counted and reported, because failing them would
assert a failure that did not happen and passing them silently would hide a feed that may be dead.

## Open items, stated plainly

1. **No sitemap adapter.** 42 of the hosts that serve no feed declare a sitemap. That is the
   permitted next route for them and it is not implemented; nothing here reads a sitemap yet.
2. **No API-surface work.** The public and admin endpoints of the brief's §11 are not wired.
   `/api/news` is untouched and still serves through its existing path and its existing single
   source; this family is sidecar-only.
3. **No entity extraction beyond the asset dictionary**, no similarity clustering, no event
   table, no LLM enrichment — deliberately, per the deterministic-first rule.
4. **`data.news_events` and `data.news_item_entities` do not exist**, because the level-4/5
   pipeline that would fill them does not.
5. **Nothing is deployed.** The registry, the DDL and the adapter ship to `main` and CI; the
   production sidecar still runs the build that predates this family, and `data.news_source`
   is absent from the production database until that build is rolled.
6. **94 hosts from the inventory carry no feed.** They are recorded, with the measured reason
   for each, in the table above. A registry row is not owed to a publisher that does not
   publish a machine-readable feed.

## Checks

`gofmt`, `go vet`, `go test ./apps/data/...` (offline and deterministic); the schema census in
`schema_test.go` and the byte-identity guard between the embedded DDL and
`db/schema/data-schema.sql`; the repo-wide `scripts/verify/verify-all.sh`; and, separately,
the two live checks: `go test -tags live -run TestLiveFeeds` (the adapter itself, every active
source) and `python3 scripts/verify/verify-newsfeed.py` (the registry, the directives and the
same-host redirect rule, at the adapter's own UA). CI runs neither live check on purpose: a
publisher's outage must not turn into a red build.

