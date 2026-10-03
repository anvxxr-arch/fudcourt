package bybit

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

// defaultRecvWindow is the recv-window sent with every signed request.
//
// ASSUMPTION: Bybit accepts a 5000 ms recv-window on all v5 endpoints; this is
// the documented default used by every public Bybit client, but the exact
// tolerance is not verifiable from this repository (no live calls in tests).
const defaultRecvWindow = "5000"

// Sign computes the Bybit v5 HMAC-SHA256 request signature in hex-lowercase.
//
// The signed string is EXACTLY this concatenation, with no separators:
//
//	timestamp + apiKey + recvWindow + payload
//
// where payload is the URL query string WITHOUT the leading '?' for GET
// requests (params joined in Bybit's required ASCII-sorted key order) and the
// raw JSON request body for POST requests. timestamp and recvWindow are the
// decimal-millisecond / decimal-millisecond strings sent in the X-BAPI-TIMESTAMP
// and X-BAPI-RECV-WINDOW headers, and apiKey is the X-BAPI-API-Key value — the
// signature covers the exact headers the request carries.
//
// The function is deterministic and dependency-free so tests can assert it
// byte-for-byte against an independent HMAC computation. The secret never
// leaves this function: it is used only as the HMAC key and is never rendered
// in any error, log or return value.
func Sign(timestamp, apiKey, secret, recvWindow, payload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte(apiKey))
	mac.Write([]byte(recvWindow))
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}
