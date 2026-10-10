// Package bi is the Bank Indonesia provider adapter: canonical Indonesian
// monetary series (BI rate, USD middle rate) from the public SEKI/SPPI API.
//
// Endpoints (public; the gateway may demand X-API-KEY, sent when
// BI_API_KEY is set):
//
//	series  GET https://api.bi.go.id/v1/public/{statistic} (e.g. /seki/bi_rate, /seki/kurs_tengah/USD)
//
// Wire shape is {"status":"success","data":[{"sifat":"FB","date":"2024-01-31",
// "value":"6.00"},...]}. The series is economy/<statistic slug>/country:id;
// frequency comes from the endpoint config; a row with no numeric value
// skips, never writes 0. An empty key when the gateway demands one surfaces
// as the gateway's response (or a no-credentials HardError where the config
// declares the key required) — the seeded jobs mirror this: Enabled=false
// until BI_API_KEY is present. The cursor pins the last observed date so the
// next run resumes incrementally. Every fetch is ONE attempt: the engine
// owns retries; a failure here is a typed HardError and nothing partial is
// written.
package bi
