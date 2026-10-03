// Package session verifies the FUDCourt signed session cookie at the
// executor's private HTTP surface.
//
// # WHY THIS EXISTS HERE (deliberate duplication, recorded)
//
// The canonical Go implementation of the session cookie lives in
// backend/api/internal/access/identity (cookie.go). It cannot be reused: the
// objective's dependency rules forbid cross-service implementation imports
// ("Services may share contracts, not implementation"; .ai/restructure-fudcourt.md
// §DOMAIN DEPENDENCY RULES), and both modules live under internal/, so the
// compiler would refuse the import anyway. The accepted alternative — a shared
// Go contracts/math module — does not exist yet and creating one is an
// architectural decision with its own rollout, not a side effect of this
// surface.
//
// This file is therefore a WIRE-FAITHFUL port of the cookie format
// (base64url(payload) "." base64url(HMAC-SHA256(secret, payload)) with the
// SessionClaims JSON in field order), not a re-implementation of a policy: the
// only behaviour it owns is "verify the signature, parse the claims, check
// expiry", exactly as session.ts / cookie.go do. session_test.go pins the
// format with a golden token minted by the api implementation, so the two
// copies cannot drift silently.
//
// SECURITY NOTE (a decision someone must record, not hide): the web tier
// proxies `/api/executor/*` to this service with the browser's cookie, so this
// service now performs the SAME session verification the web tier performs.
// The shared secret (FUDCOURT_SESSION_SECRET) is consequently present in this
// process too. The listener stays loopback-only (the web tier is the only
// client) so the secret is not reachable off-host.
package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// CookieName is the cookie carrying the signed session (SESSION_COOKIE in
// session.ts / SessionCookieName in the api's identity package).
const CookieName = "fud_session"

// minSecretLen is the fail-closed secret floor from session.ts: a secret
// shorter than 32 characters is not a secret, so verification reports "no
// session" instead of degrading into forgeable cookies.
const minSecretLen = 32

// ErrNoSession is the single "not authenticated" refusal. It says nothing
// about WHY verification failed (missing, forged and expired are
// indistinguishable to a caller — telling a thief when their cookie was
// noticed is a leak).
var ErrNoSession = errors.New("session: no valid session")

// ErrSecretMissing marks a missing/short FUDCOURT_SESSION_SECRET. It is a
// deployment fault, not a caller fault: the request is fine, the operator's
// environment is not.
var ErrSecretMissing = errors.New("session: FUDCOURT_SESSION_SECRET is missing or shorter than 32 characters")

// Tier is an authorization level, totally ordered by Rank exactly as
// TIER_RANK in session.ts.
type Tier string

const (
	// TierPublic is anonymous access: the rank floor everyone has.
	TierPublic Tier = "public"
	// TierMember is a resolved guild member.
	TierMember Tier = "member"
	// TierTeam is the treasury/operations tier; `/api/executor` requires it.
	TierTeam Tier = "team"
	// TierAdmin is the highest tier.
	TierAdmin Tier = "admin"
)

// Rank returns the numeric order of the tier. An unknown tier ranks 0 so it
// can never out-rank a known one.
func (t Tier) Rank() int {
	switch t {
	case TierAdmin:
		return 3
	case TierTeam:
		return 2
	case TierMember:
		return 1
	case TierPublic:
		return 0
	default:
		return 0
	}
}

// AtLeast reports whether t satisfies the required tier (the rank comparison
// shared by hasTier in guard.ts).
func (t Tier) AtLeast(need Tier) bool { return t.Rank() >= need.Rank() }

// Claims is the signed payload of one session cookie (SessionClaims in
// session.ts). The JSON field order is the wire order.
type Claims struct {
	ID         string   `json:"id"`
	Username   string   `json:"username"`
	GlobalName *string  `json:"globalName"`
	Avatar     *string  `json:"avatar"`
	Tier       Tier     `json:"tier"`
	Roles      []string `json:"roles"`
	// Exp is the expiry in epoch SECONDS (session.ts compares exp*1000 against
	// Date.now()).
	Exp int64 `json:"exp"`
}

// base64URL is Node's Buffer base64url: standard alphabet, no padding.
var base64URL = base64.RawURLEncoding

// VerifySecret validates a session secret. Invariant: there is no fallback
// key — without this there is no session at all.
func VerifySecret(secret string) error {
	if len(secret) < minSecretLen {
		return ErrSecretMissing
	}
	return nil
}

// hmacBase64URL is HMAC-SHA256 of the payload STRING bytes (the base64url
// text, not the decoded JSON), base64url-encoded unpadded.
func hmacBase64URL(secret, payload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return base64URL.EncodeToString(mac.Sum(nil))
}

// tierOrNull accepts only the four known tier strings; anything else is not a
// session.
func tierOrNull(value any) Tier {
	s, ok := value.(string)
	if !ok {
		return ""
	}
	switch Tier(s) {
	case TierPublic, TierMember, TierTeam, TierAdmin:
		return Tier(s)
	}
	return ""
}

// stringArray keeps only actual strings, in order (stringArray in session.ts).
func stringArray(values []any) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// parseClaims decodes the payload exactly as parseClaims in session.ts: a
// missing id/username, a non-numeric exp or an unknown tier is not a session.
func parseClaims(payload string) (*Claims, bool) {
	raw, err := base64URL.DecodeString(payload)
	if err != nil {
		return nil, false
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return nil, false
	}
	id, ok := obj["id"].(string)
	if !ok {
		return nil, false
	}
	username, ok := obj["username"].(string)
	if !ok {
		return nil, false
	}
	exp, ok := obj["exp"].(float64)
	if !ok {
		return nil, false
	}
	tier := tierOrNull(obj["tier"])
	if tier == "" {
		return nil, false
	}
	var globalName *string
	if s, ok := obj["globalName"].(string); ok {
		globalName = &s
	}
	var avatar *string
	if s, ok := obj["avatar"].(string); ok {
		avatar = &s
	}
	roles := []string{}
	if list, ok := obj["roles"].([]any); ok {
		roles = stringArray(list)
	}
	return &Claims{
		ID:         id,
		Username:   username,
		GlobalName: globalName,
		Avatar:     avatar,
		Tier:       tier,
		Roles:      roles,
		Exp:        int64(exp),
	}, true
}

// FromCookie verifies and decodes a cookie value. Any parse, shape, signature
// or expiry failure returns ErrNoSession; a missing/short secret returns
// ErrSecretMissing. Invariant: the signature is computed over the payload's
// WIRE bytes, so every token the web tier mints verifies here.
func FromCookie(secret, value string, now time.Time) (*Claims, error) {
	if err := VerifySecret(secret); err != nil {
		return nil, err
	}
	if value == "" {
		return nil, ErrNoSession
	}
	dot := strings.Index(value, ".")
	if dot <= 0 {
		return nil, ErrNoSession
	}
	payload, sig := value[:dot], value[dot+1:]
	if !hmac.Equal([]byte(sig), []byte(hmacBase64URL(secret, payload))) {
		return nil, ErrNoSession
	}
	claims, ok := parseClaims(payload)
	if !ok {
		return nil, ErrNoSession
	}
	if claims.Exp*1000 <= now.UnixMilli() {
		return nil, ErrNoSession
	}
	return claims, nil
}

// RequireTeam is the one `/api/executor/*` gate (requireExecutorUser in
// runtime.ts): a verified session AT LEAST team tier, or the single 401
// refusal. Both "no session" and "session below tier" are the same refusal
// because that is exactly what the TS gate does — it answers one 401 whether
// the session is absent or merely insufficient.
func RequireTeam(secret, value string, now time.Time) (*Claims, error) {
	claims, err := FromCookie(secret, value, now)
	if err != nil {
		return nil, err
	}
	if !claims.Tier.AtLeast(TierTeam) {
		return nil, ErrNoSession
	}
	return claims, nil
}

// TestGoldenTokenCrossTier is a documented cross-tier interop vector: the token
// below was minted by backend/api's identity.CreateSessionToken (the canonical
// implementation) and MUST verify here, or the executor surface would reject
// every session the rest of the system issues. Regenerate with:
//
//	identity.CreateSessionToken("golden-shared-secret-0123456789abcde",
//	    SessionClaims{ID:"u-1", Username:"neo", Tier:"team", Roles:[]string{}},
//	    3600, time.UnixMilli(1760000000000))
//
// (kept in the non-test file so the comment travels with the format notes).
const goldenTokenCrossTier = "eyJpZCI6InUtMSIsInVzZXJuYW1lIjoibmVvIiwiZ2xvYmFsTmFtZSI6bnVsbCwiYXZhdGFyIjpudWxsLCJ0aWVyIjoidGVhbSIsInJvbGVzIjpbXSwiZXhwIjoxNzYwMDAzNjAwfQ.CUfr9jpImxOVJZ80x10vAjkwvzgomTTO8baPybod_2o"

// goldenTokenSecret is the secret goldenTokenCrossTier was minted with.
const goldenTokenSecret = "golden-shared-secret-0123456789abcde"
