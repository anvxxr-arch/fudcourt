package helius

import (
	"context"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// This file implements the two Helius datasets: `swaps` and `wallet`. Both page
// backward through one address's enhanced-transaction history and map each
// transaction to a canonical DEX row. Solana's instruction index is not
// exposed by this endpoint, so a swap's log_index is the position of the swap
// within the transaction (0 for the primary swap); the contract is documented
// on SwapKey's caller here rather than guessed silently.

// heliusTx is one enhanced transaction (trimmed to the fields the adapter
// reads). Numerics arrive as json.Number (the decoder uses UseNumber), so an
// amount is parsed from its exact digits.
type heliusTx struct {
	Signature string         `json:"signature"`
	Slot      int64          `json:"slot"`
	Timestamp int64          `json:"timestamp"` // unix seconds
	Type      string         `json:"type"`
	FeePayer  string         `json:"feePayer"`
	Events    heliusTxEvents `json:"events"`
}

type heliusTxEvents struct {
	Swap *heliusSwap `json:"swap"`
}

type heliusSwap struct {
	TokenInputs  []heliusTokenTransfer `json:"tokenInputs"`
	TokenOutputs []heliusTokenTransfer `json:"tokenOutputs"`
	// NativeInput/NativeOutput carry the SOL side of a swap as lamports. They
	// are NOT optional decoration: on Solana a swap usually has ONE token side
	// and ONE native side (SOL is the quote asset of most pairs), so an adapter
	// that reads only the token arrays rejects the majority of real swaps —
	// measured against the live API, 1 of 10 swap events carried both token
	// sides while 5 of 10 had exactly one token side plus a native one.
	NativeInput  *heliusNativeTransfer `json:"nativeInput"`
	NativeOutput *heliusNativeTransfer `json:"nativeOutput"`
}

// heliusNativeTransfer is one native SOL side of a swap: the account and the
// amount in lamports, as exact digits (the decoder uses UseNumber).
type heliusNativeTransfer struct {
	Account string `json:"account"`
	Amount  string `json:"amount"`
}

type heliusTokenTransfer struct {
	UserAccount    string          `json:"userAccount"`
	Mint           string          `json:"mint"`
	RawTokenAmount heliusRawAmount `json:"rawTokenAmount"`
}

type heliusRawAmount struct {
	TokenAmount string `json:"tokenAmount"`
	Decimals    int    `json:"decimals"`
}

// wsolMint is the canonical handle for a SOL leg of a Solana swap. Helius
// reports a native transfer with no mint at all, but the leg still has a
// canonical token identity: Solana pools hold wrapped SOL, so the sibling
// jupiter adapter keys this same mint, at this same 9 decimals, for SOL legs.
// Reusing it keeps a SOL leg joinable across the two Solana adapters instead of
// inventing a second identity for the same asset.
const (
	wsolMint    = "So11111111111111111111111111111111111111112"
	solDecimals = 9
)

// solanaChainID is the canonical chain id the adapter anchors every row on.
func solanaChainID() string {
	return canon.MintID(canon.KindChain, canon.ChainKey("solana"))
}

// tokenID mints the canonical token id for a Solana mint.
func tokenID(mint string) string {
	return canon.MintID(canon.KindToken, canon.TokenKey("solana", mint))
}

// poolID mints the canonical pool id for the watched address (the job subject
// names the pool/market address whose history is being read).
func poolID(address string) string {
	return canon.MintID(canon.KindPool, canon.PoolKey("solana", address))
}

// splitSubject splits "chain:address" into its address (the chain prefix is
// fixed to solana for this adapter).
func splitSubject(subject string) string {
	if i := strings.IndexByte(subject, ':'); i >= 0 {
		return subject[i+1:]
	}
	return subject
}

// chainMeta is the entity upsert every fetch performs opportunistically.
func chainMeta() canon.Chain {
	return canon.Chain{ChainID: solanaChainID(), Name: "solana", Kind: "solana"}
}

// swaps implements the `swaps` dataset: one address page -> one canon.Swap per
// transaction carrying a swap event.
func (c *client) swaps(ctx context.Context, w canon.Writer, dw dexstore.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	address := splitSubject(job.Subject)
	before := cursorString(job.Cursor, "before")
	var txs []heliusTx
	if err := c.getJSON(ctx, c.txnsURL(address, pageTypeSwap, before), &txs); err != nil {
		return 0, 0, nil, err
	}
	if _, err := w.UpsertChains(ctx, []canon.Chain{chainMeta()}); err != nil {
		return 0, 0, nil, err
	}
	now := time.Now().UTC()
	rows := make([]canon.Swap, 0, len(txs))
	rejected := 0
	lastSig := ""
	for _, tx := range txs {
		// Only a non-empty signature may advance the backward cursor: an empty
		// one would clobber it to "" and make the next page restart from the
		// beginning (a silent infinite loop), so it is skipped here and counted
		// as a rejection below.
		if tx.Signature != "" {
			lastSig = tx.Signature
		}
		row, ok := mapSwap(address, tx, now)
		if !ok {
			rejected++
			continue
		}
		rows = append(rows, row)
	}
	written, rej, err := dw.WriteDexSwaps(ctx, rows)
	if err != nil {
		return written, rej + rejected, nil, err
	}
	// No signature advanced the cursor: return the job's cursor UNCHANGED.
	// Returning nil would wipe the stored column (MarkSuccess writes SQL NULL)
	// and returning {"before": ""} would read back as absent — either way the
	// next page restarts from the beginning.
	if lastSig == "" {
		return written, rej + rejected, job.Cursor, nil
	}
	return written, rej + rejected, ingest.Cursor{"before": lastSig}, nil
}

// mapSwap maps one enhanced transaction to a canon.Swap. ok is false when the
// transaction carries no usable swap (a non-swap type, or a swap where a side
// has neither a token nor a native transfer), which the caller counts as a
// rejection rather than fabricating a row.
func mapSwap(address string, tx heliusTx, now time.Time) (canon.Swap, bool) {
	if tx.Events.Swap == nil || tx.Signature == "" {
		return canon.Swap{}, false
	}
	in, hasIn := swapLeg(tx.Events.Swap.TokenInputs, tx.Events.Swap.NativeInput)
	out, hasOut := swapLeg(tx.Events.Swap.TokenOutputs, tx.Events.Swap.NativeOutput)
	if !hasIn || !hasOut {
		return canon.Swap{}, false
	}
	amountIn, okIn := rawAmount(in)
	amountOut, okOut := rawAmount(out)
	if !okIn || !okOut {
		return canon.Swap{}, false
	}
	eventTime := time.Unix(tx.Timestamp, 0).UTC()
	if tx.Timestamp == 0 {
		eventTime = now
	}
	slot := tx.Slot
	trader := tx.FeePayer
	if trader == "" {
		trader = in.UserAccount
	}
	// Solana log_index: 0 for the primary swap of a transaction (this endpoint
	// does not expose an instruction index). Documented on the SwapKey rule.
	prov := canon.ProvenanceForProvider(providerName)
	prov.ChainID = solanaChainID()
	prov.BlockNumber = &slot
	prov.TxHash = tx.Signature
	prov.ObservedAt = eventTime
	prov.NormalizedAt = now
	return canon.Swap{
		SwapID:      canon.MintID(canon.KindSwap, canon.SwapKey("solana", tx.Signature, 0)),
		NaturalKey:  canon.SwapKey("solana", tx.Signature, 0),
		PoolID:      poolID(address),
		ChainID:     solanaChainID(),
		TxHash:      tx.Signature,
		LogIndex:    0,
		BlockNumber: &slot,
		Trader:      trader,
		TokenIn:     tokenID(in.Mint),
		TokenOut:    tokenID(out.Mint),
		AmountIn:    amountIn,
		AmountOut:   amountOut,
		EventTime:   eventTime,
		Provenance:  prov,
	}, true
}

// wallet implements the `wallet` dataset: one address page -> one
// canon.WalletActivity per transaction.
func (c *client) wallet(ctx context.Context, w canon.Writer, dw dexstore.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	address := splitSubject(job.Subject)
	before := cursorString(job.Cursor, "before")
	var txs []heliusTx
	if err := c.getJSON(ctx, c.txnsURL(address, "", before), &txs); err != nil {
		return 0, 0, nil, err
	}
	if _, err := w.UpsertChains(ctx, []canon.Chain{chainMeta()}); err != nil {
		return 0, 0, nil, err
	}
	now := time.Now().UTC()
	rows := make([]canon.WalletActivity, 0, len(txs))
	rejected := 0
	lastSig := ""
	for _, tx := range txs {
		// Same rule as swaps: never let an empty signature clobber the cursor.
		if tx.Signature != "" {
			lastSig = tx.Signature
		}
		row, ok := mapWallet(address, tx, now)
		if !ok {
			rejected++
			continue
		}
		rows = append(rows, row)
	}
	written, rej, err := dw.WriteDexWalletActivity(ctx, rows)
	if err != nil {
		return written, rej + rejected, nil, err
	}
	if lastSig == "" {
		return written, rej + rejected, job.Cursor, nil
	}
	return written, rej + rejected, ingest.Cursor{"before": lastSig}, nil
}

// mapWallet maps one enhanced transaction to a canon.WalletActivity. ok is
// false for a transaction with no signature.
func mapWallet(address string, tx heliusTx, now time.Time) (canon.WalletActivity, bool) {
	if tx.Signature == "" {
		return canon.WalletActivity{}, false
	}
	eventTime := time.Unix(tx.Timestamp, 0).UTC()
	if tx.Timestamp == 0 {
		eventTime = now
	}
	kind := strings.ToLower(tx.Type)
	if kind == "" {
		kind = "unknown"
	}
	prov := canon.ProvenanceForProvider(providerName)
	prov.ChainID = solanaChainID()
	prov.TxHash = tx.Signature
	prov.ObservedAt = eventTime
	prov.NormalizedAt = now
	act := canon.WalletActivity{
		ActivityID: canon.MintID(canon.KindWalletActivity, canon.WalletActivityKey(providerName, tx.Signature)),
		NaturalKey: canon.WalletActivityKey(providerName, tx.Signature),
		Provider:   providerName,
		ChainID:    solanaChainID(),
		Wallet:     address,
		Kind:       kind,
		TxHash:     tx.Signature,
		EventTime:  eventTime,
		Provenance: prov,
	}
	// A swap activity also carries the moved token and amount. The input side
	// resolves through the same native-aware path as a swap leg, so a SOL-in
	// swap (the common case) is not left with an empty token and amount.
	if tx.Events.Swap != nil {
		if in, ok := swapLeg(tx.Events.Swap.TokenInputs, tx.Events.Swap.NativeInput); ok {
			act.PoolID = poolID(address)
			act.TokenID = tokenID(in.Mint)
			if amt, ok := rawAmount(in); ok {
				act.Amount = &amt
			}
		}
	}
	return act, true
}

// firstTransfer returns the first transfer of a side.
func firstTransfer(ts []heliusTokenTransfer) (heliusTokenTransfer, bool) {
	if len(ts) == 0 {
		return heliusTokenTransfer{}, false
	}
	return ts[0], true
}

// swapLeg resolves ONE side of a swap to a token transfer, preferring the token
// array and falling back to the native SOL transfer. Helius reports a SOL leg
// as nativeInput/nativeOutput (lamports, no mint), so a side is only truly
// absent when neither is present — which is what the caller rejects on.
func swapLeg(ts []heliusTokenTransfer, native *heliusNativeTransfer) (heliusTokenTransfer, bool) {
	if t, ok := firstTransfer(ts); ok {
		return t, true
	}
	return nativeAsTransfer(native)
}

// nativeAsTransfer spells a native SOL transfer as the wrapped-SOL token leg
// (see wsolMint) so it flows through the same amount path as any token leg.
// The amount is NOT rescaled by hand: lamports are the raw amount and 9 is
// SOL's exponent, which is exactly what rawAmount expects.
func nativeAsTransfer(n *heliusNativeTransfer) (heliusTokenTransfer, bool) {
	if n == nil || n.Amount == "" {
		return heliusTokenTransfer{}, false
	}
	return heliusTokenTransfer{
		UserAccount:    n.Account,
		Mint:           wsolMint,
		RawTokenAmount: heliusRawAmount{TokenAmount: n.Amount, Decimals: solDecimals},
	}, true
}

// rawAmount converts a transfer's raw token amount into an exact TokenAmount.
// A missing/zero-decimal amount is still exact: 0 decimals is a real mint class
// (an NFT-like or integer token), so it is preserved, not rejected.
func rawAmount(t heliusTokenTransfer) (canon.TokenAmount, bool) {
	if t.RawTokenAmount.TokenAmount == "" {
		return canon.TokenAmount{}, false
	}
	bi, ok := new(big.Int).SetString(t.RawTokenAmount.TokenAmount, 10)
	if !ok {
		return canon.TokenAmount{}, false
	}
	amt, err := canon.NewTokenAmount(bi, t.RawTokenAmount.Decimals)
	if err != nil {
		return canon.TokenAmount{}, false
	}
	return amt, true
}

// cursorString reads a string cursor field.
func cursorString(cur ingest.Cursor, key string) string {
	if cur == nil {
		return ""
	}
	if v, ok := cur[key].(string); ok {
		return v
	}
	return ""
}

// itoa is a local int->string helper (kept out of the hot path's imports).
func itoa(n int) string { return strconv.Itoa(n) }
