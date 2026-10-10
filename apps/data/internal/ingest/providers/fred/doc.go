// Package fred is the FRED (Federal Reserve Economic Data) provider adapter:
// canonical economic series for the seeded U.S. aggregates (CPI, fed funds,
// GDP, unemployment) with daily incremental polls.
//
// Endpoints (require a free API key in FRED_API_KEY):
//
//	series meta   GET https://api.stlouisfed.org/fred/series?series_id=CPIAUCSL&api_key=...&file_type=json
//	observations  GET https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL&file_type=json&observation_start=YYYY-MM-DD
//
// A missing key raises HardError{Kind:"no-credentials"} at fetch start: the
// job stays scheduled (Enabled stays true) and the engine journals the failed
// attempts, but nothing is fetched or written until the operator provides the
// key. Wire shapes are {"seriess":[{id,title,units,frequency,...}]} and
// {"observations":[{date,value},...]}; a value of "." or "" is a
// published-but-missing period - the row is skipped, never written as 0.
// The job subject is a comma-separated list of FRED series ids; the cursor
// pins the last observed period per series id for the next incremental run.
// Every fetch is ONE attempt: the engine owns retries; a failure here is a
// typed HardError and nothing partial is written.
package fred
