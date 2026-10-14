# News adapters

How collection mechanisms are implemented, and how to add one. One provider
package (not 158), one generic mechanism per wire format, configuration-driven.

## The provider contract

`newsfeed` is a single `ingest.Module`. The engine drives it; the adapter never
schedules, retries, or rate-limits anything itself.

```go
type Module interface {
	Provider() string                    // "newsfeed" — data.job provider column
	Fetchers() map[string]Fetcher        // key = dataset id
	Jobs() []JobSpec                     // one seed job per dataset
}

type Fetcher interface {
	Fetch(ctx context.Context, job Job, w canon.Writer) (FetchResult, error)
}
```

- `Fetch` is **one synchronous attempt**. The engine owns retries, exponential
  backoff, the circuit breaker, the per-provider rate limiter, the worker pool,
  graceful shutdown, and the `ingestion_run` / `ingestion_error` journal.
  A fetcher must not sleep, loop, or retry.
- `FetchResult{RowsIn, RowsWritten, RowsRejected, Next, NextRunHint}`: counters
  come from the writer's own `(written, rejected)` return, never an
  adapter-invented number.
- `Next` is the persisted checkpoint (`map[string]any`, jsonb round-trip). The
  newsfeed cursor carries `etag`, `last_modified`, `last_published_at`,
  `last_id`.
- `JobSpec.Mode` is `"poll"` for news — never `"stream"`, which is the engine's
  higher-frequency ticker mode.

### Identity

```go
ArticleID = canon.ArticleKey(provider, providerArticleID)
```

`providerArticleID` is the feed's `<guid>`/`<id>` when present, else
`sha256(canonicalURL + "\x00" + headline)`. `ArticleKey` lowercases the provider
and namespaces the id, so two providers can never collide.

### Two timestamp rules

`repo.validateArticle` rejects an empty `ArticleID`, `Headline`, `URL`,
`Source`, or `RetrievedAt`, and any `retrieved_at` beyond `now+5min`:

| Field | Value |
|---|---|
| `RetrievedAt` | `time.Now().UTC()` at write time — **never** the feed's `pubDate` |
| `PublishedAt` | The feed's own timestamp; engine-absent feeds stay `nil` |

Putting the pubDate in `RetrievedAt` would poison a feed with clock skew (a
future-dated item would make every row un-writable).

## Mechanisms

| Mechanism | State | File |
|---|---|---|
| RSS 2.0 / 1.0 + Dublin Core | implemented | `parse_feed.go` |
| Atom 1.0 | implemented | `parse_feed.go` |
| REST API | not implemented | — |
| JSON Feed | not implemented | — |
| Sitemap | not implemented | — |
| Structured HTML | not implemented (policy-blocked) | — |

An unimplemented mechanism is a deliberate boundary, not an oversight: no source
in the audited registry needs one, and adding a mechanism without a live source
to verify it would be unverifiable code.

### RSS / Atom parsing notes

- Struct fields are **plain strings**. Go's `encoding/xml` fills a plain string
  from character data and from CDATA payloads verbatim, but this toolchain
  rejects the `,innerxml` and `,chardata` tag flags, and a plain string field
  does not capture nested element markup. Publisher feeds deliver HTML either
  escaped or inside CDATA, so the string form plus `stripTags` covers the real
  cases; a summary built from raw nested markup yields an honest empty value
  rather than corrupt text.
- Namespace prefixes are matched on local name (`creator` catches
  `dc:creator`), so Dublin Core fields parse without a namespace declaration.
- The document root is sniffed (`rss` vs `feed`) before dispatch. An
  unrecognized root returns an empty result, and the fetcher turns that into a
  loud `shape` error — a publisher replacing its feed with a login page fails
  visibly rather than reporting "0 articles".
- Atom link selection takes the first link with `rel` empty or `alternate`;
  `rel="self"` (the feed's own URL) is skipped.

## The HTTP client

`client.go` follows the house provider convention (`cftc`/`bi`):

```go
type HardError struct { Kind, URL string; Status int; Detail string }
func (e *HardError) Error() string   // pointer receiver
```

`HardError` is declared **per provider package** — there is no shared error type
to import. Kinds:

| Kind | Cause | Engine behavior |
|---|---|---|
| `transport` | DNS, dial, TLS, blocked URL, redirect to a blocked URL | retry |
| `status` | non-2xx; a 429 carries `retry-after:<v>` in the detail | retry |
| `shape` | body cap hit, unparseable feed, unknown dataset | retry |
| `api-error` | provider error envelope | retry |
| `no-credentials` | source not dispatchable | terminal |

Client safety properties:

| Property | Implementation |
|---|---|
| SSRF | `ssrfBlocked`: rejects non-http(s), userinfo, empty host, `localhost`, and literal loopback/private/link-local/multicast IPs; re-checked on the final URL after redirects |
| Size cap | `io.ReadAll(io.LimitReader(body, maxBodyBytes))`; reaching the cap is a loud `shape` error — a truncated body is never parsed (the `cftc` rule) |
| Timeout | 30s default, applied by `newClient` |
| Conditional GET | `If-None-Match` / `If-Modified-Since` from the job cursor; a 304 returns `notModified` with no body |
| Redirect safety | Follows the shared transport's policy; the destination URL is re-checked against `ssrfBlocked` |
| Single attempt | No `Sleep`, no retry loop — the engine dispatches again |

## Adding a source

For an RSS or Atom feed, **no code change is required**:

1. Probe the endpoint. Record the real status, content type, and item count.
2. Append a `Source` row in `sources.go`:

```go
{
	ID: "example", Name: "Example", Label: "Example", Domain: "example.com",
	Category: "publisher", Country: "US", Language: "en",
	FeedURL: "https://example.com/rss",
	Method:  MethodRSS, PollInterval: 5 * time.Minute,
	Topics: []string{"markets"}, Status: StatusWorking,
	Evidence: "2026-10-11 200 application/xml 42 items",
},
```

3. Verify:

```bash
go test ./apps/data/internal/ingest/providers/newsfeed/ -count=1
go test -tags live ./apps/data/internal/ingest/providers/newsfeed/ -run TestLiveSources -v
```

`Fetchers()` and `Jobs()` are both derived from the table, so restarting the
sidecar dispatches the new source on the next engine tick.

## Adding a blocked or restricted source

Record the real blocker. A non-working row must carry a `BlockReason`, and
`ValidateSources` enforces it:

```go
{
	ID: "example-blocked", Name: "Example", Domain: "example.org",
	Category: "publisher", FeedURL: "https://example.org/feed",
	Method: MethodRSS, Status: StatusRestricted,
	BlockReason: "probe 2026-10-11: HTTP 403 Cloudflare challenge on /feed; no keyless feed accepted",
	Evidence:    "2026-10-11 403 text/html",
},
```

Statuses: `working`, `pending_verify`, `pending_credentials`, `restricted`,
`unsupported`. Only `working` rows are dispatched; the rest exist to keep
coverage honest.

**Never** mark a source `working` on configuration alone, and never bypass a
paywall, CAPTCHA, bot control, or authentication to reach content.

## Adding a new mechanism

When a live source needs a format that is not implemented:

1. Add a `parse_*.go` with a pure function `([]byte) ([]rawItem, error)`, and
   extend `parseFeed`'s root sniff to dispatch to it.
2. Map its fields onto `rawItem` (`ExtID, URL, Title, Summary, Author,
   PublishedAt, Topics`) — no new output type, so normalization, identity,
   dedup, and storage are unchanged.
3. Add a `Method` constant and a table fixture under `testdata/`; write parsing
   tests with no network.
4. Add a live smoke case decided by the registry's `Method` field.

Keep parsing pure and I/O in `client.go`: that split is what makes the parser
testable with fixtures and is why the suite is deterministic.

## `Source` field reference

| Field | Purpose |
|---|---|
| `ID` | Dataset key (`data.job.dataset`) and provider-id namespace |
| `Name` | Human-readable outlet name |
| `Label` | Value stored in `canon.Article.Publisher` |
| `Domain` | Registrable domain, for dedup and reporting |
| `Category` | `publisher` / `exchange` / `regulator` / `research` / `security` / `aggregator` / `intelligence` |
| `Country` | ISO 3166-1 alpha-2 where meaningful |
| `Language` | BCP 47; stored on each article |
| `FeedURL` | Collection endpoint |
| `Method` | `rss` / `atom` / `api` / `json_feed` / `sitemap` / `html` |
| `PollInterval` / `PollIntervalSeconds` | Desired freshness (duration in Go, seconds on the manifest wire) |
| `Topics` | Intrinsic tags merged into every row's `topics` |
| `MaxItems` | Per-fetch row cap (0 = none) |
| `Status` | Audit state |
| `BlockReason` | Required when `Status` is not `working`/`pending_verify` |
| `Evidence` | Required when `Status` is `working` — the probe result |
