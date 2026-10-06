package coinglass

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// CgEnvelope is the wire body for a coinglass mode.
//
// DESIGN NOTE — why `data` is upstream verbatim.
//
// The other families in this sidecar project and re-name fields, because their
// upstreams ship a page-shaped payload that a UI would otherwise have to
// understand. CoinGlass is different: the dashboard's OWN API already returns the
// exact object/array it renders, every field is already a flat scalar or a
// per-exchange map, and nothing about it is page-specific. Re-shaping it would
// mean inventing a second vocabulary for data we did not author — the kind of
// duplicate that drifts. So the family passes the decrypted payload through
// untouched and spends its honesty budget on PROVENANCE instead: `upstream`,
// `cipher` (the `v` header upstream chose), `encrypted`, `upstreamCount` and
// `derived`.
//
// `derived` is the sentence that keeps this from being a blind proxy: it states
// what was actually done to the bytes, so a reader never has to guess whether a
// short row list is upstream's or the shaper's.
type CgEnvelope struct {
	Kind      string `json:"kind"`
	Upstream  string `json:"upstream"`
	FetchedAt int64  `json:"fetchedAt"`

	// Cipher is the `v` header the response carried: which rotation slot
	// produced this payload's keys. It is exposed because the v table is the
	// single most fragile part of the scheme — a future reader seeing an
	// unfamiliar value here has found a rotated slot before it became a
	// padding error.
	Cipher string `json:"cipher,omitempty"`
	// Encrypted is false when upstream answered plain JSON (it mixes both, e.g.
	// a refusal). Stated rather than implied, so a consumer can tell a decoded
	// payload from a forwarded one.
	Encrypted bool `json:"encrypted"`

	// UpstreamCode/UpstreamMsg are upstream's own envelope fields, carried
	// verbatim. A non-"0" code is a refusal and the handler returns it as 502 —
	// it never becomes a 200 with an empty table.
	UpstreamCode string `json:"upstreamCode,omitempty"`
	UpstreamMsg  string `json:"upstreamMsg,omitempty"`

	// UpstreamCount is the row count, set only when the payload is an array.
	// A wrong decryption cannot produce a plausible array, so this doubles as a
	// cheap sanity signal.
	UpstreamCount *int `json:"upstreamCount,omitempty"`

	// Data is the decrypted payload, byte-for-byte from upstream's `data`.
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
	Kind   string // "upstream" | "non-json" | "shape"
	URL    string
	Code   string
	Detail string
}

func (e *HardError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("coinglass: %s (%s %s): %s", e.Kind, e.Code, e.URL, e.Detail)
	}
	return fmt.Sprintf("coinglass: %s (%s): %s", e.Kind, e.URL, e.Detail)
}

// Service ties a Fetcher to the mode semantics.
type Service struct{ F *Fetcher }

// TTLDefault is the family's default cache TTL in seconds, for the boot log.
func TTLDefault() int { return defaultTTL }

// Envelope fetches and returns the response for one already-validated
// (mode, symbol). Every failure is returned as an error; the handler maps it and
// never substitutes an empty payload.
func (s *Service) Envelope(ctx context.Context, mode, symbol string, fresh bool) (CgEnvelope, error) {
	url := UpstreamURL(mode, symbol)
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
		return CgEnvelope{}, err
	}

	// Upstream's own refusal is a real answer. Surface it as a 502 carrying
	// CoinGlass's message — never as a 200 whose data is null.
	if res.Refused() {
		return CgEnvelope{}, &HardError{
			Kind: "upstream", URL: url, Code: res.Code,
			Detail: fmt.Sprintf("CoinGlass refused the request: %s", firstNonEmpty(res.Msg, "(no message)")),
		}
	}

	if !json.Valid(res.JSON) {
		return CgEnvelope{}, &HardError{Kind: "non-json", URL: url, Detail: "decrypted payload is not valid JSON"}
	}

	env := CgEnvelope{
		Kind:         mode,
		Upstream:     url,
		FetchedAt:    info.FetchedAt,
		Cipher:       res.V,
		Encrypted:    res.Encrypted,
		UpstreamCode: res.Code,
		UpstreamMsg:  res.Msg,
		Data:         res.JSON,
		Cache:        info.Cache,
	}

	// Count arrays so a consumer (and the verifier) can assert the shape
	// without walking the payload. An object payload leaves the field absent —
	// `0` would assert a measurement upstream never made.
	var rows []json.RawMessage
	if err := json.Unmarshal(res.JSON, &rows); err == nil {
		n := len(rows)
		env.UpstreamCount = &n
		env.Derived = fmt.Sprintf("upstream `data` verbatim (%d rows, %s)", n, cipherNote(res))
	} else {
		env.Derived = fmt.Sprintf("upstream `data` verbatim (object, %s)", cipherNote(res))
	}
	return env, nil
}

// cipherNote describes how the bytes arrived, for the derived sentence.
func cipherNote(res Result) string {
	if !res.Encrypted {
		return "plain JSON, no decryption needed"
	}
	return "AES-128-ECB x2 + gzip, v=" + res.V
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}
