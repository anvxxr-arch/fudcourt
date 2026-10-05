package identity

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

// Session cookie signing/verification — the port of the HMAC spine in
// frontend/web/src/server/auth.ts. Wire format, byte for byte:
//
//	token = base64url(payload) "." base64url(HMAC-SHA256(secret, payload))
//	payload = JSON of {id, username, globalName, avatar, tier, roles, exp}
//
// The signature covers the base64url payload string, exactly as
// hmacBase64Url(secret, payload) does in session.ts, so a cookie minted by the
// TypeScript side verifies here and one minted here verifies there. The wire
// JSON is keyed in SessionClaims field order — the same enumeration order
// JSON.stringify produces for the spread SessionUser + exp — so the payloads
// are byte-identical for the same claims.

// SessionCookieName is the cookie carrying the signed session (SESSION_COOKIE
// in session.ts).
const SessionCookieName = "fud_session"

// SessionMaxAge is the session lifetime in seconds — 7 days, matching both the
// cookie maxAge and SESSION_MAX_AGE in session.ts.
const SessionMaxAge = 7 * 24 * 60 * 60

// minSessionSecretLen is the fail-closed secret floor from session.ts: a
// FUDCOURT_SESSION_SECRET shorter than 32 characters is not a secret, so
// signing refuses and verification reports "no session" instead of degrading
// into forgeable cookies.
const minSessionSecretLen = 32

// CodeSessionSecretMissing names a signing/verifying attempt without a usable
// FUDCOURT_SESSION_SECRET. It is validation (deployment) class like
// CodeTierUnknownRole: the request is fine, the operator's environment is not.
const CodeSessionSecretMissing = "IDENTITY_SESSION_SECRET_MISSING"

// SessionClaims is the signed payload of one session cookie (SessionClaims in
// session.ts): the SessionUser fields plus exp. Field order is the wire order
// and matches JSON.stringify's enumeration of the spread SessionUser + exp.
type SessionClaims struct {
	ID         string   `json:"id"`
	Username   string   `json:"username"`
	GlobalName *string  `json:"globalName"`
	Avatar     *string  `json:"avatar"`
	Tier       Tier     `json:"tier"`
	Roles      []string `json:"roles"`
	// Exp is the expiry in epoch SECONDS (session.ts works in seconds and
	// compares exp*1000 against Date.now()).
	Exp int64 `json:"exp"`
}

// SessionSecret validates an environment secret exactly as sessionSecret() in
// session.ts: present and at least 32 characters, else refused. Invariant:
// there is no fallback key — without this there is no session at all.
func SessionSecret(env string) (string, error) {
	if len(env) < minSessionSecretLen {
		return "", errs.New(errs.CategoryValidation, CodeSessionSecretMissing,
			"FUDCOURT_SESSION_SECRET is missing or shorter than 32 characters")
	}
	return env, nil
}

// stringArray is stringArray in session.ts: only actual strings survive, in
// order; anything else in the array is dropped.
func stringArray(values []any) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// tierOrNull is tierOrNull in session.ts: only the four known tier strings are
// a Tier; everything else is not a session.
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

// base64URL is Node's Buffer base64url: standard alphabet, no padding.
var base64URL = base64.RawURLEncoding

// hmacBase64Url is hmacBase64Url in session.ts: HMAC-SHA256 of the payload
// STRING bytes (the base64url text, not the decoded JSON), base64url-encoded
// unpadded.
func hmacBase64URL(secret, payload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return base64URL.EncodeToString(mac.Sum(nil))
}

// parseClaims is parseClaims in session.ts, run at the boundary: anything not
// matching the SessionUser contract (missing id or username, non-numeric exp,
// unknown tier) is not a session. Non-string globalName/avatar degrade to null
// and a non-string list degrades role by role, exactly as the TS parser
// normalises.
func parseClaims(payload string) (*SessionClaims, bool) {
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
	return &SessionClaims{
		ID:         id,
		Username:   username,
		GlobalName: globalName,
		Avatar:     avatar,
		Tier:       tier,
		Roles:      roles,
		Exp:        int64(exp),
	}, true
}

// CreateSessionToken mints the signed cookie value for one user — the port of
// createSessionToken in session.ts. ttlSeconds is relative to now, which is
// epoch milliseconds so callers can freeze the clock in tests. The wire JSON
// is the SessionClaims struct in field order (id, username, globalName,
// avatar, tier, roles, exp), the same order JSON.stringify produces for the
// spread SessionUser + exp. Exp is truncated to whole seconds exactly as
// Math.floor(now/1000) + ttl does. nil/empty roles serialize as `[]`, never
// `null`, because stringArray always returns an array.
func CreateSessionToken(secret string, user SessionClaims, ttlSeconds int64, now time.Time) (string, error) {
	if _, err := SessionSecret(secret); err != nil {
		return "", err
	}
	claims := user
	claims.Exp = now.UnixMilli()/1000 + ttlSeconds
	if claims.Roles == nil {
		claims.Roles = []string{}
	}
	raw, err := json.Marshal(&claims)
	if err != nil {
		return "", errs.Wrap(errs.CategoryInternal, "INTERNAL", "session claims do not serialize", err)
	}
	payload := base64URL.EncodeToString(raw)
	return payload + "." + hmacBase64URL(secret, payload), nil
}

// ReadSession verifies and decodes a cookie value — the port of readSession in
// session.ts. Any parse, shape, signature or expiry failure means "no session":
// (nil, nil), never an error and never a trust-the-payload path. Invariant:
// the signature is computed over the payload's WIRE bytes (the base64url text
// exactly as it arrived), the same bytes hmacBase64Url signed in session.ts, so
// every token the TS side verifies is verified here and vice versa. Claims are
// parsed only after the signature checks out, so unauthenticated bytes are
// never believed; the expiry check uses exp*1000 <= now so a token expires at
// the same instant in both runtimes. A missing/short secret is also "no
// session" (fail-closed), exactly as session.ts degrades.
func ReadSession(secret, value string, now time.Time) (*SessionClaims, error) {
	if len(secret) < minSessionSecretLen || value == "" {
		return nil, nil
	}
	dot := strings.Index(value, ".")
	if dot <= 0 {
		return nil, nil
	}
	payload, sig := value[:dot], value[dot+1:]
	want := hmacBase64URL(secret, payload)
	if subtle.ConstantTimeCompare([]byte(sig), []byte(want)) != 1 {
		return nil, nil
	}
	claims, ok := parseClaims(payload)
	if !ok {
		return nil, nil
	}
	if claims.Exp*1000 <= now.UnixMilli() {
		return nil, nil
	}
	return claims, nil
}

// CodeSessionRequired names the wire refusal for a route that needs a live
// session and got none. The message deliberately says nothing about WHY the
// session did not verify (missing, forged or expired are indistinguishable to
// a caller — telling a thief when their stolen cookie was noticed is a leak).
const CodeSessionRequired = "IDENTITY_SESSION_REQUIRED"

// ErrSessionRequired is that refusal as a canonical error (401 at the route
// layer: the caller is simply not authenticated).
var ErrSessionRequired = errs.New(errs.CategoryUnauthenticated, CodeSessionRequired,
	"authentication required: no valid session")

// SessionFromCookie is the one bridge from a raw Cookie header value to a
// verified session: "no session" becomes the single canonical refusal so every
// handler answers identically. Invariant: this NEVER trusts any header other
// than the signed cookie — a proxy-supplied identity is spoofable and is not
// an input. The domain-level validity rule (Session.Require) is the last gate,
// so a future user store only has to change the User state it feeds here.
func SessionFromCookie(secret, cookieValue string, now time.Time) (*SessionClaims, error) {
	claims, err := ReadSession(secret, cookieValue, now)
	if err != nil {
		return nil, err
	}
	if claims == nil {
		return nil, ErrSessionRequired
	}
	sess := Session{UserID: claims.ID, Tier: claims.Tier, ExpiresAtMs: claims.Exp * 1000}
	if err := sess.Require(now.UnixMilli(), User{ID: claims.ID, State: StateActive}); err != nil {
		return nil, err
	}
	return claims, nil
}
