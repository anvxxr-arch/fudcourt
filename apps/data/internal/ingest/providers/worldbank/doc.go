// Package worldbank is the World Bank Open Data provider adapter: canonical
// annual economic series per indicator and country (GDP, CPI, unemployment)
// from the v2 API.
//
// Endpoints (public, keyless):
//
//	indicators  GET https://api.worldbank.org/v2/country/IND;USA/indicator/NY.GDP.MKTP.CD?format=json&per_page=20000&page=N
//	sources     GET https://api.worldbank.org/v2/source?format=json
//
// Wire shape is a 2-element array: [meta {"page","pages","per_page","total"},
// rows []]. Each row carries {"indicator":{"id","value"},"country":{"id":"IN",
// "value":"India"},"countryiso3code":"IND","date":"2023","value":...}. The
// series subject is the ISO2 code in country.id (the ISO3 countryiso3code is
// ignored for identity); a row whose country.id is not a 2-char ISO2 code is
// skipped - aggregates and regions never mint series. Null/missing values are
// skipped, never written as 0. The job subject is "indicator:<ID>"; the
// cursor pins the last page and the last observed year per ISO2 so the next
// run resumes incrementally. Every fetch is ONE attempt: the engine owns
// retries; a failure here is a typed HardError and nothing partial is
// written.
package worldbank
