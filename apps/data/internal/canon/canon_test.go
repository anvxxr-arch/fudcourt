package canon

import (
	"strings"
	"testing"
	"time"
)

// TestMintIDDeterministic proves the rule is a pure function: the same inputs
// mint the same id, every time, in any order.
func TestMintIDDeterministic(t *testing.T) {
	const (
		kind = KindInstrument
		key  = "instrument/binance/linear_perp/BTC/USDT"
	)
	first := MintID(kind, key)
	for call := range 100 {
		if got := MintID(kind, key); got != first {
			t.Fatalf("MintID is not deterministic: call %d gave %q, first gave %q", call, got, first)
		}
	}
	if got := MintIDWithSalt(kind, key, Salt); got != first {
		t.Fatalf("MintIDWithSalt(Salt) = %q, MintID = %q: the default salt is not the documented one", got, first)
	}
}

// TestMintIDShape pins the visible shape: kind prefix, colon, IDHexLen lowercase
// hex digits, nothing else.
func TestMintIDShape(t *testing.T) {
	id := MintID(KindSeries, "series/macro/cpi/country:us")
	if !strings.HasPrefix(id, "series:") {
		t.Fatalf("id %q does not carry its kind prefix", id)
	}
	rest := id[len("series:"):]
	if len(rest) != IDHexLen {
		t.Fatalf("id %q carries %d hex digits, want %d", id, len(rest), IDHexLen)
	}
	for _, c := range rest {
		isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')
		if !isHex {
			t.Fatalf("id %q carries non-lowercase-hex digit %q", id, c)
		}
	}
	// Every kind mints into its own namespace.
	for _, k := range EntityKinds {
		got := MintID(k, "x")
		if prefix := Kind(got); prefix != string(k) {
			t.Errorf("kind %s minted id %q with prefix %q", k, got, prefix)
		}
		if !k.Valid() {
			t.Errorf("kind %s in EntityKinds reports invalid", k)
		}
	}
	// Kind() classifies, it does not validate: a colonless string comes back
	// whole, a prefixed one is split at the FIRST colon.
	if got := Kind("nocolon"); got != "nocolon" {
		t.Errorf("Kind(colonless) = %q, want the string whole", got)
	}
	if got := Kind("a:b:c"); got != "a" {
		t.Errorf("Kind(a:b:c) = %q, want %q", got, "a")
	}
}

// TestSaltChangesIDs proves the salt is hashed, not decorative: a different
// salt must change every id.
func TestSaltChangesIDs(t *testing.T) {
	cases := []struct {
		kind EntityKind
		key  string
	}{
		{KindAsset, "asset/fiat/USD"},
		{KindChain, "chain/ethereum"},
		{KindToken, "token/ethereum/0xABC"},
		{KindVenue, "venue/binance"},
		{KindInstrument, "instrument/bybit/linear_perp/BTC/USDT"},
		{KindProtocol, "protocol/aave"},
		{KindSeries, "series/macro/cpi/country:us"},
	}
	for _, c := range cases {
		base := MintIDWithSalt(c.kind, c.key, Salt)
		alt := MintIDWithSalt(c.kind, c.key, "fudcourt/canonical-reference/v2")
		if base == alt {
			t.Errorf("%s/%s: changing the salt did not change the id", c.kind, c.key)
		}
		// The kind and natural key feed the hash too: either changing moves
		// the id. (Same salt, different key -> different id.)
		if other := MintID(c.kind, c.key+"x"); other == base {
			t.Errorf("%s: changing the natural key did not change the id", c.kind)
		}
	}
}

// TestInstrumentKeySegments walks the segment rules: casing, market type,
// trailing segments only when they exist, strike zero-trimming, UTC expiry.
func TestInstrumentKeySegments(t *testing.T) {
	// Spot: stops at the quote symbol.
	spot := InstrumentRef{VenueID: "Binance", MarketType: "spot", Base: "btc", Quote: "usdt"}
	if got, want := InstrumentKey(spot), "instrument/binance/spot/BTC/USDT"; got != want {
		t.Errorf("spot key = %q, want %q", got, want)
	}
	// Dated future: adds the YYYYMMDD segment (UTC, not local).
	exp := time.Date(2026, 3, 26, 0, 0, 0, 0, time.UTC)
	fut := InstrumentRef{VenueID: "Bybit", MarketType: "linear_perp", Base: "BTC", Quote: "USDT", Expiry: &exp}
	const futureKey = "instrument/bybit/linear_perp/BTC/USDT/20260326"
	if got, want := InstrumentKey(fut), futureKey; got != want {
		t.Errorf("future key = %q, want %q", got, want)
	}
	// The same future minted from a non-UTC clock must land on the same day:
	// 2026-03-27 01:00 +08:00 is still 2026-03-26 UTC.
	expTZ := time.Date(2026, 3, 27, 1, 0, 0, 0, time.FixedZone("+0800", 8*3600))
	futTZ := fut
	futTZ.Expiry = &expTZ
	if got := InstrumentKey(futTZ); got != futureKey {
		t.Errorf("future key from +08:00 clock = %q, want %q", got, futureKey)
	}
	// Option: strike, expiry, option type; the strike loses trailing zeros.
	strike := 65000.5
	opt := InstrumentRef{VenueID: "bybit", MarketType: "linear_perp", Base: "BTC", Quote: "USDT",
		Expiry: &exp, Strike: &strike, OptionType: "c"}
	if got, want := InstrumentKey(opt), "instrument/bybit/linear_perp/BTC/USDT/65000.5/20260326/C"; got != want {
		t.Errorf("option key = %q, want %q", got, want)
	}
	// "65000.50" is the same price as "65000.5" and must mint the same key.
	strike2 := 65000.50
	opt2 := opt
	opt2.Strike = &strike2
	if got := InstrumentKey(opt2); got != InstrumentKey(opt) {
		t.Errorf("strike 65000.50 minted %q, 65000.5 minted %q", got, InstrumentKey(opt))
	}
	// Integral strikes keep no decimal point.
	iStrike := 65000.0
	optI := opt
	optI.Strike = &iStrike
	if got, want := InstrumentKey(optI), "instrument/bybit/linear_perp/BTC/USDT/65000/20260326/C"; got != want {
		t.Errorf("integral strike key = %q, want %q", got, want)
	}
	// Strike without expiry is its own (dated-less) branch: the strike segment
	// still appears, in the fixed order.
	strikeOnly := InstrumentRef{VenueID: "bybit", MarketType: "linear_perp", Base: "BTC", Quote: "USDT", Strike: &strike}
	if got, want := InstrumentKey(strikeOnly), "instrument/bybit/linear_perp/BTC/USDT/65000.5"; got != want {
		t.Errorf("strike-only key = %q, want %q", got, want)
	}
	// Distinct coordinates must not collide.
	if InstrumentKey(spot) == InstrumentKey(fut) {
		t.Fatal("spot and dated future minted the same natural key")
	}
	if InstrumentKey(opt) == InstrumentKey(optI) {
		t.Fatal("65000.5 and 65000 minted the same natural key")
	}
}

// TestValidateTimeframe is the closed-vocabulary table: exactly the documented
// set is true, near-misses are false.
func TestValidateTimeframe(t *testing.T) {
	valid := []string{
		"tick", "1s", "1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M",
		"quarterly", "annual", "event",
	}
	for _, tf := range valid {
		if !ValidateTimeframe(tf) {
			t.Errorf("ValidateTimeframe(%q) = false, want true", tf)
		}
	}
	invalid := []string{
		"", " ", "TICK", "1M ", "1mm", "60m", "24h", "7d", "1y", "monthly",
		"2m", "tick ", "\t1d", "1m,5m", "1MM", "1mn",
	}
	for _, tf := range invalid {
		if ValidateTimeframe(tf) {
			t.Errorf("ValidateTimeframe(%q) = true, want false", tf)
		}
	}
	// The case trap is load-bearing: 1M (month) and 1m (minute) are different
	// frames and both valid - but nothing else case-variant is.
	if !ValidateTimeframe("1m") || !ValidateTimeframe("1M") {
		t.Fatal("1m/1M pair must both be valid")
	}
}

// TestSeriesKeyLowercasing proves the subject key is lowercased (a series
// about "US" and one about "us" are the same series) while domain and metric
// pass through as given - they are the caller's vocabulary.
func TestSeriesKeyLowercasing(t *testing.T) {
	cases := []struct {
		domain, metric, subject, want string
	}{
		{"macro", "cpi", "country:US", "series/macro/cpi/country:us"},
		{"macro", "gdp", "country:Br", "series/macro/gdp/country:br"},
		{"market", "price", "asset:asset:d40acc5bec", "series/market/price/asset:asset:d40acc5bec"},
		{"market", "price", "GLOBAL", "series/market/price/global"},
		{"onchain", "tvl", "Chain:Solana", "series/onchain/tvl/chain:solana"},
	}
	for _, c := range cases {
		got := SeriesKey(c.domain, c.metric, c.subject)
		if got != c.want {
			t.Errorf("SeriesKey(%q, %q, %q) = %q, want %q", c.domain, c.metric, c.subject, got, c.want)
		}
	}
	// The two spellings mint ONE id.
	if MintID(KindSeries, SeriesKey("macro", "cpi", "country:US")) !=
		MintID(KindSeries, SeriesKey("macro", "cpi", "country:us")) {
		t.Fatal("US and us minted different series ids")
	}
}

// TestKeyBuilderCasing pins the per-builder normalization rules in one place:
// which argument is uppercased, which lowercased, which passes through
// verbatim.
func TestKeyBuilderCasing(t *testing.T) {
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"AssetKey uppercases and trims", AssetKey(AssetNative, " eth "), "asset/native/ETH"},
		{"TokenKey lowercases chain, keeps address verbatim",
			TokenKey(" Ethereum ", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
			"token/ethereum/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"},
		{"ChainKey lowercases", ChainKey("Polygon"), "chain/polygon"},
		{"VenueKey lowercases", VenueKey("Binance"), "venue/binance"},
		{"ProtocolKey lowercases", ProtocolKey("Aave"), "protocol/aave"},
		{"CountryKey uppercases", CountryKey("br"), "country/BR"},
		{"CurrencyKey uppercases", CurrencyKey("usd"), "currency/USD"},
		{"ArticleKey lowercases provider, keeps id verbatim",
			ArticleKey(" CryptoRank ", "art-42"), "article/cryptorank/art-42"},
		{"PoolKey lowercases chain, keeps address verbatim",
			PoolKey("Base", "0xABC"), "pool/base/0xABC"},
		{"PredictKey lowercases provider, keeps id verbatim",
			PredictKey(" PolyMarket ", "559651"), "prediction/polymarket/559651"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, c.got, c.want)
		}
	}
}

// TestPinnedMintIDs pins a few full-rule outputs (computed independently of
// this package, from the one-line rule) so a refactor of the hashing itself
// cannot move ids silently. The parity test covers the existing kinds against
// the artifact; these extend the pin to the new kinds.
func TestPinnedMintIDs(t *testing.T) {
	cases := []struct {
		kind EntityKind
		key  string
		want string
	}{
		{KindSeries, "series/macro/cpi/country:us", "series:41f42b07d3"},
		{KindInstrument, "instrument/bybit/linear_perp/BTC/USDT/20260326/65000.5/C", "instrument:67fe47d605"},
		{KindPool, "pool/base/0xabc", "pool:4abbf42ab2"},
		{KindCountry, "country/BR", "country:8344473ad5"},
		{KindPrediction, "prediction/polymarket/559651", "prediction:e9cd091293"},
	}
	for _, c := range cases {
		if got := MintID(c.kind, c.key); got != c.want {
			t.Errorf("MintID(%s, %q) = %q, pinned %q", c.kind, c.key, got, c.want)
		}
	}
}
