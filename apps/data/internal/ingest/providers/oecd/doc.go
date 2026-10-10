// Package oecd is the OECD SDMX provider adapter: canonical annual economic
// series from the sdmx.oecd.org public data endpoint, parsed from
// csvfilewithlabels CSV responses.
//
// Endpoints (public, keyless):
//
//	dataflow  GET https://sdmx.oecd.org/public/rest/data/{agency},{df},{version}/{key}?format=csvfilewithlabels&dimensionAtObservation=AllDimensions&startPeriod=YYYY
//
// Columns vary per dataflow, so the parser stays generic: the header row is
// read once and the dataset config maps the canonical fields (OBS_VALUE,
// TIME_PERIOD, REF_AREA) to whatever column names the flow uses. Each CSV row
// becomes one observation on series economy/<metric>/country:<REF_AREA
// lower>; rows with an empty or non-numeric OBS_VALUE are skipped, never
// written as 0. The job subject is the full request path
// "{agency},{df},{version}/{key}"; the cursor pins the last observed
// TIME_PERIOD so the next run advances startPeriod. Every fetch is ONE
// attempt: the engine owns retries; a failure here is a typed HardError and
// nothing partial is written.
package oecd
