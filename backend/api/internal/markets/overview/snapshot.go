package markets

// Snapshot is the two-sided touch a preview/execution path prices a spread
// against (the worker's MarketSnapshot in frontend/web/src/platform/executor/
// worker.ts, reduced to the touch pair).
type Snapshot struct {
	Bid string `json:"bid"`
	Ask string `json:"ask"`
}

// SnapshotFromTicker derives the touch pair of a ticker under the honest-null
// rule (mirroring tickerToSnapshot in frontend/web/src/platform/executor/worker.ts
// with its fabrication removed): the bid and ask sides are used AS REPORTED and
// are NEVER substituted with last — a last-only trade print is not a quote, and
// pricing a spread against it would invent a touch price the venue never gave.
//
// ok is false, with empty sides, whenever a usable two-sided touch does not
// exist:
//   - either side missing (the last-only ticker is the canonical case);
//   - either side unparseable or non-positive (untrustworthy data);
//   - the book crossed (bid > ask) — corrupt data, refused like Book.Validate.
//
// A missing side is reported as missing, never as zero or as the other side.
func SnapshotFromTicker(t Ticker) (Snapshot, bool) {
	empty := Snapshot{}
	if err := t.Validate(); err != nil {
		return empty, false
	}
	if t.Bid == "" || t.Ask == "" {
		return empty, false
	}
	if lessThan(t.Ask, t.Bid) {
		return empty, false
	}
	return Snapshot{Bid: t.Bid, Ask: t.Ask}, true
}
