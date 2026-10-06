package identity

import "testing"

// TestRequiredTier ports "guard: route policy gates treasury paths to team
// and admin to admin" from frontend/web/scripts/tests/auth-tests.ts, with the
// guard.ts TIER_PAGES / TEAM_API_ROUTES tables expressed as a RoutePolicy.
func TestRequiredTier(t *testing.T) {
	policy := RoutePolicy{
		PagePrefixes: [][2]string{
			{"/team", string(TierTeam)},
			{"/admin", string(TierAdmin)},
			{"/member", string(TierMember)},
			{"/executor", string(TierTeam)},
		},
		TeamAPIRoutes: []string{
			"/api/all", "/api/wallets", "/api/coins", "/api/reconcile",
			"/api/transactions", "/api/executor",
		},
	}
	cases := []struct {
		path string
		want Tier // "" means the public surface (nil).
	}{
		{"/team/balance", TierTeam},
		{"/admin", TierAdmin},
		{"/member", TierMember},
		{"/api/all", TierTeam},
		{"/api/wallets", TierTeam},
		{"/api/coins", TierTeam},
		{"/api/reconcile", TierTeam},
		{"/api/transactions/1", TierTeam},
		{"/executor", TierTeam},
		{"/", ""},
		{"/ticker", ""},
		{"/dex", ""},
		{"/api/markets", ""},
		{"/api/news", ""},
		{"/robots.txt", ""},
		// A prefix must not capture a lookalike path.
		{"/teamspeak", ""},
		{"/api/alloy", ""},
	}
	for _, c := range cases {
		got := policy.RequiredTier(c.path)
		if c.want == "" {
			if got != nil {
				t.Errorf("RequiredTier(%q) = %q, want the public surface", c.path, *got)
			}
			continue
		}
		if got == nil {
			t.Errorf("RequiredTier(%q) = nil, want %q", c.path, c.want)
			continue
		}
		if *got != c.want {
			t.Errorf("RequiredTier(%q) = %q, want %q", c.path, *got, c.want)
		}
	}
}

// TestIsSafeNext ports "open redirect: isSafeNext only accepts a
// site-relative path" from auth-tests.ts.
func TestIsSafeNext(t *testing.T) {
	for _, ok := range []string{"/", "/team/balance", "/admin"} {
		if !IsSafeNext(ok) {
			t.Errorf("IsSafeNext(%q) = false, want true", ok)
		}
	}
	bad := []struct {
		in  string
		why string
	}{
		{"//evil.example.com", "protocol-relative -> another host"},
		{"https://evil.example.com", "absolute"},
		{"/team/../../etc", "traversal"},
		{"/x?y=1", "second target smuggled via query"},
		{"/x#frag", "fragment"},
		{"/a%2Fb", "ambiguous once decoded"},
		{"", "empty"},
		{"team/balance", "not rooted"},
		{`/\evil.example.com`, "backslash normalizes to protocol-relative"},
		{`/\\evil.example.com`, "double backslash"},
		{`/\/evil.example.com`, "escaped backslash then slash"},
		{"%2F%2Fevil.example.com", "percent-encoded leading slashes"},
		{"/%5Cevil.example.com", "percent-encoded backslash"},
	}
	for _, c := range bad {
		if IsSafeNext(c.in) {
			t.Errorf("IsSafeNext(%q) = true, want false (%s)", c.in, c.why)
		}
	}
}
