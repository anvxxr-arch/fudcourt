package binance

import (
	"context"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// depth fetches the current partial order book for one spot symbol:
// GET /api/v3/depth?symbol=&limit=
// Row shape: {"lastUpdateId":123,"bids":[["27945.01","0.001"],...],
// "asks":[["27945.02","0.5"],...]} — every price/size is a string.
//
// One fetch yields one canon OrderbookSnap: At is the retrieval instant and
// Depth counts both sides. The dataset is spot-only; a perp subject is a
// shape error (never-fake: no silent market remap).
func (c *client) depth(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	if isPerpSubject(job.Subject) {
		return 0, 0, &HardError{Kind: "shape", Detail: "depth dataset is spot-only, got subject " + job.Subject}
	}
	sym := subjectSymbol(job.Subject)
	baseSym, quoteSym, ok := splitSymbol(sym)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", Detail: "unparseable symbol " + sym}
	}
	inst := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: venueID, MarketType: "spot", Base: baseSym, Quote: quoteSym,
	}))
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	url := fmt.Sprintf("%s/api/v3/depth?symbol=%s&limit=100", SpotBase, sym)

	var doc struct {
		Bids [][2]string `json:"bids"`
		Asks [][2]string `json:"asks"`
	}
	if err := c.getJSON(ctx, url, &doc); err != nil {
		return 0, 0, err
	}
	parseSide := func(side [][2]string, name string) ([][2]float64, error) {
		out := make([][2]float64, 0, len(side))
		for _, lvl := range side {
			price, err := parseF64(lvl[0])
			if err != nil {
				return nil, &HardError{Kind: "shape", URL: url, Detail: name + " price " + lvl[0]}
			}
			size, err := parseF64(lvl[1])
			if err != nil {
				return nil, &HardError{Kind: "shape", URL: url, Detail: name + " qty " + lvl[1]}
			}
			out = append(out, [2]float64{price, size})
		}
		return out, nil
	}
	bids, err := parseSide(doc.Bids, "bid")
	if err != nil {
		return 0, 0, err
	}
	asks, err := parseSide(doc.Asks, "ask")
	if err != nil {
		return 0, 0, err
	}
	if len(bids) == 0 && len(asks) == 0 {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "empty depth response"}
	}
	now := time.Now().UTC()
	return w.WriteOrderbook(ctx, []canon.OrderbookSnap{{
		InstrumentID: inst,
		VenueID:      venue,
		At:           now,
		Depth:        len(bids) + len(asks),
		Bids:         bids,
		Asks:         asks,
		Source:       "binance",
		RetrievedAt:  now,
	}})
}
