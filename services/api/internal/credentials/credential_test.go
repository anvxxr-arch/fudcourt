package credentials

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

func TestMaskKeyMirrorsWebMaskApiKey(t *testing.T) {
	cases := []struct {
		name string
		key  string
		want string
	}{
		{"empty", "", "***"},
		{"one rune", "a", "***"},
		{"exactly eight", "abcdefgh", "***"},
		{"nine runes", "abcdefghi", "abc...ghi"},
		{"typical secret", "AKIA12345678XYZ", "AKI...XYZ"},
		{"ten runes", "qwertyuiop", "qwe...iop"},
		// BMP text slices identically to the JS UTF-16 implementation:
		// 9 runes, first 3 + last 3 like `slice(0,3)`/`slice(-3)`.
		{"bmp text", "秘密鍵テキストです", "秘密鍵...トです"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := MaskKey(tc.key); got != tc.want {
				t.Fatalf("MaskKey(%q) = %q, want %q", tc.key, got, tc.want)
			}
		})
	}
}

func TestMaskKeyNeverEchoesTheMiddleOfAKey(t *testing.T) {
	const secret = "AKIA-middle-of-the-key-9876543210"
	masked := MaskKey(secret)
	if strings.Contains(masked, "middle-of-the-key") {
		t.Fatalf("mask %q leaks key body", masked)
	}
	if strings.Contains(secret, masked) {
		t.Fatalf("mask %q is a substring of the secret", masked)
	}
}

func TestCredentialJSONNeverCarriesSecretMaterial(t *testing.T) {
	const (
		apiKey    = "live-api-key-0123456789abcdef"
		apiSecret = "live-api-secret-super-secret-material"
		pass      = "live-passphrase-material"
	)
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	c := Credential{
		ID:           "cred-1",
		UserID:       "user-1",
		Exchange:     "binance",
		Label:        "main",
		APIKeyMasked: MaskKey(apiKey),
		Status:       StatusActive,
		CreatedAt:    now,
		Updated:      now,
	}
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{apiKey, apiSecret, pass} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("credential JSON leaks secret material: %s", raw)
		}
	}
	if !strings.Contains(string(raw), MaskKey(apiKey)) {
		t.Fatalf("credential JSON missing masked key: %s", raw)
	}

	// Structural half of the invariant: no field can even be named like a
	// secret holder, so no future edit can smuggle one in unnoticed.
	typ := reflect.TypeOf(Credential{})
	for i := range typ.NumField() {
		name := strings.ToLower(typ.Field(i).Name)
		for _, banned := range []string{"secret", "passphrase", "plaintext", "apikey"} {
			if name == "apikeymasked" {
				continue // the masked display key is the one allowed key-derived field
			}
			if strings.Contains(name, banned) {
				t.Fatalf("Credential field %q looks like secret material", typ.Field(i).Name)
			}
		}
	}
}

func TestRevokeLifecycle(t *testing.T) {
	at := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name        string
		start       Status
		wantErr     bool
		wantCode    string
		wantStatus  Status
		wantRevoked bool
	}{
		{"active revokes once", StatusActive, false, "", StatusRevoked, true},
		// Revocation must always be possible even when lifecycle data is
		// missing: cutting a key off is never blocked on unknown state.
		{"unknown revokes once", StatusUnknown, false, "", StatusRevoked, true},
		{"second revoke conflicts", StatusRevoked, true, CodeAlreadyRevoked, StatusRevoked, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			when := at
			c := Credential{Status: tc.start}
			if tc.start == StatusRevoked {
				revoked := at.Add(-time.Hour)
				c.RevokedAt = &revoked
			}
			err := c.Revoke(when)
			if tc.wantErr {
				var e *errs.Error
				if !errors.As(err, &e) {
					t.Fatalf("revoke error = %v, want *errs.Error", err)
				}
				if e.Category != errs.CategoryConflict {
					t.Fatalf("category = %q, want %q", e.Category, errs.CategoryConflict)
				}
				if e.Code != tc.wantCode {
					t.Fatalf("code = %q, want %q", e.Code, tc.wantCode)
				}
				if !strings.Contains(strings.ToLower(e.Message), "revoked") {
					t.Fatalf("message %q must name the state", e.Message)
				}
			} else if err != nil {
				t.Fatalf("revoke: %v", err)
			}
			if c.Status != tc.wantStatus {
				t.Fatalf("status = %q, want %q", c.Status, tc.wantStatus)
			}
			if tc.wantRevoked && c.RevokedAt == nil {
				t.Fatal("revoked credential must carry RevokedAt")
			}
			if !tc.wantErr && !c.RevokedAt.Equal(when) {
				t.Fatalf("RevokedAt = %v, want %v", c.RevokedAt, when)
			}
		})
	}
}
