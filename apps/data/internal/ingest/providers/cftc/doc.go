// Package cftc is the CFTC Commitments of Traders provider adapter: the
// weekly positioning series from the Legacy Futures Only report, delivered
// through CFTC's public Socrata endpoint, and the asset/series upserts the
// rows imply.
//
// Endpoint (public, keyless):
//
//	cot  GET https://publicreporting.cftc.gov/resource/6dca-aqww.json
//	     ?$select=<cotFields>&$limit=50000&$offset=<cursor>   (Socrata SoQL paging)
//
// Wire shape: a JSON array of report rows. The fields this adapter reads are
// strings on the wire, even the numerics ("open_interest_all":"287046"):
//
//	{"market_and_exchange_names":"WHEAT-SRW - CHICAGO BOARD OF TRADE",
//	 "report_date_as_yyyy_mm_dd":"2022-09-13T00:00:00.000",
//	 "cftc_contract_market_code":"001602",
//	 "open_interest_all":"287046",
//	 "noncomm_positions_long_all":"88091", "noncomm_positions_short_all":"96219",
//	 "comm_positions_long_all":"119219",   "comm_positions_short_all":"106242"}
//
// The $select projection is load-bearing: the report carries 400+ columns,
// and an unprojected page would blow past the 64 MiB body cap and truncate
// mid-array — a 200 whose JSON just ends. Bodies that reach the cap are a
// loud shape HardError, never a truncated parse.
//
// Positioning is canon series data only: domain "positioning", subject
// asset:<asset_id>, one observation per metric per report week. Open interest
// rides the same series path (cot_open_interest); the derivatives open_interest
// table is untouched, because a COT row is a positioning statistic about an
// asset, not a per-venue derivative snapshot. Contract names this adapter
// cannot resolve to a tracked asset are counted as rejected rows, not faked.
package cftc
