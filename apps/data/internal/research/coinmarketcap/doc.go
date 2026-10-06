// Package coinmarketcap is the CoinMarketCap market-data family: the plain
// net/http fetcher, the JSON envelope, and the local pagination bounds.
//
// # Why this needs no API key (the third keyless provider)
//
// CoinMarketCap ships two surfaces:
//
//	pro-api.coinmarketcap.com  -> the documented API; needs an issued
//	                              `X-CMC_PRO_API_KEY`, billed per credit
//	api.coinmarketcap.com      -> the dashboard's OWN backend; NO key at all
//
// The second surface is the one this family uses. It is the endpoint the
// coinmarketcap.com site itself calls, and it carries no credential, no
// signature, and no encrypted payload — which makes it the THIRD distinct
// "keyless" mechanism in this sidecar, after coinglass (an encrypted body we
// decrypt) and coinank (a credential computed client-side). Stating the three
// apart is the point: a reader must not assume one scheme covers all three.
//
// # No silence
//
// CoinMarketCap's failure modes are quiet, and each is handled explicitly:
//
//   - A REFUSAL is HTTP 200 with `status.error_code != "0"` (measured: "400"
//     for marketPairs with no slug, "500" "The system is busy, please try again
//     later!" for an unknown slug and for a non-integer limit). It is upstream
//     refusing, and it must surface as a real error — never a 200 with an empty
//     table.
//   - An EMPTY-LIST trap: `limit=0` answers HTTP 200 with `error_code "0"` and
//     `{"cryptoCurrencyList":[],"totalCount":"8138"}`. Nothing about that
//     response says "you asked for zero rows" as opposed to "this market has no
//     coins", so the bounds are enforced LOCALLY and a bad value is a 400 before
//     any request is made.
//   - An IGNORED PARAM: `?bogus=1` returns the ordinary listing. Upstream does
//     not reject an unrecognised query param, so the param-scoping matrix is
//     enforced here — a param a mode does not accept is a 400, never silently
//     dropped.
package coinmarketcap
