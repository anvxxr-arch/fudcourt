package okx

import (
	"context"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// depth fetches one order-book snapshot for one SPOT instrument id:
// GET /api/v5/market/books?instId=BTC-USDT&sz=
// data[0] shape: {"bids":[["42660.1","1.254",...],...],"asks":[[...]]} — each
// level is an array of >=2 STRING numbers [px, sz, ...]; only the first two
// are read. One snapshot per fetch, At = now (UTC); Depth is the number of
// levels on both sides. A level with fewer than two fields, or an
// unparseable px/sz, is a shape error (never-fake); an empty book is one
// too. depth is a SPOT dataset, so a perp subject is one too.
func (c *client) depth(ctx context.Context, w canon.Writer, job ingest.Job, limit int) (int, int, error) {
	if subjectIsPerp(job.Subject) {
		return 0, 0, &HardError{Kind: "shape", Detail: "depth is a SPOT dataset; perp subject " + job.Subject}
	}
	instID := subjectInstID(job.Subject)
	url := fmt.Sprintf("%s/api/v5/market/books?instId=%s&sz=%d", Base, instID, limit)
	var raw []struct {
		Bids [][]string `json:"bids"`
		Asks [][]string `json:"asks"`
	}
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, err
	}
	if len(raw) == 0 {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "books data empty"}
	}
	baseSym, quoteSym, ok := splitInstID(instID)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "unparseable instId " + instID}
	}
	inst := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: venueID, MarketType: "spot", Base: baseSym, Quote: quoteSym,
	}))
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()
	levels := func(side [][]string, name string) ([][2]float64, error) {
		out := make([][2]float64, 0, len(side))
		for _, lvl := range side {
			if len(lvl) < 2 {
				return nil, &HardError{Kind: "shape", URL: url,
					Detail: fmt.Sprintf("%s level width %d", name, len(lvl))}
			}
			px, okPx := f64(lvl[0])
			sz, okSz := f64(lvl[1])
			if !okPx || !okSz {
				return nil, &HardError{Kind: "shape", URL: url,
					Detail: name + " level px " + lvl[0] + " sz " + lvl[1]}
			}
			out = append(out, [2]float64{px, sz})
		}
		return out, nil
	}
	bids, err := levels(raw[0].Bids, "bid")
	if err != nil {
		return 0, 0, err
	}
	asks, err := levels(raw[0].Asks, "ask")
	if err != nil {
		return 0, 0, err
	}
	if len(bids)+len(asks) == 0 {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "book snapshot has no levels"}
	}
	rows := []canon.OrderbookSnap{{
		InstrumentID: inst,
		VenueID:      venue,
		At:           now,
		Depth:        len(bids) + len(asks),
		Bids:         bids,
		Asks:         asks,
		Source:       "okx",
		RetrievedAt:  now,
	}}
	return w.WriteOrderbook(ctx, rows)
}
