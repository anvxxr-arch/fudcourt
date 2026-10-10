package bybit

import (
	"context"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// depth fetches one spot orderbook snapshot:
// GET /v5/market/orderbook?category=spot&symbol=&limit=50.
// result: {"bids":[["42660.10","1.254"],...],"asks":[["42660.20","0.971"],...]}
// — price/size STRING pairs, best level first. One snapshot per fetch with
// At = now UTC and Depth = len(bids)+len(asks).
func (c *client) depth(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	if isPerpSubject(job.Subject) {
		return 0, 0, &HardError{Kind: "shape", Detail: "depth is spot-only, got subject " + job.Subject}
	}
	sym := subjectSymbol(job.Subject)
	url := fmt.Sprintf("%s/v5/market/orderbook?category=spot&symbol=%s&limit=50", Base, sym)
	var res struct {
		Bids [][2]any `json:"bids"`
		Asks [][2]any `json:"asks"`
	}
	if err := c.getJSON(ctx, url, &res); err != nil {
		return 0, 0, err
	}
	baseSym, quoteSym, ok := splitSymbol(sym)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "unparseable symbol " + sym}
	}
	inst := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: venueID, MarketType: "spot", Base: baseSym, Quote: quoteSym,
	}))
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()
	parseSide := func(levels [][2]any, which string) ([][2]float64, error) {
		out := make([][2]float64, 0, len(levels))
		for i, pair := range levels {
			p, okP := f64(pair[0])
			s, okS := f64(pair[1])
			if !okP || !okS {
				return nil, &HardError{Kind: "shape", URL: url, Detail: fmt.Sprintf("%s level %d", which, i)}
			}
			out = append(out, [2]float64{p, s})
		}
		return out, nil
	}
	bids, err := parseSide(res.Bids, "bid")
	if err != nil {
		return 0, 0, err
	}
	asks, err := parseSide(res.Asks, "ask")
	if err != nil {
		return 0, 0, err
	}
	if len(bids) == 0 && len(asks) == 0 {
		return 0, 0, nil
	}
	return w.WriteOrderbook(ctx, []canon.OrderbookSnap{{
		InstrumentID: inst,
		VenueID:      venue,
		At:           now,
		Depth:        len(bids) + len(asks),
		Bids:         bids,
		Asks:         asks,
		Source:       "bybit",
		RetrievedAt:  now,
	}})
}
