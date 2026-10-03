package mexc

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

// MEXC request signing (the documented HEADER variant).
//
// MEXC documents more than one signing form for its REST API. Which exact
// form each endpoint accepts is not verifiable from this repository (no live
// calls in CI), so this adapter implements EXACTLY ONE form and marks the
// variant honestly:
//
// ASSUMPTION (signing variant — header variant):
//
//	signature = hex(HMAC-SHA256(secret, apiKey + timestampMs))
//
// with the credentials carried in request headers, never in the query string:
//
//	X-MEXC-APIKEY    = the API key
//	X-MEXC-TIMESTAMP = the signing timestamp (unix milliseconds, decimal)
//	X-MEXC-SIGNATURE = the signature above
//
// The OTHER documented variant signs `paramTime` — a request parameter that
// carries the timestamp and is folded into the signature material instead of
// the wall timestamp — and/or passes signature material as query parameters.
// That variant is NOT implemented here: the adapter signs the wall timestamp
// produced by the injected Clock and sends it in headers only. Endpoints that
// require the paramTime variant would need it added as a second, explicitly
// marked variant — never guessed.
//
// SECRET HYGIENE (PRD §109): the secret exists only inside Sign's HMAC; the
// API key, timestamp and signature travel in headers and MUST NEVER appear in
// errors, logs, messages or rendered request forms.

// Sign computes the MEXC header-variant signature:
// hex(HMAC-SHA256(secret, apiKey+timestamp)). It is deterministic and pure —
// tests pin it against independent HMAC-SHA256 vectors — and it never renders
// its inputs or the secret anywhere.
func Sign(secret, apiKey, timestamp string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(apiKey + timestamp))
	return hex.EncodeToString(mac.Sum(nil))
}
