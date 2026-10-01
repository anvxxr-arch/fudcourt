package credentials

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

var testKey = bytes.Repeat([]byte{0x42}, MasterKeySize)

func TestNewMasterKeyRefusesBadInputBeforeAnyCrypto(t *testing.T) {
	cases := []struct {
		name    string
		hexKey  string
		wantErr bool
	}{
		{"valid lowercase", strings.Repeat("ab", MasterKeySize), false},
		{"valid uppercase", strings.Repeat("AB", MasterKeySize), false},
		{"empty", "", true},
		{"one byte short", strings.Repeat("ab", MasterKeySize-1), true},
		{"one byte long", strings.Repeat("ab", MasterKeySize+1), true},
		{"non-hex", strings.Repeat("zz", MasterKeySize), true},
		{"odd character count", strings.Repeat("a", 2*MasterKeySize-1), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			key, err := NewMasterKey(tc.hexKey)
			if tc.wantErr {
				var e *errs.Error
				if !errors.As(err, &e) {
					t.Fatalf("err = %v, want *errs.Error", err)
				}
				if e.Category != errs.CategoryValidation || e.Code != CodeKeyInvalid {
					t.Fatalf("got %s/%s, want validation/%s", e.Category, e.Code, CodeKeyInvalid)
				}
				if key != nil {
					t.Fatal("refused key must not yield bytes")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(key) != MasterKeySize {
				t.Fatalf("key length = %d, want %d", len(key), MasterKeySize)
			}
		})
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	pass := "hunter2"
	cases := []struct {
		name       string
		plaintexts []string
		want       Revealed
	}{
		{
			name:       "api_key and api_secret only",
			plaintexts: []string{"api-key-123", "api-secret-456"},
			want:       Revealed{APIKey: "api-key-123", APISecret: "api-secret-456"},
		},
		{
			name:       "with optional passphrase column",
			plaintexts: []string{"api-key-123", "api-secret-456", "hunter2"},
			want:       Revealed{APIKey: "api-key-123", APISecret: "api-secret-456", Passphrase: &pass},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env, err := Seal(testKey, tc.plaintexts...)
			if err != nil {
				t.Fatal(err)
			}
			n := len(tc.plaintexts)
			if len(env.Fields) != n {
				t.Fatalf("sealed %d fields, want %d", len(env.Fields), n)
			}
			// TS layout: 12-byte IV + 16-byte tag per secret, concatenated.
			if len(env.IV) != n*NonceSize || len(env.AuthTag) != n*TagSize {
				t.Fatalf("layout iv=%d tag=%d, want %d/%d", len(env.IV), len(env.AuthTag), n*NonceSize, n*TagSize)
			}
			for i, plain := range tc.plaintexts {
				if bytes.Contains(env.Fields[i], []byte(plain)) {
					t.Fatal("ciphertext must not contain the plaintext")
				}
			}
			got, err := Open(testKey, env)
			if err != nil {
				t.Fatal(err)
			}
			if got.APIKey != tc.want.APIKey || got.APISecret != tc.want.APISecret {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
			if (got.Passphrase == nil) != (tc.want.Passphrase == nil) {
				t.Fatalf("passphrase presence mismatch: got %+v want %+v", got.Passphrase, tc.want.Passphrase)
			}
			if got.Passphrase != nil && *got.Passphrase != *tc.want.Passphrase {
				t.Fatalf("passphrase = %q, want %q", *got.Passphrase, *tc.want.Passphrase)
			}
		})
	}
}

func TestSealRefusesBadArityAndBadKey(t *testing.T) {
	cases := []struct {
		name       string
		key        []byte
		plaintexts []string
	}{
		{"one field", testKey, []string{"only-one"}},
		{"four fields", testKey, []string{"a", "b", "c", "d"}},
		{"key too short", bytes.Repeat([]byte{0x42}, MasterKeySize-1), []string{"a", "b"}},
		{"key too long", bytes.Repeat([]byte{0x42}, MasterKeySize+1), []string{"a", "b"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env, err := Seal(tc.key, tc.plaintexts...)
			if err == nil {
				t.Fatal("Seal must fail closed")
			}
			if len(env.Fields) != 0 || len(env.IV) != 0 || len(env.AuthTag) != 0 {
				t.Fatalf("refused seal must return a zero Envelope, got %+v", env)
			}
		})
	}
}

func TestSealNeverReusesANonce(t *testing.T) {
	plain := []string{"api-key-123", "api-secret-456"}
	first, err := Seal(testKey, plain...)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Seal(testKey, plain...)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first.IV, second.IV) {
		t.Fatal("two seals must never share an IV")
	}
	if bytes.Equal(first.Fields[0], second.Fields[0]) {
		t.Fatal("same plaintext under fresh nonces must not repeat ciphertext")
	}
	// Within one envelope the per-secret nonces differ too.
	if bytes.Equal(first.IV[:NonceSize], first.IV[NonceSize:]) {
		t.Fatal("per-secret nonces within one envelope must differ")
	}
}

func TestOpenRefusesWrongKeyAndTamperWithNoPartialPlaintext(t *testing.T) {
	const (
		secretKey    = "api-key-123"
		secretSecret = "api-secret-456"
	)
	wrongKey := bytes.Repeat([]byte{0x19}, MasterKeySize)
	tampered := func(env Envelope) Envelope {
		flipped := append([]byte(nil), env.Fields[1]...)
		flipped[0] ^= 0xff
		fields := append([][]byte(nil), env.Fields...)
		fields[1] = flipped
		env.Fields = fields
		return env
	}
	cases := []struct {
		name  string
		key   []byte
		break_ func(Envelope) Envelope
	}{
		{"wrong key", wrongKey, func(e Envelope) Envelope { return e }},
		{"tampered second field", testKey, tampered},
		{"tampered first field", testKey, func(env Envelope) Envelope {
			flipped := append([]byte(nil), env.Fields[0]...)
			flipped[0] ^= 0xff
			env.Fields = [][]byte{flipped, env.Fields[1]}
			return env
		}},
		{"truncated iv", testKey, func(env Envelope) Envelope {
			env.IV = env.IV[:NonceSize-1]
			return env
		}},
		{"truncated auth tag", testKey, func(env Envelope) Envelope {
			env.AuthTag = env.AuthTag[:TagSize-1]
			return env
		}},
		{"field count mismatch", testKey, func(env Envelope) Envelope {
			env.Fields = env.Fields[:1]
			return env
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env, err := Seal(testKey, secretKey, secretSecret)
			if err != nil {
				t.Fatal(err)
			}
			got, err := Open(tc.key, tc.break_(env))
			if err == nil {
				t.Fatal("Open must refuse")
			}
			if got != (Revealed{}) {
				t.Fatalf("no partial plaintext may escape: %+v", got)
			}
			var e *errs.Error
			if !errors.As(err, &e) {
				t.Fatalf("err = %v, want *errs.Error", err)
			}
			if e.Category != errs.CategoryCredential || e.Code != CodeTampered {
				t.Fatalf("got %s/%s, want credential/%s", e.Category, e.Code, CodeTampered)
			}
			if strings.Contains(err.Error(), secretKey) || strings.Contains(err.Error(), secretSecret) {
				t.Fatalf("error leaks plaintext: %v", err)
			}
		})
	}
}
