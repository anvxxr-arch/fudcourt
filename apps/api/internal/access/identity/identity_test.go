package identity

import (
	"errors"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
)

// TestTierRankOrdering ports "tiers: rank ordering is public < member < team <
// admin" from frontend/web/scripts/tests/auth-tests.ts.
func TestTierRankOrdering(t *testing.T) {
	if !(TierPublic.Rank() < TierMember.Rank()) ||
		!(TierMember.Rank() < TierTeam.Rank()) ||
		!(TierTeam.Rank() < TierAdmin.Rank()) {
		t.Fatalf("rank ordering broken: public=%d member=%d team=%d admin=%d",
			TierPublic.Rank(), TierMember.Rank(), TierTeam.Rank(), TierAdmin.Rank())
	}
}

// TestAtLeast ports "guard: hasTier enforces the rank and refuses null
// sessions": a session satisfies its own rank and below, never above. The null
// session case lives in the authorization matrix (a missing actor is an
// authorization concern), so it is out of scope here.
func TestAtLeast(t *testing.T) {
	cases := []struct {
		tier Tier
		need Tier
		want bool
	}{
		{TierMember, TierTeam, false},
		{TierTeam, TierTeam, true},
		{TierTeam, TierAdmin, false},
		{TierAdmin, TierMember, true},
		{TierPublic, TierPublic, true},
		{TierPublic, TierMember, false},
		{TierAdmin, TierAdmin, true},
		{Tier("bogus"), TierPublic, true}, // unknown ranks 0: never out-ranks.
	}
	for _, c := range cases {
		if got := c.tier.AtLeast(c.need); got != c.want {
			t.Errorf("Tier(%q).AtLeast(%q) = %v, want %v", c.tier, c.need, got, c.want)
		}
	}
}

// TestTierFromRoleIDs ports "tierFromRoles: admin outranks team; unknown env
// can only lower access" from auth-tests.ts, case for case.
func TestTierFromRoleIDs(t *testing.T) {
	guardTS := RoleEnv{ // MemberRoleIDs empty: the guard.ts member floor.
		AdminRoleIDs: []string{"role-admin"},
		TeamRoleIDs:  []string{"role-team"},
	}
	narrowed := RoleEnv{ // Member allowlist configured: it narrows the floor.
		AdminRoleIDs:  []string{"role-admin"},
		TeamRoleIDs:   []string{"role-team"},
		MemberRoleIDs: []string{"role-member"},
	}
	cases := []struct {
		name    string
		roleIDs []string
		env     RoleEnv
		want    Tier
		wantErr string
	}{
		{name: "admin role resolves to admin", roleIDs: []string{"role-admin"}, env: guardTS, want: TierAdmin},
		{name: "team role resolves to team", roleIDs: []string{"role-team"}, env: guardTS, want: TierTeam},
		{name: "admin outranks team when both held", roleIDs: []string{"role-team", "role-admin"}, env: guardTS, want: TierAdmin},
		{name: "unresolvable role lowers to member, never grants", roleIDs: []string{"something-else"}, env: guardTS, want: TierMember},
		{name: "no roles held still resolves to member (guard.ts floor)", roleIDs: nil, env: guardTS, want: TierMember},
		{name: "explicit member role is member", roleIDs: []string{"role-member"}, env: narrowed, want: TierMember},
		{name: "narrowed floor drops an unresolvable role to public", roleIDs: []string{"something-else"}, env: narrowed, want: TierPublic},
		{name: "narrowed floor drops no roles at all to public", roleIDs: nil, env: narrowed, want: TierPublic},
		{
			// Fail-loud variant of guard.ts's fail-closed: the tier mirrors
			// guard.ts (`public`), and the misconfiguration is reported.
			name:    "missing team role set resolves public with IDENTITY_TIER_UNKNOWN_ROLE",
			roleIDs: []string{"role-admin"},
			env:     RoleEnv{AdminRoleIDs: []string{"role-admin"}},
			want:    TierPublic,
			wantErr: CodeTierUnknownRole,
		},
		{
			name:    "missing admin role set likewise",
			roleIDs: []string{"role-team"},
			env:     RoleEnv{TeamRoleIDs: []string{"role-team"}},
			want:    TierPublic,
			wantErr: CodeTierUnknownRole,
		},
		{
			name:    "no role sets configured is empty resolution: public",
			roleIDs: []string{"role-admin"},
			env:     RoleEnv{},
			want:    TierPublic,
			wantErr: CodeTierUnknownRole,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := TierFromRoleIDs(c.roleIDs, c.env)
			if c.wantErr != "" {
				var e *errs.Error
				if !errors.As(err, &e) {
					t.Fatalf("TierFromRoleIDs() error = %v, want errs.Error", err)
				}
				if e.Code != c.wantErr || e.Category != errs.CategoryValidation {
					t.Fatalf("TierFromRoleIDs() = %s/%s, want validation/%s", e.Category, e.Code, c.wantErr)
				}
				if got != c.want {
					t.Fatalf("TierFromRoleIDs() tier = %q alongside the error, want %q", got, c.want)
				}
				return
			}
			if err != nil {
				t.Fatalf("TierFromRoleIDs() unexpected error: %v", err)
			}
			if got != c.want {
				t.Errorf("TierFromRoleIDs() = %q, want %q", got, c.want)
			}
		})
	}
}

// TestSessionIsValid covers "session: an expired cookie is rejected" plus the
// user-active half of the validity rule: expiry alone is not enough when the
// account is disabled or deleted.
func TestSessionIsValid(t *testing.T) {
	active := User{ID: "u1", DiscordID: "d1", DisplayName: "u", State: StateActive}
	cases := []struct {
		name string
		sess Session
		now  int64
		user User
		want bool
	}{
		{
			name: "unexpired active session is valid",
			sess: Session{UserID: "u1", Tier: TierTeam, IssuedAtMs: 1000, ExpiresAtMs: 2000},
			now:  1500,
			user: active,
			want: true,
		},
		{
			name: "expired session is rejected",
			sess: Session{UserID: "u1", Tier: TierAdmin, IssuedAtMs: 1000, ExpiresAtMs: 1500},
			now:  1500, // exp*1000 <= now is rejection in session.ts: boundary refuses.
			user: active,
			want: false,
		},
		{
			name: "disabled user is invalid even with a live session",
			sess: Session{UserID: "u1", Tier: TierAdmin, IssuedAtMs: 1000, ExpiresAtMs: 2000},
			now:  1500,
			user: User{ID: "u1", State: StateDisabled},
			want: false,
		},
		{
			name: "deleted user is invalid even with a live session",
			sess: Session{UserID: "u1", Tier: TierAdmin, IssuedAtMs: 1000, ExpiresAtMs: 2000},
			now:  1500,
			user: User{ID: "u1", State: StateDeleted},
			want: false,
		},
	}
	for _, c := range cases {
		if got := c.sess.IsValid(c.now, c.user); got != c.want {
			t.Errorf("%s: IsValid() = %v, want %v", c.name, got, c.want)
		}
		err := c.sess.Require(c.now, c.user)
		if c.want && err != nil {
			t.Errorf("%s: Require() = %v, want nil", c.name, err)
		}
		if !c.want {
			var e *errs.Error
			if !errors.As(err, &e) || e.Code != CodeSessionExpired {
				t.Errorf("%s: Require() = %v, want %s", c.name, err, CodeSessionExpired)
			}
		}
	}
}

// TestMaskKey ports maskApiKey from frontend/web/src/lib/executor.ts
// (PRD §109) including the exact length boundary.
func TestMaskKey(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", "***"},
		{"short", "***"},
		{"12345678", "***"},        // len 8: wholly hidden.
		{"123456789", "123...789"}, // len 9: first boundary that shows bytes.
		{"abcdefghijklmnop", "abc...nop"},
		{"sk_live_abcdef", "sk_...def"},
	}
	for _, c := range cases {
		if got := MaskKey(c.in); got != c.want {
			t.Errorf("MaskKey(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
