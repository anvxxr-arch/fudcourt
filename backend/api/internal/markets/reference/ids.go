package reference

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// IDHexLen is the number of sha256 hex digits kept in a minted id. 10 hex
// digits is 40 bits; the registry holds hundreds of entities, so the
// birthday-collision horizon is far beyond its scale - and Build still refuses a
// collision instead of trusting that arithmetic (see the duplicate check in
// registry.go).
const IDHexLen = 10

// MintID returns the canonical id for one entity.
//
// The rule, in one line: id = kind + ":" + sha256(salt NUL kind NUL naturalKey)
// truncated to IDHexLen hex digits. It is a pure function of its arguments - no
// clock, no randomness, no counter, no map order - which is what makes an id
// reproducible in another process, another machine and another language.
//
// naturalKey MUST be the entity's stable natural key (see the package doc for
// the per-kind rule), not a display name: this function cannot check that, so
// the callers in this package construct it, the document records it, and the
// tests pin the output.
func MintID(kind EntityKind, naturalKey string) string {
	return MintIDWithSalt(kind, naturalKey, Salt)
}

// MintIDWithSalt is MintID with an explicit salt. It exists so a test can prove
// the salt is actually hashed (changing it must change every id), instead of the
// salt being a decorative string nothing reads.
func MintIDWithSalt(kind EntityKind, naturalKey, salt string) string {
	h := sha256.New()
	h.Write([]byte(salt))
	h.Write([]byte{0})
	h.Write([]byte(kind))
	h.Write([]byte{0})
	h.Write([]byte(naturalKey))
	return string(kind) + ":" + hex.EncodeToString(h.Sum(nil))[:IDHexLen]
}

// AssetKey builds an asset's natural key. See the package doc: an asset is the
// one entity whose key is symbol-derived, because native coins and fiat units
// have no issuer identity anywhere in the tree.
func AssetKey(kind AssetKind, symbol string) string {
	return "asset/" + string(kind) + "/" + strings.ToUpper(strings.TrimSpace(symbol))
}

// TokenKey builds a token's natural key from the chain's canonical name and the
// FULL contract address. Truncation is refused rather than silently producing a
// different token, which is the fix for the `SPL:<mint6>` label (see seed.go).
func TokenKey(chainName, address string) string {
	return "token/" + strings.ToLower(strings.TrimSpace(chainName)) + "/" + strings.TrimSpace(address)
}

// ChainKey builds a chain's natural key from its canonical lowercase name.
func ChainKey(name string) string {
	return "chain/" + strings.ToLower(strings.TrimSpace(name))
}

// VenueKey builds a venue's natural key from the venue id the tree already uses.
func VenueKey(venueID string) string {
	return "venue/" + strings.ToLower(strings.TrimSpace(venueID))
}

// AddressKind classifies a contract address the way the repo already does:
// frontend/web/src/features/dex/client.ts addressKind returns
// base58 | hex | name from three regexes, because DexScreener accepts all three
// shapes. The same three families are recognized here so a token's address_kind
// is exactly one of the contract's enum values.
//
// The classification is by the STRING'S OWN SHAPE, never by an assumption about
// the chain: guessing a chain from an address shape is the silent invention
// backend/api/internal/accounts/wallets/wallets.go explicitly refuses to make.
func AddressKind(address string) (string, error) {
	addr := strings.TrimSpace(address)
	if addr == "" {
		return "", fmt.Errorf("%w: address is empty", ErrInvalidSeed)
	}
	if EVMAddressShape.MatchString(addr) {
		return "hex", nil
	}
	if SolAddressShape.MatchString(addr) {
		return "base58", nil
	}
	if NameAddressShape.MatchString(addr) {
		return "name", nil
	}
	return "", fmt.Errorf("%w: address %q is not an address this build can classify", ErrInvalidSeed, address)
}
