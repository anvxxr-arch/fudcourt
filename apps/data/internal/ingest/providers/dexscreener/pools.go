package dexscreener

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// pool fetches the pool snapshots for one job subject and writes canon.Pool
// rows plus the entity upserts they imply. The subject spelling is
//
//	chain:address        -> GET /token-pairs/v1/{chain}/{address} (array)
//	pair/chain:address   -> GET /latest/dex/pairs/{chain}/{address} ({"pairs":[...]})
//	search/chain:query   -> GET /latest/dex/search?q={query}        ({"pairs":[...]})
//
// The bare chain:address form is the seeded poll shape (one token, every
// pool that trades it); the prefixed forms opt into a specific pair or a
// search page. Every returned pair becomes one canon.Pool row: chain and DEX
// venue upsert on first sight, pool id mints over canon.PoolKey with the
// verbatim pairAddress (composite identities stay verbatim), and At is the
// fetch time — DexScreener serves a live snapshot, not a history.
func (c *client) pools(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	subject := job.Subject
	if s, ok := job.Cursor["subject"].(string); ok && s != "" {
		subject = s
	}
	mode, chain, key, ok := splitSubject(subject)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", Detail: "pool job needs subject chain:address, got " + subject}
	}
	var pairs []pairRow
	switch mode {
	case "token":
		url := fmt.Sprintf("%s/token-pairs/v1/%s/%s", Base, url.PathEscape(chain), url.PathEscape(key))
		if err := c.getJSON(ctx, url, &pairs); err != nil {
			return 0, 0, err
		}
	case "pair":
		url := fmt.Sprintf("%s/latest/dex/pairs/%s/%s", Base, url.PathEscape(chain), url.PathEscape(key))
		var res struct {
			Pairs []pairRow `json:"pairs"`
		}
		if err := c.getJSON(ctx, url, &res); err != nil {
			return 0, 0, err
		}
		pairs = res.Pairs
	case "search":
		url := fmt.Sprintf("%s/latest/dex/search?q=%s", Base, url.QueryEscape(key))
		var res struct {
			Pairs []pairRow `json:"pairs"`
		}
		if err := c.getJSON(ctx, url, &res); err != nil {
			return 0, 0, err
		}
		pairs = res.Pairs
	default:
		return 0, 0, &HardError{Kind: "shape", Detail: "unknown pool subject mode " + mode}
	}
	return writePairs(ctx, w, chain, pairs)
}

// writePairs maps wire pairs to canon rows and writes them: chains and DEX
// venues upsert first, pools write through WritePools. Rows whose chain or
// pair address is missing are counted as rejected, never guessed.
func writePairs(ctx context.Context, w canon.Writer, subjectChain string, pairs []pairRow) (int, int, error) {
	now := time.Now().UTC()
	var chains []canon.Chain
	var venues []canon.Venue
	var pools []canon.Pool
	rejected := 0
	seenChain := map[string]bool{}
	seenVenue := map[string]bool{}
	for _, p := range pairs {
		chain := lower(strings.TrimSpace(p.ChainID))
		if chain == "" {
			chain = lower(strings.TrimSpace(subjectChain))
		}
		address := strings.TrimSpace(p.PairAddress)
		if chain == "" || address == "" {
			rejected++
			continue
		}
		cid := canon.MintID(canon.KindChain, canon.ChainKey(chain))
		if !seenChain[cid] {
			chains = append(chains, canon.Chain{ChainID: cid, Name: chain, Kind: chainKind(chain)})
			seenChain[cid] = true
		}
		dex := lower(strings.TrimSpace(p.DexID))
		vid := ""
		if dex != "" {
			vid = canon.MintID(canon.KindVenue, canon.VenueKey(dex))
			if !seenVenue[vid] {
				venues = append(venues, canon.Venue{
					VenueID:     vid,
					Name:        strPtr(dex),
					Kind:        "dex",
					MarketTypes: []string{"swap"},
				})
				seenVenue[vid] = true
			}
		}
		pool := canon.Pool{
			PoolID:      canon.MintID(canon.KindPool, canon.PoolKey(chain, address)),
			ChainID:     cid,
			DEXVenueID:  vid,
			Address:     address,
			At:          now,
			Source:      Source,
			RetrievedAt: now,
		}
		if v, ok := f64(p.PriceUSD); ok {
			pool.Price = &v
		}
		if v, ok := f64(p.Liquidity.USD); ok {
			pool.LiquidityUSD = &v
		}
		if v, ok := f64(p.Volume.H24); ok {
			pool.Volume24hUSD = &v
		}
		if v, ok := f64(p.FDV); ok {
			pool.FdvUsd = &v
		}
		if p.BaseToken.Symbol != "" || p.BaseToken.Address != "" {
			pool.BaseAssetID = assetRef(chain, p.BaseToken)
		}
		if p.QuoteToken.Symbol != "" || p.QuoteToken.Address != "" {
			pool.QuoteAssetID = assetRef(chain, p.QuoteToken)
		}
		pools = append(pools, pool)
	}
	if len(chains) > 0 {
		if _, err := w.UpsertChains(ctx, chains); err != nil {
			return 0, 0, err
		}
	}
	if len(venues) > 0 {
		if _, err := w.UpsertVenues(ctx, venues); err != nil {
			return 0, 0, err
		}
	}
	if len(pools) == 0 {
		return 0, rejected, nil
	}
	written, rej, err := w.WritePools(ctx, pools)
	return written, rej + rejected, err
}

// assetRef mints the pool side's asset anchor: the canonical asset id for
// the token's symbol (kind resolved against the reference vocabulary). A
// symbol-less token anchors nil — the address alone does not mint an asset.
func assetRef(chain string, tok tokenRef) *string {
	sym := upper(strings.TrimSpace(tok.Symbol))
	if sym == "" {
		return nil
	}
	aid := canon.MintID(canon.KindAsset, canon.AssetKey(assetKind(sym), sym))
	return &aid
}

// splitSubject splits the job subject into its mode/chain/key triple:
// "chain:address" is a token subject, "pair/chain:address" and
// "search/chain:query" opt into the wrapped endpoints.
func splitSubject(subject string) (mode, chain, key string, ok bool) {
	s := strings.TrimSpace(subject)
	if s == "" {
		return "", "", "", false
	}
	if rest, found := strings.CutPrefix(s, "pair/"); found {
		chain, key, ok = splitChainKey(rest)
		return "pair", chain, key, ok
	}
	if rest, found := strings.CutPrefix(s, "search/"); found {
		chain, key, ok = splitChainKey(rest)
		return "search", chain, key, ok
	}
	chain, key, ok = splitChainKey(s)
	return "token", chain, key, ok
}

// splitChainKey splits "chain:key" at the FIRST colon (a query may carry
// more; an address never does).
func splitChainKey(s string) (chain, key string, ok bool) {
	chain, key, found := strings.Cut(s, ":")
	chain = strings.TrimSpace(chain)
	key = strings.TrimSpace(key)
	if !found || chain == "" || key == "" {
		return "", "", false
	}
	return chain, key, true
}

// lower is strings.ToLower local (avoids a strings import per file).
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
