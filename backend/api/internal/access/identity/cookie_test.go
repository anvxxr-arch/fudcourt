package identity

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// testSecret is the secret frontend/web/scripts/tests/auth-tests.ts pins its HMAC
// vectors to. The two suites must agree byte for byte, so they share the key.
const testSecret = "test-secret-at-least-32-characters-long!!"

// tsToken is the byte-exact token the TypeScript oracle mints (generated from
// session.ts itself with Date.now() frozen at 2025-01-01T00:00:00Z and
// ttlSeconds 3600):
//
//	claims: {"id":"1","username":"u","globalName":"U","avatar":null,
//	         "tier":"team","roles":["r1","r2"],"exp":1735693200}
//
// If this constant ever fails to verify, the Go port and session.ts have
// stopped being byte-compatible and live sessions would break at cutover.
const tsToken = "eyJpZCI6IjEiLCJ1c2VybmFtZSI6InUiLCJnbG9iYWxOYW1lIjoiVSIsImF2YXRhciI6bnVsbCwidGllciI6InRlYW0iLCJyb2xlcyI6WyJyMSIsInIyIl0sImV4cCI6MTczNTY5MzIwMH0.HQsLGF_G7XEUAspRCu7flBYh-9UNYBP93EyXuUPfk_I"

// tsEpoch is the frozen clock behind tsToken.
var tsEpoch = time.UnixMilli(1735689600000)

func str(s string) *string { return &s }

// TestTokenRoundTrips ports "session: a signed cookie round-trips to the same
// user" from auth-tests.ts.
func TestTokenRoundTrips(t *testing.T) {
	user := SessionClaims{
		ID: "1", Username: "u", GlobalName: str("U"), Avatar: nil,
		Tier: TierTeam, Roles: []string{},
	}
	token, err := CreateSessionToken(testSecret, user, SessionMaxAge, tsEpoch)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ReadSession(testSecret, token, tsEpoch.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("a signed cookie must round-trip to the same user")
	}
	if got.ID != "1" || got.Tier != TierTeam || got.GlobalName == nil || *got.GlobalName != "U" {
		t.Fatalf("claims drifted: %+v", got)
	}
}

// TestTSVectorVerifies proves byte-compatibility with session.ts: the token the
// TypeScript implementation mints MUST verify here (live sessions survive the
// cutover), and Go's mint for the same claims MUST be the same token (both
// directions byte-identical).
func TestTSVectorVerifies(t *testing.T) {
	got, err := ReadSession(testSecret, tsToken, tsEpoch.Add(30*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("token minted by session.ts must verify in Go")
	}
	if got.ID != "1" || got.Username != "u" || got.Tier != TierTeam ||
		got.GlobalName == nil || *got.GlobalName != "U" || got.Avatar != nil ||
		got.Exp != 1735693200 || len(got.Roles) != 2 || got.Roles[0] != "r1" || got.Roles[1] != "r2" {
		t.Fatalf("claims drifted from the TS vector: %+v", got)
	}
	// The Go mint for the same claims must reproduce the TS token byte for byte.
	mine, err := CreateSessionToken(testSecret, SessionClaims{
		ID: "1", Username: "u", GlobalName: str("U"), Avatar: nil,
		Tier: TierTeam, Roles: []string{"r1", "r2"},
	}, 3600, tsEpoch)
	if err != nil {
		t.Fatal(err)
	}
	if mine != tsToken {
		t.Fatalf("Go mint differs from the TS mint:\n got %s\nwant %s", mine, tsToken)
	}
}

// TestTamperedPayloadRejected ports "session: a tampered payload is rejected
// (no privilege escalation)" from auth-tests.ts: swap the tier, keep the sig.
func TestTamperedPayloadRejected(t *testing.T) {
	token, err := CreateSessionToken(testSecret, SessionClaims{
		ID: "1", Username: "u", Tier: TierMember, Roles: []string{},
	}, 3600, tsEpoch)
	if err != nil {
		t.Fatal(err)
	}
	sig := token[strings.Index(token, ".")+1:]
	forged, err := CreateSessionToken(testSecret, SessionClaims{
		ID: "1", Username: "u", Tier: TierAdmin, Roles: []string{},
	}, 3600, tsEpoch)
	if err != nil {
		t.Fatal(err)
	}
	payload := forged[:strings.Index(forged, ".")]
	got, err := ReadSession(testSecret, payload+"."+sig, tsEpoch.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("forged admin tier must not be accepted, got %+v", got)
	}
}

// TestForeignSignatureRejected ports "session: a cookie signed with a different
// key is rejected" from auth-tests.ts.
func TestForeignSignatureRejected(t *testing.T) {
	payload := "eyJpZCI6IjEiLCJ1c2VybmFtZSI6InUiLCJnbG9iYWxOYW1lIjoiVSIsImF2YXRhciI6bnVsbCwidGllciI6ImFkbWluIiwicm9sZXMiOltdLCJleHAiOjE3MzU2OTMyMDB9"
	mac := hmac.New(sha256.New, []byte("a-completely-different-secret-value-32ch"))
	mac.Write([]byte(payload))
	foreignSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	got, err := ReadSession(testSecret, payload+"."+foreignSig, tsEpoch.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatal("a cookie signed with a different key must be rejected")
	}
}

// TestMalformedValuesAreNoSession ports "session: truncated / malformed / empty
// values are all 'no session'" from auth-tests.ts.
func TestMalformedValuesAreNoSession(t *testing.T) {
	for _, bad := range []string{"", ".", "abc", "a.b", "nodot", "..", "a.", ".b"} {
		got, err := ReadSession(testSecret, bad, tsEpoch.Add(time.Second))
		if err != nil {
			t.Fatalf("malformed input must not error (%q): %v", bad, err)
		}
		if got != nil {
			t.Fatalf("malformed input %q must be no session, got %+v", bad, got)
		}
	}
}

// TestExpiredTokenRejected ports "session: an expired cookie is rejected" from
// auth-tests.ts: exp*1000 <= now is dead at the same instant in both runtimes.
func TestExpiredTokenRejected(t *testing.T) {
	token, err := CreateSessionToken(testSecret, SessionClaims{
		ID: "1", Username: "u", Tier: TierAdmin, Roles: []string{},
	}, -10, tsEpoch)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := ReadSession(testSecret, token, tsEpoch); got != nil {
		t.Fatal("an expired cookie must be rejected")
	}
	// The boundary instant itself is already expired (TS: exp*1000 <= Date.now()).
	live, err := CreateSessionToken(testSecret, SessionClaims{
		ID: "1", Username: "u", Tier: TierAdmin, Roles: []string{},
	}, 60, tsEpoch)
	if err != nil {
		t.Fatal(err)
	}
	claims, _ := ReadSession(testSecret, live, tsEpoch.Add(60*time.Second))
	if claims != nil {
		t.Fatal("a cookie must die exactly at exp, not one tick later")
	}
	if claims, _ := ReadSession(testSecret, live, tsEpoch.Add(59*time.Second)); claims == nil {
		t.Fatal("a cookie must still be live one tick before exp")
	}
}

// TestFailClosedSecrets pins session.ts's fail-closed rule: a missing or
// truncated secret signs nothing and verifies nothing — it can never degrade
// into unsigned/forgeable cookies.
func TestFailClosedSecrets(t *testing.T) {
	if _, err := CreateSessionToken("", SessionClaims{ID: "1", Username: "u", Tier: TierPublic, Roles: []string{}}, 60, tsEpoch); err == nil {
		t.Fatal("signing without a secret must refuse")
	}
	if _, err := CreateSessionToken("short", SessionClaims{ID: "1", Username: "u", Tier: TierPublic, Roles: []string{}}, 60, tsEpoch); err == nil {
		t.Fatal("signing with a truncated secret must refuse")
	}
	if got, err := ReadSession("", tsToken, tsEpoch.Add(time.Second)); err != nil || got != nil {
		t.Fatalf("verification without a secret must be no session, got %v %v", got, err)
	}
	if got, err := ReadSession("short", tsToken, tsEpoch.Add(time.Second)); err != nil || got != nil {
		t.Fatalf("verification with a truncated secret must be no session, got %v %v", got, err)
	}
}

// TestBadClaimsAreNoSession pins the parseClaims boundary: structurally valid
// JSON that breaks the SessionUser contract is not a session (and cannot be
// made one, because the signature check already refused the tampering attempt).
func TestBadClaimsAreNoSession(t *testing.T) {
	signed := func(json string) string {
		payload := base64.RawURLEncoding.EncodeToString([]byte(json))
		mac := hmac.New(sha256.New, []byte(testSecret))
		mac.Write([]byte(payload))
		return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	}
	cases := map[string]string{
		"array root":        `[1,2]`,
		"missing id":        `{"username":"u","tier":"team","roles":[],"exp":1735693200}`,
		"missing username":  `{"id":"1","tier":"team","roles":[],"exp":1735693200}`,
		"missing exp":       `{"id":"1","username":"u","tier":"team","roles":[]}`,
		"non-numeric exp":   `{"id":"1","username":"u","tier":"team","roles":[],"exp":"soon"}`,
		"unknown tier":      `{"id":"1","username":"u","tier":"root","roles":[],"exp":1735693200}`,
		"null roles ok but": `{"id":"1","username":"u","tier":"team","exp":1735693200}`,
	}
	for name, json := range cases {
		if name == "null roles ok but" {
			// roles is optional in the TS parser (stringArray degrades); the
			// case only documents that it is not a refusal — assert the opposite.
			if got, _ := ReadSession(testSecret, signed(json), tsEpoch.Add(time.Second)); got == nil {
				t.Fatalf("%s: missing roles must degrade to [], not refuse", name)
			}
			continue
		}
		if got, _ := ReadSession(testSecret, signed(json), tsEpoch.Add(time.Second)); got != nil {
			t.Fatalf("%s: must be no session, got %+v", name, got)
		}
	}
}

// TestSessionFromCookieRefusesWithCanonicalError pins the handler bridge: an
// absent or dead session is exactly ErrSessionRequired, nothing softer.
func TestSessionFromCookieRefusesWithCanonicalError(t *testing.T) {
	if _, err := SessionFromCookie(testSecret, "", tsEpoch); err != ErrSessionRequired {
		t.Fatalf("want ErrSessionRequired, got %v", err)
	}
	if ErrSessionRequired.Code != CodeSessionRequired || CodeSessionRequired != "IDENTITY_SESSION_REQUIRED" {
		t.Fatalf("the refusal code is a stable contract, got %q/%q", ErrSessionRequired.Code, CodeSessionRequired)
	}
	claims, err := SessionFromCookie(testSecret, tsToken, tsEpoch.Add(time.Second))
	if err != nil || claims == nil {
		t.Fatalf("a live cookie must authenticate: %v %v", claims, err)
	}
}
