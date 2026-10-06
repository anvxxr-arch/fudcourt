package exchangeaccounts

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
)

func TestNewValidation(t *testing.T) {
	long := strings.Repeat("x", MaxLabelRunes+1)
	cases := []struct {
		name        string
		id          string
		credential  string
		exchange    string
		label       string
		accountType AccountType
		wantCode    string
		wantField   string
	}{
		{"valid spot", "acc-1", "cred-1", "binance", "main", AccountTypeSpot, "", ""},
		{"valid futures on bybit", "acc-1", "cred-1", "bybit", "hedge", AccountTypeFutures, "", ""},
		{"valid both on mexc", "acc-1", "cred-1", "mexc", "all", AccountTypeBoth, "", ""},
		{"empty label", "acc-1", "cred-1", "binance", "", AccountTypeSpot, CodeLabelInvalid, "label"},
		{"whitespace label", "acc-1", "cred-1", "binance", "   ", AccountTypeSpot, CodeLabelInvalid, "label"},
		{"overlong label", "acc-1", "cred-1", "binance", long, AccountTypeSpot, CodeLabelInvalid, "label"},
		{"unknown exchange", "acc-1", "cred-1", "kraken", "main", AccountTypeSpot, CodeExchangeUnknown, "exchange"},
		{"empty exchange", "acc-1", "cred-1", "", "main", AccountTypeSpot, CodeExchangeUnknown, "exchange"},
		{"missing credential", "acc-1", "", "binance", "main", AccountTypeSpot, CodeCredentialInvalid, "credential_id"},
		{"unknown account type", "acc-1", "cred-1", "binance", "main", AccountType("margin"), CodeTypeInvalid, "account_type"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			acc, err := New(tc.id, "user-1", tc.credential, tc.exchange, tc.label, tc.accountType)
			if tc.wantCode == "" {
				if err != nil {
					t.Fatal(err)
				}
				if acc.Status != StatusPending {
					t.Fatalf("status = %q, want %q", acc.Status, StatusPending)
				}
				if acc.LastSyncAt != nil {
					t.Fatalf("fresh account must report no sync, got %v", acc.LastSyncAt)
				}
				if acc.CredentialID != tc.credential {
					t.Fatalf("credential_id = %q, want %q", acc.CredentialID, tc.credential)
				}
				return
			}
			var e *errs.Error
			if !errors.As(err, &e) {
				t.Fatalf("err = %v, want *errs.Error", err)
			}
			if e.Category != errs.CategoryValidation {
				t.Fatalf("category = %q, want %q", e.Category, errs.CategoryValidation)
			}
			if e.Code != tc.wantCode {
				t.Fatalf("code = %q, want %q", e.Code, tc.wantCode)
			}
			if !strings.Contains(e.Message, "field "+tc.wantField) {
				t.Fatalf("message %q must name field %q", e.Message, tc.wantField)
			}
		})
	}
}

func TestExchangeAccountJSONNeverCarriesSecretMaterial(t *testing.T) {
	secrets := []string{
		"live-api-key-0123456789abcdef",
		"live-api-secret-super-secret-material",
		"hunter2-passphrase",
	}
	truth := true
	acc := ExchangeAccount{
		ID:               "acc-1",
		UserID:           "user-1",
		CredentialID:     "cred-1",
		Exchange:         "binance",
		Label:            "main",
		AccountType:      AccountTypeBoth,
		Status:           StatusActive,
		SupportedMarkets: []MarketType{MarketTypeSpot, MarketTypeLinearPerp},
		Permissions:      Permissions{Read: true, SpotTrade: &truth, FuturesTrade: &truth},
	}
	raw, err := json.Marshal(acc)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range secrets {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("account JSON leaks secret material: %s", raw)
		}
	}

	// Structural half of the invariant: no field can even be named like a
	// secret holder or typed like raw key bytes, so no future edit can smuggle
	// one in unnoticed.
	typ := reflect.TypeOf(ExchangeAccount{})
	for i := range typ.NumField() {
		f := typ.Field(i)
		name := strings.ToLower(f.Name)
		if f.Type.Kind() == reflect.Slice && f.Type.Elem().Kind() == reflect.Uint8 {
			t.Fatalf("ExchangeAccount field %q is []byte: a secret-material shape", f.Name)
		}
		for _, banned := range []string{"secret", "passphrase", "apikey", "plaintext", "sealed", "ciphertext"} {
			if strings.Contains(name, banned) {
				t.Fatalf("ExchangeAccount field %q looks like secret material", f.Name)
			}
		}
	}
}

func TestTransitionToLifecycle(t *testing.T) {
	all := []Status{StatusPending, StatusActive, StatusDisabled, StatusRevoked}
	legal := map[[2]Status]bool{
		{StatusPending, StatusActive}:   true,
		{StatusActive, StatusDisabled}:  true,
		{StatusDisabled, StatusRevoked}: true,
	}
	for _, from := range all {
		for _, to := range all {
			acc := ExchangeAccount{Status: from}
			err := acc.TransitionTo(to)
			key := [2]Status{from, to}
			if legal[key] {
				if err != nil {
					t.Fatalf("%s -> %s must be legal: %v", from, to, err)
				}
				if acc.Status != to {
					t.Fatalf("status = %q, want %q", acc.Status, to)
				}
				continue
			}
			var e *errs.Error
			if !errors.As(err, &e) {
				t.Fatalf("%s -> %s err = %v, want *errs.Error", from, to, err)
			}
			if e.Category != errs.CategoryConflict {
				t.Fatalf("%s -> %s category = %q, want %q", from, to, e.Category, errs.CategoryConflict)
			}
			if e.Code != CodeInvalidTransition {
				t.Fatalf("%s -> %s code = %q, want %q", from, to, e.Code, CodeInvalidTransition)
			}
			// The refusal is about the transition: it must name both states.
			if !strings.Contains(e.Message, string(from)) || !strings.Contains(e.Message, string(to)) {
				t.Fatalf("message %q must name both %q and %q", e.Message, from, to)
			}
			if acc.Status != from {
				t.Fatalf("refused transition must leave status %q, got %q", from, acc.Status)
			}
		}
	}
}

func TestTouchSyncMovesForwardOnly(t *testing.T) {
	t0 := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	t1 := t0.Add(time.Hour)
	t2 := t0.Add(2 * time.Hour)

	// First sync fills the honest absence.
	acc := ExchangeAccount{}
	acc.TouchSync(t1)
	if acc.LastSyncAt == nil || !acc.LastSyncAt.Equal(t1) {
		t.Fatalf("first sync: LastSyncAt = %v, want %v", acc.LastSyncAt, t1)
	}

	// A later sync moves forward…
	acc.TouchSync(t2)
	if !acc.LastSyncAt.Equal(t2) {
		t.Fatalf("forward sync: LastSyncAt = %v, want %v", acc.LastSyncAt, t2)
	}
	// …an earlier one must never rewind the record.
	acc.TouchSync(t0)
	if !acc.LastSyncAt.Equal(t2) {
		t.Fatalf("rewound to %v, want %v", acc.LastSyncAt, t2)
	}
	// An equal touch is a no-op, not an error.
	acc.TouchSync(t2)
	if !acc.LastSyncAt.Equal(t2) {
		t.Fatalf("equal touch changed time to %v", acc.LastSyncAt)
	}
}
