package evmrpc

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// The series namespace the block dataset writes into:
// series/blockchain/<metric>/chain:<chain_id>, matching the Etherscan adapter's
// gas series so the two can be joined without a unit or subject-key mismatch.
const (
	domainBlockchain  = "blockchain"
	metricBlockHeight = "block_height"
	metricBaseFeeGwei = "base_fee_gwei"
	metricGasUsedPct  = "gas_used_pct"
)

// Cursor keys. The cursor round-trips through data.job.cursor (jsonb), so its
// numbers come back as float64 regardless of the Go type that wrote them - see
// cursorUint64.
const (
	cursorLastBlock     = "last_block"
	cursorLastBlockHash = "last_block_hash"
	cursorReorgCount    = "reorg_count"
	cursorReorgAtBlock  = "reorg_at_block"
)

// block fetches one chain's tip and writes it as canonical observations.
//
// Three facts per block, each its own series, because they have different
// units and different availability: block_height is always present,
// base_fee_gwei is absent before EIP-1559 (null, never 0), and gas_used_pct
// needs both gas words.
//
// # Reorg handling
//
// The cursor carries the last block's hash, and every run re-reads the block at
// that height and compares. If the hash has changed, the block the previous run
// recorded is no longer on the canonical chain: the run increments
// reorg_count and records reorg_at_block, then writes the CURRENT tip. The
// height claim stays true (a chain's height at time T is a point-in-time fact),
// but the event is recorded rather than silently overwritten - an ingester that
// cannot say "the block I stored last time was orphaned" cannot be trusted to
// checkpoint a log range later.
//
// The check costs one extra eth_getBlockByNumber per run. That is the price of
// a cursor a later range-based dataset can rely on.
func (c *client) block(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	ch, ok := lookupChain(job.Subject)
	if !ok {
		return 0, 0, nil, &HardError{Kind: "shape",
			Detail: "unsupported chain " + job.Subject + " (not in the adapter's chain map)"}
	}
	ep := endpoint(ch)
	head, err := c.blockNumber(ctx, ep)
	if err != nil {
		return 0, 0, nil, err
	}
	hdr, err := c.blockByNumber(ctx, ep, head, false)
	if err != nil {
		return 0, 0, nil, err
	}

	// Reorg check against the previous run's checkpoint.
	reorgCount := cursorUint64Or(job.Cursor, cursorReorgCount, 0)
	reorgAt := cursorUint64Or(job.Cursor, cursorReorgAtBlock, 0)
	prevBlock, hasPrev := cursorUint64(job.Cursor, cursorLastBlock)
	prevHash := cursorString(job.Cursor, cursorLastBlockHash)
	if hasPrev && prevHash != "" {
		switch {
		case prevBlock > head:
			// The tip moved backwards: either a reorg deeper than the poll
			// interval or a different node behind the endpoint. Both make the
			// stored checkpoint unusable, and neither is a shape error.
			reorgCount++
			reorgAt = prevBlock
		case prevBlock < head:
			pb, err := c.blockByNumber(ctx, ep, prevBlock, false)
			if err != nil {
				return 0, 0, nil, err
			}
			if !strings.EqualFold(pb.Hash, prevHash) {
				reorgCount++
				reorgAt = prevBlock
			}
		}
	}

	observedAt, ok := blockTime(hdr)
	if !ok {
		return 0, 0, nil, &HardError{Kind: "shape", URL: redact(ep),
			Detail: "eth_getBlockByNumber: unparseable timestamp " + preview(hdr.Timestamp)}
	}
	chainID := canon.MintID(canon.KindChain, canon.ChainKey(ch.Name))
	now := time.Now().UTC()

	rows := []canon.Observation{{
		SeriesID:    seriesID(metricBlockHeight, chainID),
		ObservedAt:  observedAt,
		Value:       ptr(float64(head)),
		Revision:    "latest",
		Source:      providerName,
		RetrievedAt: now,
	}}
	if gwei, ok := baseFeeGwei(hdr); ok {
		rows = append(rows, canon.Observation{
			SeriesID:    seriesID(metricBaseFeeGwei, chainID),
			ObservedAt:  observedAt,
			Value:       ptr(gwei),
			Revision:    "latest",
			Source:      providerName,
			RetrievedAt: now,
		})
	}
	if pct, ok := gasUsedPct(hdr); ok {
		rows = append(rows, canon.Observation{
			SeriesID:    seriesID(metricGasUsedPct, chainID),
			ObservedAt:  observedAt,
			Value:       ptr(pct),
			Revision:    "latest",
			Source:      providerName,
			RetrievedAt: now,
		})
	}

	// The series rows must exist before the observations land in them.
	if _, err := w.UpsertSeries(ctx, blockSeries(ch, chainID)); err != nil {
		return 0, 0, nil, err
	}
	written, rejected, err := w.WriteObservations(ctx, rows)
	if err != nil {
		return 0, 0, nil, err
	}
	next := ingest.Cursor{
		cursorLastBlock:     float64(head),
		cursorLastBlockHash: hdr.Hash,
		cursorReorgCount:    float64(reorgCount),
	}
	if reorgAt != 0 {
		next[cursorReorgAtBlock] = float64(reorgAt)
	}
	return written, rejected, next, nil
}

// seriesID builds one block series' canonical id.
func seriesID(metric, chainID string) string {
	return canon.MintID(canon.KindSeries, canon.SeriesKey(domainBlockchain, metric, "chain:"+chainID))
}

// blockSeries is the SeriesMeta for the three block series of one chain. Only
// the height series is unconditional: base fee and gas utilisation describe
// fields that a pre-EIP-1559 chain does not have, and registering a series for
// a metric that will never be written would advertise coverage that does not
// exist.
func blockSeries(ch chain, chainID string) []canon.SeriesMeta {
	chainIDCopy := chainID
	base := func(metric, title, unit string) canon.SeriesMeta {
		return canon.SeriesMeta{
			SeriesID:             seriesID(metric, chainID),
			Domain:               domainBlockchain,
			Metric:               metric,
			SubjectKey:           "chain:" + chainID,
			Title:                strPtr(title),
			Unit:                 strPtr(unit),
			Frequency:            "event",
			ChainID:              &chainIDCopy,
			Source:               providerName,
			Provider:             providerName,
			ProviderSeriesID:     metric + ":" + ch.Name,
			SchemaVersion:        canon.SchemaVersion,
			NormalizationVersion: canon.NormalizationVersion,
		}
	}
	return []canon.SeriesMeta{
		base(metricBlockHeight, ch.Name+" block height", "blocks"),
		base(metricBaseFeeGwei, ch.Name+" base fee", "gwei"),
		base(metricGasUsedPct, ch.Name+" gas utilisation", "percent"),
	}
}

// blockTime reads the block's own timestamp. It is the observation's
// observed_at: the fact was true at the block's time, not when we read it
// (retrieved_at carries that).
func blockTime(hdr *blockHeader) (time.Time, bool) {
	sec, ok := hexToUint64(hdr.Timestamp)
	if !ok {
		return time.Time{}, false
	}
	return time.Unix(int64(sec), 0).UTC(), true
}

// baseFeeGwei converts baseFeePerGas from wei to gwei. ok is false when the
// field is absent, which is the correct answer for a chain without EIP-1559 -
// the value stays null, never 0.
func baseFeeGwei(hdr *blockHeader) (float64, bool) {
	wei, ok := hexToBigFloat(hdr.BaseFeePerGas)
	if !ok {
		return 0, false
	}
	return wei / 1e9, true
}

// gasUsedPct is the block's gas utilisation as a percentage of its limit. Both
// words are required: a utilisation computed from a missing limit would be a
// fabricated number, and a limit of 0 would divide by zero.
func gasUsedPct(hdr *blockHeader) (float64, bool) {
	used, okU := hexToBigFloat(hdr.GasUsed)
	limit, okL := hexToBigFloat(hdr.GasLimit)
	if !okU || !okL || limit <= 0 {
		return 0, false
	}
	return used / limit * 100, true
}

// cursorUint64 reads a cursor value as a uint64. The value round-trips through
// data.job.cursor (jsonb), so a number written as a Go uint64 is read back as a
// float64; an int and a json.Number are accepted too, because a cursor written
// by an older run or by a hand-edited job row must not become a silent zero.
// A value that is not a number is absent, never 0.
func cursorUint64(c ingest.Cursor, key string) (uint64, bool) {
	if c == nil {
		return 0, false
	}
	v, ok := c[key]
	if !ok || v == nil {
		return 0, false
	}
	switch t := v.(type) {
	case float64:
		if t < 0 {
			return 0, false
		}
		return uint64(t), true
	case int:
		if t < 0 {
			return 0, false
		}
		return uint64(t), true
	case int64:
		if t < 0 {
			return 0, false
		}
		return uint64(t), true
	case uint64:
		return t, true
	case json.Number:
		n, err := t.Int64()
		if err != nil || n < 0 {
			return 0, false
		}
		return uint64(n), true
	}
	return 0, false
}

// cursorUint64Or is cursorUint64 with a default for an absent key.
func cursorUint64Or(c ingest.Cursor, key string, def uint64) uint64 {
	if v, ok := cursorUint64(c, key); ok {
		return v
	}
	return def
}

// cursorString reads a cursor value as a string; an absent or non-string value
// is the empty string.
func cursorString(c ingest.Cursor, key string) string {
	if c == nil {
		return ""
	}
	s, _ := c[key].(string)
	return s
}

// ptr is a non-empty float64 as a pointer. It is deliberately not a "0 becomes
// nil" helper: a real 0 (an empty block's gas utilisation) must survive.
func ptr(f float64) *float64 { return &f }
