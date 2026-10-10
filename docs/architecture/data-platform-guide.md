# Data platform guide — extending `apps/data`

How to add a provider, a metric, or an asset class without touching canonical domain logic — the
id rule (`internal/canon/ids.go`), the frozen interfaces (`internal/ingest/interfaces.go`), and
the DDL (`internal/ingest/schema.sql`); all three are read-only for adapters.

## Layout

```
apps/data/main.go              composition root; buildDataModules() is the provider registry
apps/data/internal/ingest/     engine: scheduler, worker pool, limiter/breaker, backoff, dead letters
  interfaces.go                frozen surface: Module, Fetcher, FetchResult, JobSpec, Cursor
  jobstore.go / journal.go     data.job registry; per-attempt runs + dead letters
  engine.go / retention.go     dispatch gates (rate limiter, breaker); per-dataset TTL sweeps
  schema.go / schema.sql       embedded DDL, applied idempotently at startup (29 numbered tables)
  serve/   repo/               /api/data/* handlers; pgx canon store (entities, facts, validate)
  providers/<name>/            one package per upstream (bybit, binance, okx, fred, ...)
apps/data/internal/canon/      ids.go minting rule, types.go structs, api.go Writer/Reader,
  versions.go                  SchemaVersion / NormalizationVersion
apps/data/internal/derive/     derived metrics: metric.go Registry, processors.go, pipeline.go
                               (pure functions in indicators.go / quant.go; no scheduling here)
apps/data/internal/research/   read-proxy families (separate concern; mint no ids)
apps/data/platform/            cache (Valkey L2, fail-open), httpx (shared TLS transport)
```

## Canonical ids

The minting rule (`apps/data/internal/canon/ids.go`, `MintID`):

```
id = kind + ":" + hex(sha256(salt || 0x00 || kind || 0x00 || naturalKey))[:10]
```

Salt is `canon.Salt` = `fudcourt/canonical-reference/v1`; ids keep 10 hex digits
(`canon.IDHexLen`). The rule is a pure function of (salt, kind, natural key), so every process
mints the same id. Ids are opaque: consumers never parse them and never read a symbol out of one.

- Venue: `canon.VenueKey(id)` -> `venue/<lowercased venue id>`, minted with `canon.KindVenue`.
- Instrument: `canon.InstrumentKey(canon.InstrumentRef{...})` ->
  `instrument/<lower venue>/<market_type>/<UPPER base>/<UPPER quote>[/<STRIKE>][/<YYYYMMDD>][/<C|P>]`;
  only existing trailing segments are appended and strikes are trimmed (`65000.50` = `65000.5`).

Provider symbols NEVER become ids. The mapping is data: fetchers upsert `canon.ProviderSymbol`
rows (`data.provider_symbol`, kind-checked against the id namespace) and readers resolve through
`canon.Reader.ResolveProviderSymbol` (`apps/data/internal/canon/api.go`); an unknown pair is
`canon.ErrUnknownSymbol`, never a guess.

## Add a provider

1. New package `apps/data/internal/ingest/providers/<name>/` (`doc.go`, `client.go`, one file per
   dataset, `module.go`); copy the shape of `.../providers/bybit/`.
2. `client.go`: struct with a `canon.Doer` + timeout; `newClient(d, timeout)`, nil Doer gets the
   shared `httpx.NewClient` transport. Constants: `Base`, `UA = "fudcourt-data/1.0"`,
   `defaultTimeout`, `maxBodyBytes`. One `getJSON(ctx, url, &v)` that turns non-2xx, error
   envelopes and body-cap overflow into `HardError{Kind: ...}` — kinds `transport | status |
   api-error | shape | no-credentials`; the engine's breaker keys on them. An upstream key is
   read from the env inside the package (`.../providers/fred/env.go`) and never logged.
3. Per-dataset fetch funcs return `(written, rejected int, err error)`: parse rows, mint ids with
   `canon.MintID` over the natural keys, write through the matching `canon.Writer` method
   (`WriteOhlcv`, `WriteFunding`, `WriteObservations`, ...), opportunistically upserting the
   entities each fetch implies (venue, instruments) plus `UpsertProviderSymbols`.
4. `module.go`: `Module{client *client}` + `NewModule(d canon.Doer)`; `Provider()` is the
   `data.job.provider` value; `Fetchers()` maps dataset name -> `ingest.Fetcher`; `Jobs()` seeds
   `[]ingest.JobSpec{Provider, Dataset, Subject, Mode, Schedule, Priority, Enabled}` (subjects
   carry the market where one spans datasets: `"spot:BTCUSDT"` / `"linear_perp:BTCUSDT"`).
5. Register the module in `buildDataModules()` in `apps/data/main.go`.

Non-negotiables:

- No provider package imports another provider package; the allowed imports are `canon`,
  `ingest`, `platform/httpx` (plus `platform/cache` for the quote write-through).
- No provider type appears in `canon` — canonical structs are provider-neutral.
- Shape drift is a `HardError` (all-or-nothing for the envelope); one bad row among good ones is
  a counted rejection, never fatal.
- A missing key degrades that provider to loud no-credentials failures; it never crashes the
  engine.

## Add a metric

Ingested metric: mint the series id over the natural key, then write points.

- `seriesID := canon.MintID(canon.KindSeries, canon.SeriesKey(domain, metric, subjectKey))`;
  subject keys look like `country:<id>`, `asset:<id>`, `chain:<id>`, or `global`.
- `w.UpsertSeries(ctx, []canon.SeriesMeta{{SeriesID: ..., Domain, Metric, SubjectKey, Frequency,
  Source, Provider, ProviderSeriesID, SchemaVersion: "v1", NormalizationVersion: "v1", ...}})`
  (see `.../providers/bi/series.go` for a worked example).
- Points: `w.WriteObservations` (one value per period) or `w.WriteMetric` (derived datapoints;
  the series row must already exist).
- `Frequency` must be in `canon.ValidTimeframes` (`apps/data/internal/canon/api.go`): `tick 1s
  1m 5m 15m 1h 4h 1d 1w 1M quarterly annual event`. Exact match: `1M` != `1m`.

Derived alternative — the value is computed, not ingested: register a pure `derive.Processor` in
a `derive.Registry` (`apps/data/internal/derive/metric.go`, `Register(spec, proc)`), then
`derive.Pipeline.Run(ctx, spec, sourceSeriesID, window)` (`apps/data/internal/derive/pipeline.go`)
reads the source series, computes, upserts the derived series (`is_derived = true`, source
`derived`, id from `derive.DerivedSeriesKey` = `SeriesKey` over `metric_<param suffix>`), and
writes `data.metric` points via `WriteMetric`. Nothing schedules itself; the orchestrator calls
`Run`. Stock processors: `apps/data/internal/derive/processors.go` (`DefaultProcessors`).

## Add a new asset class

An asset class is data, not schema. What distinguishes it lives on the instrument:

- `market_type` — exact spellings in use: `spot`, `linear_perp` (`canon.InstrumentRef`,
  `data.instrument.market_type`).
- Options add `Strike` (*float64), `Expiry` (*time.Time), `OptionType` ("C"/"P"); dated futures
  add `Expiry` only. `InstrumentKey` composes them in fixed order — strike, then expiry, then
  option type (`apps/data/internal/canon/ids.go`) — so different strikes/expiries mint distinct ids.
- Facts land in the existing hypertables keyed by the minted `instrument_id` (`data.ohlcv`,
  `data.quote`, `data.funding`, ...). A new asset class needs NO schema change unless a genuinely
  new fact table is justified; then it is a new numbered section in
  `apps/data/internal/ingest/schema.sql` (follow the `-- N. name` convention; the table inventory
  is frozen in the ADDENDUM B conventions block at the top) plus matching `Writer`/`Reader`
  methods in `apps/data/internal/canon/api.go` and a repo implementation.

## Modes and cadence

`data.job.mode` has three values:

- `poll` — fixed cadence: dispatched when `last_attempt + schedule_seconds <= now` (`DueJobs`).
  Default market jobs: ohlcv 1m, funding/open-interest 5m.
- `backfill` — same loop, cursor-driven depth: the fetcher reads `job.Cursor` (start/end windows,
  page tokens) and returns the next `FetchResult.Next` checkpoint (history pulls, the daily
  instrument listing).
- `stream` — poll-tier, fetcher-owned cadence: dispatched through the identical gate as poll, but
  the fetcher owns the effective cadence via `FetchResult.NextRunHint` — the engine suppresses
  the next dispatch until the hint elapses (`apps/data/internal/ingest/engine.go`,
  `suppressJob`); the three ticker jobs (bybit/binance/okx, 30s) are seeded in this mode. On
  success the quotes are also written through to the Valkey hot cache as
  `data:quote:<venue_id>:<instrument_id>` (best-effort; the Postgres row from `WriteQuotes` is
  the record — `cacheQuotes` in `.../providers/bybit/klines.go`).

Every mode passes the same gates in `apps/data/internal/ingest/engine.go`: per-provider rate
limiter (5 rps, burst = rate), circuit breaker (open after 5 consecutive failures, 60 s half-open
probe), bounded worker pool (default 4). Failures back off exponentially (`2s * 2^attempt`, cap
5 m) and dead-letter into `data.ingestion_error`.

## Data quality and lineage

- `splitValid` (`apps/data/internal/ingest/repo/facts.go`) partitions every batch through the
  validators in `.../repo/validate.go`: accepted rows are written, rejected rows are counted in
  the `FetchResult` and journaled — never silently dropped, never faked with zeros, never fatal.
- Envelope/shape drift is all-or-nothing: a dataset whose rows are ALL unparseable returns
  `HardError{Kind: "shape"}` so the breaker/backoff owns it
  (`TestInstrumentsAllBadIsDatasetHardError` in `.../providers/bybit/bybit_test.go`).
- Lineage on every fact row: `source` (the provider name) and `retrieved_at` are stamped by the
  writers; observation rows additionally carry `provider` and `provider_record_id`.
- `canon.SchemaVersion` and `canon.NormalizationVersion` (`apps/data/internal/canon/versions.go`)
  are reported by `GET /api/data/health` (`handleHealth` in
  `apps/data/internal/ingest/serve/serve.go`) and carried on series rows; bump them deliberately
  on DDL-semantics or normalization-rule changes so a behavior change is never silent.

## Verification

```
go build ./apps/data/...
go test ./apps/data/...
bash scripts/verify/verify-all.sh
```

Manual probe (sidecar on `:3101`):

```
curl -X POST 'http://127.0.0.1:3101/api/data/ingest/run?provider=<name>&dataset=<dataset>[&subject=<s>&backfill=1]'
```

One synchronous `Fetch`; the response is the `FetchResult` (rows in/written/rejected). Then check
`GET /api/data/health` (`db:true`, your provider listed, `schema_version` unchanged unless you
bumped it on purpose) and `GET /api/data/runs?limit=5` for the journaled attempt.
