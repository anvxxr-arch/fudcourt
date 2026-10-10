package okx

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/cache"
)

// venueID is this adapter's canonical venue id (venue/okx in reference.json).
const venueID = "okx"

// candles fetches OHLCV bars for one instrument id:
// GET /api/v5/market/candles?instId=BTC-USDT&bar=1m&limit=
// Row shape: ["1707163200000","42630.1","42714","42554","42661","254.07","1.08","108434803.5","1"]
// — array of arrays of STRING numbers [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm],
// newest first; confirm "1" is a closed bar, "0" the still-forming one.
// The newest (unclosed) row is dropped so a bar is written once it closed.
func (c *client) candles(ctx context.Context, w canon.Writer, job ingest.Job, timeframe string, limit int) (int, int, error) {
	if timeframe == "" {
		timeframe = "1m"
	}
	bar, ok := bars[timeframe]
	if !ok {
		return 0, 0, &HardError{Kind: "shape", Detail: "unsupported timeframe " + timeframe}
	}
	instID := subjectInstID(job.Subject)
	perp := subjectIsPerp(job.Subject)
	url := fmt.Sprintf("%s/api/v5/market/candles?instId=%s&bar=%s&limit=%d", Base, instID, bar, limit)
	if n, ok := cursorI64(job.Cursor["after"]); ok {
		url += fmt.Sprintf("&after=%d", n)
	}
	if n, ok := cursorI64(job.Cursor["before"]); ok {
		url += fmt.Sprintf("&before=%d", n)
	}
	var raw [][]any
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, err
	}
	market := "spot"
	if perp {
		market = "linear_perp"
	}
	baseSym, quoteSym, ok := splitInstID(instID)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "unparseable instId " + instID}
	}
	inst := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: venueID, MarketType: market, Base: baseSym, Quote: quoteSym,
	}))
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()
	rows := make([]canon.Ohlcv, 0, len(raw))
	for i := len(raw) - 1; i >= 0; i-- {
		row := raw[i]
		if len(row) < 6 {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: fmt.Sprintf("candle row width %d", len(row))}
		}
		open, ok1 := ms(row[0])
		o, ok2 := f64(row[1])
		h, ok3 := f64(row[2])
		l, ok4 := f64(row[3])
		cl, ok5 := f64(row[4])
		vol, ok6 := f64(row[5])
		if !ok1 || !ok2 || !ok3 || !ok4 || !ok5 || !ok6 {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "candle numeric field"}
		}
		// confirm is the 9th field when present; "0" marks the bar still
		// forming, which is not written (a bar is written once, closed).
		if len(row) >= 9 {
			if s, ok := row[8].(string); ok && s == "0" {
				continue
			}
		}
		var volQuote *float64
		if len(row) >= 8 {
			if v, ok := f64(row[7]); ok {
				volQuote = &v
			}
		}
		closeT := open.Add(time.Duration(barMs[timeframe]) * time.Millisecond)
		rows = append(rows, canon.Ohlcv{
			InstrumentID: inst,
			VenueID:      venue,
			Timeframe:    timeframe,
			OpenTime:     open,
			CloseTime:    closeT,
			O:            o, H: h, L: l, C: cl,
			VolumeBase:  &vol,
			VolumeQuote: volQuote,
			Source:      "okx",
			RetrievedAt: now,
		})
	}
	if len(rows) == 0 {
		return 0, 0, nil
	}
	return w.WriteOhlcv(ctx, rows)
}

// funding fetches the funding-rate history for one SWAP:
// GET /api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=
// Row shape: [{"instId":"BTC-USDT-SWAP","instType":"SWAP","fundingRate":"0.0001",
// "realizedRate":"0.0001","fundingTime":"1707163200000"}] — string numbers,
// ms-string timestamps. OKX publishes no cap on this endpoint, so Cap stays
// nil (never-fake).
func (c *client) funding(ctx context.Context, w canon.Writer, job ingest.Job, limit int) (int, int, error) {
	instID := subjectInstID(job.Subject)
	url := fmt.Sprintf("%s/api/v5/public/funding-rate-history?instId=%s&limit=%d", Base, instID, limit)
	if n, ok := cursorI64(job.Cursor["after"]); ok {
		url += fmt.Sprintf("&after=%d", n)
	}
	if n, ok := cursorI64(job.Cursor["before"]); ok {
		url += fmt.Sprintf("&before=%d", n)
	}
	var raw []struct {
		InstID      string `json:"instId"`
		InstType    string `json:"instType"`
		FundingRate string `json:"fundingRate"`
		FundingTime string `json:"fundingTime"`
	}
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, err
	}
	baseSym, quoteSym, ok := splitInstID(instID)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "unparseable instId " + instID}
	}
	inst := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: venueID, MarketType: "linear_perp", Base: baseSym, Quote: quoteSym,
	}))
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()
	rows := make([]canon.FundingRate, 0, len(raw))
	for _, r := range raw {
		if r.InstID == "" || r.FundingRate == "" {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "funding row missing instId/rate"}
		}
		at, ok := ms(r.FundingTime)
		if !ok {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "fundingTime " + r.FundingTime}
		}
		rate, ok := f64(r.FundingRate)
		if !ok {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "fundingRate " + r.FundingRate}
		}
		rows = append(rows, canon.FundingRate{
			InstrumentID: inst,
			VenueID:      venue,
			FundingTime:  at,
			Rate:         rate,
			Source:       "okx",
			RetrievedAt:  now,
		})
	}
	if len(rows) == 0 {
		return 0, 0, nil
	}
	return w.WriteFunding(ctx, rows)
}

// openInterest fetches the CURRENT open-interest snapshot for one SWAP:
// GET /api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP
// data[0] shape: {"instId":"BTC-USDT-SWAP","instType":"SWAP","oi":"5754450",
// "oiCcy":"5754.45","oiUsd":"237953549.4","ts":"1707163200000"}. oiUsd is the
// primary canon field when present; oiCcy (base) is recorded alongside. A
// missing oi/oiUsd pair is a shape error (never-fake: no zero fill).
func (c *client) openInterest(ctx context.Context, w canon.Writer, job ingest.Job, limit int) (int, int, error) {
	_ = limit
	instID := subjectInstID(job.Subject)
	if !subjectIsPerp(job.Subject) {
		instID += "-SWAP"
	}
	url := fmt.Sprintf("%s/api/v5/public/open-interest?instType=SWAP&instId=%s", Base, instID)
	var raw []struct {
		InstID   string `json:"instId"`
		InstType string `json:"instType"`
		OI       string `json:"oi"`
		OICcy    string `json:"oiCcy"`
		OIUsd    string `json:"oiUsd"`
		Ts       string `json:"ts"`
	}
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, err
	}
	if len(raw) == 0 {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "open-interest data empty"}
	}
	r := raw[0]
	baseSym, quoteSym, ok := splitInstID(r.InstID)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "unparseable instId " + r.InstID}
	}
	inst := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: venueID, MarketType: "linear_perp", Base: baseSym, Quote: quoteSym,
	}))
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()
	at := now
	if r.Ts != "" {
		if t, ok := ms(r.Ts); ok {
			at = t
		}
	}
	var oiUSD, oiBase *float64
	if r.OIUsd != "" {
		if v, ok := f64(r.OIUsd); ok {
			oiUSD = &v
		} else {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "oiUsd " + r.OIUsd}
		}
	}
	if r.OICcy != "" {
		if v, ok := f64(r.OICcy); ok {
			oiBase = &v
		} else {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "oiCcy " + r.OICcy}
		}
	}
	if oiUSD == nil && oiBase == nil {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "open-interest snapshot missing oi/oiUsd"}
	}
	rows := []canon.OpenInterest{{
		InstrumentID:     inst,
		VenueID:          venue,
		OIAt:             at,
		OpenInterestUSD:  oiUSD,
		OpenInterestBase: oiBase,
		Source:           "okx",
		RetrievedAt:      now,
	}}
	return w.WriteOpenInterest(ctx, rows)
}

// ticker fetches 24h tickers for one instId (or the whole instType market
// when the subject is empty). SPOT rows: {"instId":"BTC-USDT","last":"...",
// "bidPx":"...","askPx":"...","bidSz":"...","askSz":"...","vol24h":"...",
// "volCcy24h":"...","ts":"..."}; SWAP rows add "openInterest24h"/"openInterestUsd".
// Every parsed row also registers its provider symbol.
func (c *client) ticker(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	instType := "SPOT"
	market := "spot"
	instID := ""
	if sub := job.Subject; sub != "" {
		instID = subjectInstID(sub)
		if subjectIsPerp(sub) {
			instType = "SWAP"
			market = "linear_perp"
		}
	}
	url := fmt.Sprintf("%s/api/v5/market/tickers?instType=%s", Base, instType)
	if instID != "" {
		url += "&instId=" + instID
	}
	var raw []struct {
		InstID    string `json:"instId"`
		Last      string `json:"last"`
		BidPx     string `json:"bidPx"`
		AskPx     string `json:"askPx"`
		BidSz     string `json:"bidSz"`
		AskSz     string `json:"askSz"`
		Vol24h    string `json:"vol24h"`
		VolCcy24h string `json:"volCcy24h"`
		Open24h   string `json:"open24h"`
		Ts        string `json:"ts"`
	}
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, err
	}
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()
	rows := make([]canon.Quote, 0, len(raw))
	symbols := make([]canon.ProviderSymbol, 0, len(raw))
	rejected := 0
	for _, r := range raw {
		baseSym, quoteSym, ok := splitInstID(r.InstID)
		if !ok {
			// Real market rows for ids outside our quote vocabulary are
			// counted, not fatal.
			rejected++
			continue
		}
		inst := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
			VenueID: venueID, MarketType: market, Base: baseSym, Quote: quoteSym,
		}))
		row := canon.Quote{
			InstrumentID: inst,
			VenueID:      venue,
			At:           now,
			Source:       "okx",
			RetrievedAt:  now,
		}
		if v, ok := f64(r.BidPx); ok {
			row.Bid = &v
		}
		if v, ok := f64(r.AskPx); ok {
			row.Ask = &v
		}
		if v, ok := f64(r.BidSz); ok {
			row.BidSize = &v
		}
		if v, ok := f64(r.AskSz); ok {
			row.AskSize = &v
		}
		if v, ok := f64(r.Last); ok {
			row.Last = &v
		}
		rows = append(rows, row)
		symbols = append(symbols, canon.ProviderSymbol{
			Provider:     providerName,
			ProviderSymb: r.InstID,
			Kind:         string(canon.KindInstrument),
			CanonicalID:  inst,
			LastSeenAt:   &now,
		})
	}
	if len(rows) == 0 {
		if rejected > 0 {
			return 0, rejected, nil
		}
		return 0, 0, nil
	}
	if _, err := w.UpsertProviderSymbols(ctx, symbols); err != nil {
		return 0, 0, err
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

// instruments registers one instrument row per SPOT/SWAP instrument the venue
// lists: GET /api/v5/public/instruments?instType=SPOT. The SPOT rows carry
// the pair directly: {"instId":"BTC-USDT","baseCcy":"BTC","quoteCcy":"USDT"};
// SWAP rows carry the contract currency instead, so base/quote split off the
// id ("BTC-USDT-SWAP" -> base BTC, quote USDT, settle USDT). A row with no
// instId, or no decodable pair, is counted as rejected — one broken row must
// not hard-error a 1000-instrument universe (dataset-level failure is for an
// unreadable envelope, not a row). This fetcher upserts instruments and
// provider symbols and writes no facts.
func (c *client) instruments(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	instType := "SPOT"
	market := "spot"
	if subjectIsPerp(job.Subject) {
		instType = "SWAP"
		market = "linear_perp"
	}
	url := fmt.Sprintf("%s/api/v5/public/instruments?instType=%s", Base, instType)
	var raw []struct {
		InstID    string `json:"instId"`
		BaseCcy   string `json:"baseCcy"`
		QuoteCcy  string `json:"quoteCcy"`
		SettleCcy string `json:"settleCcy"`
		State     string `json:"state"`
	}
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, err
	}
	now := time.Now().UTC()
	instrs := make([]canon.Instrument, 0, len(raw))
	symbols := make([]canon.ProviderSymbol, 0, len(raw))
	rejected := 0
	for _, r := range raw {
		var base, quote string
		switch instType {
		case "SWAP":
			// The contract id is the pair: BTC-USDT-SWAP -> base BTC,
			// quote USDT; settleCcy (USDT) agrees or the row is unusable.
			if r.InstID == "" {
				rejected++
				continue
			}
			parts := strings.Split(strings.ToUpper(strings.TrimSpace(r.InstID)), "-")
			if len(parts) != 3 || parts[2] != "SWAP" || parts[0] == "" || parts[1] == "" {
				rejected++
				continue
			}
			base, quote = parts[0], parts[1]
			settle := strings.ToUpper(strings.TrimSpace(r.SettleCcy))
			if settle != "" && settle != quote {
				rejected++
				continue
			}
		default:
			base, quote = r.BaseCcy, r.QuoteCcy
		}
		if r.InstID == "" || base == "" || quote == "" {
			rejected++
			continue
		}
		instID := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
			VenueID: venueID, MarketType: market, Base: base, Quote: quote,
		}))
		status := r.State
		if status == "" {
			status = "active"
		}
		instrs = append(instrs, canon.Instrument{
			InstrumentID: instID,
			VenueID:      canon.MintID(canon.KindVenue, canon.VenueKey(venueID)),
			VenueName:    venueID,
			MarketType:   market,
			BaseSymbol:   base,
			QuoteSymbol:  quote,
			Ticker:       strPtr(r.InstID),
			Status:       status,
		})
		symbols = append(symbols, canon.ProviderSymbol{
			Provider:     providerName,
			ProviderSymb: r.InstID,
			Kind:         string(canon.KindInstrument),
			CanonicalID:  instID,
			LastSeenAt:   &now,
		})
	}
	if len(instrs) == 0 {
		if rejected > 0 {
			// EVERY row failed while the envelope decoded: that is a shape
			// drift in the universe, not one unlucky row — a dataset-level
			// HardError so the engine's breaker/backoff owns it.
			return 0, rejected, &HardError{Kind: "shape", URL: url,
				Detail: fmt.Sprintf("all %d instrument rows unparseable", rejected)}
		}
		return 0, 0, nil
	}
	if _, err := w.UpsertInstruments(ctx, instrs); err != nil {
		return 0, 0, err
	}
	n, err := w.UpsertProviderSymbols(ctx, symbols)
	return n, rejected, err
}

// strPtr is a non-empty string as a pointer; "" stays nil (never-fake).
func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
