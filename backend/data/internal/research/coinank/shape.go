package coinank

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// CnEnvelope is the wire body for a coinank mode.
//
// DESIGN NOTE — why `data` is upstream verbatim.
//
// Same call as the coinglass family (CgEnvelope), for the same reason: CoinAnk's
// dashboard API already returns the exact object/array it renders, every field is
// already flat or a per-exchange map, and none of it is page-specific. Re-shaping
// it would invent a second vocabulary for data we did not author. The family
// passes the payload through untouched and spends its honesty budget on
// PROVENANCE instead.
//
// `derived` is the sentence that keeps this from being a blind proxy: it states
// what was done to the bytes, so a reader never has to guess whether a short row
// list is upstream's or the shaper's.
type CnEnvelope struct {
	Kind      string `json:"kind"`
	Upstream  string `json:"upstream"`
	FetchedAt int64  `json:"fetchedAt"`

	// Auth states how the request was authorised. For this family the value is
	// always the computed client signature: there is no issued key anywhere in
	// the path. Stated rather than implied, so nobody later "fixes" a missing
	// key into a config variable that never existed.
	Auth string `json:"auth"`

	// Interval echoes the effective interval for modes that take one. It is
	// echoed rather than omitted because the handler DEFAULTS it (the mode
	// accepts an omitted interval), and a reader must be able to tell which
	// value actually reached upstream without re-deriving the default.
	Interval string `json:"interval,omitempty"`

	// UpstreamCode/UpstreamMsg are upstream's own envelope fields, carried
	// verbatim. Upstream signals a refusal with success:false and a 200 status,
	// so the handler returns these as 502 — they never become a 200 with an
	// empty table.
	UpstreamCode string `json:"upstreamCode,omitempty"`
	UpstreamMsg  string `json:"upstreamMsg,omitempty"`

	// UpstreamCount is the row count, set only when the payload is an array.
	// An object payload (mode=whales) leaves it absent — `0` would assert a
	// measurement upstream never made.
	UpstreamCount *int `json:"upstreamCount,omitempty"`

	// Data is the payload, byte-for-byte from upstream's `data`.
	Data json.RawMessage `json:"data"`

	// Derived says what the shaper did to Data.
	Derived string `json:"derived"`

	// Cache is the X-Cache value. It is a header, not body state (json:"-").
	Cache string `json:"-"`
}

// Now is the injected clock (tests pin fetchedAt).
var Now = func() int64 { return time.Now().Unix() }

// HardError is a failure the handler must map to a specific status instead of a
// generic 502 — an upstream refusal, or a payload that decoded but is not the
// shape the mode promises.
type HardError struct {
	Kind   string // "upstream" | "non-json"
	URL    string
	Code   string
	Detail string
}

func (e *HardError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("coinank: %s (%s %s): %s", e.Kind, e.Code, e.URL, e.Detail)
	}
	return fmt.Sprintf("coinank: %s (%s): %s", e.Kind, e.URL, e.Detail)
}

// Service ties a Fetcher to the mode semantics.
type Service struct{ F *Fetcher }

// TTLDefault is the family's default cache TTL in seconds, for the boot log.
func TTLDefault() int { return defaultTTL }

// Envelope fetches and returns the response for one already-validated
// (mode, interval). Every failure is returned as an error; the handler maps it
// and never substitutes an empty payload.
func (s *Service) Envelope(ctx context.Context, mode, interval string, fresh bool) (CnEnvelope, error) {
	if mode == "liquidation" && interval == "" {
		interval = DefaultInterval
	}
	url := UpstreamURL(mode, interval)

	var (
		res  Result
		info CacheInfo
		err  error
	)
	if fresh {
		res, info, err = s.F.FetchFresh(ctx, url)
	} else {
		res, info, err = s.F.Fetch(ctx, url)
	}
	if err != nil {
		// A refusal already carries upstream's code and message (Decode builds
		// the HardError), so it propagates untouched.
		return CnEnvelope{}, err
	}

	env := CnEnvelope{
		Kind:         mode,
		Upstream:     url,
		FetchedAt:    Now(),
		Auth:         AuthNote,
		UpstreamCode: res.Envelope.Code,
		Data:         res.Envelope.Data,
		Cache:        info.Cache,
	}
	if mode == "liquidation" {
		env.Interval = interval
	}
	if res.Envelope.Msg != nil {
		env.UpstreamMsg = *res.Envelope.Msg
	}

	if len(env.Data) == 0 || string(env.Data) == "null" {
		// success:true with a null body is still "no measurement". Say so
		// rather than shipping data:null with a row count of 0.
		return CnEnvelope{}, &HardError{
			Kind: "non-json", URL: url,
			Detail: "upstream reported success but sent no data (data is null)",
		}
	}

	// Count arrays so a consumer (and the verifier) can assert the shape without
	// walking the payload.
	var rows []json.RawMessage
	if err := json.Unmarshal(env.Data, &rows); err == nil {
		n := len(rows)
		env.UpstreamCount = &n
		env.Derived = fmt.Sprintf(
			"upstream `data` verbatim (%d rows, %s)", n, AuthNote)
	} else {
		env.Derived = fmt.Sprintf(
			"upstream `data` verbatim (object, %s)", AuthNote)
	}
	return env, nil
}

// AuthNote is the provenance sentence for how the request was authorised. It is
// a constant because the answer never varies: computed client signature, no
// issued key. Keeping it here means the same words appear in `derived` and in
// the tests.
const AuthNote = "keyless client signature, no decryption"
