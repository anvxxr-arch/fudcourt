// Package capability is the authorization vocabulary for the dashboard: what an identity MAY do,
// keyed to Discord ROLE IDS — never to a role name, so renaming "Moderator" cannot change who may
// ban someone (§22).
//
// Two layers, one authority each:
//
//   - the VOCABULARY lives here, in code, because every check is a line of code somewhere; a
//     capability nothing checks would be a decoration an operator could grant and nothing would
//     honour;
//   - the role→capability MAPPING lives in Postgres (`discord_role_capabilities`), because it is
//     configuration an admin edits from the dashboard — the same split as the log category list
//     (`logCategoryList`) and the routing rows (`log_destinations`).
//
// The consequence is deliberate: a stored grant naming a capability this file does not know is NOT
// silently honoured. Resolve drops it and REPORTS it, so the permissions panel can show the drift
// instead of a grant that looks active and does nothing.
package capability

import "strings"

// List is every capability this bot checks, in the order the permissions editor renders them:
// grouped by namespace, read before write inside each group, which is the order a reader scans.
//
// Snowflakes are elsewhere; these are plain names. They are part of the API contract — changing a
// name here is a breaking change for the stored mappings, which is why `Acceptable` refuses to write
// a grant this list cannot satisfy.
var List = []string{
	"moderation.read", "moderation.warn", "moderation.timeout", "moderation.kick", "moderation.ban",
	"automod.read", "automod.write",
	"logs.read",
	"welcome.read", "welcome.write",
	"roles.read", "roles.manage",
	"custom_commands.read", "custom_commands.manage",
	"feeds.read", "feeds.manage",
	"scheduler.read", "scheduler.manage",
	"settings.read", "settings.manage",
	"permissions.read", "permissions.manage",
}

// The capabilities the API and the bot CHECK BY NAME are named here as constants, so a mistyped check
// is a compile error instead of a guard that silently never fires. As more routes adopt the engine,
// their checks are added here — and TestNamedChecksAreInList keeps them from drifting out of List.
const (
	// PermissionsManage guards editing this mapping (the permissions panel's writes).
	PermissionsManage = "permissions.manage"
)

// known is List as a set, built once.
var known = func() map[string]bool {
	m := make(map[string]bool, len(List))
	for _, c := range List {
		m[c] = true
	}
	return m
}()

// All returns a set holding every capability in List.
//
// It is the one definition of "everything", shared by the two identities that hold it: the guild
// owner (§22's implicit full access) and the admin tier (the owner's configured admin ROLE, which is
// the baseline that makes the first mapping writable — see resolvedCapabilities in the api).
func All() map[string]bool {
	set := make(map[string]bool, len(List))
	for _, c := range List {
		set[c] = true
	}
	return set
}

// Namespace returns the part of a capability before its first dot: "moderation" for
// "moderation.kick". A name with no dot is its own namespace, which is how a malformed grant stays
// visible instead of collapsing into an empty string.
func Namespace(c string) string {
	if i := strings.IndexByte(c, '.'); i >= 0 {
		return c[:i]
	}
	return c
}

// IsKnown reports whether c is a capability this code checks.
func IsKnown(c string) bool { return known[c] }

// Namespaces returns the distinct namespaces in List, in List order.
func Namespaces() []string {
	seen := make(map[string]bool, 8)
	out := make([]string, 0, 8)
	for _, c := range List {
		ns := Namespace(c)
		if !seen[ns] {
			seen[ns] = true
			out = append(out, ns)
		}
	}
	return out
}

// IsWildcard reports whether a stored grant is the ONE wildcard shape we accept: "<namespace>.*".
//
// Exactly one dot: "*.*" and "a.b.*" are refused, so a wildcard is always "everything in one
// namespace" and never a pattern that needs a matcher to interpret.
func IsWildcard(c string) bool {
	if !strings.HasSuffix(c, ".*") || len(c) <= 2 {
		return false
	}
	return strings.Count(c, ".") == 1
}

// Acceptable reports whether a grant may be STORED: a known capability, or a wildcard over a
// namespace that exists.
//
// A bare "*" is deliberately NOT acceptable. "Everything" is what the owner override is for, and it
// is earned by being the guild owner rather than by typing one character into a role mapping — the
// widest possible grant must not also be the shortest possible string.
func Acceptable(c string) bool {
	if IsKnown(c) {
		return true
	}
	if !IsWildcard(c) {
		return false
	}
	for _, cap := range List {
		if Namespace(cap) == strings.TrimSuffix(c, ".*") {
			return true
		}
	}
	return false
}

// Resolve answers what one identity may do, given every grant the roles it holds carry. Grants that
// name a wildcard expand to that namespace's members; grants naming something unknown are DROPPED and
// returned in `unknown` (de-duplicated, in the order given) so the caller can surface them.
//
// isOwner short-circuits to every capability: the guild owner is the one identity that cannot be
// locked out of their own server's bot, and encoding that as a role mapping would mean a bad mapping
// could do it.
func Resolve(grants []string, isOwner bool) (set map[string]bool, unknown []string) {
	if isOwner {
		return All(), nil
	}
	set = make(map[string]bool, len(List))
	seenUnknown := make(map[string]bool, 2)
	for _, g := range grants {
		switch {
		case IsKnown(g):
			set[g] = true
		case IsWildcard(g):
			ns := strings.TrimSuffix(g, ".*")
			matched := false
			for _, c := range List {
				if Namespace(c) == ns {
					set[c] = true
					matched = true
				}
			}
			if !matched && !seenUnknown[g] {
				seenUnknown[g] = true
				unknown = append(unknown, g)
			}
		default:
			if !seenUnknown[g] {
				seenUnknown[g] = true
				unknown = append(unknown, g)
			}
		}
	}
	return set, unknown
}

// Has reports whether a resolved set holds a capability. A nil set holds none.
func Has(set map[string]bool, c string) bool { return set[c] }

// Missing returns the capabilities in List that a set does NOT hold, in List order — the readable
// half of a refusal ("needs permissions.manage"), and what the panel uses to grey a control out.
func Missing(set map[string]bool) []string {
	out := make([]string, 0, 4)
	for _, c := range List {
		if !set[c] {
			out = append(out, c)
		}
	}
	return out
}
