// Package authorization decides whether an actor MAY perform an action on a
// resource. It is deliberately independent of identity's session plumbing: the
// caller resolves who is acting, this package answers the policy question and
// never invents data for an actor it cannot see.
package authorization

import "github.com/anvxxr-arch/fudcourt/backend/api/internal/access/identity"

// Action is a verb on a resource ("order.create", "execution.cancel", ...).
// Invariant: Action is non-empty wherever a Decision is evaluated; policies
// key their tier floors by exact Action string.
type Action string

// Resource is the object an action targets. Invariant: OwnerUserID is empty
// exactly for resources no user owns (market data, system objects); such
// resources are never "own", so only tier floors grant access to them.
type Resource struct {
	// Type is the resource kind ("execution", "order", "credential", ...).
	Type string
	// ID identifies the specific object within Type.
	ID string
	// OwnerUserID is the owning user's id, empty when unowned.
	OwnerUserID string
}

// Actor is who wants to act. Invariant: a zero Actor (no UserID, no tier) is
// treated as TierPublic — there is no "unknown means admin" path.
type Actor struct {
	// UserID is the acting account's id; empty for nothing at all.
	UserID string
	// Tier is the actor's resolved tier.
	Tier identity.Tier
	// IsServiceAccount marks machine identities, which never gain ownership
	// of user-owned resources just by naming them.
	IsServiceAccount bool
}

// Decision is the verdict of Evaluate. Invariant: when Allow is false the
// caller MUST honor Code; when Allow is true Code is empty and callers must
// not branch on it.
type Decision struct {
	// Allow is the verdict.
	Allow bool
	// Reason is a human-readable justification for logs and audit trails,
	// never for access-control branching.
	Reason string
	// Code is the stable SCREAMING_SNAKE refusal code, empty when Allow.
	Code string
}

// Policy is the tier floor per action. Invariant: a missing action has no
// floor — TierFloors is authoritative as written, and an action absent from it
// is denied rather than implicitly public (fail-closed).
type Policy struct {
	// TierFloors maps an Action to the minimum tier a NON-OWNER needs. The
	// floor never applies to the owner of the resource.
	TierFloors map[Action]identity.Tier
}

// Refusal codes carried by Decision.Code.
const (
	// CodeAuthzDenied is the generic authorization refusal.
	CodeAuthzDenied = "AUTHZ_DENIED"
	// CodeNotFound is returned instead of a denial when a READ targets another
	// user's owned resource: see Evaluate for why existence is never leaked.
	CodeNotFound = "NOT_FOUND"
)

// actionRead is the read verb convention used to apply the not-found rule.
const actionRead Action = "read"

// Evaluate decides whether actor may perform action on resource under policy.
//
// Rules, in order:
//  1. An owner may act on their own resource regardless of tier floor.
//  2. A READ of another user's owned resource is refused as NOT_FOUND, never
//     as a denial. WHY: a 403-style denial confirms the object exists, which
//     leaks another user's activity to a guessing caller (object ids are
//     enumerable); answering NOT_FOUND makes "exists but forbidden" and
//     "does not exist" indistinguishable, so probing learns nothing. The audit
//     trail records the true action, only the caller-facing code is masked.
//     Unowned resources cannot leak this way — their existence is public
//     knowledge — so reads of them fall through to the tier floor.
//  3. Anyone else needs the action's tier floor from the policy. An action
//     with no floor entry is denied (fail-closed).
//
// Invariant: Evaluate never escalates — ownership or the actor's own tier are
// the only grants; a service account owns nothing and a zero Actor ranks
// public.
func Evaluate(actor Actor, action Action, resource Resource, policy Policy) Decision {
	isOwner := actor.UserID != "" && resource.OwnerUserID != "" && actor.UserID == resource.OwnerUserID
	if isOwner {
		return Decision{Allow: true, Reason: "owner acts on own resource"}
	}
	if action == actionRead && resource.OwnerUserID != "" {
		return Decision{
			Allow:  false,
			Reason: "read of another user's owned resource is masked as missing",
			Code:   CodeNotFound,
		}
	}
	floor, ok := policy.TierFloors[action]
	if !ok {
		return Decision{Allow: false, Reason: "no tier floor configured for action", Code: CodeAuthzDenied}
	}
	if actor.Tier.AtLeast(floor) {
		return Decision{Allow: true, Reason: "actor tier meets the action's floor"}
	}
	return Decision{Allow: false, Reason: "actor tier is below the action's floor", Code: CodeAuthzDenied}
}
