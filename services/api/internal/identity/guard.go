package identity

import (
	"fmt"
	"strings"
	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

// CodeTierRequired names the wire refusal for a session whose tier is below
// the route's requirement (the API-shape counterpart of middleware.ts's
// `{error: 'unauthorized', detail: 'requires <tier> tier'}`).
const CodeTierRequired = "IDENTITY_TIER_REQUIRED"

// ErrTierRequired builds that refusal for the required tier. It is 401 (not
// 403) deliberately: middleware.ts and the executor contract's `Unauthorized`
// response both answer "no session, or the session lacks the tier" with 401,
// and every migrated route must keep the status its callers already see.
func ErrTierRequired(need Tier) *errs.Error {
	return errs.New(errs.CategoryUnauthenticated, CodeTierRequired, fmt.Sprintf("requires %s tier", need))
}

// RoutePolicy is the single route policy of requiredTierForPath in
// apps/web/src/platform/auth/guard.ts, moved from hardcoded TypeScript tables
// to explicit configuration. Invariant: the ORDER of entries matters exactly
// as guard.ts's two passes do — every PagePrefixes entry is consulted before
// any TeamAPIRoutes entry, so a page prefix and an API prefix that overlap
// resolve to the page's tier; within each list the first matching base wins.
// A path matching nothing is public (nil), the open surface.
type RoutePolicy struct {
	// PagePrefixes are [base, tier] pairs for page surfaces, consulted first.
	PagePrefixes [][2]string
	// TeamAPIRoutes are API path bases gated at TierTeam, consulted second.
	TeamAPIRoutes []string
}

// under reports whether pathname is base or beneath it. Invariant: only a
// full path segment boundary counts, so `/teamspeak` is NOT under `/team` —
// a lookalike prefix must never capture the gate (or, worse here, escape it).
func under(pathname, base string) bool {
	return pathname == base || strings.HasPrefix(pathname, base+"/")
}

// RequiredTier returns the tier a path needs, or nil for the public surface —
// the port of requiredTierForPath in guard.ts. Invariant: an unlisted path is
// public, never implicitly gated, and a prefix match only fires on a path
// segment boundary.
func (p RoutePolicy) RequiredTier(pathname string) *Tier {
	for _, pair := range p.PagePrefixes {
		if under(pathname, pair[0]) {
			tier := Tier(pair[1])
			return &tier
		}
	}
	for _, base := range p.TeamAPIRoutes {
		if under(pathname, base) {
			tier := TierTeam
			return &tier
		}
	}
	return nil
}

// IsSafeNext ports isSafeNext from guard.ts: the post-login destination is
// attacker-supplied, so only a site-relative path is accepted. Invariant:
// a leading "/" and NEVER a second one (which would make the value
// protocol-relative, i.e. another host), no ".." (which would climb out of the
// intended prefix once a browser normalises the path), and no '?', '#' or '%'
// (which would smuggle in a second target or make the value ambiguous across
// the cookie + query round-trip). Plain paths also need no encode/decode on
// the way through the state cookie.
func IsSafeNext(value string) bool {
	if value == "" || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") {
		return false
	}
	if strings.Contains(value, "..") {
		return false
	}
	return !strings.ContainsAny(value, "?#%")
}
