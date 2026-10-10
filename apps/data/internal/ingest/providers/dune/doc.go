// Package dune is the Dune provider adapter: a generic query adapter that
// turns the rows of one Dune query result into canonical metric points.
//
// Endpoint (requires an API key; no keyless fallback):
//
//	results  GET https://api.dune.com/api/v1/query/{query_id}/results?limit={n}
//	         header  X-DUNE-API-KEY: <key>
//
// The key is read once at module construction from DUNE_API_KEY. With no key,
// Fetch returns a no-credentials HardError without touching the network and
// the module registers ZERO seed jobs (operators add jobs by config: the job
// subject + cursor pin the query id and the column->metric mapping). The key
// travels only in the request header - never in a URL - and never appears in
// an error.
//
// Wire shape (real): {"result":{"rows":[{"block_date":"2026-01-01",
// "volume":123.4},...],"metadata":{"column_names":[...],"total_row_count":n,
// ...}},"state":"QUERY_STATE_COMPLETED",...}. Each row is an object; the job
// cursor's "columns" map decides which columns become which metrics:
//
//	cursor: {"query_id": 1234, "domain": "onchain",
//	         "columns": {"volume": "dex_volume_24h_usd"},
//	         "time_column": "block_date"}
//
// Every mapped column of every row becomes one MetricPoint on series
// series/<domain>/<metric>/global. Rows whose mapped value is missing or not
// numeric are counted, never faked. Every fetch is ONE attempt: the engine
// owns retries; a transport/shape failure here is a typed HardError and
// nothing is written.
package dune
