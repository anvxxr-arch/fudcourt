package geckoterminal

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// pool fetches one pool document and writes the canon rows it implies:
//
//	GET {Base}/networks/{network}/pools/{pool_address}?include=base_token,quote_token
//
// The job subject is network:pool_address ("eth:0x11b8..." — the network is
// GeckoTerminal's slug). The pool mints over canon.PoolKey with the canonical
// chain name the network maps to; the dex venue comes from
// relationships.dex ("uniswap_v3" — GeckoTerminal's dex id IS the venue slug
// the tree canonicalizes on, lowercased), falling back to "geckoterminal"
// when the relationship is absent. At is the fetch time: the endpoint is a
// live snapshot, not a history.
func (c *client) pool(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	subject := job.Subject
	if s, ok := job.Cursor["subject"].(string); ok && s != "" {
		subject = s
	}
	network, address, ok := strings.Cut(trimSpace(subject), ":")
	network, address = trimSpace(network), trimSpace(address)
	if !ok || network == "" || address == "" {
		return 0, 0, &HardError{Kind: "shape", Detail: "pool job needs subject network:pool_address, got " + subject}
	}
	chain, ok := networkToChain[network]
	if !ok {
		chain = strings.ToLower(network)
	}
	url := fmt.Sprintf("%s/networks/%s/pools/%s?include=base_token,quote_token",
		Base, url.PathEscape(network), url.PathEscape(address))
	var doc poolDoc
	if err := c.getJSON(ctx, url, &doc); err != nil {
		return 0, 0, err
	}
	attrs := doc.Data.Attributes
	poolAddr := trimSpace(attrs.Address)
	if poolAddr == "" {
		poolAddr = address
	}
	if poolAddr == "" {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "pool document carries no address"}
	}
	now := time.Now().UTC()
	cid := canon.MintID(canon.KindChain, canon.ChainKey(chain))
	if _, err := w.UpsertChains(ctx, []canon.Chain{{
		ChainID: cid,
		Name:    chain,
		Kind:    chainKind(chain),
	}}); err != nil {
		return 0, 0, err
	}
	dex := lower(doc.dexID())
	if dex == "" {
		dex = fallbackVenue
	}
	vid := canon.MintID(canon.KindVenue, canon.VenueKey(dex))
	if _, err := w.UpsertVenues(ctx, []canon.Venue{{
		VenueID:     vid,
		Name:        strPtr(dex),
		Kind:        "dex",
		MarketTypes: []string{"swap"},
	}}); err != nil {
		return 0, 0, err
	}
	tokens := doc.tokens()
	// The venue dex id carries the version suffix; the venue row is the dex,
	// the fee tier (when the pool name spells one, "WETH / USDT 0.05%") is
	// pool-level — parsed only from the documented fee field, never guessed.
	row := canon.Pool{
		PoolID:      canon.MintID(canon.KindPool, canon.PoolKey(chain, poolAddr)),
		ChainID:     cid,
		DEXVenueID:  vid,
		Address:     poolAddr,
		Price:       parseF64(attrs.BaseTokenPriceUSD),
		At:          now,
		Source:      Source,
		RetrievedAt: now,
	}
	if v := parseF64(attrs.ReserveInUSD); v != nil {
		row.LiquidityUSD = v
	}
	if v := parseF64(attrs.VolumeUSD.H24); v != nil {
		row.Volume24hUSD = v
	}
	if v := parseF64(attrs.FDVUSD); v != nil {
		row.FdvUsd = v
	}
	row.BaseAssetID = assetRef(tokens.base)
	row.QuoteAssetID = assetRef(tokens.quote)
	written, rejected, err := w.WritePools(ctx, []canon.Pool{row})
	return written, rejected, err
}

// assetRef mints the pool side's asset anchor from an included token row:
// the canonical asset id for the token's symbol (kind resolved against the
// reference vocabulary). A symbol-less token anchors nil — the address alone
// does not mint an asset.
func assetRef(tok *includedToken) *string {
	if tok == nil {
		return nil
	}
	sym := upper(trimSpace(tok.Symbol))
	if sym == "" {
		return nil
	}
	aid := canon.MintID(canon.KindAsset, canon.AssetKey(assetKind(sym), sym))
	return &aid
}

// lower is strings.ToLower local.
func lower(s string) string {
	return strings.ToLower(s)
}

// upper is strings.ToUpper local.
func upper(s string) string {
	return strings.ToUpper(s)
}

// strPtr is a non-empty string as a pointer; "" stays nil (never-fake).
func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
