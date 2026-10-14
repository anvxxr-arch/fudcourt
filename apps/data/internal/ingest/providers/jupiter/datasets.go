package jupiter

import (
	"context"
	"fmt"
	"math/big"
	"net/url"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// This file implements the two Jupiter datasets: `quote` (a route quote for one
// mint pair) and `tokens` (the token list). Numerics on the wire are decimal
// STRINGS or json.Number (the client decodes with UseNumber), so an amount is
// built from its exact digits — no float64 touches a quote.

// defaultQuoteSubject is the seeded quote subject: SOL -> USDC, 1 SOL in raw
// lamports. The spelling is mint:mint:rawAmount; an operator adds more pairs as
// further job rows on the same dataset.
const defaultQuoteSubject = "So11111111111111111111111111111111111111112:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:1000000000"

// quoteResponse is the Jupiter /quote body (trimmed to the fields the adapter
// reads). RoutePlan is the hop list.
type quoteResponse struct {
	InputMint            string          `json:"inputMint"`
	InAmount             string          `json:"inAmount"`
	OutputMint           string          `json:"outputMint"`
	OutAmount            string          `json:"outAmount"`
	OtherAmountThreshold string          `json:"otherAmountThreshold"`
	PriceImpactPct       string          `json:"priceImpactPct"`
	RoutePlan            []quotePlanStep `json:"routePlan"`
}

type quotePlanStep struct {
	Percent  int           `json:"percent"`
	SwapInfo quoteSwapInfo `json:"swapInfo"`
}

type quoteSwapInfo struct {
	AMMKey    string `json:"ammKey"`
	Label     string `json:"label"`
	FeeAmount string `json:"feeAmount"`
	FeeMint   string `json:"feeMint"`
}

// solanaChainID is the canonical chain id every row anchors on.
func solanaChainID() string {
	return canon.MintID(canon.KindChain, canon.ChainKey(chainSolana))
}

// tokenID mints the canonical token id for a Solana mint.
func tokenID(mint string) string {
	return canon.MintID(canon.KindToken, canon.TokenKey(chainSolana, mint))
}

// knownDecimals maps the well-known Solana mints to their decimals. It exists
// because the Jupiter quote endpoint returns RAW integers only: without the
// exponent the raw amount cannot be normalized, and defaulting to 0 would
// fabricate a value 1e9 too large (SOL) — a never-fake violation, not a
// cosmetic bug. A mint outside this map AND outside the job cursor is a LOUD
// failure, never a silent 0.
var knownDecimals = map[string]int{
	"So11111111111111111111111111111111111111112":  9, // wrapped SOL
	"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 6, // USDC
	"Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": 6, // USDT
	"JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN":  6, // JUP
	"mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So":  9, // mSOL
	"bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1":  9, // bSOL
}

// decimalsFor resolves a mint's decimals: an operator-supplied cursor value
// wins, then the known-mint map. ok is false when neither knows — the caller
// MUST fail loudly rather than assume 0.
func decimalsFor(mint string, cursor map[string]int) (int, bool) {
	if d, ok := cursor[mint]; ok {
		return d, true
	}
	d, ok := knownDecimals[mint]
	return d, ok
}

// quote implements the `quote` dataset. The subject carries mint:mint:raw; the
// resulting quote is written through the DEX writer. A malformed subject is a
// shape HardError (never a silent skip).
func (c *client) quote(ctx context.Context, w canon.Writer, dw dexstore.Writer, job ingest.Job) (int, int, error) {
	if dw == nil {
		return 0, 0, &HardError{Kind: "shape", Detail: "no dex writer wired"}
	}
	inMint, outMint, raw, ok := splitQuoteSubject(job.Subject)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", Detail: "quote subject must be mint:mint:rawAmount, got " + job.Subject}
	}
	q, err := c.fetchQuote(ctx, inMint, outMint, raw, slippageBpsFromCursor(job.Cursor))
	if err != nil {
		return 0, 0, err
	}
	now := time.Now().UTC()
	// Decimals for the raw quote amounts: the API returns a raw integer only,
	// so the exponent comes from the operator's cursor map, then the known-mint
	// table. An unknown mint is a LOUD failure — a silent 0 would fabricate a
	// normalized amount off by orders of magnitude.
	decimals := cursorDecimals(job.Cursor)
	inDec, ok := decimalsFor(inMint, decimals)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", Detail: "unknown decimals for input mint " + inMint + "; supply cursor.decimals"}
	}
	outDec, ok := decimalsFor(outMint, decimals)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", Detail: "unknown decimals for output mint " + outMint + "; supply cursor.decimals"}
	}
	inAmt, ok := rawAmount(q.InAmount, inDec)
	if !ok {
		return 0, 1, &HardError{Kind: "shape", Detail: "unparseable inAmount " + q.InAmount}
	}
	outAmt, ok := rawAmount(q.OutAmount, outDec)
	if !ok {
		return 0, 1, &HardError{Kind: "shape", Detail: "unparseable outAmount " + q.OutAmount}
	}
	var impact *canon.Dec
	if d, err := canon.DecFromString(q.PriceImpactPct); err == nil {
		impact = &d
	}
	legs := make([]canon.RouteLeg, 0, len(q.RoutePlan))
	for i, step := range q.RoutePlan {
		leg := canon.RouteLeg{Index: i, TokenIn: tokenID(inMint), TokenOut: tokenID(outMint)}
		leg.Sources = []canon.LiquiditySource{{
			PoolID:  canon.MintID(canon.KindPool, canon.PoolKey(chainSolana, step.SwapInfo.AMMKey)),
			ChainID: solanaChainID(),
		}}
		// RoutePlan is PERCENT-based: this leg carries its share of the total,
		// not the whole amount. Both sides are derived exactly from the percent
		// (scaled by 100 for the division), never left nil and never the full
		// input. A step with no usable percent leaves the leg amounts absent
		// rather than fabricating one.
		if amt, ok := legShare(inAmt, step.Percent); ok {
			leg.AmountIn = amt
		}
		if amt, ok := legShare(outAmt, step.Percent); ok {
			leg.AmountOut = amt
		}
		legs = append(legs, leg)
	}
	prov := canon.ProvenanceForProvider(providerName)
	prov.ChainID = solanaChainID()
	prov.SourceEndpoint = c.base + "/swap/v1/quote"
	prov.ObservedAt = now
	prov.NormalizedAt = now
	quote := canon.RouteQuote{
		QuoteID:        canon.MintID(canon.KindRouteQuote, canon.RouteQuoteKey(providerName, tokenID(inMint), tokenID(outMint), raw)),
		NaturalKey:     canon.RouteQuoteKey(providerName, tokenID(inMint), tokenID(outMint), raw),
		Provider:       providerName,
		ChainID:        solanaChainID(),
		TokenIn:        tokenID(inMint),
		TokenOut:       tokenID(outMint),
		AmountIn:       inAmt,
		AmountOut:      outAmt,
		Legs:           legs,
		PriceImpactPct: impact,
		QuotedAt:       now,
		Provenance:     prov,
	}
	if _, err := w.UpsertChains(ctx, []canon.Chain{{ChainID: solanaChainID(), Name: chainSolana, Kind: "solana"}}); err != nil {
		return 0, 0, err
	}
	written, rejected, err := dw.WriteDexRouteQuotes(ctx, []canon.RouteQuote{quote})
	if err != nil {
		return written, rejected, err
	}
	hotCacheQuote(ctx, quote)
	return written, rejected, nil
}

// fetchQuote performs the /quote GET and decodes it exactly.
func (c *client) fetchQuote(ctx context.Context, inMint, outMint, raw string, slippageBps int) (quoteResponse, error) {
	u := c.base + "/swap/v1/quote?inputMint=" + url.QueryEscape(inMint) +
		"&outputMint=" + url.QueryEscape(outMint) +
		"&amount=" + url.QueryEscape(raw) +
		"&slippageBps=" + fmt.Sprintf("%d", slippageBps)
	var q quoteResponse
	if err := c.getJSON(ctx, u, &q); err != nil {
		return quoteResponse{}, err
	}
	return q, nil
}

// tokensResponse is one entry of the /tokens list.
type tokensResponse struct {
	Address  string `json:"address"`
	Symbol   string `json:"symbol"`
	Name     string `json:"name"`
	Decimals int    `json:"decimals"`
}

// tokens implements the `tokens` dataset: the daily token list, upserted as
// canonical assets plus the (jupiter, mint) -> token-id provider-symbol map.
func (c *client) tokens(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	var list []tokensResponse
	if err := c.getJSON(ctx, c.base+"/tokens/v2/tag?query=verified", &list); err != nil {
		return 0, 0, err
	}
	now := time.Now().UTC()
	assets := make([]canon.Asset, 0, len(list))
	symbols := make([]canon.ProviderSymbol, 0, len(list))
	for _, t := range list {
		if t.Address == "" || t.Symbol == "" {
			continue
		}
		tid := tokenID(t.Address)
		assets = append(assets, canon.Asset{
			AssetID: tid, Symbol: t.Symbol, Name: strPtrOrNil(t.Name), Kind: canon.AssetOther,
		})
		symbols = append(symbols, canon.ProviderSymbol{
			Provider: providerName, ProviderSymb: t.Address,
			Kind: string(canon.KindToken), CanonicalID: tid, LastSeenAt: &now,
		})
	}
	aw, err := w.UpsertAssets(ctx, assets)
	if err != nil {
		return aw, 0, err
	}
	if _, err := w.UpsertProviderSymbols(ctx, symbols); err != nil {
		return aw, 0, err
	}
	return aw, len(list) - len(assets), nil
}

// legShare scales a token amount by a route-plan percent (an integer 0-100),
// exactly: raw * percent / 100. The multiplication is exact and the division by
// 100 is exact only when it divides evenly; a non-terminating share is TRUNCATED
// toward zero (the leg cannot hold less than a whole smallest-unit), which is the
// honest floor rather than a fabricated rounding. ok is false for a missing raw
// amount or a percent outside (0,100].
func legShare(total canon.TokenAmount, percent int) (canon.TokenAmount, bool) {
	if total.Raw == nil || percent <= 0 || percent > 100 {
		return canon.TokenAmount{}, false
	}
	num := new(big.Int).Mul(total.Raw, big.NewInt(int64(percent)))
	num.Quo(num, big.NewInt(100))
	if num.Sign() == 0 {
		return canon.TokenAmount{}, false
	}
	amt, err := canon.NewTokenAmount(num, total.Decimals)
	if err != nil {
		return canon.TokenAmount{}, false
	}
	return amt, true
}

// splitQuoteSubject parses mint:mint:rawAmount.
func splitQuoteSubject(subject string) (inMint, outMint, raw string, ok bool) {
	parts := strings.Split(subject, ":")
	if len(parts) != 3 {
		return "", "", "", false
	}
	if parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return "", "", "", false
	}
	if _, ok := new(big.Int).SetString(parts[2], 10); !ok {
		return "", "", "", false
	}
	return parts[0], parts[1], parts[2], true
}

// rawAmount builds an exact TokenAmount from a raw integer string and decimals.
func rawAmount(rawStr string, decimals int) (canon.TokenAmount, bool) {
	if rawStr == "" {
		return canon.TokenAmount{}, false
	}
	bi, ok := new(big.Int).SetString(rawStr, 10)
	if !ok {
		return canon.TokenAmount{}, false
	}
	amt, err := canon.NewTokenAmount(bi, decimals)
	if err != nil {
		return canon.TokenAmount{}, false
	}
	return amt, true
}

// cursorDecimals reads a mint->decimals map from the job cursor.
func cursorDecimals(cur ingest.Cursor) map[string]int {
	out := map[string]int{}
	if cur == nil {
		return out
	}
	raw, ok := cur["decimals"].(map[string]any)
	if !ok {
		return out
	}
	for mint, v := range raw {
		switch n := v.(type) {
		case int:
			out[mint] = n
		case int64:
			out[mint] = int(n)
		case float64:
			out[mint] = int(n)
		case string:
			var d int
			fmt.Sscanf(n, "%d", &d)
			out[mint] = d
		}
	}
	return out
}

// slippageBpsFromCursor reads the optional slippage; default 50 bps.
func slippageBpsFromCursor(cur ingest.Cursor) int {
	if cur == nil {
		return 50
	}
	switch v := cur["slippageBps"].(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	}
	return 50
}

// strPtrOrNil returns a pointer to s, or nil for an empty string (never-fake:
// an empty name is absent, not "").
func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
