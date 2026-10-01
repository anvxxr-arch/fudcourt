package identity

import "github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"

// CodeTierUnknownRole is the stable code IDENTITY_TIER_UNKNOWN_ROLE naming a
// tier resolution failure where the configured role id sets are incomplete; it
// is validation because the deployment, not the request, is wrong.
const CodeTierUnknownRole = "IDENTITY_TIER_UNKNOWN_ROLE"

// RoleEnv is the guild/role configuration tierFromRoles in guard.ts reads
// from the environment (FUDCOURT_GUILD_ID, FUDCOURT_ROLE_ADMIN,
// FUDCOURT_ROLE_TEAM). Invariant: a RoleEnv can resolve roles ONLY when both
// the admin and team sets are configured — guard.ts fails closed when any of
// its env vars is missing, and the guild precondition folds into that same
// rule here (role id snowflakes are globally unique, so a separate guild id
// would only duplicate the "is this environment configured" question).
type RoleEnv struct {
	// AdminRoleIDs are the role ids granting admin.
	AdminRoleIDs []string
	// TeamRoleIDs are the role ids granting team.
	TeamRoleIDs []string
	// MemberRoleIDs optionally narrows the member floor: when non-empty, only
	// these role ids grant member and every other holder drops to public.
	// When empty, the guard.ts rule applies — any resolvable account is at
	// least member ("an authenticated account is never anonymous").
	MemberRoleIDs []string
}

// TierFromRoleIDs maps Discord role ids to a Tier, mirroring tierFromRoles in
// guard.ts: admin beats team beats member. Invariants (fail-closed):
//   - an unresolvable role id can only LOWER access, never grant: it is
//     ignored for the max, and when MemberRoleIDs narrows the member floor it
//     leaves its holder at public;
//   - empty resolution is TierPublic: an environment without both admin and
//     team role sets resolves nothing, and the tier mirrors guard.ts's
//     `public`;
//   - when the environment cannot resolve at all, the TierPublic result is
//     accompanied by IDENTITY_TIER_UNKNOWN_ROLE. guard.ts returns `public`
//     silently there; a silent demotion of real admins is indistinguishable
//     from a working deploy, so the Go port keeps guard.ts's answer but makes
//     the misconfiguration loud. Callers wanting guard.ts's behaviour verbatim
//     read the tier and ignore the error.
func TierFromRoleIDs(roleIDs []string, env RoleEnv) (Tier, error) {
	if len(env.AdminRoleIDs) == 0 || len(env.TeamRoleIDs) == 0 {
		return TierPublic, errs.New(errs.CategoryValidation, CodeTierUnknownRole,
			"role environment is not resolvable: admin and team role id sets must both be configured")
	}
	held := make(map[string]bool, len(roleIDs))
	for _, id := range roleIDs {
		held[id] = true
	}
	anyHeldIn := func(ids []string) bool {
		for _, id := range ids {
			if held[id] {
				return true
			}
		}
		return false
	}
	if anyHeldIn(env.AdminRoleIDs) {
		return TierAdmin, nil
	}
	if anyHeldIn(env.TeamRoleIDs) {
		return TierTeam, nil
	}
	if len(env.MemberRoleIDs) == 0 {
		// guard.ts: with resolution configured, every guild account that holds
		// no admin/team role is at least member.
		return TierMember, nil
	}
	if anyHeldIn(env.MemberRoleIDs) {
		return TierMember, nil
	}
	// A member allowlist is configured and nothing held resolves: the
	// unresolvable roles lowered access to the floor, which is public.
	return TierPublic, nil
}
