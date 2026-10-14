# News API reference

Two distinct news surfaces exist. They are not interchangeable.

| Endpoint | Serves | Backing |
|---|---|---|
| `GET /api/news` | The publisher **relay** (research family) | One live RSS feed, stateless, re-read per request |
| `GET /api/data/news` | The **durable store** | Every article the ingestion engine has written |

## `GET /api/data/news`

Reads `data.news_article`, newest first, with filters and keyset pagination.

### Query parameters

| Param | Type | Effect | On invalid input |
|---|---|---|---|
| `limit` | int ≥ 1 | Page size; default 100, clamped to 1000 | `400 bad_request` |
| `source` | string | Outlet display name (`The Defiant`) **or** ingestion family (`newsfeed`) | empty page |
| `category` | string | Member of `topics` | empty page |
| `asset` | string | Member of `assets`; uppercased for you (`btc` → `BTC`) | empty page |
| `search` | string | Case-insensitive substring over `headline` + `summary` | empty page |
| `before` | timestamp | Keyset cursor — returns articles **strictly older**; RFC 3339 or `YYYY-MM-DD` | `400 bad_request` |

Filters narrow, they never assert: an unknown outlet or asset returns an empty
page rather than an error. `limit` and `before` are validated and do 400 on
malformed input, matching the house rule of never silently coercing a caller's
parameter.

### Response

```json
{
  "data": [
    {
      "article_id": "article/newsfeed/https://www.theblock.co/post/…",
      "headline": "Bitcoin ETF sees record inflows",
      "summary": "Spot funds pulled in $1.2B.",
      "url": "https://www.theblock.co/post/…",
      "publisher": "The Block",
      "published_at": "2026-10-11T18:38:29Z",
      "language": "en",
      "topics": ["markets"],
      "assets": ["BTC"],
      "sentiment": null,
      "source": "newsfeed",
      "retrieved_at": "2026-10-11T18:40:33.299443Z"
    }
  ]
}
```

Nullable fields are `null`, never a fabricated value. `published_at` is `null`
when the feed omits a timestamp; `sentiment` is `null` because nothing populates
it yet.

### Headers

| Header | When | Value |
|---|---|---|
| `Link` | Page is full | `</news?before=2026-10-11T18:00:39Z&limit=100>; rel="next"` |
| `Cache-Control` | Via the web proxy | `public, max-age=60` when upstream set none |

### Pagination

Keyset, not offset. Take the last row's `published_at`, pass it as `before`, and
repeat. Because the predicate is `published_at < before` over a `DESC` order, a
concurrent insert cannot cause a skip or a repeat the way `OFFSET` would.

```bash
# Page 1
curl -sS "http://127.0.0.1:3101/api/data/news?limit=50" -D /tmp/h
# Follow the Link header, or take the last published_at yourself.
curl -sS "http://127.0.0.1:3101/api/data/news?limit=50&before=2026-10-11T18:00:39Z"
```

Rows with a `null` `published_at` sort last and appear only on the first
(uncursored) page; they are excluded from cursor pages by design so the NULL
tail cannot repeat forever.

### Errors

| Status | Code | Meaning |
|---|---|---|
| `400` | `bad_request` | `limit` or `before` malformed |
| `405` | `method_not_allowed` | Not GET/HEAD |
| `503` | `unavailable` | The store could not answer (Postgres unreachable) |

A 503 carries the underlying error text so an operator sees the cause in one
probe. Raw adapter errors are never exposed here.

### Examples

```bash
# Newest 20 overall
curl -sS "http://127.0.0.1:3101/api/data/news?limit=20"

# One outlet
curl -sS "http://127.0.0.1:3101/api/data/news?source=The%20Defiant&limit=20"

# Bitcoin-tagged only
curl -sS "http://127.0.0.1:3101/api/data/news?asset=BTC&limit=20"

# Security category
curl -sS "http://127.0.0.1:3101/api/data/news?category=security&limit=20"

# Full-text-ish search
curl -sS "http://127.0.0.1:3101/api/data/news?search=ledger&limit=20"

# Continue a page
curl -sS "http://127.0.0.1:3101/api/data/news?before=2026-10-11T18:00:39Z&limit=20"
```

## `GET /api/data/news` via the web app

`apps/web/src/app/(frontend)/api/data/news/route.ts` is a thin proxy to the
sidecar. It forwards the query string verbatim and relays
`Cache-Control`, `Link`, and `ETag`.

```bash
curl -sS "http://127.0.0.1:3000/api/data/news?limit=2&asset=BTC"
```

The route exists as the concrete handler Next resolves ahead of the
`/api/[...path]` gateway. The gateway now ALSO forwards the `data` family with
its path remainder (the pre-2026-10-12 subpath-drop was fixed), so
`/api/data/news` is reachable both ways; this dedicated file remains the faster,
pinned path. It is not the `research` route and does not appear in the Go-api
proxy table the conformance gate checks (it proxies `FUDCOURT_DATA_URL`,
matching the existing gateway).

## `GET /api/news` (research relay — unchanged)

Do not confuse this with the store.

```json
{
  "items": [{"title": "…", "link": "…", "description": "…", "pubDate": "…"}],
  "total": 30,
  "timestamp": "2026-10-11T18:40:00Z",
  "upstream": "https://cointelegraph.com/rss"
}
```

| Param | Effect | On invalid input |
|---|---|---|
| `source` | Feed name from the relay's table (one entry: `cointelegraph`) | `400` naming the valid sources verbatim |
| `limit` | Rows to return (1–100) | `400` |

`total` is the full parsed count; `items` is the `limit` head. An empty upstream
feed is a loud `502`, never an empty 200. The wire contract — including the
exact 400 detail text and the `news:1 feeds` healthz count — is pinned by
`scripts/verify/verify-news.py` and must not change.
