package binance

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/cache"
)

// funding fetches the funding-rate history for one perp symbol:
// GET /fapi/v1/fundingRate?symbol=&limit=
// Row shape: [{"symbol":"BTCUSDT","fundingTime":1697049600000,
//
//	"fundingRate":"0.00010000","markPrice":"27945.01"}]
//
// markPrice is optional; it is NOT a funding row field and is ignored — the
// canon funding row is (instrument, time, rate, cap). Binance publishes no cap
// on this endpoint, so Cap stays nil (never-fake).
func (c *client) funding(ctx context.Context, w canon.Writer, job ingest.Job, limit int) (int, int, error) {
	sym := subjectSymbol(job.Subject)
	url := fmt.Sprintf("%s/fapi/v1/fundingRate?symbol=%s&limit=%d", PerpBase, sym, limit)
	var raw []struct {
		Symbol      string `json:"symbol"`
		FundingTime int64  `json:"fundingTime"`
		FundingRate string `json:"fundingRate"`
	}
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, err
	}
	baseSym, quoteSym, ok := splitSymbol(sym)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "unparseable symbol " + sym}
	}
	inst := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: venueID, MarketType: "linear_perp", Base: baseSym, Quote: quoteSym,
	}))
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()
	rows := make([]canon.FundingRate, 0, len(raw))
	for _, r := range raw {
		if r.Symbol == "" || r.FundingRate == "" {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "funding row missing symbol/rate"}
		}
		rate, err := parseF64(r.FundingRate)
		if err != nil {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "fundingRate " + r.FundingRate}
		}
		rows = append(rows, canon.FundingRate{
			InstrumentID: inst,
			VenueID:      venue,
			FundingTime:  time.UnixMilli(r.FundingTime).UTC(),
			Rate:         rate,
			Source:       "binance",
			RetrievedAt:  now,
		})
	}
	if len(rows) == 0 {
		return 0, 0, nil
	}
	return w.WriteFunding(ctx, rows)
}

// openInterest fetches the CURRENT open-interest snapshot for one perp symbol
// and, when the job asks for history (dataset openInterest), the recent hist
// series:
//   - GET /fapi/v1/openInterest?symbol= -> {"openInterest":"10659.309",
//     "symbol":"BTCUSDT","time":1533270900000}
//   - GET /futures/data/openInterestHist?symbol=&period=5m&limit= ->
//     [{"symbol":"BTCUSDT","sumOpenInterest":"20493.63","sumOpenInterestValue":
//     "1570570874.07","timestamp":1583127900000}]
//
// sumOpenInterestValue (USD) is the primary canon field; base OI is recorded
// alongside. A missing USD field is a shape error (never-fake: no zero fill).
func (c *client) openInterest(ctx context.Context, w canon.Writer, job ingest.Job, limit int) (int, int, error) {
	sym := subjectSymbol(job.Subject)
	baseSym, quoteSym, ok := splitSymbol(sym)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", Detail: "unparseable symbol " + sym}
	}
	inst := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: venueID, MarketType: "linear_perp", Base: baseSym, Quote: quoteSym,
	}))
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()

	if job.Cursor["hist"] == nil && job.Mode != "backfill" {
		// Live snapshot: one row.
		var snap struct {
			Symbol       string `json:"symbol"`
			OpenInterest string `json:"openInterest"`
			Time         int64  `json:"time"`
		}
		url := fmt.Sprintf("%s/fapi/v1/openInterest?symbol=%s", PerpBase, sym)
		if err := c.getJSON(ctx, url, &snap); err != nil {
			return 0, 0, err
		}
		if snap.Symbol == "" || snap.OpenInterest == "" {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "openInterest snapshot missing fields"}
		}
		oiBase, err := parseF64(snap.OpenInterest)
		if err != nil {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "openInterest " + snap.OpenInterest}
		}
		at := now
		if snap.Time > 0 {
			at = time.UnixMilli(snap.Time).UTC()
		}
		// Price is needed to value OI in USD; the snapshot carries none, so
		// the base quantity is recorded and USD stays nil (never-fake).
		rows := []canon.OpenInterest{{
			InstrumentID:     inst,
			VenueID:          venue,
			OIAt:             at,
			OpenInterestBase: &oiBase,
			Source:           "binance",
			RetrievedAt:      now,
		}}
		return w.WriteOpenInterest(ctx, rows)
	}

	// History series (backfill or a cursor-flagged job).
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	url := fmt.Sprintf("%s/futures/data/openInterestHist?symbol=%s&period=5m&limit=%d", PerpBase, sym, limit)
	var raw []struct {
		Symbol               string `json:"symbol"`
		SumOpenInterest      string `json:"sumOpenInterest"`
		SumOpenInterestValue string `json:"sumOpenInterestValue"`
		Timestamp            int64  `json:"timestamp"`
	}
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, err
	}
	rows := make([]canon.OpenInterest, 0, len(raw))
	for _, r := range raw {
		if r.Symbol == "" || r.SumOpenInterest == "" || r.SumOpenInterestValue == "" {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "openInterestHist row missing fields"}
		}
		oiBase, err := parseF64(r.SumOpenInterest)
		if err != nil {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "sumOpenInterest " + r.SumOpenInterest}
		}
		oiUSD, err := parseF64(r.SumOpenInterestValue)
		if err != nil {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "sumOpenInterestValue " + r.SumOpenInterestValue}
		}
		rows = append(rows, canon.OpenInterest{
			InstrumentID:     inst,
			VenueID:          venue,
			OIAt:             time.UnixMilli(r.Timestamp).UTC(),
			OpenInterestUSD:  &oiUSD,
			OpenInterestBase: &oiBase,
			Source:           "binance",
			RetrievedAt:      now,
		})
	}
	if len(rows) == 0 {
		return 0, 0, nil
	}
	return w.WriteOpenInterest(ctx, rows)
}

// ticker fetches 24h tickers. A subject selects one symbol
// (GET /api/v3/ticker/24hr?symbol=); an empty subject fetches the whole
// market (GET /api/v3/ticker/24hr) and every row is written.
// Row shape (identical in both responses):
// {"symbol":"BTCUSDT","lastPrice":"27945.01","bidPrice":"...","askPrice":
// "...","bidQty":"...","askQty":"...","volume":"...","quoteVolume":"...",
// "closeTime":1697049659999}
//
// The canon Quote row is a best-bid/ask snapshot; the ticker's last price is
// carried too. Rows for symbols whose base/quote cannot be parsed are counted
// as rejected (they are real market rows for pairs outside our quote
// vocabulary), not shape errors — the full-market response legitimately
// contains them.
//
// tickerRow is one 24hr ticker record; the endpoint returns it either
// bare (single-symbol query) or in an array (full-market query).
type tickerRow struct {
	Symbol    string `json:"symbol"`
	LastPrice string `json:"lastPrice"`
	BidPrice  string `json:"bidPrice"`
	AskPrice  string `json:"askPrice"`
	BidQty    string `json:"bidQty"`
	AskQty    string `json:"askQty"`
	CloseTime int64  `json:"closeTime"`
}

func (c *client) ticker(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	url := SpotBase + "/api/v3/ticker/24hr"
	if sym := subjectSymbol(job.Subject); sym != "" {
		url += "?symbol=" + sym
	}
	// The real /api/v3/ticker/24hr is polymorphic: no symbol param -> an
	// ARRAY of full-market rows; symbol=<S> -> one OBJECT for that symbol.
	// Decode into RawMessage first and dispatch on the first byte, so one
	// row type serves both shapes.
	var doc json.RawMessage
	if err := c.getJSON(ctx, url, &doc); err != nil {
		return 0, 0, err
	}
	var raw []tickerRow
	var one tickerRow
	if len(doc) > 0 && doc[0] == '[' {
		if err := json.Unmarshal(doc, &raw); err != nil {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: err.Error()}
		}
	} else {
		if err := json.Unmarshal(doc, &one); err != nil {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: err.Error()}
		}
		if one.Symbol == "" {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "ticker object missing symbol"}
		}
		raw = append(raw, one)
	}
	if len(raw) == 0 {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "empty ticker response"}
	}
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()
	rows := make([]canon.Quote, 0, len(raw))
	rejected := 0
	for _, r := range raw {
		baseSym, quoteSym, ok := splitSymbol(r.Symbol)
		if !ok {
			rejected++
			continue
		}
		inst := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
			VenueID: venueID, MarketType: "spot", Base: baseSym, Quote: quoteSym,
		}))
		row := canon.Quote{
			InstrumentID: inst,
			VenueID:      venue,
			At:           now,
			Source:       "binance",
			RetrievedAt:  now,
		}
		if v, err := parseF64(r.BidPrice); err == nil {
			row.Bid = &v
		}
		if v, err := parseF64(r.AskPrice); err == nil {
			row.Ask = &v
		}
		if v, err := parseF64(r.BidQty); err == nil {
			row.BidSize = &v
		}
		if v, err := parseF64(r.AskQty); err == nil {
			row.AskSize = &v
		}
		if v, err := parseF64(r.LastPrice); err == nil {
			row.Last = &v
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		if rejected > 0 {
			return 0, rejected, nil
		}
		return 0, 0, nil
	}
	written, rej, err := w.WriteQuotes(ctx, rows)
	if err == nil {
		cacheQuotes(rows)
	}
	return written, rej + rejected, err
}

// cachedQuote is one hot-cache ticker snapshot, keyed canonically in Valkey
// as data:quote:<venue id>:<instrument id>. It is a best-effort read model
// for the boards; the Postgres row written by WriteQuotes is the record.
type cachedQuote struct {
	At           time.Time `json:"at"`
	Bid          *float64  `json:"bid"`
	Ask          *float64  `json:"ask"`
	Last         *float64  `json:"last"`
	VenueID      string    `json:"venue_id"`
	InstrumentID string    `json:"instrument_id"`
}

// cacheQuoteTTL is the hot-cache lifetime per snapshot. It matches the
// platform/cache DefaultTTL floor; stream tickers run at or above this
// cadence, so a key never outlives the snapshot that replaced it.
const cacheQuoteTTL = cache.DefaultTTL

// cacheQuotes writes one Valkey snapshot key per quote row. Best-effort
// only: cache.Set logs and swallows its own failures, and a cache write
// must never fail a fetch whose DB write succeeded. Keys use the canonical
// venue/instrument ids, never provider symbols.
func cacheQuotes(rows []canon.Quote) {
	if !cache.Enabled() {
		return
	}
	ctx := context.Background()
	for _, row := range rows {
		body, err := json.Marshal(cachedQuote{
			At:           row.At,
			Bid:          row.Bid,
			Ask:          row.Ask,
			Last:         row.Last,
			VenueID:      row.VenueID,
			InstrumentID: row.InstrumentID,
		})
		if err != nil {
			continue
		}
		cache.Set(ctx, "data:quote:"+row.VenueID+":"+row.InstrumentID, string(body), cacheQuoteTTL)
	}
}
