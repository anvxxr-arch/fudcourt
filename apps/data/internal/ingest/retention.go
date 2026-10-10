package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

// Dataset keys for the retention windows (contract §43). The fact tables
// spell their window key "<dataset>:<timeframe>" (ohlcv:1m, ohlcv:1w, ...);
// everything else keys by dataset name. Datasets not listed here are
// permanent (never swept) — an explicit, documented default, not a guess.
const (
	DSOhlcv        = "ohlcv"
	DSTrade        = "trade"
	DSQuote        = "quote"
	DSOrderbook    = "orderbook"
	DSObservation  = "observation"
	DSFunding      = "funding"
	DSOpenInterest = "open_interest"
	DSLiquidation  = "liquidation"
	DSTVLProtocol  = "tvl_protocol"
	DSTVLChain     = "tvl_chain"
	DSPool         = "pool"
	DSSupply       = "supply"
	DSMetric       = "metric"
)

// DefaultRetentionWindows is the frozen window table (days): ohlcv 1d/1w
// permanent, 1m/5m/15m 400d, 1h/4h 730d; trades 90d; quotes 30d; orderbook
// 14d; funding 400d; open_interest 400d; liquidation 180d; tvl_* 730d; pool
// 180d; supply 180d; observation/series and metric permanent (absent on
// purpose). ohlcv timeframes outside the listed set (tick, 1s, ..., quarter,
// annual, event) are permanent too: the contract pins windows for the regular
// frames only, and never-fake forbids guessing one for the rest. An explicit
// 0 value means permanent wherever it appears.
func DefaultRetentionWindows() RetentionWindows {
	w := RetentionWindows{}
	for _, tf := range []string{"1m", "5m", "15m"} {
		w["ohlcv:"+tf] = 400
	}
	for _, tf := range []string{"1h", "4h"} {
		w["ohlcv:"+tf] = 730
	}
	w[DSTrade] = 90
	w[DSQuote] = 30
	w[DSOrderbook] = 14
	w[DSFunding] = 400
	w[DSOpenInterest] = 400
	w[DSLiquidation] = 180
	w[DSTVLProtocol] = 730
	w[DSTVLChain] = 730
	w[DSPool] = 180
	w[DSSupply] = 180
	return w
}

// RetentionWindows maps a dataset key ("trade", "ohlcv:1m", ...) to its
// retention window in days. A missing key (or an explicit 0) means permanent:
// never swept.
type RetentionWindows map[string]int

// WithOverrides returns a copy of w with the JSON overrides applied. Unknown
// dataset keys are an error (a typo like "ohlcv;1m" must fail loudly, not
// silently sweep nothing); a negative window is an error. A table-level
// "ohlcv" override applies to every ohlcv timeframe that has no explicitly
// spelled-out window; "ohlcv:<tf>" windows the single timeframe. Overrides on
// the permanent datasets (observation, metric) are legal: an operator may
// retire data faster than the default, and an explicit 0 documents "keep
// forever".
func (w RetentionWindows) WithOverrides(overrides map[string]int) (RetentionWindows, error) {
	out := make(RetentionWindows, len(w)+len(overrides))
	for k, v := range w {
		out[k] = v
	}
	for k, v := range overrides {
		if v < 0 {
			return nil, fmt.Errorf("ingest: retention override %q: negative window", k)
		}
		if !validRetentionKey(k) {
			return nil, fmt.Errorf("ingest: retention override %q: unknown dataset", k)
		}
		out[k] = v
	}
	return out, nil
}

// validRetentionKey reports whether k names a dataset this sweeper knows:
// the table-level "ohlcv" fan-out key, any "ohlcv:<tf>" timeframe, or one of
// the sweepable table-level datasets (including the permanent observation and
// metric, overridable to a positive window).
func validRetentionKey(k string) bool {
	if k == DSOhlcv {
		return true
	}
	if strings.HasPrefix(k, DSOhlcv+":") {
		return true
	}
	switch k {
	case DSTrade, DSQuote, DSOrderbook, DSFunding, DSOpenInterest,
		DSLiquidation, DSTVLProtocol, DSTVLChain, DSPool, DSSupply,
		DSObservation, DSMetric:
		return true
	}
	return false
}

// retentionEnvVar is the documented override knob (contract §43).
const retentionEnvVar = "FUDCOURT_DATA_RETENTION_JSON"

// EnvRetentionJSON reads the override map from a FUDCOURT_DATA_RETENTION_JSON
// getter: a JSON object mapping dataset key -> days ("{\"ohlcv:5m\": 90,
// \"trade\": 30}"). Absent or empty means "no overrides" (nil, nil).
// Malformed JSON is an error: a silently ignored override would change what
// data gets deleted.
func EnvRetentionJSON(getenv func(string) string) (map[string]int, error) {
	if getenv == nil {
		getenv = defaultGetenv
	}
	raw := getenv(retentionEnvVar)
	if raw == "" {
		return nil, nil
	}
	var m map[string]int
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, fmt.Errorf("ingest: %s: %w", retentionEnvVar, err)
	}
	if len(m) == 0 {
		return nil, nil
	}
	return m, nil
}

func defaultGetenv(k string) string { return os.Getenv(k) }

// PGRetention is the pgx-backed Retention implementation: it deletes rows
// older than each dataset's window, per contract §43.
type PGRetention struct {
	pool    Executor
	windows RetentionWindows
}

// NewRetention builds a Retention from the default window table plus the
// parsed FUDCOURT_DATA_RETENTION_JSON overrides. getenv is injectable for
// tests; nil reads the process environment.
func NewRetention(pool Executor, getenv func(string) string) (*PGRetention, error) {
	windows := DefaultRetentionWindows()
	overrides, err := EnvRetentionJSON(getenv)
	if err != nil {
		return nil, err
	}
	if overrides != nil {
		windows, err = windows.WithOverrides(overrides)
		if err != nil {
			return nil, err
		}
	}
	return &PGRetention{pool: pool, windows: windows}, nil
}

// sweepStatement is one dataset's deletion: the key (for logs/tests), the SQL
// and its arguments. The cutoff argument is fully resolved.
type sweepStatement struct {
	key  string
	sql  string
	args []any
}

// plan builds the ordered deletion plan for the configured windows: one
// DELETE per sweepable (table, window) pair, cutoff = now - days. Permanent
// keys (missing or 0) are skipped. The time column per table is the
// hypertable partition column (ADDENDUM B). Statements are ordered
// alphabetically by key so a mid-sweep failure is deterministic and tests can
// pin the plan without a database.
func (r *PGRetention) plan(now time.Time) []sweepStatement {
	// Expand a table-level "ohlcv" override to every timeframe that has no
	// explicitly spelled-out window (the spelled-out ones, including 0 =
	// permanent, win).
	windows := make(RetentionWindows, len(r.windows))
	for k, v := range r.windows {
		windows[k] = v
	}
	if v, ok := windows[DSOhlcv]; ok {
		for _, tf := range ohlcvWindowTFs {
			if _, spelled := windows["ohlcv:"+tf]; !spelled {
				windows["ohlcv:"+tf] = v
			}
		}
	}

	type target struct{ key, table, col string }
	var targets []target
	add := func(key, table, col string) {
		if days := windows[key]; days > 0 {
			targets = append(targets, target{key, table, col})
		}
	}
	for _, tf := range ohlcvWindowTFs {
		add("ohlcv:"+tf, "data.ohlcv", "open_time")
	}
	add(DSTrade, "data.trade", "trade_time")
	add(DSQuote, "data.quote", "at")
	add(DSOrderbook, "data.orderbook", "at")
	add(DSFunding, "data.funding", "funding_time")
	add(DSOpenInterest, "data.open_interest", "at")
	add(DSLiquidation, "data.liquidation", "at")
	add(DSTVLProtocol, "data.tvl_protocol", "at")
	add(DSTVLChain, "data.tvl_chain", "at")
	add(DSPool, "data.pool", "at")
	add(DSSupply, "data.supply", "at")
	add(DSMetric, "data.metric", "at")

	plan := make([]sweepStatement, 0, len(targets))
	for _, t := range targets {
		cutoff := now.Add(-time.Duration(windows[t.key]) * 24 * time.Hour)
		if strings.HasPrefix(t.key, DSOhlcv+":") {
			tf := strings.TrimPrefix(t.key, DSOhlcv+":")
			plan = append(plan, sweepStatement{
				key:  t.key,
				sql:  "DELETE FROM " + t.table + " WHERE timeframe = $1 AND " + t.col + " < $2",
				args: []any{tf, cutoff},
			})
			continue
		}
		plan = append(plan, sweepStatement{
			key:  t.key,
			sql:  "DELETE FROM " + t.table + " WHERE " + t.col + " < $1",
			args: []any{cutoff},
		})
	}
	sort.Slice(plan, func(i, j int) bool { return plan[i].key < plan[j].key })
	return plan
}

// ohlcvWindowTFs is the ohlcv timeframe vocabulary the windows table can
// address: the frames the contract pins windows for, plus the permanent
// frames (1d, 1w) so a table-level override can still shrink them — an
// explicit operator decision, validated by WithOverrides. Exotic frames
// (tick, 1s, ..., quarter, annual, event) are unreachable from overrides and
// always permanent.
var ohlcvWindowTFs = []string{"1m", "5m", "15m", "1h", "4h", "1d", "1w"}

// Sweep deletes every row older than its dataset's window and returns the
// rows deleted. The first statement error aborts the sweep; rows already
// deleted are counted and returned, never hidden.
func (r *PGRetention) Sweep(ctx context.Context, now time.Time) (int64, error) {
	var total int64
	for _, p := range r.plan(now) {
		tag, err := r.pool.Exec(ctx, p.sql, p.args...)
		if err != nil {
			return total, fmt.Errorf("ingest: retention sweep %s: %w", p.key, err)
		}
		total += execRowsAffected(tag)
	}
	return total, nil
}

// execRowsAffected extracts the deleted-row count from an Exec result across
// the small set of concrete tag types pgx returns.
func execRowsAffected(v any) int64 {
	switch t := v.(type) {
	case interface{ RowsAffected() int64 }:
		return t.RowsAffected()
	}
	return 0
}
