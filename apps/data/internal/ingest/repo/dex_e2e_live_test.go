//go:build live

// Live end-to-end test for the DEX storage layer: it creates the data.dex_*
// tables IN THE TRANSACTION (Postgres DDL is transactional), writes every DEX
// fact type through the real repo, and reads them back — proving the exact
// numeric mapping (canon.Dec <-> numeric, canon.TokenAmount <-> numeric+int)
// works against the real database, not just against the pgx type map.
//
// SAFETY: the entire test runs inside one transaction that is ALWAYS rolled
// back, so neither the DDL it applies nor any row it writes can persist. It
// refuses to run unless the caller opts in explicitly:
//
//	FUDCOURT_DEX_E2E_PG_URL=<dsn> FUDCOURT_DEX_E2E_ALLOW=1 \
//	  go test -tags live ./apps/data/internal/ingest/repo/ -run TestLiveE2EDex -v
package repo_test

import (
	"context"
	"math/big"
	"os"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest/repo"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// dexE2EDDL is the DDL the test needs, extracted verbatim-in-shape from the
// tracked schema's DEX block. It is applied inside the rolled-back transaction
// so the test is self-contained against a database that predates the DEX
// tables. The tracked schema remains the sole owner of the real DDL.
const dexE2EDDL = `
CREATE SCHEMA IF NOT EXISTS data;
CREATE TABLE IF NOT EXISTS data.dex_deployment (
  deployment_id text PRIMARY KEY, natural_key text NOT NULL, protocol_id text NOT NULL,
  chain_id text NOT NULL, factory text, router text, other_contracts jsonb, address_kind text,
  source text NOT NULL, retrieved_at timestamptz);
CREATE TABLE IF NOT EXISTS data.dex_swap (
  swap_id text NOT NULL, natural_key text NOT NULL, pool_id text NOT NULL, chain_id text NOT NULL,
  tx_hash text NOT NULL, log_index int NOT NULL, block_number bigint, tx_index int, trader text,
  sender text, token_in text NOT NULL, token_out text NOT NULL, amount_in_raw numeric NOT NULL,
  amount_in_decimals int NOT NULL, amount_out_raw numeric NOT NULL, amount_out_decimals int NOT NULL,
  amount_usd numeric, side text, source text NOT NULL, event_time timestamptz NOT NULL,
  retrieved_at timestamptz, PRIMARY KEY (swap_id, event_time),
  UNIQUE (chain_id, tx_hash, log_index, event_time));
CREATE TABLE IF NOT EXISTS data.dex_candle (
  candle_id text NOT NULL, natural_key text NOT NULL, pool_id text NOT NULL, chain_id text NOT NULL,
  interval text NOT NULL, open_time timestamptz NOT NULL, close_time timestamptz,
  o numeric NOT NULL, h numeric NOT NULL, l numeric NOT NULL, c numeric NOT NULL,
  volume_base numeric, volume_quote numeric, volume_usd numeric, trade_count bigint, vwap numeric,
  source text NOT NULL, retrieved_at timestamptz, PRIMARY KEY (candle_id, open_time),
  UNIQUE (pool_id, interval, open_time));
CREATE TABLE IF NOT EXISTS data.dex_market_snapshot (
  snapshot_id text NOT NULL, natural_key text NOT NULL, pool_id text NOT NULL, chain_id text NOT NULL,
  at timestamptz NOT NULL, price_usd numeric, price_native numeric, volume_24h_usd numeric,
  txns_24h bigint, buys_24h bigint, sells_24h bigint, price_change_pct_24h numeric, fdv_usd numeric,
  market_cap_usd numeric, fee_tier_bps int, source text NOT NULL, retrieved_at timestamptz,
  PRIMARY KEY (snapshot_id, at), UNIQUE (pool_id, at));
CREATE TABLE IF NOT EXISTS data.dex_route_quote (
  quote_id text PRIMARY KEY, natural_key text NOT NULL UNIQUE, provider text NOT NULL,
  chain_id text NOT NULL, token_in text NOT NULL, token_out text NOT NULL,
  amount_in_raw numeric NOT NULL, amount_in_decimals int NOT NULL, amount_out_raw numeric NOT NULL,
  amount_out_decimals int NOT NULL, expected_output_usd numeric, gas_estimate_usd numeric,
  gas_estimate_raw numeric, gas_estimate_decimals int, price_impact_pct numeric, slippage_pct numeric,
  legs jsonb, quoted_at timestamptz NOT NULL, retrieved_at timestamptz);
CREATE TABLE IF NOT EXISTS data.dex_risk_metric (
  risk_id text NOT NULL, natural_key text NOT NULL, subject_key text NOT NULL, metric text NOT NULL,
  score numeric NOT NULL, band text, algorithm_version text NOT NULL, input_sources text[],
  at timestamptz NOT NULL, source text NOT NULL, PRIMARY KEY (risk_id, at), UNIQUE (natural_key, at));
CREATE TABLE IF NOT EXISTS data.dex_quality_status (
  subject_key text NOT NULL, dataset text NOT NULL, at timestamptz NOT NULL, state text NOT NULL,
  reasons text[], detail jsonb, PRIMARY KEY (subject_key, dataset, at));
CREATE TABLE IF NOT EXISTS data.pool (
  pool_id text NOT NULL, at timestamptz NOT NULL, chain_id text NOT NULL, dex_venue_id text,
  address text NOT NULL, base_asset_id text, quote_asset_id text, base_symbol text,
  quote_symbol text, fee_tier_bps int, price double precision, liquidity_usd double precision,
  volume_24h_usd double precision, fdv_usd double precision, source text NOT NULL,
  retrieved_at timestamptz, pool_created_at timestamptz,
  PRIMARY KEY (pool_id, at), UNIQUE (chain_id, address, at));
`

func TestLiveE2EDexStorage(t *testing.T) {
	dsn := os.Getenv("FUDCOURT_DEX_E2E_PG_URL")
	if dsn == "" {
		t.Skip("FUDCOURT_DEX_E2E_PG_URL unset")
	}
	if os.Getenv("FUDCOURT_DEX_E2E_ALLOW") != "1" {
		t.Skip("FUDCOURT_DEX_E2E_ALLOW != 1: refusing to touch a live database without explicit opt-in")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() {
		if err := tx.Rollback(ctx); err != nil && err != pgx.ErrTxClosed {
			t.Logf("rollback: %v", err)
		}
	}()

	if _, err := tx.Exec(ctx, dexE2EDDL); err != nil {
		t.Fatalf("apply DEX DDL: %v", err)
	}
	r := repo.New(txExec{tx: tx})
	now := time.Now().UTC()

	// --- swap with an exact 18-decimal amount and a decimal USD value --------
	raw, _ := new(big.Int).SetString("1500000000000000000", 10) // 1.5e18
	amt, err := canon.NewTokenAmount(raw, 18)
	if err != nil {
		t.Fatal(err)
	}
	usd, err := canon.DecFromString("4001.20")
	if err != nil {
		t.Fatal(err)
	}
	sw := canon.Swap{
		SwapID:     canon.MintID(canon.KindSwap, canon.SwapKey("ethereum", "0xdeadbeef", 3)),
		NaturalKey: canon.SwapKey("ethereum", "0xdeadbeef", 3),
		PoolID:     "pool:x", ChainID: "chain:eth", TxHash: "0xdeadbeef", LogIndex: 3,
		TokenIn: "token:weth", TokenOut: "token:usdc",
		AmountIn: amt, AmountOut: amt, AmountUSD: &usd,
		EventTime:  now,
		Provenance: canon.Provenance{SourceProvider: "test-dex", NormalizedAt: now},
	}
	written, rejected, err := r.WriteDexSwaps(ctx, []canon.Swap{sw})
	if err != nil || written != 1 || rejected != 0 {
		t.Fatalf("WriteDexSwaps: written=%d rejected=%d err=%v", written, rejected, err)
	}
	// Idempotent re-write (same chain/tx/log/time).
	if w2, _, err := r.WriteDexSwaps(ctx, []canon.Swap{sw}); err != nil || w2 != 1 {
		t.Fatalf("rewrite: w=%d err=%v", w2, err)
	}
	var count int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM data.dex_swap WHERE chain_id=$1 AND tx_hash=$2 AND log_index=$3`,
		"chain:eth", "0xdeadbeef", 3).Scan(&count); err != nil {
		t.Fatalf("count swaps: %v", err)
	}
	if count != 1 {
		t.Fatalf("swap rows = %d, want 1 (idempotency broken)", count)
	}

	// --- read the swap back and assert EXACT fidelity ------------------------
	swaps, err := r.ReadDexSwaps(ctx, "pool:x", time.Time{}, time.Time{}, 10)
	if err != nil {
		t.Fatalf("ReadDexSwaps: %v", err)
	}
	if len(swaps) != 1 {
		t.Fatalf("read swaps = %d, want 1", len(swaps))
	}
	if got := swaps[0].AmountIn.RawString(); got != "1500000000000000000" {
		t.Fatalf("amount_in raw = %q (precision lost)", got)
	}
	if got := swaps[0].AmountIn.Normalized().String(); got != "1.5" {
		t.Fatalf("amount_in normalized = %q, want 1.5", got)
	}
	if swaps[0].AmountUSD == nil || swaps[0].AmountUSD.String() != "4001.2" {
		t.Fatalf("amount_usd = %v, want 4001.2", swaps[0].AmountUSD)
	}

	// --- candle with exact decimals -----------------------------------------
	candle := canon.DexCandle{
		CandleID:   canon.MintID(canon.KindCandle, canon.CandleKey("pool:x", "1m", now.Unix())),
		NaturalKey: canon.CandleKey("pool:x", "1m", now.Unix()),
		PoolID:     "pool:x", ChainID: "chain:eth", Interval: "1m",
		OpenTime: now.Truncate(time.Minute), CloseTime: now,
		Open: usd, High: usd, Low: usd, Close: usd,
		Provenance: canon.Provenance{SourceProvider: "test-dex", NormalizedAt: now},
	}
	if w, rej, err := r.WriteDexCandles(ctx, []canon.DexCandle{candle}); err != nil || w != 1 || rej != 0 {
		t.Fatalf("WriteDexCandles: w=%d rej=%d err=%v", w, rej, err)
	}
	candles, err := r.ReadDexCandles(ctx, "pool:x", "1m", time.Time{}, time.Time{}, 10)
	if err != nil || len(candles) != 1 {
		t.Fatalf("ReadDexCandles: n=%d err=%v", len(candles), err)
	}
	if candles[0].Close.String() != "4001.2" {
		t.Fatalf("candle close = %q", candles[0].Close.String())
	}

	// --- route quote (legs jsonb) -------------------------------------------
	q := canon.RouteQuote{
		QuoteID: "quote:1", NaturalKey: canon.RouteQuoteKey("jupiter", "token:a", "token:b", "1000000"),
		Provider: "jupiter", ChainID: "chain:sol", TokenIn: "token:a", TokenOut: "token:b",
		AmountIn: amt, AmountOut: amt, QuotedAt: now,
		Provenance: canon.Provenance{SourceProvider: "jupiter", NormalizedAt: now},
	}
	if w, rej, err := r.WriteDexRouteQuotes(ctx, []canon.RouteQuote{q}); err != nil || w != 1 || rej != 0 {
		t.Fatalf("WriteDexRouteQuotes: w=%d rej=%d err=%v", w, rej, err)
	}
	quotes, err := r.ReadDexRouteQuotes(ctx, "chain:sol", "token:a", "token:b", 10)
	if err != nil || len(quotes) != 1 {
		t.Fatalf("ReadDexRouteQuotes: n=%d err=%v", len(quotes), err)
	}
	if quotes[0].AmountOut.RawString() != "1500000000000000000" {
		t.Fatalf("quote amount_out = %q", quotes[0].AmountOut.RawString())
	}

	// --- risk metric (versioned) --------------------------------------------
	score, _ := canon.DecFromString("0.87")
	rm := canon.RiskMetric{
		RiskID: "risk:1", NaturalKey: canon.RiskMetricKey("pool:x", "wash_trading", "v1"),
		SubjectKey: "pool:x", Metric: "wash_trading", At: now, Score: score,
		AlgorithmVersion: "v1", Provenance: canon.Provenance{SourceProvider: "test-dex"},
	}
	if w, rej, err := r.WriteDexRiskMetrics(ctx, []canon.RiskMetric{rm}); err != nil || w != 1 || rej != 0 {
		t.Fatalf("WriteDexRiskMetrics: w=%d rej=%d err=%v", w, rej, err)
	}
	risks, err := r.ReadDexRiskMetrics(ctx, "pool:x", "wash_trading", time.Time{}, time.Time{}, 10)
	if err != nil || len(risks) != 1 || risks[0].Score.String() != "0.87" {
		t.Fatalf("ReadDexRiskMetrics: n=%d score=%v err=%v", len(risks), risks, err)
	}

	// --- quality status ------------------------------------------------------
	qs := dexstore.QualityStatus{SubjectKey: "pool:x", Dataset: "swaps", AtUnix: now.Unix(),
		State: "healthy", Reasons: []string{"ok"}}
	if w, rej, err := r.WriteQualityStatus(ctx, []dexstore.QualityStatus{qs}); err != nil || w != 1 || rej != 0 {
		t.Fatalf("WriteQualityStatus: w=%d rej=%d err=%v", w, rej, err)
	}
	// An invalid state must be REJECTED, not stored.
	bad := dexstore.QualityStatus{SubjectKey: "pool:y", Dataset: "swaps", AtUnix: now.Unix(), State: "bogus"}
	if w, rej, err := r.WriteQualityStatus(ctx, []dexstore.QualityStatus{bad}); err != nil || w != 0 || rej != 1 {
		t.Fatalf("bogus state: w=%d rej=%d err=%v (must reject)", w, rej, err)
	}

	// --- deployment entity ---------------------------------------------------
	dep := canon.DexDeployment{
		DeploymentID: canon.MintID(canon.KindDeployment, canon.DeploymentKey("ethereum", "uniswap-v3")),
		NaturalKey:   canon.DeploymentKey("ethereum", "uniswap-v3"),
		ProtocolID:   "protocol:uni", ChainID: "chain:eth", Factory: "0xfactory",
		OtherContracts: map[string]string{"quoter": "0xq"},
		Provenance:     canon.Provenance{SourceProvider: "test-dex", NormalizedAt: now},
	}
	if n, err := r.UpsertDexDeployments(ctx, []canon.DexDeployment{dep}); err != nil || n != 1 {
		t.Fatalf("UpsertDexDeployments: n=%d err=%v", n, err)
	}
	deps, err := r.ListDexDeployments(ctx, "protocol:uni", 10)
	if err != nil || len(deps) != 1 || deps[0].OtherContracts["quoter"] != "0xq" {
		t.Fatalf("ListDexDeployments: n=%d err=%v", len(deps), err)
	}

	t.Logf("DEX storage round-trip OK: swap/candle/quote/risk/quality/deployment, exact numerics preserved")

	// --- pool symbols: the projection must match scanPool's 17 targets ------
	bs, qsym := "WETH", "USDC"
	price := 4001.2
	liq := 1_000_000.0
	created := now.Add(-48 * time.Hour)
	pw := []canon.Pool{{
		PoolID: "pool:uni", At: now, ChainID: "chain:eth", DEXVenueID: "venue:uniswap",
		Address: "0xpool", BaseSymbol: &bs, QuoteSymbol: &qsym,
		Price: &price, LiquidityUSD: &liq, Source: "test-dex",
		PoolCreatedAt: &created,
	}}
	if w, rej, err := r.WritePools(ctx, pw); err != nil || w != 1 || rej != 0 {
		t.Fatalf("WritePools: w=%d rej=%d err=%v", w, rej, err)
	}
	pools, err := r.ListPools(ctx, canon.PoolQuery{ChainID: "chain:eth", Limit: 10})
	if err != nil {
		t.Fatalf("ListPools (projection/scan mismatch?): %v", err)
	}
	if len(pools) != 1 {
		t.Fatalf("ListPools n=%d, want 1", len(pools))
	}
	if pools[0].BaseSymbol == nil || *pools[0].BaseSymbol != "WETH" ||
		pools[0].QuoteSymbol == nil || *pools[0].QuoteSymbol != "USDC" {
		t.Fatalf("pool symbols lost: base=%v quote=%v", pools[0].BaseSymbol, pools[0].QuoteSymbol)
	}
	// The pool's own creation time is pool metadata, not a row timestamp: it
	// must survive the round trip intact (a nil here would silently age every
	// pool to 1970 in a consumer that trusts it).
	if pools[0].PoolCreatedAt == nil || !pools[0].PoolCreatedAt.Equal(created) {
		t.Fatalf("pool created_at lost: %v, want %v", pools[0].PoolCreatedAt, created)
	}
	// The DEX pool reads must scan the same 17 columns.
	dexPools, err := r.ListDexPools(ctx, dexstore.DexPoolQuery{ChainID: "chain:eth", Limit: 10})
	if err != nil {
		t.Fatalf("ListDexPools: %v", err)
	}
	if len(dexPools) != 1 || dexPools[0].BaseSymbol == nil || *dexPools[0].BaseSymbol != "WETH" {
		t.Fatalf("ListDexPools symbols wrong: %+v", dexPools)
	}
	if _, ok, err := r.GetDexPool(ctx, "pool:uni"); err != nil || !ok {
		t.Fatalf("GetDexPool: ok=%v err=%v", ok, err)
	}
	if _, err := r.ListDexRankings(ctx, dexstore.DexRankingQuery{ChainID: "chain:eth", Sort: "volume", Limit: 10}); err != nil {
		t.Fatalf("ListDexRankings: %v", err)
	}
	t.Logf("pool symbol projection OK across ListPools/ListDexPools/GetDexPool/ListDexRankings")
}
