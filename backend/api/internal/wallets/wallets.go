// Package wallets is the metadata of blockchain wallets (objective §8.20).
//
// The defining boundary: a wallet here is a CHAIN ADDRESS and nothing else. A
// centralized exchange account is not a wallet — it has no address the user
// controls, its balance is an IOU, and modelling it as a wallet would make the
// portfolio claim custody that does not exist. New therefore refuses chain
// names that are exchanges (code WALLET_CHAIN_IS_EXCHANGE).
package wallets

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

// Ownership records who controls the wallet's keys. The set is closed: the
// whole point of tracking ownership is distinguishing our own keys from
// someone else's, so an unlisted value is refused.
type Ownership string

const (
	OwnershipSelf     Ownership = "self"     // we hold the keys
	OwnershipExternal Ownership = "external" // someone else holds the keys
)

// Wallet is one blockchain wallet's metadata.
//
// Invariants (enforced by New): Chain, Address and Label are non-empty; Chain
// is a known chain (never a CEX name) and is stored lowercase; Address is
// valid for Chain and stored in that chain's canonical form (see
// NormalizeAddress); Ownership is self or external. Alias, Emoji, Color and
// Notes are optional display fields. PortfolioLinked records whether this
// wallet's balances count toward the portfolio view.
type Wallet struct {
	ID              string
	Chain           string
	Address         string
	Label           string
	Alias           string
	Emoji           string
	Color           string
	Notes           string
	Ownership       Ownership
	PortfolioLinked bool
}

// exchangeChains are centralized-exchange names that must never appear as a
// wallet's chain: a CEX account is an IOU on a venue, not a chain address
// (objective §8.20).
var exchangeChains = map[string]bool{
	"binance": true,
	"bybit":   true,
	"mexc":    true,
}

// addressRule is one chain's address normalization rule, kept as an explicit
// per-chain table — the chains that actually exist in the sync pipeline
// (services/sync + apps/web/scripts/tools/sync-live.py), exactly those and no
// guesses. Ethereum-style chains accept 0x hex and are canonicalized to
// lowercase hex; Solana addresses are base58 and case-SENSITIVE, so their case
// is preserved byte for byte.
type addressRule struct {
	kind string // "evm" | "sol"
}

var chainRules = map[string]addressRule{
	"ethereum": {kind: "evm"},
	"bsc":      {kind: "evm"},
	"polygon":  {kind: "evm"},
	"arbitrum": {kind: "evm"},
	"optimism": {kind: "evm"},
	"base":     {kind: "evm"},
	"solana":   {kind: "sol"},
}

var (
	evmAddressShape = regexp.MustCompile(`^(0[xX])?[0-9a-fA-F]{40}$`)
	solAddressShape = regexp.MustCompile(`^[1-9A-HJ-NP-Za-km-z]{32,44}$`)
)

// NormalizeAddress returns the canonical form of addr on chain: lowercase
// 0x-prefixed hex for ethereum-style chains (EVM addresses are
// case-insensitive; lowercasing makes string equality the lookup), the exact
// input for solana (base58 is case-sensitive — lowercasing would corrupt it).
// An unknown chain is refused with WALLET_CHAIN_UNSUPPORTED, a malformed
// address with WALLET_ADDRESS_INVALID: the rule table covers the chains that
// exist, and guessing an address's chain from its shape would be a silent
// invention.
func NormalizeAddress(chain, addr string) (string, error) {
	rule, ok := chainRules[strings.ToLower(strings.TrimSpace(chain))]
	if !ok {
		return "", errs.New(errs.CategoryValidation, "WALLET_CHAIN_UNSUPPORTED",
			fmt.Sprintf("chain %q is not one of ethereum, bsc, polygon, arbitrum, optimism, base, solana", chain))
	}
	trimmed := strings.TrimSpace(addr)
	switch rule.kind {
	case "evm":
		if !evmAddressShape.MatchString(trimmed) {
			return "", errs.New(errs.CategoryValidation, "WALLET_ADDRESS_INVALID",
				fmt.Sprintf("address %q is not a 20-byte hex address", addr))
		}
		hex := strings.TrimPrefix(strings.TrimPrefix(trimmed, "0x"), "0X")
		return "0x" + strings.ToLower(hex), nil
	default: // "sol"
		if !solAddressShape.MatchString(trimmed) {
			return "", errs.New(errs.CategoryValidation, "WALLET_ADDRESS_INVALID",
				fmt.Sprintf("address %q is not a base58 solana address", addr))
		}
		return trimmed, nil
	}
}

// New validates w and returns it with Chain lowercased and Address in the
// chain's canonical form.
//
// It refuses (errs.CategoryValidation, message naming the field): a missing
// chain, address or label; a chain that names a centralized exchange (code
// WALLET_CHAIN_IS_EXCHANGE — the wallets/exchanges separation is enforced, not
// documented-and-hoped); a chain outside the per-chain rule table; an address
// that does not fit its chain; and an Ownership outside self/external.
func New(w Wallet) (Wallet, error) {
	chain := strings.ToLower(strings.TrimSpace(w.Chain))
	if chain == "" {
		return Wallet{}, errs.New(errs.CategoryValidation, "WALLET_FIELD_REQUIRED", "chain is required")
	}
	if exchangeChains[chain] {
		return Wallet{}, errs.New(errs.CategoryValidation, "WALLET_CHAIN_IS_EXCHANGE",
			fmt.Sprintf("chain %q names a centralized exchange: a wallet is a chain address, never a CEX account", w.Chain))
	}
	if strings.TrimSpace(w.Address) == "" {
		return Wallet{}, errs.New(errs.CategoryValidation, "WALLET_ADDRESS_INVALID", "address is required")
	}
	if strings.TrimSpace(w.Label) == "" {
		return Wallet{}, errs.New(errs.CategoryValidation, "WALLET_FIELD_REQUIRED", "label is required")
	}
	if w.Ownership != OwnershipSelf && w.Ownership != OwnershipExternal {
		return Wallet{}, errs.New(errs.CategoryValidation, "WALLET_OWNERSHIP_INVALID",
			fmt.Sprintf("ownership %q is not self or external", w.Ownership))
	}
	address, err := NormalizeAddress(chain, w.Address)
	if err != nil {
		return Wallet{}, err
	}
	w.Chain = chain
	w.Address = address
	return w, nil
}
