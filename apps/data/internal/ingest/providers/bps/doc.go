// Package bps is the BPS (Badan Pusat Statistik, Indonesia's statistics
// bureau) provider adapter: canonical economic series for one configured
// variable (seeded: var/347, inflation YoY) from the WebAPI v1.
//
// Endpoints (require the key pair BPS_API_KEY + BPS_API_ID):
//
//	subject list  GET https://webapi.bps.go.id/v1/api/list/model/domain/subject/key/{key}/id/{id}/domain/0000/
//	variable data GET https://webapi.bps.go.id/v1/api/list/model/data/lang/eng/domain/0000/key/{key}/id/{id}/var/{var}/turvar/{turvar}/verunit/{verunit}/...
//
// A missing key pair raises HardError{Kind:"no-credentials"} at fetch start;
// the seed job is ALSO registered Enabled=false so the engine never schedules
// it until the operator provides credentials (and can flip the row enabled).
// The wire shape is {"status":"OK","datacontent":{"variables":[...]},"var":[
// {"val":...,"label":...,"unit":...},...]} with per-period "tval" entries;
// rows with no numeric value skip, never write 0. The series is
// economy/<var-label slug>/country:id; the cursor pins the last period id so
// the next run skips already-stored periods. Every fetch is ONE attempt: the
// engine owns retries; a failure here is a typed HardError and nothing
// partial is written.
package bps
