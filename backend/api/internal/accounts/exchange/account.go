// Package exchangeaccounts is the domain model of a user's connected venue
// account (PRD §108, DR-021).
//
// The load-bearing invariant: an ExchangeAccount NEVER holds secret material —
// not a key, not a secret, not a passphrase, not sealed ciphertext. It
// references the sealed credential by CredentialID and carries only what a UI
// or scheduler needs: identity, venue, lifecycle status, what markets it covers
// and which permissions were verified.
package exchangeaccounts

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

// Stable refusal codes for this domain. Clients branch on these, so they are
// frozen once shipped.
const (
	// CodeInvalidTransition marks a status change outside the legal lifecycle.
	CodeInvalidTransition = "ACCOUNT_INVALID_TRANSITION"
	// CodeLabelInvalid marks a missing or unbounded account label.
	CodeLabelInvalid = "ACCOUNT_LABEL_INVALID"
	// CodeExchangeUnknown marks an exchange outside the supported set.
	CodeExchangeUnknown = "ACCOUNT_EXCHANGE_UNKNOWN"
	// CodeTypeInvalid marks an account type outside the supported set.
	CodeTypeInvalid = "ACCOUNT_TYPE_INVALID"
	// CodeCredentialInvalid marks a missing credential reference.
	CodeCredentialInvalid = "ACCOUNT_CREDENTIAL_INVALID"
)

// MaxLabelRunes bounds an account label so it stays presentable in listings and
// cannot become a storage or UI abuse vector.
const MaxLabelRunes = 64

// AccountType is the venue account's trading scope.
type AccountType string

const (
	// AccountTypeSpot trades spot markets only.
	AccountTypeSpot AccountType = "spot"
	// AccountTypeFutures trades derivatives only.
	AccountTypeFutures AccountType = "futures"
	// AccountTypeBoth trades both scopes on one venue account.
	AccountTypeBoth AccountType = "both"
)

// MarketType names a venue market family. It mirrors the web executor's
// MarketType (frontend/web/src/lib/executor.ts: 'spot' | 'linear_perp'),
// including the linear_perp spelling.
type MarketType string

const (
	// MarketTypeSpot is the spot market family.
	MarketTypeSpot MarketType = "spot"
	// MarketTypeLinearPerp is USDT-linear perpetual futures.
	MarketTypeLinearPerp MarketType = "linear_perp"
)

// Status is the account lifecycle state. The only legal ordering is
// pending → active → disabled → revoked (see TransitionTo).
type Status string

const (
	// StatusPending means the account is registered but never verified against
	// its venue.
	StatusPending Status = "pending"
	// StatusActive means the account is verified and usable for trading.
	StatusActive Status = "active"
	// StatusDisabled means the account is deliberately switched off but its
	// history and credential link remain.
	StatusDisabled Status = "disabled"
	// StatusRevoked means access is cut off permanently.
	StatusRevoked Status = "revoked"
)

// Permissions mirrors the venue-reported key restrictions
// (frontend/web/src/lib/executor.ts AccountPermissions). Every
// venue-reported flag is *bool: nil means the venue does not report it and is
// NEVER inferred as false (house rule: honest absence over fabricated zero).
type Permissions struct {
	// Read is verified by probe: the credential can read account state.
	Read bool `json:"read"`
	// SpotTrade is as reported by the venue's key-restriction endpoint, nil if
	// the venue is silent.
	SpotTrade *bool `json:"spot_trade"`
	// FuturesTrade is as reported by the venue's key-restriction endpoint, nil
	// if the venue is silent.
	FuturesTrade *bool `json:"futures_trade"`
	// Withdraw MUST be false or nil in effect: FUDCourt never requests
	// withdrawal capability. true would mean the USER granted it on the key and
	// must be surfaced as a warning, never silently trusted.
	Withdraw *bool `json:"withdraw"`
}

// ExchangeAccount is one connected venue account. INVARIANT (tested): this
// record contains no secret material of any kind — json.Marshal of it can
// therefore never leak credentials. The vault link is CredentialID only.
type ExchangeAccount struct {
	ID string `json:"id"`
	// UserID scopes ownership; every lookup binds it (PRD §108).
	UserID string `json:"user_id"`
	// CredentialID references the sealed credential record; the secrets
	// themselves live in the vault, never here.
	CredentialID string `json:"credential_id"`
	Exchange     string `json:"exchange"`
	Label        string `json:"label"`
	AccountType  AccountType `json:"account_type"`
	Status       Status      `json:"status"`
	// SupportedMarkets lists the market families this account may trade.
	SupportedMarkets []MarketType `json:"supported_markets"`
	Permissions      Permissions  `json:"permissions"`
	// LastSyncAt is nil until the first successful venue sync — a missing sync
	// is reported as missing, never as a zero timestamp.
	LastSyncAt *time.Time `json:"last_sync_at"`
}

// KnownExchange reports whether the venue is one this build supports.
func KnownExchange(exchange string) bool {
	switch exchange {
	case "binance", "bybit", "mexc":
		return true
	}
	return false
}

// New validates and constructs a connected venue account. It refuses (never
// repairs): a missing or unbounded label, an exchange outside
// binance|bybit|mexc, a missing credential reference, and an unknown account
// type — each error is errs.CategoryValidation naming the offending field, so
// a caller can map the refusal straight onto a form.
//
// The account starts pending with a nil LastSyncAt: until a venue sync has
// actually happened there is no sync time to report.
func New(id, userID, credentialID, exchange, label string, accountType AccountType) (ExchangeAccount, error) {
	if strings.TrimSpace(label) == "" {
		return ExchangeAccount{}, errs.New(errs.CategoryValidation, CodeLabelInvalid, "field label is required")
	}
	if utf8.RuneCountInString(label) > MaxLabelRunes {
		return ExchangeAccount{}, errs.New(errs.CategoryValidation, CodeLabelInvalid,
			fmt.Sprintf("field label must be at most %d characters", MaxLabelRunes))
	}
	if !KnownExchange(exchange) {
		return ExchangeAccount{}, errs.New(errs.CategoryValidation, CodeExchangeUnknown,
			fmt.Sprintf("field exchange must be one of binance|bybit|mexc, got %q", exchange))
	}
	if credentialID == "" {
		return ExchangeAccount{}, errs.New(errs.CategoryValidation, CodeCredentialInvalid, "field credential_id is required")
	}
	switch accountType {
	case AccountTypeSpot, AccountTypeFutures, AccountTypeBoth:
	default:
		return ExchangeAccount{}, errs.New(errs.CategoryValidation, CodeTypeInvalid,
			fmt.Sprintf("field account_type must be one of spot|futures|both, got %q", accountType))
	}
	return ExchangeAccount{
		ID:          id,
		UserID:      userID,
		CredentialID: credentialID,
		Exchange:    exchange,
		Label:       label,
		AccountType: accountType,
		Status:      StatusPending,
	}, nil
}

// TransitionTo moves the account one step along its lifecycle. The ONLY legal
// ordering is pending → active → disabled → revoked: an account must be
// verified before it can be switched off and switched off before it can be cut
// off, so every state change is observable and reversible mistakes stop one
// step short of revocation. Any other pair — including self-transitions and
// skipping a step — is refused with errs.CategoryConflict and
// CodeInvalidTransition naming BOTH states, because the refusal is about the
// transition, not about either endpoint alone. The receiver is unchanged on
// refusal.
func (a *ExchangeAccount) TransitionTo(next Status) error {
	allowed := map[Status]Status{
		StatusPending:  StatusActive,
		StatusActive:   StatusDisabled,
		StatusDisabled: StatusRevoked,
	}
	want, ok := allowed[a.Status]
	if !ok || want != next {
		return errs.New(errs.CategoryConflict, CodeInvalidTransition,
			fmt.Sprintf("illegal account status transition %s -> %s", a.Status, next))
	}
	a.Status = next
	return nil
}

// TouchSync records a successful venue sync at now. INVARIANT: it only ever
// moves LastSyncAt forward — an out-of-order or retried sync must not rewind
// the record into looking staler than it is, and a nil LastSyncAt (first sync)
// is set outright. Touching with an older time is a harmless no-op, not an
// error: callers racing two syncs should not have their loser fail.
func (a *ExchangeAccount) TouchSync(now time.Time) {
	at := now.UTC()
	if a.LastSyncAt == nil || at.After(*a.LastSyncAt) {
		a.LastSyncAt = &at
	}
}
