// Package derive computes derived analytics (indicators and quant metrics)
// from canonical series and lands them in the data.metric hypertable via
// canon.Writer.WriteMetric. It is kept strictly separate from raw provider
// data: raw observations stay in the ingest tables, derived series are minted
// with is_derived = true, source "derived" and schema version v1.
//
// The unit of work is the Processor: a pure function over normalized input
// points. A Registry maps metric names to Processors; a Pipeline reads one
// source series, runs the registered processor and writes the result to
// derived series under data.metric. NaN heads (windows not yet full) are
// stored as NULL values, never 0.
//
// Nothing in this package schedules itself: there are no jobs, tickers or
// engine modules here. The orchestrator wires a Pipeline with a canon.Reader,
// a canon.Writer and a Registry and calls Pipeline.Run explicitly.
package derive
