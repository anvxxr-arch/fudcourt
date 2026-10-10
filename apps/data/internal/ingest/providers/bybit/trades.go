package bybit

import (
	"context"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// trades fetches the recent public trade tape for one spot symbol:
// GET /v5/market/recent-trade?category=spot&symbol=&limit=60.
// Row shape: [{"execId":"...","price":"42660.10","size":"0.012",
// "side":"Buy","time":"1707163200000"}] — string numbers, ms-string
// time (live payload 2026-10: the field is "time", not "execTime"). Bybit's recent-trade side IS the taker side, so it maps to both
// Side and Aggressor; an empty side stays nil (never-fake).
func (c *client) trades(ctx context.Context, w canon.Writer, job ingest.Job, limit int) (int, int, error) {
	if isPerpSubject(job.Subject) {
		return 0, 0, &HardError{Kind: "shape", Detail: "trades is spot-only, got subject " + job.Subject}
	}
	sym := subjectSymbol(job.Subject)
	url := fmt.Sprintf("%s/v5/market/recent-trade?category=spot&symbol=%s&limit=%d", Base, sym, limit)
	var res struct {
		List []struct {
			ExecID string `json:"execId"`
			Price  string `json:"price"`
			Size   string `json:"size"`
			Side   string `json:"side"`
			Time   string `json:"time"`
		} `json:"list"`
	}
	if err := c.getJSON(ctx, url, &res); err != nil {
		return 0, 0, err
	}
	raw := res.List
	baseSym, quoteSym, ok := splitSymbol(sym)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "unparseable symbol " + sym}
	}
	inst := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: venueID, MarketType: "spot", Base: baseSym, Quote: quoteSym,
	}))
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()
	rows := make([]canon.Trade, 0, len(raw))
	for _, r := range raw {
		price, okP := f64(r.Price)
		qty, okQ := f64(r.Size)
		at, okT := ms(r.Time)
		if !okP || !okQ || !okT {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "trade field " + r.ExecID}
		}
		side := strPtr(lowerASCII(r.Side))
		rows = append(rows, canon.Trade{
			InstrumentID:    inst,
			VenueID:         venue,
			ProviderTradeID: r.ExecID,
			TradeTime:       at,
			Price:           price,
			Quantity:        qty,
			Side:            side,
			Aggressor:       side,
			Source:          "bybit",
			RetrievedAt:     now,
		})
	}
	if len(rows) == 0 {
		return 0, 0, nil
	}
	return w.WriteTrades(ctx, rows)
}
