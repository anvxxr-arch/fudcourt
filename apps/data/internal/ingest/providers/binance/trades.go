package binance

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// trades fetches recent aggregate trades for one spot symbol:
// GET /api/v3/aggTrades?symbol=&limit=
// Row shape: [{"a":12345,"p":"27945.01","q":"0.001","T":1697049659999,
// "m":false}, ...] — a is the aggregate trade id, p/q price and quantity as
// strings, T the trade time in ms, and m whether the buyer was the maker
// (true => the taker SOLD).
//
// Aggregate trades carry no maker/taker side field, so canon Trade.Side
// stays nil; Aggressor is derived from m. The store's ON CONFLICT PK
// (venue, instrument, provider_trade_id, trade_time) makes re-fetching the
// same window idempotent, so the fetch keeps no last-trade-time cursor.
func (c *client) trades(ctx context.Context, w canon.Writer, job ingest.Job, limit int) (int, int, error) {
	if isPerpSubject(job.Subject) {
		return 0, 0, &HardError{Kind: "shape", Detail: "trades dataset is spot-only, got subject " + job.Subject}
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
	url := fmt.Sprintf("%s/api/v3/aggTrades?symbol=%s&limit=%d", SpotBase, sym, limit)

	var raw []struct {
		A int64  `json:"a"`
		P string `json:"p"`
		Q string `json:"q"`
		T int64  `json:"T"`
		M bool   `json:"m"`
	}
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, err
	}
	if len(raw) == 0 {
		return 0, 0, nil
	}
	now := time.Now().UTC()
	rows := make([]canon.Trade, 0, len(raw))
	for _, r := range raw {
		price, err := parseF64(r.P)
		if err != nil {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "aggTrade price " + r.P}
		}
		qty, err := parseF64(r.Q)
		if err != nil {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "aggTrade qty " + r.Q}
		}
		aggressor := "buy"
		if r.M {
			aggressor = "sell"
		}
		rows = append(rows, canon.Trade{
			InstrumentID:    inst,
			VenueID:         venue,
			ProviderTradeID: strconv.FormatInt(r.A, 10),
			TradeTime:       time.UnixMilli(r.T).UTC(),
			Price:           price,
			Quantity:        qty,
			Side:            nil,
			Aggressor:       &aggressor,
			Source:          "binance",
			RetrievedAt:     now,
		})
	}
	return w.WriteTrades(ctx, rows)
}
