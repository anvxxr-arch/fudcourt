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
	// The sides' display symbols, when the include[] carried them. canon.Pool
	// carries them so a consumer can NAME a pool's sides without a join, and
	// every pool read projects them — leaving them unset would make every pool
	// anonymous in the API even though the symbol is right there in the
	// payload. Uppercased like the asset key they accompany; a symbol-less
	// token stays nil (never-fake), never "".
	row.BaseSymbol = sideSymbol(tokens.base)
	row.QuoteSymbol = sideSymbol(tokens.quote)
	// The pool's own creation time (age on a board). RFC3339 upstream; an
	// absent or unparseable value stays nil rather than defaulting to now,
	// which would report a five-year-old pool as brand new.
	row.PoolCreatedAt = parsePoolCreatedAt(attrs.PoolCreatedAt)
	written, rejected, err := w.WritePools(ctx, []canon.Pool{row})
	return written, rejected, err
}

// parsePoolCreatedAt parses the documented RFC3339 pool created_at. Anything
// else — blank, malformed, a zero instant — is absent (nil), never a guess and
// never a zero time that would render as 1970.
func parsePoolCreatedAt(raw string) *time.Time {
	s := trimSpace(raw)
	if s == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil || t.IsZero() {
		return nil
	}
	u := t.UTC()
	return &u
}

// sideSymbol is the upper-cased display symbol of one included token, nil when
// the row is absent or carries no symbol.
func sideSymbol(tok *includedToken) *string {
	if tok == nil {
		return nil
	}
	return strPtr(upper(trimSpace(tok.Symbol)))
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

// networksPoolsDoc is the JSON-API envelope for the per-network pools LIST:
// GET /networks/{network}/pools?sort=h24_volume_usd_desc&page=1
//
//	&include=base_token,quote_token,dex
//
// The provider allows only h24_volume_usd_desc and h24_tx_count_desc as sorts
// (a wrong sort is a loud 400 spelling that vocabulary). Attributes carry the
// numeric snapshot; relationships name the base/quote/dex by id; included[]
// resolves those ids to symbols/names. A relationship id with no included
// row resolves to nil — the pool still lands, anonymously but honestly.
type networksPoolsDoc struct {
	Data []struct {
		Attributes   poolAttrs `json:"attributes"`
		Relationship struct {
			BaseToken  relRef `json:"base_token"`
			QuoteToken relRef `json:"quote_token"`
			Dex        relRef `json:"dex"`
		} `json:"relationships"`
	} `json:"data"`
	Included []struct {
		ID         string `json:"id"`
		Type       string `json:"type"`
		Attributes struct {
			Address string `json:"address"`
			Symbol  string `json:"symbol"`
			Name    string `json:"name"`
		} `json:"attributes"`
	} `json:"included"`
}

// relRef is one JSON-API relationship reference block.
type relRef struct {
	Data struct {
		ID string `json:"id"`
	} `json:"data"`
}

// networksPools fetches the top-by-24h-volume pools for ONE network and
// writes the canon rows each implies: the chain, every distinct dex venue,
// and the pools with price/liquidity/volume/fdv/symbols/age.
//
// The job subject is the bare network slug ("hyperliquid"). This dataset is
// the platform's chain-breadth lever: it needs NO pinned addresses — one job
// per network seeds every requested chain from the provider's own ranking.
func (c *client) networksPools(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	network := trimSpace(job.Subject)
	if network == "" {
		return 0, 0, &HardError{Kind: "shape", Detail: "network-pools job needs subject network_slug"}
	}
	chain, ok := networkToChain[network]
	if !ok {
		// An unlisted slug still means the chain the slug spells: coverage
		// grows by listing a network, never by silently dropping one.
		chain = lower(network)
	}
	url := fmt.Sprintf("%s/networks/%s/pools?sort=h24_volume_usd_desc&page=1&include=base_token,quote_token,dex",
		Base, url.PathEscape(network))
	var doc networksPoolsDoc
	if err := c.getJSON(ctx, url, &doc); err != nil {
		return 0, 0, err
	}
	if len(doc.Data) == 0 {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "network " + network + " returned no pools"}
	}

	// included[] → id-keyed lookup (tokens and dexes share one block).
	type named struct {
		address, symbol, name string
	}
	included := make(map[string]named, len(doc.Included))
	for _, row := range doc.Included {
		if row.ID == "" {
			continue
		}
		included[row.ID] = named{address: row.Attributes.Address, symbol: row.Attributes.Symbol, name: row.Attributes.Name}
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

	// Distinct dex ids first: one venue upsert per dex, not per pool.
	venues := map[string]bool{}
	for _, p := range doc.Data {
		if id := trimSpace(p.Relationship.Dex.Data.ID); id != "" {
			venues[id] = true
		}
	}
	if len(venues) > 0 {
		rows := make([]canon.Venue, 0, len(venues))
		for id := range venues {
			slug := lower(trimSpace(id))
			name := strPtr(slug)
			if n, ok := included[id]; ok && trimSpace(n.name) != "" {
				name = strPtr(trimSpace(n.name))
			}
			rows = append(rows, canon.Venue{
				VenueID:     canon.MintID(canon.KindVenue, canon.VenueKey(slug)),
				Name:        name,
				Kind:        "dex",
				MarketTypes: []string{"swap"},
			})
		}
		if _, err := w.UpsertVenues(ctx, rows); err != nil {
			return 0, 0, err
		}
	}

	rows := make([]canon.Pool, 0, len(doc.Data))
	rejected := 0
	for _, p := range doc.Data {
		attrs := p.Attributes
		poolAddr := trimSpace(attrs.Address)
		if poolAddr == "" {
			// A pool without an address cannot mint a stable identity: a
			// rejection the journal counts, never a fabricated key.
			rejected++
			continue
		}
		dex := lower(trimSpace(p.Relationship.Dex.Data.ID))
		if dex == "" {
			dex = fallbackVenue
		}
		row := canon.Pool{
			PoolID:      canon.MintID(canon.KindPool, canon.PoolKey(chain, poolAddr)),
			ChainID:     cid,
			DEXVenueID:  canon.MintID(canon.KindVenue, canon.VenueKey(dex)),
			Address:     poolAddr,
			Price:       parseF64(attrs.BaseTokenPriceUSD),
			At:          now,
			Source:      Source,
			RetrievedAt: now,
		}
		row.LiquidityUSD = parseF64(attrs.ReserveInUSD)
		row.Volume24hUSD = parseF64(attrs.VolumeUSD.H24)
		row.FdvUsd = parseF64(attrs.FDVUSD)
		row.PoolCreatedAt = parsePoolCreatedAt(attrs.PoolCreatedAt)
		if base, ok := included[trimSpace(p.Relationship.BaseToken.Data.ID)]; ok {
			sym := upper(trimSpace(base.symbol))
			if sym != "" {
				row.BaseSymbol = &sym
				anchor := canon.MintID(canon.KindAsset, canon.AssetKey(assetKind(sym), sym))
				row.BaseAssetID = &anchor
			}
		}
		if quote, ok := included[trimSpace(p.Relationship.QuoteToken.Data.ID)]; ok {
			sym := upper(trimSpace(quote.symbol))
			if sym != "" {
				row.QuoteSymbol = &sym
				anchor := canon.MintID(canon.KindAsset, canon.AssetKey(assetKind(sym), sym))
				row.QuoteAssetID = &anchor
			}
		}
		rows = append(rows, row)
	}
	written, rejectedW, err := w.WritePools(ctx, rows)
	return written, rejected + rejectedW, err
}
