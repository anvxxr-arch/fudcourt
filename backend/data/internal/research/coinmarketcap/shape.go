package coinmarketcap

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// CmcEnvelope is the wire body for a coinmarketcap mode.
//
// DESIGN NOTE — why `data` is upstream verbatim.
//
// Same call as the CoinGlass and CoinAnk families, for the same reason:
// CoinMarketCap's dashboard API already returns the exact object it renders,
// every field is already flat or a per-exchange object, and none of it is
// page-specific. Re-shaping it would invent a second vocabulary for data we did
// not author. The family passes the payload through untouched and spends its
// honesty budget on PROVENANCE instead.
//
// `derived` is the sentence that keeps this from being a blind proxy: it states
// what was done to the bytes, so a reader never has to guess whether a short row
// list is upstream's or the shaper's.
type CmcEnvelope struct {
	Kind      string `json:"kind"`
	Upstream  string `json:"upstream"`
	FetchedAt int64  `json:"fetchedAt"`

	// Auth states how the request was authorised. For this family the value is
	// always the same sentence: no credential at all. Stated rather than
	// implied, so nobody later "fixes" a missing key into a config variable
	// that never existed.
	Auth string `json:"auth"`

	// Slug echoes the coin slug for mode=marketPairs. It is echoed rather than
	// omitted because it is the caller's own input and the row set is scoped to
	// it — a reader must be able to tell which coin a pair list belongs to
	// without re-parsing the upstream URL.
	Slug string `json:"slug,omitempty"`

	// Start/Limit echo the effective pagination for the paginated modes. They
	// are echoed because the handler DEFAULTS them, and a reader must be able to
	// tell which values actually reached upstream without re-deriving them.
	Start *int `json:"start,omitempty"`
	Limit *int `json:"limit,omitempty"`

	// UpstreamCode/UpstreamMsg are upstream's own envelope status fields,
	// carried verbatim. Upstream signals a refusal with error_code != "0" and a
	// 200 status, so the handler returns these as 502 — they never become a 200
	// with an empty table.
	UpstreamCode string `json:"upstreamCode,omitempty"`
	UpstreamMsg  string `json:"upstreamMsg,omitempty"`

	// UpstreamCount is the row count, set only when the payload carries an array
	// at the mode's known path. An object payload (mode=global) leaves it absent
	// — `0` would assert a measurement upstream never made.
	UpstreamCount *int `json:"upstreamCount,omitempty"`

	// Data is the payload, byte-for-byte from upstream's `data`.
	Data json.RawMessage `json:"data"`

	// Derived says what the shaper did to Data.
	Derived string `json:"derived"`

	// Cache is the X-CMC-Cache value. It is a header, not body state (json:"-").
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
		return fmt.Sprintf("coinmarketcap: %s (%s %s): %s", e.Kind, e.Code, e.URL, e.Detail)
	}
	return fmt.Sprintf("coinmarketcap: %s (%s): %s", e.Kind, e.URL, e.Detail)
}

// Service ties a Fetcher to the mode semantics.
type Service struct{ F *Fetcher }

// TTLDefault is the family's default cache TTL in seconds, for the boot log.
func TTLDefault() int { return defaultTTL }

// Envelope fetches and returns the response for one already-validated
// (mode, slug, start, limit). Every failure is returned as an error; the handler
// maps it and never substitutes an empty payload.
func (s *Service) Envelope(ctx context.Context, mode, slug string, start, limit int, fresh bool) (CmcEnvelope, error) {
	url := UpstreamURL(mode, slug, start, limit)

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
		return CmcEnvelope{}, err
	}

	env := CmcEnvelope{
		Kind:         mode,
		Upstream:     url,
		FetchedAt:    Now(),
		Auth:         AuthNote,
		UpstreamCode: res.Envelope.Status.ErrorCode,
		Data:         res.Envelope.Data,
		Cache:        info.Cache,
	}
	if mode == "marketPairs" {
		env.Slug = slug
	}
	if isPaginated(mode) {
		env.Start = &start
		env.Limit = &limit
	}
	if res.Envelope.Status.ErrorMessage != "" {
		env.UpstreamMsg = res.Envelope.Status.ErrorMessage
	}

	if len(env.Data) == 0 || string(env.Data) == "null" {
		// error_code "0" with a null body is still "no measurement". Say so
		// rather than shipping data:null with a row count of 0.
		return CmcEnvelope{}, &HardError{
			Kind: "non-json", URL: url,
			Detail: "upstream reported success but sent no data (data is null)",
		}
	}

	// Count arrays so a consumer (and the verifier) can assert the shape without
	// walking the payload. The path is per-mode and shared with the verifier via
	// ArrayPath, so the two cannot disagree about where the rows live.
	if path := arrayPath(mode); path != "" {
		if n, ok := countRows(env.Data, path); ok {
			env.UpstreamCount = &n
			env.Derived = fmt.Sprintf(
				"upstream `data` verbatim (%d rows at data.%s, %s)", n, path, AuthNote)
			return env, nil
		}
	}
	env.Derived = fmt.Sprintf("upstream `data` verbatim (object, %s)", AuthNote)
	return env, nil
}

// isPaginated reports whether a mode takes start/limit.
func isPaginated(mode string) bool {
	switch mode {
	case "listing", "exchanges", "marketPairs":
		return true
	default: // global
		return false
	}
}

// countRows returns the length of the array at the dotted path inside `data`.
// It is deliberately strict: it returns ok=false unless the path resolves to an
// actual JSON array, so a shape drift (upstream renames the key) surfaces as an
// absent count rather than a silent 0.
func countRows(data json.RawMessage, path string) (int, bool) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return 0, false
	}
	raw, ok := obj[path]
	if !ok {
		return 0, false
	}
	var rows []json.RawMessage
	if err := json.Unmarshal(raw, &rows); err != nil {
		return 0, false
	}
	return len(rows), true
}

// AuthNote is the provenance sentence for how the request was authorised. It is
// a constant because the answer never varies: no credential, no signature, no
// decryption — the dashboard's own open endpoint. Keeping it here means the same
// words appear in `derived` and in the tests.
const AuthNote = "keyless dashboard endpoint, no credential, no signature"
