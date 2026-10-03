package binance

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

// DefaultRecvWindow is the request-validity window sent with every signed
// call. Binance rejects signed requests whose (timestamp, recvWindow) window
// does not cover server time (error -1021).
//
// ASSUMPTION: recvWindow=5000 ms is sent uniformly; the exact value FUDCourt
// wants is a deployment tuning knob not specified by the contract, and 5 s is
// the venue-documented common default. A clock skew beyond the window is
// surfaced as a classified venue error (-1021), never silently widened.
const DefaultRecvWindow = 5000

// SignQuery computes the Binance request signature for a query string: the
// HMAC-SHA256 of the EXACT bytes of query (the canonical parameter string as
// emitted by the request builder, WITHOUT any "&signature=" parameter and
// without a trailing separator), keyed with secret, rendered as a lowercase
// hex digest (hex.EncodeToString of the 32 raw HMAC bytes). Binance requires
// the signature appended as the FINAL parameter: query + "&signature=" + hex.
//
// Signing is deterministic: the same (query, secret) always yields the same
// byte-exact output. The secret is used only as the HMAC key here and is never
// rendered, logged or returned (PRD §109).
func SignQuery(query, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(query)) // never fails for a hash.Hash writer
	return hex.EncodeToString(mac.Sum(nil))
}
