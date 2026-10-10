package binance

import (
	"context"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// venueID is this adapter's canonical venue id.
const venueID = "binance"

// klines fetches OHLCV bars for one symbol from one market segment.
// Spot:  GET /api/v3/klines?symbol=&interval=&limit=
// Perp:  GET /fapi/v1/klines?symbol=&interval=&limit=
// Row shape: ["1697049600000","27945.01",...,"27945.01","3.566","99829.86",...]
// — array of arrays of strings, open time ms.
func (c *client) klines(ctx context.Context, w canon.Writer, job ingest.Job, timeframe string, limit int) (int, int, error) {
	if timeframe == "" {
		timeframe = "1m"
	}
	if _, ok := intervals[timeframe]; !ok {
		return 0, 0, &HardError{Kind: "shape", Detail: "unsupported timeframe " + timeframe}
	}
	market := "spot"
	base := SpotBase + "/api/v3/klines"
	sym := subjectSymbol(job.Subject)
	if isPerpSubject(job.Subject) {
		market = "linear_perp"
		base = PerpBase + "/fapi/v1/klines"
	}
	url := fmt.Sprintf("%s?symbol=%s&interval=%s&limit=%d", base, sym, intervals[timeframe], limit)

	var raw [][]any
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, err
	}
	now := time.Now().UTC()
	rows := make([]canon.Ohlcv, 0, len(raw))
	for _, row := range raw {
		if len(row) < 7 {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: fmt.Sprintf("kline row width %d", len(row))}
		}
		open, ok1 := ms(row[0])
		if !ok1 {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "kline open time"}
		}
		o, ok2 := f64(row[1])
		h, ok3 := f64(row[2])
		l, ok4 := f64(row[3])
		cl, ok5 := f64(row[4])
		vol, ok6 := f64(row[5])
		qvol, ok7 := f64(row[7])
		if !ok2 || !ok3 || !ok4 || !ok5 || !ok6 || !ok7 {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "kline numeric field"}
		}
		baseSym, quoteSym, ok := splitSymbol(sym)
		if !ok {
			return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "unparseable symbol " + sym}
		}
		inst := canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
			VenueID: venueID, MarketType: market, Base: baseSym, Quote: quoteSym,
		}))
		closeT := open.Add(time.Duration(intervalMs[intervals[timeframe]]) * time.Millisecond)
		rows = append(rows, canon.Ohlcv{
			InstrumentID: inst,
			VenueID:      canon.MintID(canon.KindVenue, canon.VenueKey(venueID)),
			Timeframe:    timeframe,
			OpenTime:     open,
			CloseTime:    closeT,
			O:            o, H: h, L: l, C: cl,
			VolumeBase:  &vol,
			VolumeQuote: &qvol,
			Source:      "binance",
			RetrievedAt: now,
		})
	}
	if len(rows) == 0 {
		return 0, 0, nil
	}
	return w.WriteOhlcv(ctx, rows)
}

// isPerpSubject reports whether a job subject encodes the perp market. The
// job registry stores subjects like "spot:BTCUSDT" / "linear_perp:BTCUSDT";
// a bare symbol means spot.
func isPerpSubject(subject string) bool {
	return hasPrefixFold(subject, "linear_perp:")
}

// hasPrefixFold is a case-insensitive strings.HasPrefix.
func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && (s[:len(prefix)] == prefix ||
		lowerASCII(s[:len(prefix)]) == lowerASCII(prefix))
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
