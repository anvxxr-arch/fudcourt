// Package polymarket is the Polymarket provider adapter: the open prediction
// markets from the Gamma API, and the entity upserts the rows imply.
//
// Endpoint (public, keyless):
//
//	markets  GET https://gamma-api.polymarket.com/markets
//	         ?limit=100&offset=<cursor>&active=true&closed=false
//
// Wire shape: a JSON array of market objects. outcomes and outcomePrices are
// JSON-ENCODED STRINGS on this API ('["Yes","No"]', '["0.52","0.48"]'), so a
// row decodes twice: the page array, then the pair arrays.
//
// Every market mints its canonical id with the prediction kind
// (canon.PredictKey) and writes one canon.PredictionMarket row; the first
// rows also register the provider symbol (gamma id -> prediction id) so the
// resolver can answer without a live call. Rows whose outcomes/prices arrays
// are malformed are counted as rejected, never guessed into shape.
//
// TLS posture: the client is httpx.NewClient — the SAME shared transport the
// research families use (TLS >= 1.2, HTTP/2, ProxyFromEnvironment). The
// live "x509: certificate is valid for intern..." failure measured in the
// field is upstream interception that serves a certificate for a hostname
// gamma-api.polymarket.com does not match; verification stays ON (the repo
// ships no InsecureSkipVerify anywhere), so such a body fails as a transport
// HardError and the engine's breaker owns it — it is never worked around in
// client code.
package polymarket
