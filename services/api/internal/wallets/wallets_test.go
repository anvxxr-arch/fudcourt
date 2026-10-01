package wallets

import (
	"errors"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

const (
	evmAddr  = "0x6816ba2cb2bc013a78225228a153586ca63b1548"
	evmMixed = "0x6816BA2CB2BC013A78225228A153586CA63B1548"
	solAddr  = "7KMhEBFjmhhC1B2HqaJC7zvkyx9pJ9ryCXqUnGBThgFP"
)

func validWallet() Wallet {
	return Wallet{
		ID: "w-1", Chain: "Ethereum", Address: evmMixed, Label: "Main",
		Ownership: OwnershipSelf, PortfolioLinked: true,
	}
}

func wantRefusal(t *testing.T, err error, code, namesField string) {
	t.Helper()
	var canonical *errs.Error
	if !errors.As(err, &canonical) {
		t.Fatalf("error %v is not a canonical errs.Error", err)
	}
	if canonical.Code != code {
		t.Fatalf("code = %q, want %q (message %q)", canonical.Code, code, canonical.Message)
	}
	if canonical.Category != errs.CategoryValidation {
		t.Fatalf("category = %q, want validation", canonical.Category)
	}
	if namesField != "" && !strings.Contains(canonical.Message, namesField) {
		t.Fatalf("message %q does not name %q", canonical.Message, namesField)
	}
}

func TestNewCanonicalizesAndRequiresFields(t *testing.T) {
	w, err := New(validWallet())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if w.Chain != "ethereum" {
		t.Fatalf("Chain = %q, want lowercased %q", w.Chain, "ethereum")
	}
	if w.Address != evmAddr {
		t.Fatalf("Address = %q, want lowercase EVM hex %q", w.Address, evmAddr)
	}

	cases := []struct {
		name  string
		mut   func(*Wallet)
		code  string
		field string
	}{
		{"missing chain", func(w *Wallet) { w.Chain = " " }, "WALLET_FIELD_REQUIRED", "chain"},
		{"missing address", func(w *Wallet) { w.Address = "" }, "WALLET_ADDRESS_INVALID", "address"},
		{"missing label", func(w *Wallet) { w.Label = "" }, "WALLET_FIELD_REQUIRED", "label"},
		{"unknown chain", func(w *Wallet) { w.Chain = "dogechain" }, "WALLET_CHAIN_UNSUPPORTED", "dogechain"},
		{"solana address on ethereum", func(w *Wallet) { w.Address = solAddr }, "WALLET_ADDRESS_INVALID", "address"},
		{"short hex", func(w *Wallet) { w.Address = "0x1234" }, "WALLET_ADDRESS_INVALID", "address"},
		{"ownership", func(w *Wallet) { w.Ownership = "custodian" }, "WALLET_OWNERSHIP_INVALID", "ownership"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := validWallet()
			tc.mut(&w)
			_, err := New(w)
			if err == nil {
				t.Fatal("New must refuse")
			}
			wantRefusal(t, err, tc.code, tc.field)
		})
	}
}

func TestNewRefusesExchangeChains(t *testing.T) {
	// The wallets/exchanges separation is enforced at the door: a CEX account
	// is not a chain address and must not be modelled as one.
	for _, chain := range []string{"binance", "Binance", "BYBIT", "mexc"} {
		w := validWallet()
		w.Chain = chain
		_, err := New(w)
		var canonical *errs.Error
		if !errors.As(err, &canonical) || canonical.Code != "WALLET_CHAIN_IS_EXCHANGE" {
			t.Fatalf("chain %q: err = %v, want WALLET_CHAIN_IS_EXCHANGE", chain, err)
		}
	}
}

func TestNormalizeAddressPerChainRules(t *testing.T) {
	cases := []struct {
		chain, addr, want string
	}{
		{"Ethereum", evmMixed, evmAddr},
		{"bsc", "0X6816BA2CB2BC013A78225228A153586CA63B1548", evmAddr},
		{"polygon", evmAddr, evmAddr},
		{"arbitrum", evmMixed, evmAddr},
		{"optimism", evmAddr, evmAddr},
		{"base", evmMixed, evmAddr},
		// Solana base58 is case-sensitive: preserved byte for byte.
		{"solana", solAddr, solAddr},
		{"Solana", "  " + solAddr + " ", solAddr},
	}
	for _, tc := range cases {
		got, err := NormalizeAddress(tc.chain, tc.addr)
		if err != nil {
			t.Fatalf("NormalizeAddress(%q, %q): %v", tc.chain, tc.addr, err)
		}
		if got != tc.want {
			t.Fatalf("NormalizeAddress(%q, %q) = %q, want %q", tc.chain, tc.addr, got, tc.want)
		}
	}

	// Mixed-case solana must survive untouched — lowercasing would corrupt it.
	mixed := "7KmhebFJmhhC1B2HqaJC7zvkyx9pJ9ryCXqUnGBThgFP"
	got, err := NormalizeAddress("solana", mixed)
	if err != nil {
		t.Fatalf("NormalizeAddress: %v", err)
	}
	if got != mixed {
		t.Fatalf("solana address case corrupted: %q, want %q", got, mixed)
	}

	for _, tc := range []struct{ chain, addr, code string }{
		{"dogechain", evmAddr, "WALLET_CHAIN_UNSUPPORTED"},
		{"solana", evmAddr, "WALLET_ADDRESS_INVALID"},
		{"ethereum", solAddr, "WALLET_ADDRESS_INVALID"},
		{"ethereum", "0xZZ16ba2cb2bc013a78225228a153586ca63b154", "WALLET_ADDRESS_INVALID"},
		{"solana", "0OIl-short", "WALLET_ADDRESS_INVALID"},
	} {
		_, err := NormalizeAddress(tc.chain, tc.addr)
		wantRefusal(t, err, tc.code, "")
	}
}
