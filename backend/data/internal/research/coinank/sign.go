// Package coinank is the CoinAnk futures-data family: the KEYLESS
// client-side signature, the plain net/http fetcher, and the JSON envelope.
//
// # Why this needs no API key either (the second keyless provider)
//
// CoinAnk ships two surfaces (docs/architecture/coinank-data-types.md):
//
//	open-api.coinank.com  -> the documented OpenAPI host; needs a real `apikey`
//	                         issued per plan tier (VIP1-VIP4), ~80 endpoints
//	api.coinank.com       -> the dashboard's OWN backend; NO issued key at all
//
// The second surface is the one this family uses. It does demand a header named
// `coinank-apikey`, but that value is not issued to anyone: the browser computes
// it from public inputs, so it is a client-side signature dressed up as a
// credential. There is therefore no key to procure here -- only a function to
// re-implement.
//
// # The signature (reconstructed from s.coinank.com/_nuxt/*.js, verified live)
//
//	UUID    = <36-char uuid constant shipped in the bundle>
//	C       = <13-digit constant added to the clock>
//	WEBVER  = "102"
//
//	apikey(t):
//	    prefix = UUID[8:] + UUID[:8]            // the 8-char head moved to the tail
//	    return base64( prefix + "|" + str(t + C) + "347" )
//
// Headers sent with every request: `coinank-apikey`, `web-version`, `client`,
// `token` (empty for anonymous), and an Origin/Referer of https://coinank.com.
//
// # The constants are in CODE, not prose, and that is deliberate
//
// They are protocol constants -- shipped to every browser, decoding public
// market data, authenticating to no account -- so they are not credentials and
// the DR-033 credential rule does not apply. They still do not belong in a
// document: prose cannot consume them, and a re-implementation needs them next
// to the derivation that uses them (same call as the CoinGlass `v` table in
// internal/research/coinglass/decrypt.go). coinank-data-types.md states the
// algorithm and points here.
//
// # No silence
//
// CoinAnk's failure modes are quiet, and each one is handled explicitly:
//
//   - A request MISSING a required param answers HTTP 200 with
//     `{"success":false,"code":"0","msg":"system error!"}` -- not a 4xx. That is
//     upstream refusing, and it must surface as a real error.
//   - An UNSUPPORTED value for a supported param (measured: `interval` outside
//     {1h,2h,4h,6h,12h,1d}) answers HTTP 200 with a well-formed row set whose
//     numbers are all **0**. Nothing about that response says "I did not
//     understand you". It is the exact "upstream 0 means not reported" trap, so
//     the supported set is enforced LOCALLY and a bad value is a 400 before any
//     request is made.
package coinank

import (
	"encoding/base64"
	"strconv"
	"strings"
)

// Bundle constants. See the package doc for why they live here.
const (
	// signUUID is the 36-char uuid the bundle uses as the "app id". Only its
	// first 8 characters and the remainder are ever used, and they are used
	// REORDERED (see Signature).
	signUUID = "b2d903dd-b31e-c547-d299-b6d07b7631ab"
	// signClockOffset is added to the millisecond clock before formatting.
	signClockOffset = 2222222222222
	// signSuffix is appended after the offset timestamp. It is part of the
	// signed string, not a separator.
	signSuffix = "347"
	// signPrefixLen is how many leading uuid characters get moved to the tail.
	signPrefixLen = 8
)

// WebVersion is the `web-version` header. The dashboard sends it on every call
// and the server accepts 102 today; it is a version gate, so it is pinned here
// and asserted in the tests rather than spread across call sites.
const WebVersion = "102"

// Client is the `client` header value for the anonymous web surface.
const Client = "web"

// Signature builds the `coinank-apikey` header for a millisecond timestamp.
//
// The uuid's first 8 characters are moved to the END. Note the JS original uses
// String.prototype.replace, which removes the FIRST occurrence only — not every
// occurrence. This code reproduces that exactly; a ReplaceAll would produce a
// different key the moment the 8-char head appeared twice, and the failure would
// be a 200 with `system error!` rather than anything that names the bug.
func Signature(nowMs int64) string {
	head := signUUID[:signPrefixLen]
	rest := strings.Replace(signUUID, head, "", 1)
	payload := rest + head + "|" + strconv.FormatInt(nowMs+signClockOffset, 10) + signSuffix
	return base64.StdEncoding.EncodeToString([]byte(payload))
}

// RequestHeaders is the full header set the dashboard sends.
//
// `token` is deliberately an EMPTY string rather than an omitted header: the
// dashboard always sends it (an anonymous visitor has an empty token), and the
// two are only equivalent while CoinAnk keeps treating the empty value as
// anonymous. Omitting it would silently depend on that same assumption without
// recording it.
func RequestHeaders(nowMs int64) map[string]string {
	return map[string]string{
		"Accept":          "application/json, text/plain, */*",
		"Accept-Language": "en-US,en;q=0.9",
		"Client":          Client,
		"Coinank-Apikey":  Signature(nowMs),
		"Origin":          "https://coinank.com",
		"Referer":         "https://coinank.com/",
		"Token":           "",
		"User-Agent":      UA,
		"Web-Version":     WebVersion,
	}
}
