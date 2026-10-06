// Package identity models WHO is acting: Discord users and their tier, signed
// sessions, and the machine identities (service accounts, API tokens) that
// stand in for a user. Pure domain model only — no cookie crypto, no Discord
// calls. The tier resolution and key-masking semantics deliberately mirror the
// TypeScript oracles (frontend/web/src/server/auth.ts and
// frontend/web/src/lib/executor.ts) so the two runtimes cannot drift.
package identity

import (
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
)

// UserState is the lifecycle state of a User. Only StateActive may act: every
// other state is a refusal, so a disabled or deleted account fails closed.
type UserState string

const (
	// StateActive marks a user allowed to act.
	StateActive UserState = "active"
	// StateDisabled marks a user suspended without destroying their record.
	StateDisabled UserState = "disabled"
	// StateDeleted marks a user whose account was removed but whose audit
	// trail must survive; the state is terminal.
	StateDeleted UserState = "deleted"
)

// User is one human account. Invariant: ID and DiscordID are non-empty once a
// user exists; State governs whether the account may act at all.
type User struct {
	// ID is the internal account id, non-empty and immutable.
	ID string
	// DiscordID is the Discord user snowflake the account is bound to.
	DiscordID string
	// DisplayName is the human label; it carries no authorization meaning.
	DisplayName string
	// State decides whether the account may act; only StateActive does.
	State UserState
}

// Tier is an authorization level. Invariant: tiers are totally ordered by
// Rank() (public < member < team < admin) exactly as TIER_RANK in
// session.ts, and an unknown tier string is not a Tier at all.
type Tier string

const (
	// TierPublic is anonymous access: the rank floor everyone has.
	TierPublic Tier = "public"
	// TierMember is a resolved guild member.
	TierMember Tier = "member"
	// TierTeam is a treasury/operations tier.
	TierTeam Tier = "team"
	// TierAdmin is the highest tier.
	TierAdmin Tier = "admin"
)

// Rank returns the numeric order of the tier (TIER_RANK in session.ts).
// Invariant: Rank is strictly increasing across public < member < team < admin;
// an unknown tier ranks 0 so it can never out-rank a known one.
func (t Tier) Rank() int {
	switch t {
	case TierAdmin:
		return 3
	case TierTeam:
		return 2
	case TierMember:
		return 1
	case TierPublic:
		return 0
	default:
		return 0
	}
}

// AtLeast reports whether t satisfies the required tier, the rank comparison
// shared by hasTier in guard.ts: a higher tier satisfies a lower requirement
// and a session never satisfies above its own rank.
func (t Tier) AtLeast(need Tier) bool { return t.Rank() >= need.Rank() }

// Session is the authenticated identity of one request. Invariant: a Session
// is only authoritative while IsValid(now); it is a value copy of the signed
// claims, never the signature itself.
type Session struct {
	// UserID is the internal account id the session speaks for.
	UserID string
	// Tier is the resolved tier at issue time; it does not rise later.
	Tier Tier
	// IssuedAtMs is the issue time in epoch milliseconds.
	IssuedAtMs int64
	// ExpiresAtMs is the hard expiry in epoch milliseconds.
	ExpiresAtMs int64
}

// IsValid reports whether the session may be used at now (epoch ms).
// Invariant: validity requires BOTH halves of the rule — the session must not
// have expired (mirroring readSession in session.ts, where exp*1000 <= now is
// rejected) AND the user behind it must be StateActive. A disabled or deleted
// user keeps their session cryptographically intact but loses all access, so
// revocation is instant and does not depend on cookie expiry.
func (s Session) IsValid(now int64, user User) bool {
	if user.State != StateActive {
		return false
	}
	return now < s.ExpiresAtMs
}

// ServiceAccount is a machine identity acting without a human session.
// Invariant: a ServiceAccount is never a User; authorization sees it as
// Actor.IsServiceAccount and every action it takes is auditable under its ID.
type ServiceAccount struct {
	// ID is the machine identity's id, non-empty and immutable.
	ID string
	// DisplayName labels the automation in audit trails.
	DisplayName string
	// Tier is the ceiling the machine may act at; automation is never
	// implicitly admin.
	Tier Tier
}

// APIToken is the record of a bearer credential handed to a caller.
// Invariant: the raw token is NEVER stored or returned here — only the masked
// form — so no audit log or API response can leak it.
type APIToken struct {
	// MaskedToken is the MaskKey form of the raw token, display-only.
	MaskedToken string
	// Scopes are the granted scope names; empty grants nothing.
	Scopes []string
	// ExpiresAt is the hard expiry after which the token must not be accepted.
	ExpiresAt time.Time
}

// CodeSessionExpired is the stable code IDENTITY_SESSION_EXPIRED naming a
// session refusal. It deliberately covers BOTH halves of the validity rule —
// clock expiry and a non-active user — because to a caller there is no usable
// difference: the session is dead either way, and distinguishing "expired"
// from "revoked" in the response would tell a thief when their stolen session
// was noticed.
const CodeSessionExpired = "IDENTITY_SESSION_EXPIRED"

// Require returns nil exactly while IsValid says the session may act;
// otherwise it returns IDENTITY_SESSION_EXPIRED. Invariant: this is the ONLY
// bridge from a validity verdict to an errs refusal, so no caller can invent
// a softer interpretation of an invalid session.
func (s Session) Require(now int64, user User) error {
	if s.IsValid(now, user) {
		return nil
	}
	return errs.New(errs.CategoryAuthorization, CodeSessionExpired, "session is expired or the account is not active")
}

// MaskKey masks an API key for display exactly as maskApiKey in
// frontend/web/src/lib/executor.ts (PRD §109): keys of 8 bytes or
// fewer are wholly hidden behind "***", longer keys show their first and last
// 3 bytes as `abc...xyz`. Invariant: the masked form never reveals more than
// 6 bytes of the secret, and length 9 is the first key to show any of it.
func MaskKey(s string) string {
	if len(s) <= 8 {
		return "***"
	}
	return s[:3] + "..." + s[len(s)-3:]
}
