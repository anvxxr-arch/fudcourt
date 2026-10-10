package bybit

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

// venueID is this adapter's canonical venue id (venue/bybit in reference.json).
const venueID = "bybit"

// klines fetches OHLCV bars for one symbol from one market segment:
// GET /v5/market/kline?category=&symbol=&interval=&start=&end=&limit=
// Row shape: ["1670604000000","17071","17073","17055","17061","268611","..."]
// — array of arrays of STRING numbers, open time ms. start/end are epoch-ms
// when the job carries them. Rows come newest-first and are written oldest-first.
func (c *client) klines(ctx context.Context, w canon.Writer, job ingest.Job, timeframe string, limit int) (int, int, error) {
	if timeframe == "" {
		timeframe = "1m"
	}
	iv, ok := intervals[timeframe]
	if !ok {
		return 0, 0, &HardError{Kind: "shape", Detail: "unsupported timeframe " + timeframe}
	}
	market := "spot"
	category := "spot"
	sym := subjectSymbol(job.Subject)
	if isPerpSubject(job.Subject) {
		market = "linear_perp"
		category = "linear"
	}
	url := fmt.Sprintf("%s/v5/market/kline?category=%s&symbol=%s&interval=%s&limit=%d",
		Base, category, sym, iv, limit)
	if ms, ok := epochMs(job.Cursor["start"]); ok {
		url += fmt.Sprintf("&start=%d", ms)
	}
	if ms, ok := epochMs(job.Cursor["end"]); ok {
		url += fmt.Sprintf("&end=%d", ms)
	}
	var res struct {
		List [][]any `json:"list"`
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
		VenueID: venueID, MarketType: market, Base: baseSym, Quote: quoteSym,
	}))
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()
	rows := make([]canon.Ohlcv, 0, len(raw))
	for i := len(raw) - 1; i >= 0; i-- {
		row := raw[i]
		if len(row) < 6 {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: fmt.Sprintf("kline row width %d", len(row))}
		}
		open, ok1 := ms(row[0])
		o, ok2 := f64(row[1])
		h, ok3 := f64(row[2])
		l, ok4 := f64(row[3])
		cl, ok5 := f64(row[4])
		vol, ok6 := f64(row[5])
		if !ok1 || !ok2 || !ok3 || !ok4 || !ok5 || !ok6 {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "kline numeric field"}
		}
		var qvol *float64
		if len(row) >= 7 {
			if v, ok := f64(row[6]); ok {
				qvol = &v
			}
		}
		closeT := open.Add(time.Duration(intervalMs[timeframe]) * time.Millisecond)
		rows = append(rows, canon.Ohlcv{
			InstrumentID: inst,
			VenueID:      venue,
			Timeframe:    timeframe,
			OpenTime:     open,
			CloseTime:    closeT,
			O:            o, H: h, L: l, C: cl,
			VolumeBase:  &vol,
			VolumeQuote: qvol,
			Source:      "bybit",
			RetrievedAt: now,
		})
	}
	if len(rows) == 0 {
		return 0, 0, nil
	}
	return w.WriteOhlcv(ctx, rows)
}

// funding fetches the funding-rate history for one linear perp:
// GET /v5/market/funding/history?category=linear&symbol=&limit=
// Row shape: [{"symbol":"BTC-03JAN25","fundingRate":"0.0001","fundingRateTimestamp":
// "1670604000000"}] — string numbers, ms-string timestamps.
func (c *client) funding(ctx context.Context, w canon.Writer, job ingest.Job, limit int) (int, int, error) {
	sym := subjectSymbol(job.Subject)
	url := fmt.Sprintf("%s/v5/market/funding/history?category=linear&symbol=%s&limit=%d", Base, sym, limit)
	if ms, ok := epochMs(job.Cursor["start"]); ok {
		url += fmt.Sprintf("&startTime=%d", ms)
	}
	if ms, ok := epochMs(job.Cursor["end"]); ok {
		url += fmt.Sprintf("&endTime=%d", ms)
	}
	var res struct {
		List []struct {
			Symbol               string `json:"symbol"`
			FundingRate          string `json:"fundingRate"`
			FundingRateTimestamp any    `json:"fundingRateTimestamp"`
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
		VenueID: venueID, MarketType: "linear_perp", Base: baseSym, Quote: quoteSym,
	}))
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()
	rows := make([]canon.FundingRate, 0, len(raw))
	for _, r := range raw {
		at, ok := ms(r.FundingRateTimestamp)
		if !ok {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "fundingRateTimestamp " + fmt.Sprint(r.FundingRateTimestamp)}
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
			Source:       "bybit",
			RetrievedAt:  now,
		})
	}
	if len(rows) == 0 {
		return 0, 0, nil
	}
	return w.WriteFunding(ctx, rows)
}

// openInterest fetches the open-interest HISTORY series for one linear perp:
// GET /v5/market/open-interest?category=linear&symbol=&intervalTime=5min&limit=
// Row shape: [{"symbol":"BTCUSDT","openInterest":"5968.815","timestamp":
// "1669528140000"}] — the endpoint has no current-snapshot variant, so the
// newest row IS the snapshot. openInterest is base-coin sized; USD stays nil
// (never-fake: no price-derived zero fill).
func (c *client) openInterest(ctx context.Context, w canon.Writer, job ingest.Job, limit int) (int, int, error) {
	sym := subjectSymbol(job.Subject)
	url := fmt.Sprintf("%s/v5/market/open-interest?category=linear&symbol=%s&intervalTime=5min&limit=%d",
		Base, sym, limit)
	if ms, ok := epochMs(job.Cursor["start"]); ok {
		url += fmt.Sprintf("&startTime=%d", ms)
	}
	if ms, ok := epochMs(job.Cursor["end"]); ok {
		url += fmt.Sprintf("&endTime=%d", ms)
	}
	var res struct {
		List []struct {
			Symbol       string `json:"symbol"`
			OpenInterest string `json:"openInterest"`
			Timestamp    any    `json:"timestamp"`
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
		VenueID: venueID, MarketType: "linear_perp", Base: baseSym, Quote: quoteSym,
	}))
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()
	rows := make([]canon.OpenInterest, 0, len(raw))
	for _, r := range raw {
		at, ok := ms(r.Timestamp)
		if !ok {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "open-interest timestamp"}
		}
		oi, ok := f64(r.OpenInterest)
		if !ok {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "openInterest " + r.OpenInterest}
		}
		rows = append(rows, canon.OpenInterest{
			InstrumentID:     inst,
			VenueID:          venue,
			OIAt:             at,
			OpenInterestBase: &oi,
			Source:           "bybit",
			RetrievedAt:      now,
		})
	}
	if len(rows) == 0 {
		return 0, 0, nil
	}
	return w.WriteOpenInterest(ctx, rows)
}

// ticker fetches 24h tickers. category=spot is the registered job; a linear
// subject is accepted and flips the category. The response rows carry the
// symbol, the string numbers and (spot only) a ms-string ts. Every parsed row
// also registers its provider symbol so the resolver can map
// (bybit, BTCUSDT) -> instrument id later.
//
//	spot:   {"symbol":"BTCUSDT","bid1Price":"...","ask1Price":"...","lastPrice":"...",
//	         "bid1Size":"...","ask1Size":"...","volume24h":"...","turnover24h":"...","ts":"..."}
//	linear: {"symbol":"BTCUSDT","lastPrice":"...","bid1Price":"...","ask1Price":"...",
//	         "volume24h":"...","turnover24h":"...","openInterest":"..."}
func (c *client) ticker(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	market := "spot"
	category := "spot"
	if isPerpSubject(job.Subject) {
		market = "linear_perp"
		category = "linear"
	}
	url := fmt.Sprintf("%s/v5/market/tickers?category=%s", Base, category)
	if sym := subjectSymbol(job.Subject); sym != "" {
		url += "&symbol=" + sym
	}
	var res struct {
		List []struct {
			Symbol       string `json:"symbol"`
			LastPrice    string `json:"lastPrice"`
			Bid1Price    string `json:"bid1Price"`
			Ask1Price    string `json:"ask1Price"`
			Bid1Size     string `json:"bid1Size"`
			Ask1Size     string `json:"ask1Size"`
			Volume24h    string `json:"volume24h"`
			Turnover24h  string `json:"turnover24h"`
			Price24hPcnt string `json:"price24hPcnt"`
		} `json:"list"`
	}
	if err := c.getJSON(ctx, url, &res); err != nil {
		return 0, 0, err
	}
	raw := res.List
	venue := canon.MintID(canon.KindVenue, canon.VenueKey(venueID))
	now := time.Now().UTC()
	rows := make([]canon.Quote, 0, len(raw))
	symbols := make([]canon.ProviderSymbol, 0, len(raw))
	rejected := 0
	for _, r := range raw {
		baseSym, quoteSym, ok := splitSymbol(r.Symbol)
		if !ok {
			// Real market rows for pairs outside our quote vocabulary are
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
			Source:       "bybit",
			RetrievedAt:  now,
		}
		if v, ok := f64(r.Bid1Price); ok {
			row.Bid = &v
		}
		if v, ok := f64(r.Ask1Price); ok {
			row.Ask = &v
		}
		if v, ok := f64(r.Bid1Size); ok {
			row.BidSize = &v
		}
		if v, ok := f64(r.Ask1Size); ok {
			row.AskSize = &v
		}
		if v, ok := f64(r.LastPrice); ok {
			row.Last = &v
		}
		rows = append(rows, row)
		symbols = append(symbols, canon.ProviderSymbol{
			Provider:     providerName,
			ProviderSymb: r.Symbol,
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

// instruments registers one instrument row per spot/linear pair the venue
// lists: GET /v5/market/instruments-info?category=&limit=1000 —
// {"result":{"category":"spot","list":[{"symbol":"BTCUSDT","baseCoin":"BTC",
// "quoteCoin":"USDT",...}]}}. A row with no symbol or an undecodable pair is
// counted as rejected, never fatal. This is the fetcher the bybit-instruments
// dataset runs; it upserts instruments and provider symbols and writes no
// facts.
func (c *client) instruments(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	category := "spot"
	if isPerpSubject(job.Subject) {
		category = "linear"
	}
	url := fmt.Sprintf("%s/v5/market/instruments-info?category=%s&limit=1000", Base, category)
	var res struct {
		List []struct {
			Symbol    string `json:"symbol"`
			BaseCoin  string `json:"baseCoin"`
			QuoteCoin string `json:"quoteCoin"`
			Status    string `json:"status"`
		} `json:"list"`
	}
	if err := c.getJSON(ctx, url, &res); err != nil {
		return 0, 0, err
	}
	market := "spot"
	if category == "linear" {
		market = "linear_perp"
	}
	now := time.Now().UTC()
	instrs := make([]canon.Instrument, 0, len(res.List))
	symbols := make([]canon.ProviderSymbol, 0, len(res.List))
	rejected := 0
	for _, r := range res.List {
		if r.Symbol == "" || r.BaseCoin == "" || r.QuoteCoin == "" {
			// A row with no symbol or an undecodable pair is counted, not
			// fatal: one broken entry must not drop a 1000-row universe
			// (dataset-level failure is for an unreadable envelope).
			rejected++
			continue
		}
		instID := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
			VenueID: venueID, MarketType: market, Base: r.BaseCoin, Quote: r.QuoteCoin,
		}))
		status := r.Status
		if status == "" {
			status = "active"
		}
		instrs = append(instrs, canon.Instrument{
			InstrumentID: instID,
			VenueID:      canon.MintID(canon.KindVenue, canon.VenueKey(venueID)),
			VenueName:    venueID,
			MarketType:   market,
			BaseSymbol:   r.BaseCoin,
			QuoteSymbol:  r.QuoteCoin,
			Ticker:       strPtr(r.Symbol),
			Status:       status,
		})
		symbols = append(symbols, canon.ProviderSymbol{
			Provider:     providerName,
			ProviderSymb: r.Symbol,
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

// epochMs reads a cursor field the wire accepts as a ms epoch (number or
// numeric string). Absent/empty cursor keys are simply no window.
func epochMs(v any) (int64, bool) {
	switch t := v.(type) {
	case string:
		n, err := parseI64(t)
		if err != nil {
			return 0, false
		}
		return n, true
	case float64:
		return int64(t), true
	case int64:
		return t, true
	case int:
		return int64(t), true
	case json.Number:
		n, err := t.Int64()
		if err != nil {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
}

// isPerpSubject reports whether a job subject encodes the perp market: the
// prefixed form "linear_perp:BTCUSDT" (ohlcv/funding/oi) or the bare market
// name "linear_perp" (instruments). A bare symbol or "spot:..." means spot.
func isPerpSubject(subject string) bool {
	return strings.EqualFold(subject, "linear_perp") || hasPrefixFold(subject, "linear_perp:")
}

// hasPrefixFold is a case-insensitive strings.HasPrefix.
func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && lowerASCII(s[:len(prefix)]) == lowerASCII(prefix)
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}

// subjectSymbol strips the optional market prefix from a job subject.
func subjectSymbol(subject string) string {
	for _, p := range []string{"spot:", "linear_perp:"} {
		if hasPrefixFold(subject, p) {
			return subject[len(p):]
		}
	}
	return subject
}
