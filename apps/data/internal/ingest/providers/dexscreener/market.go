package dexscreener

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// This file adds the DEX Data Platform's `market-snapshots` dataset to the
// existing dexscreener provider (plan §38: extend, never fork). It writes exact
// data.dex_market_snapshot rows through the DEX store; the existing `pools`
// dataset keeps writing canon.Pool through the engine writer.
//
// The market snapshot is where the exact-numeric pool state lives: DexScreener
// reports priceUsd/priceNative/volume/txns/priceChange as decimal STRINGS here,
// so mapping them through canon.DecFromString keeps every digit — no float64
// touches a market row (plan §54). Same endpoint shapes as `pools`, so the
// subject vocabulary is shared.

// marketSnapshots implements the `market-snapshots` dataset. The subject
// spelling matches `pools` (chain:address | pair/chain:address | search/chain:q);
// one snapshot is minted per returned pair at the fetch instant (the endpoint is
// a live snapshot, so `at` is truncation-free fetch time and MarketSnapshotKey
// is per-pair — no two pairs collide).
func (c *client) marketSnapshots(ctx context.Context, w canon.Writer, dw dexstore.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	if dw == nil {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "no dex writer wired"}
	}
	subject := job.Subject
	if s, ok := job.Cursor["subject"].(string); ok && s != "" {
		subject = s
	}
	mode, chain, key, ok := splitSubject(subject)
	if !ok {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "market job needs subject chain:address, got " + subject}
	}
	var pairs []pairRow
	switch mode {
	case "token":
		u := fmt.Sprintf("%s/token-pairs/v1/%s/%s", Base, url.PathEscape(chain), url.PathEscape(key))
		if err := c.getJSON(ctx, u, &pairs); err != nil {
			return 0, 0, nil, err
		}
	case "pair":
		u := fmt.Sprintf("%s/latest/dex/pairs/%s/%s", Base, url.PathEscape(chain), url.PathEscape(key))
		var res struct {
			Pairs []pairRow `json:"pairs"`
		}
		if err := c.getJSON(ctx, u, &res); err != nil {
			return 0, 0, nil, err
		}
		pairs = res.Pairs
	case "search":
		u := fmt.Sprintf("%s/latest/dex/search?q=%s", Base, url.QueryEscape(key))
		var res struct {
			Pairs []pairRow `json:"pairs"`
		}
		if err := c.getJSON(ctx, u, &res); err != nil {
			return 0, 0, nil, err
		}
		pairs = res.Pairs
	default:
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "unknown market subject mode " + mode}
	}
	now := time.Now().UTC()
	rows, rejected, chains, venues := buildMarketSnapshots(subjectModeChain(mode, chain), pairs, now)
	if len(chains) > 0 {
		if _, err := w.UpsertChains(ctx, chains); err != nil {
			// Preserve the cursor on every exit: the engine replaces the column
			// wholesale, so discarding it here would lose a subject override.
			return 0, 0, job.Cursor, err
		}
	}
	if len(venues) > 0 {
		if _, err := w.UpsertVenues(ctx, venues); err != nil {
			return 0, 0, job.Cursor, err
		}
	}
	if len(rows) == 0 {
		// A successful fetch that produced no pairs must still return the job's
		// cursor: the engine REPLACES the whole column with Next, so returning an
		// empty cursor here would erase the subject override and every other key
		// on the first quiet run — the same clobber the tier path had.
		return 0, rejected, job.Cursor, nil
	}
	written, rej, err := dw.WriteDexMarketSnapshots(ctx, rows)
	if err != nil {
		return written, rej + rejected, job.Cursor, err
	}
	// Plan §28: record this subject's activity tier in the job cursor, derived
	// from the hottest pair in the batch. The cursor is what EnsureJobs
	// preserves across restarts (unlike schedule_seconds), so the tier is
	// auditable next to the job it drove and the seed path can re-derive a
	// cadence from a live reading. Liquidity is not on the market row, so the
	// classifier ranks on volume/txns — which it now does correctly rather than
	// reading the absent liquidity as dust.
	return written, rej + rejected, dexstore.WithTier(job.Cursor, hottestTier(rows), hottestActivity(rows)), nil
}

// hottestTier classifies a batch by its most active pair: the tier of a
// multi-pair subject is driven by its busiest pool, which is the one worth
// polling fast.
func hottestTier(rows []canon.DexMarketSnapshot) dexstore.ActivityTier {
	return dexstore.ClassifyActivity(hottestActivity(rows), dexstore.DefaultThresholds())
}

// hottestActivity reduces a batch to the single Activity the classifier reads:
// the maximum 24h volume and txn count, and the maximum liquidity when any row
// carries it (a market row does not today, so it stays absent).
func hottestActivity(rows []canon.DexMarketSnapshot) dexstore.Activity {
	a := dexstore.Activity{}
	for i := range rows {
		cur := dexstore.ActivityFromMarket(rows[i])
		if cur.Volume24hUSD != nil && (a.Volume24hUSD == nil || *cur.Volume24hUSD > *a.Volume24hUSD) {
			a.Volume24hUSD = cur.Volume24hUSD
		}
		if cur.LiquidityUSD != nil && (a.LiquidityUSD == nil || *cur.LiquidityUSD > *a.LiquidityUSD) {
			a.LiquidityUSD = cur.LiquidityUSD
		}
		if cur.Txns24h != nil && (a.Txns24h == nil || *cur.Txns24h > *a.Txns24h) {
			a.Txns24h = cur.Txns24h
		}
	}
	return a
}

// subjectModeChain returns the chain slug a missing pair chainId falls back to.
func subjectModeChain(_ string, chain string) string { return chain }

// buildMarketSnapshots maps wire pairs to exact DexMarketSnapshot rows plus the
// chain/venue entity upserts they imply. A pair missing its chain or address is
// counted as rejected, never guessed. The `at` is the same fetch instant for
// every row, but each row's key embeds its own pool id (MarketSnapshotKey), so
// the batch never self-collides on (pool_id, at).
func buildMarketSnapshots(subjectChain string, pairs []pairRow, now time.Time) (rows []canon.DexMarketSnapshot, rejected int, chains []canon.Chain, venues []canon.Venue) {
	seenChain := map[string]bool{}
	seenVenue := map[string]bool{}
	at := now
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
		if dex := lower(strings.TrimSpace(p.DexID)); dex != "" {
			vid := canon.MintID(canon.KindVenue, canon.VenueKey(dex))
			if !seenVenue[vid] {
				venues = append(venues, canon.Venue{
					VenueID: vid, Name: strPtr(dex), Kind: "dex", MarketTypes: []string{"swap"},
				})
				seenVenue[vid] = true
			}
		}
		poolID := canon.MintID(canon.KindPool, canon.PoolKey(chain, address))
		prov := canon.ProvenanceForProvider(Source)
		prov.ChainID = cid
		prov.ObservedAt = at
		prov.NormalizedAt = now
		row := canon.DexMarketSnapshot{
			SnapshotID: canon.MintID(canon.KindMarketSnapshot, canon.MarketSnapshotKey(poolID, at.Unix())),
			NaturalKey: canon.MarketSnapshotKey(poolID, at.Unix()),
			PoolID:     poolID,
			ChainID:    cid,
			At:         at,
			Provenance: prov,
		}
		if d, ok := wireDec(p.PriceUSD); ok {
			row.PriceUSD = &d
		}
		if d, ok := wireDec(p.PriceNative); ok {
			row.PriceNative = &d
		}
		if d, ok := wireDec(p.Volume.H24); ok {
			row.Volume24hUSD = &d
		}
		buys, okB := wireInt(p.Txns.H24.Buys)
		sells, okS := wireInt(p.Txns.H24.Sells)
		if okB || okS {
			total := int64(0)
			if okB {
				total += buys
			}
			if okS {
				total += sells
			}
			row.Txns24h = &total
			if okB {
				row.Buys24h = &buys
			}
			if okS {
				row.Sells24h = &sells
			}
		}
		if d, ok := wireDec(p.PriceChange.H24); ok {
			row.PriceChangePct24h = &d
		}
		if d, ok := wireDec(p.FDV); ok {
			row.FDVUSD = &d
		}
		if d, ok := wireDec(p.MarketCap); ok {
			row.MarketCapUSD = &d
		}
		rows = append(rows, row)
	}
	return rows, rejected, chains, venues
}

// wireDec parses a wire numeric into an exact Dec. A string is taken verbatim
// (the provider already spelled it to full precision); a json.Number keeps its
// digits. ok is false for an absent or unparseable value — the column stays
// NULL, never a fabricated 0.
func wireDec(v any) (canon.Dec, bool) {
	s, ok := wireString(v)
	if !ok {
		return canon.NilDec, false
	}
	d, err := canon.DecFromString(s)
	if err != nil {
		return canon.NilDec, false
	}
	return d, true
}
