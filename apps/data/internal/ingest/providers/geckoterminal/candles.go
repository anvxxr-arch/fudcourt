package geckoterminal

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// This file adds the DEX Data Platform's `dex-candles` dataset to the existing
// geckoterminal provider (plan §38: extend, never fork). It writes exact
// data.dex_candle rows through the DEX store, while the existing `pools` dataset
// keeps writing canon.Pool through the engine writer.
//
//	GET {Base}/networks/{network}/pools/{pool_address}/ohlcv/{timeframe}
//	      ?aggregate=1&limit=1000&currency=usd&token=base
//
// The response's ohlcv_list is [unix_seconds, open, high, low, close, volume]
// with the prices as DECIMAL STRINGS, so each value is parsed exactly into a
// canon.Dec — no float64 touches a candle (plan §54). The DEX writer is taken by
// construction: ingest.Fetcher.Fetch can only reach canon.Writer, which cannot
// write data.dex_* tables.

// ohlcvDoc is the GeckoTerminal OHLCV envelope.
type ohlcvDoc struct {
	Data struct {
		Attributes struct {
			OHLCVList [][]any `json:"ohlcv_list"`
		} `json:"attributes"`
	} `json:"data"`
}

// intervals maps a GeckoTerminal timeframe+aggregate to the canon timeframe the
// candle's natural key carries. Anything not listed is refused loudly rather
// than minted under a made-up interval.
var intervals = map[string]string{
	"minute:1":  "1m",
	"minute:5":  "5m",
	"minute:15": "15m",
	"hour:1":    "1h",
	"hour:4":    "4h",
	"day:1":     "1d",
}

// dexCandles implements the `dex-candles` dataset. The job subject is
// network:pool_address; the timeframe and aggregate travel in the cursor as
// {"timeframe":"minute","aggregate":5} (defaults minute/5m).
func (c *client) dexCandles(ctx context.Context, w canon.Writer, dw dexstore.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	if dw == nil {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "no dex writer wired"}
	}
	subject := job.Subject
	network, address, ok := strings.Cut(trimSpace(subject), ":")
	network, address = trimSpace(network), trimSpace(address)
	if !ok || network == "" || address == "" {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "dex-candles job needs subject network:pool_address, got " + subject}
	}
	tf := cursorString(job.Cursor, "timeframe")
	if tf == "" {
		tf = "minute"
	}
	agg := cursorInt(job.Cursor, "aggregate")
	if agg == 0 {
		agg = 5
	}
	interval, ok := intervals[tf+":"+strconv.Itoa(agg)]
	if !ok {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: fmt.Sprintf("unsupported timeframe %s aggregate %d", tf, agg)}
	}
	chain, ok := networkToChain[network]
	if !ok {
		chain = strings.ToLower(network)
	}
	u := fmt.Sprintf("%s/networks/%s/pools/%s/ohlcv/%s?aggregate=%d&limit=1000&currency=usd&token=base",
		Base, url.PathEscape(network), url.PathEscape(address), url.PathEscape(tf), agg)
	var doc ohlcvDoc
	if err := c.getJSON(ctx, u, &doc); err != nil {
		return 0, 0, nil, err
	}
	if _, err := w.UpsertChains(ctx, []canon.Chain{{
		ChainID: canon.MintID(canon.KindChain, canon.ChainKey(chain)),
		Name:    chain,
		Kind:    chainKind(chain),
	}}); err != nil {
		return 0, 0, nil, err
	}
	cid := canon.MintID(canon.KindChain, canon.ChainKey(chain))
	pid := canon.MintID(canon.KindPool, canon.PoolKey(chain, address))
	now := time.Now().UTC()
	rows := make([]canon.DexCandle, 0, len(doc.Data.Attributes.OHLCVList))
	rejected := 0
	for _, bar := range doc.Data.Attributes.OHLCVList {
		row, ok := mapCandle(pid, cid, interval, bar, now)
		if !ok {
			rejected++
			continue
		}
		rows = append(rows, row)
	}
	written, rej, err := dw.WriteDexCandles(ctx, rows)
	if err != nil {
		return written, rej + rejected, nil, err
	}
	return written, rej + rejected, ingest.Cursor{"timeframe": tf, "aggregate": agg}, nil
}

// mapCandle maps one [ts,o,h,l,c,v] bar to a canon.DexCandle. ok is false for a
// malformed bar (wrong arity or an unparseable decimal), which the caller counts
// as a rejection — never a fabricated bar.
func mapCandle(poolID, chainID, interval string, bar []any, now time.Time) (canon.DexCandle, bool) {
	if len(bar) < 6 {
		return canon.DexCandle{}, false
	}
	ts, ok := toInt64(bar[0])
	if !ok || ts <= 0 {
		return canon.DexCandle{}, false
	}
	open, ok1 := toDec(bar[1])
	high, ok2 := toDec(bar[2])
	low, ok3 := toDec(bar[3])
	close, ok4 := toDec(bar[4])
	if !ok1 || !ok2 || !ok3 || !ok4 {
		return canon.DexCandle{}, false
	}
	vol, _ := toDec(bar[5])
	openTime := time.Unix(ts, 0).UTC()
	prov := canon.ProvenanceForProvider(Source)
	prov.ChainID = chainID
	prov.ObservedAt = openTime
	prov.NormalizedAt = now
	row := canon.DexCandle{
		CandleID:   canon.MintID(canon.KindCandle, canon.CandleKey(poolID, interval, ts)),
		NaturalKey: canon.CandleKey(poolID, interval, ts),
		PoolID:     poolID,
		ChainID:    chainID,
		Interval:   interval,
		OpenTime:   openTime,
		CloseTime:  openTime.Add(intervalDuration(interval)),
		Open:       open,
		High:       high,
		Low:        low,
		Close:      close,
		Provenance: prov,
	}
	if vol.Present() {
		row.VolumeBase = &vol
	}
	return row, true
}

// cursorString reads a string cursor value.
func cursorString(c ingest.Cursor, key string) string {
	if c == nil {
		return ""
	}
	s, _ := c[key].(string)
	return trimSpace(s)
}

// cursorInt reads an integer cursor value (JSON numbers decode as float64; a
// string spelling is accepted too).
func cursorInt(c ingest.Cursor, key string) int {
	if c == nil {
		return 0
	}
	switch v := c[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		n, err := strconv.Atoi(trimSpace(v))
		if err == nil {
			return n
		}
	}
	return 0
}

// toDec parses a wire value into an exact Dec. GeckoTerminal returns OHLCV
// prices as bare JSON numbers (the client decodes with UseNumber, so they
// arrive as json.Number spellings) and some fields as decimal strings; both
// are parsed exactly, never through a float64.
func toDec(v any) (canon.Dec, bool) {
	switch t := v.(type) {
	case string:
		d, err := canon.DecFromString(t)
		return d, err == nil
	case json.Number:
		d, err := canon.DecFromString(string(t))
		return d, err == nil
	case float64:
		d, err := canon.DecFromString(strconv.FormatFloat(t, 'f', -1, 64))
		return d, err == nil
	}
	return canon.NilDec, false
}

// toInt64 reads a unix-seconds value from a wire value.
func toInt64(v any) (int64, bool) {
	switch t := v.(type) {
	case json.Number:
		n, err := strconv.ParseInt(string(t), 10, 64)
		return n, err == nil
	case float64:
		return int64(t), true
	case string:
		n, err := strconv.ParseInt(trimSpace(t), 10, 64)
		return n, err == nil
	}
	return 0, false
}

// intervalDuration maps a canon interval to its representative duration (used
// for close_time only; the partition column is open_time).
func intervalDuration(interval string) time.Duration {
	switch interval {
	case "1m":
		return time.Minute
	case "5m":
		return 5 * time.Minute
	case "15m":
		return 15 * time.Minute
	case "1h":
		return time.Hour
	case "4h":
		return 4 * time.Hour
	case "1d":
		return 24 * time.Hour
	case "1w":
		return 7 * 24 * time.Hour
	}
	return 0
}
