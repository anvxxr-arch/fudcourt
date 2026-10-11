# News ingestion — the publisher-feed family in the data sidecar

**Status:** built and measured on this host, 2026-10-11. Fifteen publisher feeds answer and
are collected; one is recorded **restricted** rather than worked around; nothing here is
claimed working on the strength of its configuration alone.

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

`feeds.go` is the registry: one `Feed` value per publisher, version-controlled. Adding a
source is a row, not a package. The prompt's coverage target was 158 entries; see
*Open items* for why the registry currently holds the sources that were **verified live**
instead of a transcribed list.

| Column | Meaning |
|---|---|
| `Slug` | The source id. It is the job subject, the `data.news_source` key and the `provider` on every article row |
| `Label` | Human name |
| `Homepage`, `URL` | Canonical site and the feed URL actually dialled |
| `Format` | `rss`, `atom` or `jsonfeed` — asserted against the document, not assumed |
| `Category`, `Country`, `Language` | Classifiers carried onto the article |
| `Reliability` | 1–5, a curation judgement, recorded as such |
| `License` | Reuse posture of the feed |
| `Status` | `active`, `restricted`, `pending_credentials` |
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

## Transport

`client.go` wraps the repository's own `httpx.NewClient` and adds only what a feed needs:

- **Conditional requests.** `ETag` and `Last-Modified` are stored in the job cursor and
  sent back, so a quiet source costs a 304 and zero bytes of body.
- **Bounded bodies.** An 8 MiB cap, checked as it streams, so a decompression bomb or an
  endless response is a reported error rather than resident memory.
- **A same-host redirect rule.** A feed that redirects to a different host is refused.
  This is a security control first (SSRF) and it earned its keep immediately: it caught a
  stale registry row (see the DR for the measured 308).
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

## Measured coverage (2026-10-11, this host)

One request per source, sequential, no retries — the `live` build tag
(`go test -tags live -run TestLiveFeeds`) and nothing in the default CI run.

| Slug | Feed | Items | Articles | Latency |
|---|---|---|---|---|
| cointelegraph | `cointelegraph.com/rss` | 30 | 30 | 196 ms |
| cointelegraph-bitcoin | `cointelegraph.com/rss/tag/bitcoin` | 30 | 30 | 79 ms |
| coindesk | `coindesk.com/arc/outboundfeeds/rss/` | 25 | 25 | 192 ms |
| decrypt | `decrypt.co/feed` | 58 | 58 | 180 ms |
| theblock | `theblock.co/rss.xml` | 20 | 20 | 193 ms |
| blockworks | `blockworks.com/feed` (Atom) | 50 | 50 | 525 ms |
| beincrypto | `beincrypto.com/feed/` | 12 | 12 | 141 ms |
| ambcrypto | `ambcrypto.com/feed/` | 16 | 16 | 180 ms |
| thedefiant | `thedefiant.io/api/feed` | 100 | 100 | 268 ms |
| dlnews | `dlnews.com/feed/` | 40 | 40 | 467 ms |
| protos | `protos.com/feed/` | 10 | 10 | 178 ms |
| bitcoinmagazine | `bitcoinmagazine.com/feed` | 10 | 10 | 870 ms |
| cryptopotato | `cryptopotato.com/feed/` | 36 | 36 | 224 ms |
| dailyhodl | `dailyhodl.com/feed/` | 10 | 10 | 157 ms |
| rekt | `rekt.news/rss/` | 7 | 7 | 136 ms |

**15 active, 0 refused, 0 empty, 434 articles in 3.75 s.** `cryptoslate` is registered
`restricted` with the measured reason — HTTP 403 and a Cloudflare interstitial to a
non-browser client — and is **not** collected. Nothing in this family needed a credential.

## Open items, stated plainly

1. **The 158-entry inventory never reached the executing session.** It is not in the
   session's history, not on disk, and not in the repository (the 2026-10-01 walk in
   `source-catalog.md` records the same gap for its own brief). The registry therefore holds
   the 16 sources that were verified by live request, and the engine takes new sources as
   rows. No list was invented to reach a number.
2. **No API surface yet.** The public and admin endpoints of the brief's §11 are not wired;
   `/api/news` is unchanged and still serves through its existing path.
3. **No entity extraction beyond the asset dictionary**, no similarity clustering, no event
   table, and no LLM enrichment — deliberately, per the "deterministic first" rule.
4. **`data.news_events`, `data.news_item_entities` and the rest of the brief's suggested
   entities do not exist**, because the level-4/5 pipeline that would fill them does not.

## Checks

`gofmt`, `go vet`, `go test ./apps/data/...` (offline, deterministic); the schema census in
`schema_test.go` and the byte-identity guard between the embedded DDL and
`db/schema/data-schema.sql`; the repo-wide `scripts/verify/verify-all.sh`; and, separately,
the live test above.
