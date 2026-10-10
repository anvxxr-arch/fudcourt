// Package imf is the IMF DataMapper provider adapter: canonical annual
// economic series per indicator and country (real GDP growth, inflation,
// unemployment) from the public v1 API.
//
// Endpoints (public, keyless):
//
//	indicators  GET https://www.imf.org/external/datamapper/api/v1/{indicator}/{country} (e.g. NGDP_RPCH/USA)
//
// Wire shape is {"values":{"NGDP_RPCH":{"SDN":{"1980":2.5,...},...}}} —
// indicator -> country -> year -> value (values may be null). The series
// subject is country:<iso2 lower> from the response's country key; the metric
// is the lowercased indicator; frequency annual; observed_at is Jan 1 of the
// year. Null values are skipped, never written as 0. The job subject is a
// comma-separated indicator list; the cursor pins the last observed year per
// indicator. Every fetch is ONE attempt: the engine owns retries; a failure
// here is a typed HardError and nothing partial is written.
package imf
