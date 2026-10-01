// Package httpx holds the JSON response writer shared by the server and the
// served-bytes parity test, so the escaping rule is proven on production code
// rather than on a copy of it.
package httpx

import (
	"encoding/json"
	"log"
	"net/http"
)

// WriteJSON emits v the way JSON.stringify does: HTML characters are NOT
// escaped.
//
// encoding/json's default rewrites <, > and & as \u003c, \u003e and \u0026,
// which diverges from the TS body on exactly the fields that carry prose or
// URLs (news/media titles, aioverview summaries, ecosystem descriptions, tag
// names, coin names -- the recorded ecosystem fixture alone has 59 such
// characters). SetEscapeHTML(false) here is the top-level rule.
//
// It is NOT sufficient on its own: a value that reaches this encoder through a
// nested MarshalJSON has already been encoded by json.Marshal inside that
// method, and the outer `compact` pass can only ADD escapes, never remove them.
// Every nested marshaler in internal/research/cryptorank therefore uses marshalNoEscape too;
// internal/research/paritytest drives the real handler over the recorded fixtures and
// fails if either half regresses.
//
// Framing: the body is one JSON value followed by a single "\n" (from
// Encoder.Encode). That trailing newline is the only framing difference from
// JSON.stringify's bare value, and it is stable for every response.
func WriteJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "")
	if err := enc.Encode(v); err != nil {
		// The status line is already sent, so the body cannot be replaced; log
		// rather than emit a second, corrupt payload.
		log.Printf("httpx: encoding failure for %T: %v", v, err)
	}
}
