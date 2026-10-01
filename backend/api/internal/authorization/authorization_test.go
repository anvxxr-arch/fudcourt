package authorization

import (
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/identity"
)

const (
	actionUpdate Action = "update"
	actionCancel Action = "execution.cancel"
)

func policy(floors map[Action]identity.Tier) Policy {
	return Policy{TierFloors: floors}
}

// TestEvaluateMatrix is the full owner/non-owner x tier x action matrix: who
// may act, who is refused with AUTHZ_DENIED, and which refusals must present
// as NOT_FOUND so existence never leaks.
func TestEvaluateMatrix(t *testing.T) {
	tiers := []identity.Tier{identity.TierPublic, identity.TierMember, identity.TierTeam, identity.TierAdmin}
	// Floors chosen so every rank sits below, at, and above at least one floor.
	floors := map[Action]identity.Tier{
		actionRead:   identity.TierPublic,
		actionUpdate: identity.TierTeam,
		actionCancel: identity.TierAdmin,
	}

	type want struct {
		allow bool
		code  string
	}
	// expected: action -> ownership -> tier -> want.
	expected := map[Action]map[string]map[identity.Tier]want{
		actionRead: {
			"owner": {
				identity.TierPublic: {true, ""},
				identity.TierMember: {true, ""},
				identity.TierTeam:   {true, ""},
				identity.TierAdmin:  {true, ""},
			},
			"non-owner": { // floor public, but owned-by-other read hides behind NOT_FOUND.
				identity.TierPublic: {false, CodeNotFound},
				identity.TierMember: {false, CodeNotFound},
				identity.TierTeam:   {false, CodeNotFound},
				identity.TierAdmin:  {false, CodeNotFound},
			},
		},
		actionUpdate: {
			"owner": {
				identity.TierPublic: {true, ""},
				identity.TierMember: {true, ""},
				identity.TierTeam:   {true, ""},
				identity.TierAdmin:  {true, ""},
			},
			"non-owner": { // floor team.
				identity.TierPublic: {false, CodeAuthzDenied},
				identity.TierMember: {false, CodeAuthzDenied},
				identity.TierTeam:   {true, ""},
				identity.TierAdmin:  {true, ""},
			},
		},
		actionCancel: {
			"owner": {
				identity.TierPublic: {true, ""},
				identity.TierMember: {true, ""},
				identity.TierTeam:   {true, ""},
				identity.TierAdmin:  {true, ""},
			},
			"non-owner": { // floor admin.
				identity.TierPublic: {false, CodeAuthzDenied},
				identity.TierMember: {false, CodeAuthzDenied},
				identity.TierTeam:   {false, CodeAuthzDenied},
				identity.TierAdmin:  {true, ""},
			},
		},
	}

	for _, action := range []Action{actionRead, actionUpdate, actionCancel} {
		for _, tier := range tiers {
			for _, ownership := range []string{"owner", "non-owner"} {
				actor := Actor{UserID: "u2", Tier: tier}
				res := Resource{Type: "execution", ID: "e1", OwnerUserID: "u9"}
				if ownership == "owner" {
					res.OwnerUserID = "u2"
				}
				got := Evaluate(actor, action, res, policy(floors))
				want := expected[action][ownership][tier]
				if got.Allow != want.allow || got.Code != want.code {
					t.Errorf("Evaluate(tier=%s, %s, %s) = {allow:%v code:%q}, want {allow:%v code:%q}",
						tier, action, ownership, got.Allow, got.Code, want.allow, want.code)
				}
			}
		}
	}
}

func TestEvaluateEdges(t *testing.T) {
	floors := map[Action]identity.Tier{actionUpdate: identity.TierTeam}

	// A read of an UNOWNED resource cannot leak user activity, so the
	// existence-hiding rule does not apply: the tier floor decides.
	unowned := Resource{Type: "market", ID: "btc-usd"}
	if d := Evaluate(Actor{UserID: "u2", Tier: identity.TierPublic}, actionRead, unowned, policy(floors)); d.Allow {
		t.Errorf("unowned read with no floor entry must be denied, got %+v", d)
	}
	floors[actionRead] = identity.TierPublic
	if d := Evaluate(Actor{UserID: "u2", Tier: identity.TierPublic}, actionRead, unowned, policy(floors)); !d.Allow {
		t.Errorf("unowned read at the floor must be allowed, got %+v", d)
	}

	// An action absent from the policy is denied, never implicitly public.
	if d := Evaluate(Actor{UserID: "u2", Tier: identity.TierAdmin}, actionCancel, unowned, policy(floors)); d.Allow || d.Code != CodeAuthzDenied {
		t.Errorf("unfloored action must refuse with %s, got %+v", CodeAuthzDenied, d)
	}

	// A zero Actor ranks public and owns nothing.
	if d := Evaluate(Actor{}, actionUpdate, Resource{Type: "execution", ID: "e1", OwnerUserID: ""}, policy(floors)); d.Allow || d.Code != CodeAuthzDenied {
		t.Errorf("zero actor must be refused, got %+v", d)
	}

	// A service account never owns a user's resource by naming the owner's id
	// in its own UserID field... it may only act via tier floors.
	sa := Actor{UserID: "u2", Tier: identity.TierAdmin, IsServiceAccount: true}
	ownedByOther := Resource{Type: "execution", ID: "e1", OwnerUserID: "u2"}
	if d := Evaluate(sa, actionRead, ownedByOther, policy(floors)); !d.Allow {
		// u2 == owner: ownership rule still applies on UserID; document that
		// service accounts act AS their UserID.
		t.Errorf("service account acting as its UserID on that user's resource: got %+v", d)
	}
	// Ownership cannot be claimed on an unowned resource either.
	if d := Evaluate(Actor{UserID: "u2", Tier: identity.TierTeam}, actionUpdate, Resource{Type: "market", ID: "m"}, policy(floors)); !d.Allow {
		t.Errorf("unowned resource update at floor must be allowed, got %+v", d)
	}
}
