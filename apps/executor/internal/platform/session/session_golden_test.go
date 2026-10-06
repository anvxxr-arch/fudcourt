package session

import (
	"testing"
	"time"
)

// TestGoldenTokenFromAPI pins the WIRE FORMAT against the canonical
// implementation in apps/api: this token was minted by
// identity.CreateSessionToken (see goldenTokenCrossTier) and must verify here
// with the same claims. If it fails, the two verifiers have drifted and the
// executor surface would reject every real session.
func TestGoldenTokenFromAPI(t *testing.T) {
	now := time.UnixMilli(1_760_000_500_000)
	claims, err := RequireTeam(goldenTokenSecret, goldenTokenCrossTier, now)
	if err != nil {
		t.Fatalf("RequireTeam rejected a token minted by apps/api: %v", err)
	}
	if claims.ID != "u-1" || claims.Username != "neo" || claims.Tier != TierTeam {
		t.Fatalf("claims = %+v, want u-1/neo/team", claims)
	}
	// A token minted with a DIFFERENT secret is not a session.
	if _, err := RequireTeam("another-secret-0123456789abcdefgh", goldenTokenCrossTier, now); err == nil {
		t.Fatalf("a foreign-secret token verified")
	}
	// Expired (exp = 1_760_003_600 s; now is past it).
	if _, err := RequireTeam(goldenTokenSecret, goldenTokenCrossTier, time.UnixMilli(1_760_003_700_000)); err == nil {
		t.Fatalf("an expired token verified")
	}
}
