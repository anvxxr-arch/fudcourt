package chainrank

import (
	"context"
	"encoding/json"
	"time"
)

// This file is the wire shape: the two envelopes and the Service that ties a
// Fetcher to the mode semantics.
//
// # The envelope is the TS route's, key for key
//
// Both modes build `{kind, ...upstreamBody, upstream, fetchedAt}` -- upstream's
// own fields SPREAD FIRST, then our two labels. That spread is deliberate and
// load-bearing: chainrank adds fields to its rows freely, and a projection here
// would silently drop them. The board renders what upstream sent, and the two
// fields we own are clearly ours.
//
// So the shape is checked, not rebuilt: `CheckShape` asserts the fields the
// board renders are present and of the right type, and refuses (loud 502)
// otherwise. That is this family's "empty upstream ≠ valid answer" rule.
//
// Now is the injected clock (tests pin fetchedAt).
var Now = func() int64 { return time.Now().Unix() }

// Service ties a Fetcher to the mode semantics.
type Service struct{ F *Fetcher }

// Envelope fetches one already-validated (mode, upstream URL) and returns the
// body's fields with our two labels added, JSON-encoded.
//
// It returns raw bytes rather than a typed struct on purpose: upstream's
// envelope is spread verbatim, so the only faithful representation of "every
// upstream field, plus ours" is the decoded object itself.
func (s *Service) Envelope(ctx context.Context, mode, url string) (map[string]json.RawMessage, CacheInfo, error) {
	body, info, err := s.F.Fetch(ctx, mode, url)
	if err != nil {
		return nil, CacheInfo{}, err
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		return nil, CacheInfo{}, &ShapeError{Detail: "upstream " + mode + " returned an unrecognised shape"}
	}
	if err := CheckShape(mode, envelope); err != nil {
		return nil, CacheInfo{}, err
	}
	out := make(map[string]json.RawMessage, len(envelope)+3)
	for k, v := range envelope {
		out[k] = v
	}
	out["kind"], _ = json.Marshal(mode)
	out["upstream"], _ = json.Marshal(url)
	out["fetchedAt"], _ = json.Marshal(info.FetchedAt)
	return out, info, nil
}

// CheckShape asserts the fields the board renders, per mode. It is the port of
// the TS route's two `if` guards, with the field lists taken from the verifier
// (`verify-chainrank.py` asserts exactly these) so the contract has one home.
//
//	stats     online, totalClicks, listings, totalUsdCents, topUsdCents, claimTopCents (numbers)
//	listings  rows (array)
func CheckShape(mode string, envelope map[string]json.RawMessage) error {
	switch mode {
	case "stats":
		for _, f := range []string{"online", "totalClicks", "listings", "totalUsdCents", "topUsdCents", "claimTopCents"} {
			raw, ok := envelope[f]
			if !ok || !isNumber(raw) {
				return &ShapeError{Detail: "upstream stats returned an unrecognised shape"}
			}
		}
	case "listings":
		raw, ok := envelope["rows"]
		if !ok || !isArray(raw) {
			return &ShapeError{Detail: "upstream listings returned an unrecognised shape"}
		}
	default:
		// Unknown modes never reach here (the handler refuses first); a shape
		// check that guessed would be worse than one that says so.
		return &ShapeError{Detail: "no shape contract for mode '" + mode + "'"}
	}
	return nil
}

// isNumber reports whether a raw JSON value is a NUMBER -- not null, not a
// string, not a bool. The leading-byte test is what excludes `null` and `true`,
// which unmarshal into a numeric destination without error and would otherwise
// pass as data.
func isNumber(raw json.RawMessage) bool {
	s := trimSpace(raw)
	if len(s) == 0 || (s[0] != '-' && (s[0] < '0' || s[0] > '9')) {
		return false
	}
	var n json.Number
	return json.Unmarshal(s, &n) == nil
}

// isArray reports whether a raw JSON value is an ARRAY. The leading-byte test
// excludes `null`, which unmarshals into a slice without error.
func isArray(raw json.RawMessage) bool {
	s := trimSpace(raw)
	if len(s) == 0 || s[0] != '[' {
		return false
	}
	var a []json.RawMessage
	return json.Unmarshal(s, &a) == nil
}

// trimSpace is bytes.TrimSpace over the raw value.
func trimSpace(b []byte) []byte {
	for len(b) > 0 && (b[0] == ' ' || b[0] == '\t' || b[0] == '\n' || b[0] == '\r') {
		b = b[1:]
	}
	for len(b) > 0 {
		last := b[len(b)-1]
		if last == ' ' || last == '\t' || last == '\n' || last == '\r' {
			b = b[:len(b)-1]
			continue
		}
		break
	}
	return b
}
