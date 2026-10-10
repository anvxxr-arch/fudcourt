package okx

import (
	"context"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// trades fetches recent public trades for one SPOT instrument id:
// GET /api/v5/market/trades?instId=BTC-USDT&limit=
// Row shape: [{"instId":"BTC-USDT","tradeId":"2081891","px":"42661",
// "sz":"0.1","side":"buy","ts":"1707163200000"}] — string numbers, ms-string
// timestamps, newest first. side is the TAKER side, so it fills both Side and
// Aggressor. A row missing tradeId, or with an unparseable px/sz/ts, is a
// shape error (never-fake: no zero fill); trades is a SPOT dataset, so a
// perp subject is one too.
func (c *client) trades(ctx context.Context, w canon.Writer, job ingest.Job, limit int) (int, int, error) {
	if subjectIsPerp(job.Subject) {
		return 0, 0, &HardError{Kind: "shape", Detail: "trades is a SPOT dataset; perp subject " + job.Subject}
	}
	instID := subjectInstID(job.Subject)
	url := fmt.Sprintf("%s/api/v5/market/trades?instId=%s&limit=%d", Base, instID, limit)
	var raw []struct {
		TradeID string `json:"tradeId"`
		Px      string `json:"px"`
		Sz      string `json:"sz"`
		Side    string `json:"side"`
		Ts      string `json:"ts"`
	}
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, err
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
	rows := make([]canon.Trade, 0, len(raw))
	for _, r := range raw {
		if r.TradeID == "" {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "trade row missing tradeId"}
		}
		at, ok := ms(r.Ts)
		if !ok {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "ts " + r.Ts}
		}
		price, ok := f64(r.Px)
		if !ok {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "px " + r.Px}
		}
		qty, ok := f64(r.Sz)
		if !ok {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "sz " + r.Sz}
		}
		rows = append(rows, canon.Trade{
			InstrumentID:    inst,
			VenueID:         venue,
			ProviderTradeID: r.TradeID,
			TradeTime:       at,
			Price:           price,
			Quantity:        qty,
			Side:            strPtr(r.Side),
			Aggressor:       strPtr(r.Side),
			Source:          "okx",
			RetrievedAt:     now,
		})
	}
	if len(rows) == 0 {
		return 0, 0, nil
	}
	return w.WriteTrades(ctx, rows)
}
