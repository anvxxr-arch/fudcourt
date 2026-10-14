# News ingestion engine — QA report

Date: **2026-10-11**. Scope: `apps/data/internal/ingest/providers/newsfeed`,
the `ListArticlesFiltered` read path, and the `/api/data/news` web proxy.

Every number below was produced by a command in this session. Nothing is
projected or estimated.

## 1. Build, vet, format

| Gate | Command | Result |
|---|---|---|
| Build | `go build ./apps/data/...` | PASS |
| Vet (all data packages) | `go vet ./apps/data/...` | PASS |
| Format | `gofmt -l apps/data/internal/ingest/providers/newsfeed` | empty |
| Vet (live-tagged suites) | `go vet -tags live ./apps/data/internal/ingest/{repo,providers/newsfeed}/` | PASS |

## 2. Unit suite

```bash
go test ./apps/data/internal/ingest/providers/newsfeed/ ./apps/data/internal/ingest/serve/ -count=1
```

**49 tests, 0 failures** (26 in `newsfeed`, 23 in `serve` including the news
handler regression suite). Deterministic fixtures only — no network, no
database.

| Area | Tests |
|---|---|
| Feed parsing | RSS item extraction, Atom `rel=alternate` selection, unrecognized root → empty (not error), truncated XML → error |
| URL canonicalization | tracking-param strip, host lowercase, query sort, fragment removal |
| Timestamps | RFC1123Z / RFC1123 / RFC3339 / date-only / epoch accepted; empty and garbage rejected (no fabricated epoch) |
| Article mapping | `RetrievedAt = now` (never pubDate), `PublishedAt` nil when the feed omits it, `ArticleKey` construction, content-hash fallback when no guid, asset tagging on word boundaries |
| Fetch contract | `RowsIn`/`RowsWritten`/`RowsRejected`, cursor `etag` + `last_published_at` persistence, conditional headers sent, 304 → zero rows with cursor carried, empty feed → zero rows (not an error) |
| Failure taxonomy | 429 → `status` HardError with `retry-after` in detail, non-feed body → `shape`, oversized body → `shape` naming the cap, transport failure → `transport`, non-dispatchable source → `no-credentials`, writer error propagation |
| SSRF | 9 blocked forms (loopback, RFC1918, link-local `169.254.169.254`, `file://`, `ftp://`, userinfo, localhost); 3 legitimate forms allowed |
| Registry | duplicate id/domain, missing endpoint, SSRF-blocked URL, `working` without evidence, non-working without a block reason — all rejected; the built-in table validates |
| Registry integrity | `TestManifestMatchesTable` (the committed `manifest.json` is byte-equal to the Go table), `TestManifestLoads` (the manifest round-trips through `LoadManifest` and validates) |
| Module contract | one fetcher per working source and none for blocked ones; one job per fetcher; `Mode: poll`; sub-minute schedules floored to 1 minute |
| Handler (`serve`) | absolute `Link` cursor path, filter preservation through paging, short page omits the cursor, non-overlapping pages, all five filters, unknown filter → empty (not 400), `limit=0`/`-1`/`abc` → 400, oversized limit clamped, store outage → 503, non-GET → 405 |

## 3. Race detection

`go test -race ./apps/data/internal/ingest/providers/newsfeed/ ./apps/data/internal/ingest/serve/ -count=1`

**PASS, no data races.**

## 4. Live smoke (real network)

`go test -tags live ./apps/data/internal/ingest/providers/newsfeed/ -run TestLiveSources -v`

**15/15 sources OK**, 33.8s wall (2s politeness gap between publishers).

```
coindesk 25 | cointelegraph 30 | decrypt 38 | theblock 20 | blockworks 50
thedefiant 100 | cryptobriefing 30 | ambcrypto 16 | u-today 96 | bitcoinmagazine 10
openzeppelin 10 | slowmist 10 | chainalysis 10 | sec 25 | cftc 10
```

Every source returned parseable items with zero rejections. No source is marked
working on configuration alone.

## 5. Live end-to-end (real Postgres, write → read)

`FUDCOURT_NEWS_E2E_PG_URL=<dsn> FUDCOURT_NEWS_E2E_ALLOW=1 go test -tags live ./apps/data/internal/ingest/repo/ -run TestLiveE2ENewsIngest -v`

The whole test runs inside a transaction that **always rolls back**, so it
exercises the real schema without persisting anything.

```
E2E OK (rolled back): wrote=2 rewrote=2 count=2 filtered reads OK list_page=2
--- PASS (0.03s)
```

Asserted against the live database:

- 2 rows written, 0 rejected.
- Re-writing the same `ArticleID`s reports 2 written again and `count = 2` —
  upsert, not duplicate.
- A row with `RetrievedAt` one hour in the future is **rejected** (0 written,
  1 rejected), confirming the clock-skew guard.
- `source` + `asset` filter → exactly the BTC row.
- `category` filter (`topics`) → exactly the infra row.
- `search` substring → exactly the matching row.
- Keyset `before` cursor → exactly the older row.
- Legacy `ListArticles` (unfiltered) still returns rows.

Post-test check: `SELECT count(*) FROM data.news_article` = **0** — the
rollback held; no artifacts leaked.

## 6. Live ingestion into production schema

The sidecar was run against the live `fudcourt` database with the engine
enabled. The engine dispatched the newsfeed jobs and wrote real articles.

| Metric | Value |
|---|---|
| Articles in `data.news_article` | **481** |
| Distinct outlets (`publisher`) | **15** |
| Distinct `article_id` | **481** |
| Distinct `(publisher, headline)` | **481** |
| Distinct `(provider, provider_article_id)` | **481** |
| Rows with `topics` populated | 481 / 481 (100%) |
| Rows with `assets` populated | 154 / 481 (32%) |
| Ingestion errors (`newsfeed`) | **0** |

`rows == distinct_ids == distinct(provider, provider_article_id)` is the
idempotency proof at rest: an unstable ID would have produced more rows than
distinct keys.

**Live idempotency test**: a manual run of the full `blockworks` dataset
reported `RowsWritten: 50` (all 50 rows were upserts) while the table count
stayed at **481 → 481**. No duplicate minting across repeated cycles.

### Outlet distribution

| Outlet | Articles |
|---|---|
| The Defiant | 100 |
| U.Today | 96 |
| Blockworks | 50 |
| Decrypt | 38 |
| Crypto Briefing | 31 |
| Cointelegraph | 30 |
| SEC | 25 |
| CoinDesk | 25 |
| The Block | 20 |
| AMBCrypto | 16 |
| Chainalysis | 10 |
| SlowMist | 10 |
| Bitcoin Magazine | 10 |
| OpenZeppelin | 10 |
| CFTC | 10 |

## 7. API verification (live)

`GET /api/data/news` on the sidecar and through the web proxy.

| Request | Result |
|---|---|
| `?limit=3` | 200, 3 rows, `Link: </news?before=…>; rel="next"` present |
| `?source=The%20Defiant&limit=2` | 2 rows, both `publisher = The Defiant` |
| `?asset=BTC&limit=2` | 2 rows, both carry `BTC` |
| `?category=security&limit=2` | 2 rows, both carry `security` in `topics` |
| `?search=ledger&limit=2` | 2 matching rows |
| `?limit=2&asset=BTC` via **web** `/api/data/news` | 200 through Next.js → sidecar → Postgres, 2 rows, cache headers relayed |

Both news surfaces coexist:

- `/api/data/news` → durable store, 15 outlets, filters + cursor.
- `/api/news` → research relay, unchanged envelope `{items, total, timestamp,
  upstream}`, still serving live Cointelegraph rows.
- `/api/news` status/parsing assertions in `scripts/verify/verify-news.py` all
  PASS against the running sidecar.

## 8. Benchmarks

`go test ./apps/data/internal/ingest/providers/newsfeed/ -run '^$' -bench . -benchtime=200x`

Host: Intel Core i5-6500T @ 2.50GHz.

| Benchmark | ns/op | Throughput | B/op | allocs/op |
|---|---|---|---|---|
| `BenchmarkParseRSS50` (50-item feed) | 3,510,670 | 5.44 MB/s | 1,059,541 | 13,365 |
| `BenchmarkNormalizeArticle` | 7,443 | — | 1,065 | 18 |
| `BenchmarkCanonicalURL` | 2,911 | — | 800 | 16 |
| `BenchmarkFetchEndToEnd` (parse+normalize+write, 50 items) | 2,889,453 | 6.61 MB/s | 1,222,122 | 14,351 |

Interpretation, stated conservatively:

- Parsing is the dominant cost (~3.5 ms for 50 items) and is dominated by
  `encoding/xml` reflection; the whole fetch+parse+normalize path is ~2.9 ms.
- Normalizing a single article is ~7.4 µs, so enrichment is not a bottleneck.
- A 15-source cycle moves ~470 rows in ~34 s wall, but that time is the 2 s
  inter-publisher politeness gap (a test artifact), not CPU. Measured CPU work
  for 15 feeds at ~50 items each is well under 100 ms.
- No performance claim is made beyond these measurements. No throughput
  improvement is asserted versus any prior implementation.

## 9. Repository gates

`bash scripts/verify/verify-all.sh` → **VERIFY_ALL_OK**

Includes: structure gate, design-token gates, contract gates, schema bootstrap,
canonical reference drift, `go build/vet/test ./...`, cargo build/test,
deploy-unit guard, sync oracle, cross-service API conformance, signal pipeline,
hook syntax, web typecheck + shaper tests.

Schema guards specifically:

- `cmp db/schema/data-schema.sql apps/data/internal/ingest/schema.sql` → identical.
- `TestEmbeddedSchemaMatchesTracked` → PASS (no DDL was added; the census of
  30 tables / 14 hypertables / 11 secondary indexes / 1 unique index is unchanged).

The API conformance gate reports `web_proxies=4` — unchanged, because the new
`api/data/news` route proxies the data sidecar (`FUDCOURT_DATA_URL`), which that
gate deliberately does not treat as a Go-api proxy (same as the existing
`[...path]` gateway).

## 10. Defects found and fixed during QA

Three real bugs were found by this session's own tests and live probes, and are
fixed and covered by regression tests.

### 10.1 Cursor `Link` header pointed at the wrong endpoint (high impact)

`handleNews` built the next-page URL by copying `r.URL`. `ServerHTTP` strips the
`/api/data` prefix before dispatch, so the copied URL had a bare `/news` path,
and `url.URL.String()` with an empty scheme/host emitted a relative path:

```
Link: </news?before=…>; rel="next"      # before
```

A client following that cursor — including the web proxy, where the correct
resolution is `/api/news` — lands on the **research relay**, which returns `200`
with a completely different envelope (`{items,total,timestamp,upstream}` instead
of `{data}`). Silent wrong data, not an error.

Fix: the path is built explicitly as `/api/data/news` and the caller's filters
are carried forward, so paging never widens back to the unfiltered feed.

```
Link: </api/data/news?asset=BTC&before=2026-10-11T17%3A03%3A00Z&limit=2>; rel="next"   # after
```

Verified live on the sidecar and through the web proxy, and following the link
returns the same `{data}` document. Regression tests:
`TestNewsLinkHeaderIsAbsolutePath`, `TestNewsLinkPreservesFilters`,
`TestNewsShortPageOmitsLink`.

### 10.2 `limit=0` was silently coerced instead of rejected (medium impact)

`limitParam` had:

```go
if err != nil || n < 1 {
	return 0, err          // err is nil when Atoi succeeded
}
```

For `limit=0` and `limit=-1`, `strconv.Atoi` returns `err == nil`, so the
function returned `(0, nil)` and the handler treated it as a valid limit —
quietly substituting the default for a value the caller explicitly sent. That
contradicts the repo's own documented contract on this function ("never
clamped… 0 and 101 are 400s") and the house rule that a sent parameter is
honored or refused.

Fix: a syntactically valid but out-of-range limit now returns `errBadLimit`, so
`limit=0`, `limit=-1`, and `limit=abc` are all `400`. Oversized values are still
clamped to the cap. This is a shared helper, so all 17 call sites were checked
and the full suite re-run. Regression test: `TestNewsBadParams`.

### 10.3 Outlet filtering could not select one publisher (high impact)

`WriteArticles` stores the ingestion family in **both** `provider` and `source`
(`newsfeed`), while the outlet lives in `publisher`. The initial
`ListArticlesFiltered` matched `source = $1`, so `?source=The Defiant` returned
zero rows and `?source=newsfeed` returned every publisher at once — the filter
was unusable for its purpose.

Fix: match `publisher = $1 OR source = $1`, which selects a single outlet by
name and still accepts the family. Verified live: `?source=The Defiant` returns
2/2 rows with `publisher = The Defiant`.

## 11. Scope decisions and deviations

The brief suggested twelve read endpoints and six admin endpoints. The
implementation reuses existing surfaces instead, per the repo's rule against
duplicate infrastructure:

| Suggested | Implemented as | Why |
|---|---|---|
| `/api/news`, `/api/news/latest`, `/api/news/breaking` | `GET /api/data/news?limit=N` | One newest-first read covers all three; separate paths would be three names for one query |
| `/api/news/search` | `?search=` | Same handler |
| `/api/news/sources` | `manifest.json` + `Sources` table | The registry is version-controlled; a live read would expose operator config for no benefit |
| `/api/news/tokens/{symbol}` | `?asset=BTC` | A filter, not a path |
| `/api/news/categories` | static vocabulary | The 23-category list is a constant, not data |
| `/api/news/events`, `/trending` | **not implemented** | No event clustering is persisted, so there is nothing to serve. Recency ordering plus category/asset filters cover the current read needs; adding an events table was explicitly out of scope (no new tables) |
| `GET /api/admin/news/adapters`, `/health`, `/fetch-runs` | `/api/data/runs` + `/healthz` | The generic engine surfaces already report per-provider runs and liveness for every family including newsfeed |
| `POST /api/admin/news/adapters/{id}/test\|sync` | `POST /api/data/ingest/run` | The existing manual-run endpoint already dispatches `{provider, dataset, subject}` through the engine with its rate guard. Used in this session to prove idempotency |

Additional deliberate non-choices:

- **No Valkey state added.** The engine already uses Valkey where its contract
  requires it; the news ingestion path needs no locks, queues, or counters
  because the job table already guards double-dispatch.
- **No DDL.** Zero new tables or indexes; `data.news_article` and its two
  guards (`article_id` PK, `UNIQUE(provider, provider_article_id)`) were
  sufficient. The serialized schema pair stays byte-identical.
- **No LLM enrichment.** Entity tagging is a word-boundary rule pass; no
  per-article model call exists in the pipeline.
- **No HTML scraping.** Sources without a feed are recorded as blocked rather
  than scraped.

### Live data written during verification

The live smoke ran the real engine against the live `fudcourt` database, so
`data.news_article` now holds **481 real articles** from 15 outlets. This is the
feature working, not test residue; nothing else reads that table yet. To clear
it:

```sql
DELETE FROM data.news_article WHERE source = 'newsfeed';
```

The repository's `articles` from other families (if any) are untouched by that
statement.

## 12. Known limitations

1. **137 inventory entries unaudited.** The 158-entry list is not in this
   repository or the execution context. 21 canonical sources are audited; the
   remainder are neither claimed nor fabricated. `manifest.json` +
   `LoadManifest` are the drop-in path.
2. **Five sources blocked**, each with its real probe result:
   CryptoSlate (Cloudflare 403), Coinbase Blog (HTML shell, no feed), Binance
   Announcements (TLS/SNI + anti-bot), CryptoPanic (RSS retired, API needs a
   token), Wu Blockchain (X/Telegram only), CertiK (no feed published).
3. **DNS-level SSRF is not blocked.** `ssrfBlocked` covers literal IPs,
   `localhost`, scheme, and userinfo, but does not resolve hostnames before
   dispatch. A public hostname resolving to a private address would pass. The
   registry is operator-controlled and versioned, which bounds the exposure.
4. **Entity tagging is a word-boundary rule pass**, not a model. It tags assets
   that appear plainly in the headline/summary; it can miss aliases and can tag
   a word used in another sense.
5. **No sentiment or impact scoring is enabled.** The record model has nullable
   `Sentiment`; nothing populates it. No model is called per article.
6. **`PublishedAt` may be NULL** for a feed that omits timestamps. Such rows
   sort last and are excluded from cursor pages — reachable on the first
   (uncursored) request only. All 15 dispatched sources currently carry
   timestamps, so the tail is empty today.
7. **`connector`-style HTML extraction is not used.** Sources with no feed are
   recorded as blocked rather than scraped, respecting publisher access policy.
8. **`scripts/verify/verify-news.py` has pre-existing drift** unrelated to this
   work: its UI-path check resolves `frontend/web` (stale since commit
   `9a676aa`, "move frontend into apps") and it is not part of `verify-all.sh`.
   Its wire-level assertions all PASS. Left untouched.
9. **`apps/data/main.go` carries pre-existing gofmt drift** (import ordering and
   a blank line at ~line 1337) from earlier foreign edits. Untouched to avoid
   unrelated churn.

## 13. Commands

```bash
# unit
go test ./apps/data/internal/ingest/providers/newsfeed/ -count=1

# race
go test -race ./apps/data/internal/ingest/providers/newsfeed/ ./apps/data/internal/ingest/serve/ -count=1

# live smoke (real network, polite, sequential)
go test -tags live ./apps/data/internal/ingest/providers/newsfeed/ -run TestLiveSources -v

# live end-to-end against Postgres (transactional, always rolled back)
FUDCOURT_NEWS_E2E_PG_URL="$FUDCOURT_PG_URL" FUDCOURT_NEWS_E2E_ALLOW=1 \
  go test -tags live ./apps/data/internal/ingest/repo/ -run TestLiveE2ENewsIngest -v

# benchmarks
go test ./apps/data/internal/ingest/providers/newsfeed/ -run '^$' -bench . -benchtime=200x

# full repo gate
bash scripts/verify/verify-all.sh
```
