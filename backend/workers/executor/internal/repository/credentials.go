// Credential loading for the composition root (objective §8.4). The executor
// resolves an execution's account to a sealed credential row and unseals it
// for the venue adapter; this file is the READ side of that path, kept apart
// from store.go because the worker never reads credentials (it only sees
// exchanges.Exchange) — the composition root does.
//
// The envelope shape is exactly what the web API writes with
// the retired TS executor store's sealCredentials: iv and auth_tag are
// per-secret 12-byte / 16-byte concatenations in column order (api_key,
// api_secret, [passphrase]); internal/platform/credentials reverses that layout.
package repository

import (
	"context"
	"errors"
	"fmt"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/credentials"
	"github.com/jackc/pgx/v5"
)

var (
	// ErrCredentialNotFound marks an account id with no stored row. The
	// execution must stop for that account: a missing credential can never be
	// fabricated or substituted (fail-closed, §40).
	ErrCredentialNotFound = errors.New("repository: credential row not found")
)

// CredentialRow is one sealed secret set plus its lifecycle flags. Plaintext
// is NEVER a field of this type: only the sealed bytes cross the boundary.
type CredentialRow struct {
	ID        string
	UserID    string
	Exchange  string
	Label     string
	MaskedKey string
	Envelope  credentials.Envelope
	// Revoked is true when revoked_at is set; an execution must refuse to use
	// a revoked credential even though its ciphertext still opens.
	Revoked bool
	Health  string
}

// LoadCredential reads the sealed credential envelope for one exchange
// account id. A revoked row is still returned (with Revoked=true) so the
// caller can report the precise state instead of a bare "not found".
func (s *Store) LoadCredential(ctx context.Context, accountID string) (CredentialRow, error) {
	var row CredentialRow
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, user_id, exchange, label, api_key_masked,
		       api_key_encrypted, api_secret_encrypted, passphrase_encrypted,
		       iv, auth_tag, health, (revoked_at IS NOT NULL)
		  FROM executor.exchange_accounts
		 WHERE id = $1`, accountID,
	).Scan(&row.ID, &row.UserID, &row.Exchange, &row.Label, &row.MaskedKey,
		&row.Envelope.APIKey, &row.Envelope.APISecret, &row.Envelope.Passphrase,
		&row.Envelope.IV, &row.Envelope.AuthTag, &row.Health, &row.Revoked)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CredentialRow{}, fmt.Errorf("%w: account %s", ErrCredentialNotFound, accountID)
		}
		return CredentialRow{}, fmt.Errorf("repository: load credential %s: %w", accountID, err)
	}
	return row, nil
}

// MaskedKeyOrFingerprint returns the masked key (the display form the web
// tier publishes) so logs and refusals can reference a credential without
// ever rendering plaintext (§8.4: plaintext in logs is a defect).
func (r CredentialRow) MaskedKeyOrFingerprint() string {
	if r.MaskedKey != "" {
		return r.MaskedKey
	}
	return r.ID
}

// TouchAccountCredential records a credential use (last_used_at) without touching
// any sealed column. Failures are logged by the caller, not fatal: a stale
// audit timestamp must never stop trading.
func (s *Store) TouchAccountCredential(ctx context.Context, accountID string, atMs int64) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE executor.exchange_accounts
		   SET last_used_at = $2
		 WHERE id = $1`, accountID, atMs)
	if err != nil {
		return fmt.Errorf("repository: touch credential %s: %w", accountID, err)
	}
	_ = tag
	return nil
}
