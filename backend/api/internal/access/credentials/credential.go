// Package credentials is the vault domain for stored exchange credentials and
// the envelope crypto that seals their secret material (PRD §44, §109, DR-021).
//
// The security invariant the package exists for: a Credential record can never
// carry secret material — its only key-derived field is the masked display
// string produced by MaskKey — while the real secrets live sealed in an
// Envelope and are materialised only as a short-lived, server-side-only
// Revealed value. Plaintext must never appear in records, logs or URLs.
package credentials

import (
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

// Stable refusal codes for this domain. Clients branch on these, so they are
// frozen once shipped.
const (
	// CodeKeyInvalid marks a master key that is not exactly 32 bytes of hex.
	CodeKeyInvalid = "CREDENTIAL_KEY_INVALID"
	// CodeSealFailed marks a sealing attempt whose input or crypto failed.
	CodeSealFailed = "CREDENTIAL_SEAL_FAILED"
	// CodeTampered marks an envelope that fails GCM authentication or whose
	// layout disagrees with its secret count.
	CodeTampered = "CREDENTIAL_TAMPERED"
	// CodeAlreadyRevoked marks a second revocation of the same credential.
	CodeAlreadyRevoked = "CREDENTIAL_ALREADY_REVOKED"
)

// Status is the lifecycle state of a stored credential.
type Status string

const (
	// StatusActive means the credential may be used to reach its exchange.
	StatusActive Status = "active"
	// StatusRevoked means the credential was revoked and MUST NOT be used.
	StatusRevoked Status = "revoked"
	// StatusUnknown means the credential's state was never established (for
	// example a row imported without lifecycle data) — reported honestly,
	// never silently upgraded to active.
	StatusUnknown Status = "unknown"
)

// Credential is the persisted, secret-free record of one stored exchange API
// key (DR-021). INVARIANT: no field may ever hold plaintext key material —
// only the masked display key derived by MaskKey — so json.Marshal of this
// type cannot leak secrets. Sealed ciphertext lives in an Envelope alongside
// this record, never inside it.
type Credential struct {
	ID string `json:"id"`
	// UserID scopes ownership; every lookup binds it (PRD §108).
	UserID   string `json:"user_id"`
	Exchange string `json:"exchange"`
	Label    string `json:"label"`
	// APIKeyMasked is the display form from MaskKey: at most `abc...xyz`.
	APIKeyMasked string `json:"api_key_masked"`
	Status       Status `json:"status"`
	CreatedAt    time.Time
	// Updated is the last mutation time of this record.
	Updated    time.Time     `json:"updated"`
	LastUsedAt *time.Time    `json:"last_used_at"`
	RevokedAt  *time.Time    `json:"revoked_at"`
}

// MaskKey renders an API key for display exactly like the web executor's
// maskApiKey (frontend/web/src/platform/executor/types.ts): a key of at most 8
// characters cannot show a meaningful prefix/suffix pair, so it collapses to
// "***"; anything longer shows the first and last 3 characters joined by
// "...". ASCII keys match the JS slicing byte-for-byte; the rune slicing here
// additionally keeps BMP text unbroken where JS would count UTF-16 units.
func MaskKey(key string) string {
	r := []rune(key)
	if len(r) <= 8 {
		return "***"
	}
	return string(r[:3]) + "..." + string(r[len(r)-3:])
}

// Revoke marks the credential revoked at the given time. INVARIANT: a revoked
// credential carries a non-nil RevokedAt and is never returned to active.
//
// A second revoke is refused with errs.CategoryConflict and CodeAlreadyRevoked
// (the documented choice): revocation is deliberately NOT silently idempotent —
// a repeat call means the caller's view of the credential is stale or two
// revocation paths raced, and answering "success" would paper over that bug.
// The conflict error already tells the caller what it needs to know (the
// credential is revoked) while keeping the anomaly visible.
func (c *Credential) Revoke(at time.Time) error {
	if c.Status == StatusRevoked {
		return errs.New(errs.CategoryConflict, CodeAlreadyRevoked, "credential is already revoked")
	}
	// Revocation is refused only when already revoked: from active or unknown
	// it must always be possible to cut a key off (a security action is never
	// blocked on missing lifecycle data).
	when := at.UTC()
	c.Status = StatusRevoked
	c.RevokedAt = &when
	c.Updated = when
	return nil
}
