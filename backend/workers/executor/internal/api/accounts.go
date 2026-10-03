package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/repository"
)

// exchangesSupported is the connectAccount allow-list (EXCHANGES in runtime.ts:
// binance, bybit, mexc). Paper is NOT connectable — it is a test venue, not a
// stored credential.
var exchangesSupported = []execution.ExchangeID{
	execution.ExchangeBinance, execution.ExchangeBybit, execution.ExchangeMEXC,
}

// handleAccounts ports /api/executor/accounts (accounts/route.ts):
// GET lists the session user's accounts, POST connects one (BYOK).
func (s *Server) handleAccounts(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.listAccounts(w, r, userID)
	case http.MethodPost:
		s.connectAccount(w, r, userID)
	default:
		methodGuard(w, r, http.MethodGet, http.MethodPost)
	}
}

// listAccounts is `{ accounts }` (listCredentials, masked only).
func (s *Server) listAccounts(w http.ResponseWriter, r *http.Request, userID string) {
	records, err := s.store.ListCredentials(r.Context(), userID)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	accounts := make([]CredentialRecord, 0, len(records))
	for _, rec := range records {
		accounts = append(accounts, toWireCredential(rec))
	}
	writeJSON(w, http.StatusOK, ListAccountsResponse{Accounts: accounts})
}

// connectAccount ports connectAccount in runtime.ts: validate the body, probe
// the venue live, refuse a withdrawal-capable key, then seal and store the
// credential. The response carries the masked record and the probe metadata;
// plaintext never appears in it.
func (s *Server) connectAccount(w http.ResponseWriter, r *http.Request, userID string) {
	var body struct {
		Exchange   *string `json:"exchange"`
		Label      *string `json:"label"`
		APIKey     *string `json:"apiKey"`
		APISecret  *string `json:"apiSecret"`
		Passphrase *string `json:"passphrase"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	var errs []string
	exchange := execution.ExchangeID("")
	if body.Exchange == nil || !isSupported(string(*body.Exchange)) {
		errs = append(errs, "exchange: expected one of "+supportedList())
	} else {
		exchange = execution.ExchangeID(*body.Exchange)
	}
	label := ""
	if body.Label == nil || strings.TrimSpace(*body.Label) == "" {
		errs = append(errs, "label: must be a non-empty string")
	} else {
		label = strings.TrimSpace(*body.Label)
	}
	apiKey := ""
	if body.APIKey == nil || strings.TrimSpace(*body.APIKey) == "" {
		errs = append(errs, "apiKey: must be a non-empty string")
	} else {
		apiKey = *body.APIKey
	}
	apiSecret := ""
	if body.APISecret == nil || strings.TrimSpace(*body.APISecret) == "" {
		errs = append(errs, "apiSecret: must be a non-empty string")
	} else {
		apiSecret = *body.APISecret
	}
	passphrase := ""
	if body.Passphrase != nil {
		passphrase = *body.Passphrase
	}
	if len(errs) > 0 {
		validationError(w, errs)
		return
	}
	plain := PlainCredentials{APIKey: apiKey, APISecret: apiSecret, Passphrase: passphrase}
	// Probe the venue with the candidate credential (linear_perp, exactly as
	// runtime.ts connectAccount does) — a successful read proves the key works.
	adapter, err := s.venues.AdapterPlain(r.Context(), exchange, execution.MarketLinearPerp, plain)
	if err != nil {
		s.writeCredentialProbeFailure(w, err)
		return
	}
	metadata, err := adapter.GetAccount(r.Context())
	if err != nil {
		s.writeCredentialProbeFailure(w, err)
		return
	}
	if metadata.Permissions.Withdraw != nil && *metadata.Permissions.Withdraw {
		// PRD §43: withdrawal capability is unsupported — refuse the key.
		writeDetail(w, http.StatusBadRequest, "withdrawal permission not supported",
			"this API key grants withdrawal permission — FUDCourt only supports keys WITHOUT it; revoke the permission on the exchange and reconnect")
		return
	}
	env, err := s.venues.Seal(plain)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	at := s.now()
	created, err := s.store.CreateCredential(r.Context(), repository.CredentialInput{
		UserID:       userID,
		Exchange:     exchange,
		Label:        label,
		APIKeyMasked: exchanges.MaskAPIKey(apiKey),
		Envelope:     env,
		Permissions:  metadata.Permissions,
		At:           at,
	})
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	// Health reflects the probe we just ran (createCredential writes ACTIVE).
	if metadata.Health != "" && metadata.Health != created.Health {
		if err := s.store.UpdateCredentialHealth(r.Context(), userID, created.ID, metadata.Health, at); err == nil {
			created.Health = metadata.Health
		}
	}
	s.audit(r.Context(), userID, "credential_connected", &created.ID, map[string]any{
		"exchange": string(exchange), "label": label, "health": string(metadata.Health),
	})
	masked := created.APIKeyMasked
	writeJSON(w, http.StatusOK, AccountResponse{
		Account:  toWireCredential(created),
		Metadata: toWireMetadata(metadata, &masked, label),
	})
}

// handleAccountByID ports /api/executor/accounts/{id} (GET masked read,
// DELETE revoke) and /api/executor/accounts/{id}/test (POST).
func (s *Server) handleAccountByID(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(w, r)
	if !ok {
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/executor/accounts/")
	if rest == "" || rest == r.URL.Path {
		notFound(w, "account")
		return
	}
	id, sub, _ := strings.Cut(rest, "/")
	if id == "" {
		notFound(w, "account")
		return
	}
	switch sub {
	case "":
		switch r.Method {
		case http.MethodGet:
			s.getAccount(w, r, userID, id)
		case http.MethodDelete:
			s.deleteAccount(w, r, userID, id)
		default:
			methodGuard(w, r, http.MethodGet, http.MethodDelete)
		}
	case "test":
		if !methodGuard(w, r, http.MethodPost) {
			return
		}
		s.testAccount(w, r, userID, id)
	default:
		notFound(w, "account")
	}
}

// getAccount is `{ account }` for one owned account (masked only).
func (s *Server) getAccount(w http.ResponseWriter, r *http.Request, userID, id string) {
	rec, err := s.store.GetCredential(r.Context(), userID, id)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if rec == nil {
		notFound(w, "account")
		return
	}
	writeJSON(w, http.StatusOK, AccountEnvelope{Account: toWireCredential(*rec)})
}

// deleteAccount revokes the credential and answers `{ ok: true }`. A missing or
// wrong-owner account is a 404 (existence is never leaked).
func (s *Server) deleteAccount(w http.ResponseWriter, r *http.Request, userID, id string) {
	existing, err := s.store.GetCredential(r.Context(), userID, id)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if existing == nil {
		notFound(w, "account")
		return
	}
	at := s.now()
	revoked, err := s.store.RevokeCredential(r.Context(), userID, id, at)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if revoked == nil {
		notFound(w, "account")
		return
	}
	s.audit(r.Context(), userID, "credential_revoked", &id, map[string]any{"exchange": string(existing.Exchange)})
	writeJSON(w, http.StatusOK, DeleteAccountResponse{OK: true})
}

// testAccount ports testAccount in runtime.ts: re-probe the sealed credential
// live, refresh its health, and answer the masked record + metadata. The
// sealed plaintext is opened inside the credential-owning package, never here.
func (s *Server) testAccount(w http.ResponseWriter, r *http.Request, userID, id string) {
	rec, err := s.store.GetCredential(r.Context(), userID, id)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if rec == nil || rec.RevokedAt != nil {
		notFound(w, "account")
		return
	}
	adapter, err := s.venues.AdapterSealed(r.Context(), rec.Exchange, execution.MarketLinearPerp, id)
	if err != nil {
		// A credential that can no longer be opened is not "not found": the
		// account exists, the vault read failed. Answer the credential-check 502.
		s.writeCredentialProbeFailure(w, err)
		return
	}
	metadata, probeErr := adapter.GetAccount(r.Context())
	at := s.now()
	if probeErr != nil {
		health := healthForError(classifyProbeError(probeErr))
		_ = s.store.UpdateCredentialHealth(r.Context(), userID, id, health, at)
		s.audit(r.Context(), userID, "credential_tested", &id, map[string]any{"ok": false, "category": string(classifyProbeError(probeErr))})
		s.writeCredentialProbeFailure(w, probeErr)
		return
	}
	if metadata.Permissions.Withdraw != nil && *metadata.Permissions.Withdraw {
		_ = s.store.UpdateCredentialHealth(r.Context(), userID, id, execution.HealthPermissionError, at)
		s.audit(r.Context(), userID, "credential_tested", &id, map[string]any{"ok": false, "withdraw": true})
		writeDetail(w, http.StatusBadRequest, "withdrawal permission not supported",
			"this API key grants withdrawal permission — FUDCourt only supports keys WITHOUT it")
		return
	}
	_ = s.store.UpdateCredentialHealth(r.Context(), userID, id, metadata.Health, at)
	_ = s.store.TouchCredential(r.Context(), userID, id, at)
	s.audit(r.Context(), userID, "credential_tested", &id, map[string]any{"ok": true, "health": string(metadata.Health)})
	fresh, err := s.store.GetCredential(r.Context(), userID, id)
	if err != nil || fresh == nil {
		fresh = rec
	}
	masked := fresh.APIKeyMasked
	writeJSON(w, http.StatusOK, AccountResponse{
		Account:  toWireCredential(*fresh),
		Metadata: toWireMetadata(metadata, &masked, fresh.Label),
	})
}

// --- helpers ---------------------------------------------------------------

func (s *Server) audit(ctx context.Context, userID, action string, target *string, payload map[string]any) {
	// The audit log is history, not a control channel: a failed write must not
	// fail the request (mirror of the TS `safeEvent` swallow).
	_ = s.store.Audit(ctx, repository.AuditEntry{
		UserID: userID, Action: action, Target: target, Payload: payload, At: s.now(),
	})
}

// writeCredentialProbeFailure answers the `{ error: 'credential check failed',
// detail, category }` 502 (runtime.ts's mapError path).
func (s *Server) writeCredentialProbeFailure(w http.ResponseWriter, err error) {
	category := classifyProbeError(err)
	writeCategorized(w, http.StatusBadGateway, "credential check failed", probeMessage(err), category)
}

// probeMessage is the sanitized message the TS would show (mapped.message).
func probeMessage(err error) string {
	var ve *exchanges.VenueError
	if errors.As(err, &ve) {
		msg := ve.Message
		if msg == "" {
			msg = "credential check failed"
		}
		return msg
	}
	return "credential check failed"
}

// classifyProbeError maps an adapter failure onto the retry taxonomy. A
// VenueError carries its classification directly; anything else is unknown.
func classifyProbeError(err error) execution.ErrorCategory {
	var ve *exchanges.VenueError
	if errors.As(err, &ve) {
		return ve.Class.Category
	}
	return execution.ErrUnknown
}

// healthForError is healthForError in runtime.ts: the credential-health
// implication of a probe failure category. Insufficient balance proves the key
// is live (ACTIVE); permission/rate-limit are named; everything else is UNKNOWN
// except a fatal credential refusal, which invalidates it.
func healthForError(category execution.ErrorCategory) execution.CredentialHealth {
	switch category {
	case execution.ErrNetworkRetryable:
		return execution.HealthUnknown
	case execution.ErrRateLimited:
		return execution.HealthRateLimited
	case execution.ErrExchangeOverload:
		return execution.HealthUnknown
	case execution.ErrInvalidOrder:
		return execution.HealthUnknown
	case execution.ErrPermissionError:
		return execution.HealthPermissionError
	case execution.ErrInsufficientBalance:
		return execution.HealthActive
	case execution.ErrFatal:
		return execution.HealthInvalid
	default:
		return execution.HealthUnknown
	}
}

// toWireCredential maps a stored record onto the wire shape.
func toWireCredential(rec repository.CredentialRecord) CredentialRecord {
	return CredentialRecord{
		ID:           rec.ID,
		UserID:       rec.UserID,
		Exchange:     rec.Exchange,
		Label:        rec.Label,
		APIKeyMasked: rec.APIKeyMasked,
		Permissions:  toWirePermissions(rec.Permissions),
		Health:       rec.Health,
		CreatedAt:    rec.CreatedAt,
		UpdatedAt:    rec.UpdatedAt,
		LastUsedAt:   rec.LastUsedAt,
		RevokedAt:    rec.RevokedAt,
	}
}

// toWirePermissions maps the domain permission flags onto the wire shape.
func toWirePermissions(p execution.AccountPermissions) Permissions {
	return Permissions{
		Read:         p.Read,
		SpotTrade:    p.SpotTrade,
		FuturesTrade: p.FuturesTrade,
		Withdraw:     p.Withdraw,
	}
}

// toWireMetadata maps an adapter probe result onto the wire AccountMetadata.
func toWireMetadata(m execution.AccountMetadata, masked *string, label string) AccountMetadata {
	out := AccountMetadata{
		Exchange:     m.Exchange,
		AccountType:  m.AccountType,
		Permissions:  toWirePermissions(m.Permissions),
		Health:       m.Health,
		APIKeyMasked: masked,
	}
	if m.Label != nil {
		out.Label = m.Label
	} else if label != "" {
		out.Label = &label
	}
	if out.APIKeyMasked == nil && m.APIKeyMasked != nil {
		out.APIKeyMasked = m.APIKeyMasked
	}
	return out
}

func isSupported(exchange string) bool {
	for _, e := range exchangesSupported {
		if string(e) == exchange {
			return true
		}
	}
	return false
}

func supportedList() string {
	parts := make([]string, 0, len(exchangesSupported))
	for _, e := range exchangesSupported {
		parts = append(parts, string(e))
	}
	return strings.Join(parts, ", ")
}
