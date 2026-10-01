package credentials

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"fmt"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

// Envelope geometry, mirrored from the TS store (apps/web/src/platform/
// executor/store.ts, sealCredentials/openCredentials): AES-256-GCM with one
// 12-byte IV and one 16-byte auth tag per secret, concatenated per column.
const (
	// MasterKeySize is the only accepted master key length (AES-256).
	MasterKeySize = 32
	// NonceSize is the per-secret GCM IV length (store.ts IV_LEN).
	NonceSize = 12
	// TagSize is the per-secret GCM auth tag length (store.ts TAG_LEN).
	TagSize = 16
)

// NewMasterKey validates and decodes a hex master key. INVARIANT: wrong length
// or non-hex input is refused before any crypto runs — a malformed key must
// fail as a plain validation error, never reach a cipher constructor. Exactly
// 32 bytes (64 hex characters, either case) are accepted.
func NewMasterKey(hexKey string) ([]byte, error) {
	if len(hexKey) != 2*MasterKeySize {
		return nil, errs.New(errs.CategoryValidation, CodeKeyInvalid,
			fmt.Sprintf("master key must be %d hex characters (%d bytes), got %d characters", 2*MasterKeySize, MasterKeySize, len(hexKey)))
	}
	key, err := hex.DecodeString(hexKey) // refuses non-hex without touching a cipher
	if err != nil {
		return nil, errs.Wrap(errs.CategoryValidation, CodeKeyInvalid, "master key must be hexadecimal", err)
	}
	return key, nil
}

// Envelope is the sealed form of one credential's secrets. It mirrors the TS
// row layout byte-for-byte: Fields holds the ciphertext columns in the fixed
// column order api_key, api_secret, [optional passphrase], while IV and AuthTag
// are the per-secret 12-byte nonce and 16-byte GCM tag concatenated in that
// same column order. Ciphertext is not secret material and may be persisted,
// but only these sealed columns may leave the vault path.
type Envelope struct {
	Fields  [][]byte `json:"fields"`
	IV      []byte   `json:"iv"`
	AuthTag []byte   `json:"auth_tag"`
}

// Revealed holds the decrypted secret material of one credential.
//
// SERVER-SIDE ONLY: it must never be serialized to a client, written to a log
// or put in a URL (DR-021). It exists solely so the exchange adapter can sign
// requests, and its lifetime is that single call path; Go strings cannot be
// wiped, so callers MUST NOT retain or copy it.
type Revealed struct {
	APIKey    string
	APISecret string
	// Passphrase is present only for venues whose key needs one (the optional
	// third envelope column); nil means genuinely absent, never empty-string.
	Passphrase *string
}

// Seal encrypts secrets into an Envelope under a 32-byte master key. plaintexts
// are positional in the fixed column order api_key, api_secret, [passphrase]:
// exactly two or three values. Every secret gets a fresh random 12-byte nonce
// (a GCM nonce is never reused). INVARIANT: fail closed — any bad key, bad
// arity or entropy failure yields a zero Envelope and an error, never a
// partially sealed credential.
func Seal(key []byte, plaintexts ...string) (Envelope, error) {
	aead, err := newAEAD(key)
	if err != nil {
		return Envelope{}, err
	}
	n := len(plaintexts)
	if n < 2 || n > 3 {
		return Envelope{}, errs.New(errs.CategoryCredential, CodeSealFailed,
			fmt.Sprintf("seal needs api_key and api_secret with an optional passphrase, got %d fields", n))
	}
	env := Envelope{
		Fields:  make([][]byte, n),
		IV:      make([]byte, 0, n*NonceSize),
		AuthTag: make([]byte, 0, n*TagSize),
	}
	for i, plain := range plaintexts {
		nonce := make([]byte, aead.NonceSize())
		if _, err := rand.Read(nonce); err != nil {
			return Envelope{}, errs.Wrap(errs.CategoryCredential, CodeSealFailed, "credential seal failed", err)
		}
		sealed := aead.Seal(nil, nonce, []byte(plain), nil)
		cut := len(sealed) - aead.Overhead()
		env.Fields[i] = sealed[:cut]
		env.IV = append(env.IV, nonce...)
		env.AuthTag = append(env.AuthTag, sealed[cut:]...)
	}
	return env, nil
}

// Open decrypts an Envelope produced by Seal. INVARIANT: it returns either all
// plaintexts or a single error and never a partial Revealed — a wrong key or
// any tampering fails the whole envelope (GCM authentication), so columns that
// happen to authenticate can never leak alongside one that does not.
func Open(key []byte, env Envelope) (Revealed, error) {
	aead, err := newAEAD(key)
	if err != nil {
		return Revealed{}, err
	}
	n := len(env.Fields)
	if n < 2 || n > 3 || len(env.IV) != n*NonceSize || len(env.AuthTag) != n*TagSize {
		// Mirrors openCredentials in store.ts: a layout that disagrees with the
		// stored secret count is treated as tampering, not as a best guess.
		return Revealed{}, errs.New(errs.CategoryCredential, CodeTampered, "credential envelope layout does not match its secret count")
	}
	plaintexts := make([]string, n)
	for i, ct := range env.Fields {
		sealed := make([]byte, 0, len(ct)+TagSize)
		sealed = append(sealed, ct...)
		sealed = append(sealed, env.AuthTag[i*TagSize:(i+1)*TagSize]...)
		out, err := aead.Open(nil, env.IV[i*NonceSize:(i+1)*NonceSize], sealed, nil)
		if err != nil {
			return Revealed{}, errs.Wrap(errs.CategoryCredential, CodeTampered, "credential envelope failed authentication", err)
		}
		plaintexts[i] = string(out)
	}
	rev := Revealed{APIKey: plaintexts[0], APISecret: plaintexts[1]}
	if n == 3 {
		passphrase := plaintexts[2]
		rev.Passphrase = &passphrase
	}
	return rev, nil
}

// newAEAD builds the AES-256-GCM cipher after the one key-shape check both
// directions share (32 bytes), so neither Seal nor Open can run with a key of
// the wrong strength.
func newAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) != MasterKeySize {
		return nil, errs.New(errs.CategoryValidation, CodeKeyInvalid,
			fmt.Sprintf("master key must be %d bytes", MasterKeySize))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errs.Wrap(errs.CategoryCredential, CodeSealFailed, "credential cipher unavailable", err)
	}
	aead, err := cipher.NewGCM(block) // standard 12-byte nonce size
	if err != nil {
		return nil, errs.Wrap(errs.CategoryCredential, CodeSealFailed, "credential cipher unavailable", err)
	}
	return aead, nil
}
