# News ingestion — operations

Operating the crypto news ingestion engine. Everything here is an existing
FUDCourt operational surface; news adds no new service, unit, or datastore.

## Deployment

News ships inside the existing `fudcourt-data` binary. There is no separate
deploy step.

```bash
go build ./apps/data/...          # or the existing fudcourt-data unit ExecStart
systemctl --user restart fudcourt-data
```

The module is registered in `apps/data/main.go`'s `buildDataModules()`:

```go
newsfeed.NewModule(nil),
```

A `nil` Doer means each client builds the shared tuned transport
(`httpx.NewClient`) — the same production-wiring rule every other adapter uses.
Restarting the unit re-reads the source table and re-seeds jobs via
`JobStore.EnsureJobs` (an existing row keeps its cursor, `last_success`, and
`retry_count`).

### Configuration

| Variable | Purpose | Default |
|---|---|---|
| `FUDCOURT_DATA_PG_URL` | Data platform DSN (existing) | falls back to `FUDCOURT_PG_URL` with path `/fudcourt` |
| `FUDCOURT_DATA_ADDR` | Sidecar bind address (existing) | `127.0.0.1:3101` |
| `FUDCOURT_DATA_URL` | Consumed by the **web** proxy route | `http://127.0.0.1:3101` |
| `FUDCOURT_NEWS_E2E_PG_URL` | Only for the live e2e test | unset |
| `FUDCOURT_NEWS_E2E_ALLOW` | Must be `1`, else the live e2e skips | unset |

No credentials are required by any working source. If a credentialed source is
later added (CryptoPanic), read the key from the environment — never commit it,
and never inline it in the registry table.

## What "healthy" looks like

`GET /healthz` on the sidecar reports the research families, including
`"news":"1 feeds"` — that count belongs to the **research relay**, not to the
ingestion registry. Ingestion health lives in the journal:

```sql
-- Per-dataset outcome, newest first.
SELECT dataset, status, rows_in, rows_written, rows_rejected, started_at
FROM data.ingestion_run
WHERE provider = 'newsfeed'
ORDER BY started_at DESC
LIMIT 30;
```

Healthy: `status = 'ok'`, `rows_rejected = 0`, `rows_written > 0` on a source's
first cycle and `0` on an unchanged re-fetch (a 304 or an all-duplicates
cycle).

```sql
-- Terminal failures (backoff exhausted or a recovered panic).
SELECT dataset, error, occurred_at
FROM data.ingestion_error
WHERE provider = 'newsfeed'
ORDER BY occurred_at DESC;
```

An empty result is healthy. Rows here are real terminal failures, not transient
retries — transient attempts only ever land in `data.ingestion_run`.

```sql
-- Store health.
SELECT count(*) AS articles,
       count(DISTINCT publisher) AS outlets,
       count(*) = count(DISTINCT article_id) AS ids_unique,
       max(retrieved_at) AS last_ingest
FROM data.news_article;
```

`ids_unique = true` is the standing idempotency invariant.

## Common conditions

### A source stops producing rows

1. Check the journal for that dataset — look at `status` and `error`.
2. Probe the feed directly with the same UA the adapter uses:

   ```bash
   curl -sS -m 20 -A "FUDCourt-NewsBot/1.0 (+fc.dwirijal.my.id)" \
     -o /tmp/feed.body -D /tmp/feed.hdr \
     -w "%{http_code} %{content_type} %{size_download}\n" \
     --max-filesize 10485760 "<feed url>"
   ```

3. Interpret by status:
   - **404/410** — the publisher moved or retired the feed. Find the new one,
     probe it, update `FeedURL`, and record the new evidence.
   - **403 / challenge page** — a bot control was added. Mark the source
     `restricted` with the probe result. Do not attempt to bypass it.
   - **200 but HTML** — the endpoint no longer serves a feed. Mark it
     `unsupported` or find the real feed.
   - **429** — rate-limited; the adapter already surfaces `Retry-After` and the
     engine backs off. If chronic, raise `PollInterval` on that source.
   - **TLS failure** — a certificate/SNI change. Record it; do not disable
     verification.

### Rows keep appearing every cycle (suspected duplicate minting)

This is the failure mode to check first if the table grows without new stories:

```sql
SELECT count(*) AS rows,
       count(DISTINCT article_id) AS ids,
       count(DISTINCT (provider, provider_article_id)) AS natural_keys
FROM data.news_article;
```

If `rows > ids`, IDs are unstable. The usual cause is a feed whose `<guid>`
varies per request (rotating tracking parameters), because the fallback identity
prefers `guid` verbatim. Fix by tightening `canonicalURL` for that source or by
carrying the stable part of the guid. If `rows = ids = natural_keys`, a
non-zero `rows_written` is just upsert churn — correct behavior.

### The whole read surface returns 503

`/api/data/*` returns 503 when the store is unavailable. The sidecar logs the
cause once at startup:

```
fudcourt-data: DATA PLATFORM DISABLED: data pool connect failed after retries; ...
```

This is intentional: reads fail loudly rather than serving an empty list that
reads like "no news".

## Backpressure and limits

- Dispatch is bounded by the engine's worker pool (4 workers) and the
  per-provider rate limiter and circuit breaker. A source that fails repeatedly
  is opened by the breaker and stops consuming slots until it recovers.
- One request per source per cycle; the politeness gap in the smoke suite is a
  test artifact, not a production delay.
- `maxBodyBytes` is 10 MiB. A body that reaches the cap is rejected as a shape
  error rather than truncated and parsed.
- Read pages are clamped to 1000 rows; the default is 100.

## Adding a source (no code changes for RSS/Atom)

1. Probe it. Record the real status, content type, and item count.
2. Append a `Source` row in
   `apps/data/internal/ingest/providers/newsfeed/sources.go` with `Status` and
   either `Evidence` (working) or `BlockReason` (blocked).
3. Verify locally:

   ```bash
   go test ./apps/data/internal/ingest/providers/newsfeed/ -count=1
   go test -tags live ./apps/data/internal/ingest/providers/newsfeed/ -run TestLiveSources -v
   ```

4. Restart the sidecar. `Fetchers()` and `Jobs()` are both derived from the
   table, so the new source is dispatched on the next engine tick.

For the full 158-entry inventory, provide it as a manifest and load it with
`LoadManifest`; `ValidateSources` rejects duplicates, missing endpoints,
SSRF-blocked URLs, a `working` row without evidence, and any non-working row
without a documented reason.

## Data retention

`data.news_article` is not swept by any TTL (it is a durable reference table,
not a hypertable), so articles accumulate until explicitly pruned. To bound it:

```sql
-- Example: drop articles older than one year, by publication date.
DELETE FROM data.news_article
WHERE published_at IS NOT NULL AND published_at < now() - interval '1 year';
```

Run any retention change deliberately and off-peak; the table is the source of
truth for the news read surface.

## Backups and restore

`data.news_article` lives in the `fudcourt` database and is covered by whatever
backup strategy that database already has. Nothing about news changes the
backup or restore procedure.

## Incident checklist

1. **Read surface 503** → sidecar logs; check Postgres reachability.
2. **No new articles from one source** → journal row, then a direct probe.
3. **Table growing without new stories** → the duplicate-minting query above.
4. **Feed returns a challenge page** → mark `restricted`; do not bypass.
5. **Suspected SSRF or oversized body** → the adapter rejects both as loud
   errors; check `data.ingestion_error` for the detail.
