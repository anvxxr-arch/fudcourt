package instruments

import (
	"errors"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/markets/reference"
	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

// mustRegistry builds the canonical reference registry. A failure here fails
// every test below, so it is fatal rather than t.Errorf: a broken reference
// registry means the minter cannot be tested at all.
func mustRegistry(t *testing.T) *reference.Reference {
	t.Helper()
	ref, err := reference.Build()
	if err != nil {
		t.Fatalf("reference.Build() failed: %v", err)
	}
	return ref
}

// instrumentFixture is one venue-spelled market. Every test builds its inputs
// from these so the tests exercise the same shape a real producer would hand in.
func instrumentFixture(t *testing.T, exchange, venueSymbol string, marketType MarketType) Instrument {
	t.Helper()
	return Instrument{
		Exchange:       exchange,
		ExchangeSymbol: venueSymbol,
		MarketType:     marketType,
		BaseAsset:      "ETH",
		QuoteAsset:     "USDT",
		TickSize:       "0.01",
		QuantityStep:   "0.0001",
		ContractSize:   "1",
	}
}

// TestResolveInstrumentTwoSpellingsOneID is the property the whole change
// exists for: two venues' spellings of the SAME market must produce one
// canonical instrument id. If this fails, the canonical id is just a rename of
// the spelling form and closes nothing.
func TestResolveInstrumentTwoSpellingsOneID(t *testing.T) {
	ref := mustRegistry(t)

	// binance spells it concatenated; the executor and ccxt spell the same
	// market `ETH/USDT` / `ETH/USDT:USDT`. All three are ETH/USDT spot on Binance.
	spellings := []string{"ETHUSDT", "ETH/USDT", "ETH/USDT:USDT"}
	var ids []string
	for _, spelling := range spellings {
		got, err := ResolveInstrument(instrumentFixture(t, "binance", spelling, MarketTypeSpot), ref)
		if err != nil {
			t.Fatalf("ResolveInstrument(binance, %q) failed: %v", spelling, err)
		}
		ids = append(ids, got.InstrumentID)
	}
	for i := 1; i < len(ids); i++ {
		if ids[i] != ids[0] {
			t.Errorf("spelling %q minted %s but %q minted %s; one market must be one id",
				spellings[i], ids[i], spellings[0], ids[0])
		}
	}
	if !strings.HasPrefix(ids[0], InstrumentKind+":") {
		t.Errorf("instrument id %q does not carry the %q namespace", ids[0], InstrumentKind)
	}
}

// TestResolveInstrumentDistinctMarketsDiffer proves the minter is not
// degenerate: every component of the preimage, changed alone, must produce a
// different id. A minter that ignored market type or settlement would still pass
// the two-spellings test above.
func TestResolveInstrumentDistinctMarketsDiffer(t *testing.T) {
	ref := mustRegistry(t)

	cases := []struct {
		name  string
		build func(t *testing.T) Instrument
	}{
		{"spot", func(t *testing.T) Instrument {
			return instrumentFixture(t, "binance", "ETHUSDT", MarketTypeSpot)
		}},
		{"linear_perp", func(t *testing.T) Instrument {
			return instrumentFixture(t, "binance", "ETHUSDT", MarketTypeLinearPerp)
		}},
		{"other venue", func(t *testing.T) Instrument {
			return instrumentFixture(t, "mexc", "ETH_USDT", MarketTypeSpot)
		}},
		{"other quote", func(t *testing.T) Instrument {
			i := instrumentFixture(t, "binance", "ETHUSDC", MarketTypeSpot)
			i.QuoteAsset = "USDC"
			return i
		}},
		{"other base", func(t *testing.T) Instrument {
			i := instrumentFixture(t, "binance", "BNBUSDT", MarketTypeSpot)
			i.BaseAsset = "BNB"
			return i
		}},
	}

	seen := map[string]string{}
	for _, c := range cases {
		got, err := ResolveInstrument(c.build(t), ref)
		if err != nil {
			t.Fatalf("%s: ResolveInstrument failed: %v", c.name, err)
		}
		if prev, dup := seen[got.InstrumentID]; dup {
			t.Errorf("%s and %s minted the same id %s; a changed identity component must change the id", prev, c.name, got.InstrumentID)
		}
		seen[got.InstrumentID] = c.name
	}
}

// TestMintInstrumentIDIsDeterministic proves the mint is a pure function: same
// components, same id, regardless of how many times it is called and in what
// order - and that re-minting a value assembled BY HAND matches the value
// ResolveInstrument produced (so a consumer that stores only the components can
// rebuild the id).
func TestMintInstrumentIDIsDeterministic(t *testing.T) {
	ref := mustRegistry(t)
	resolved, err := ResolveInstrument(instrumentFixture(t, "binance", "ETHUSDT", MarketTypeSpot), ref)
	if err != nil {
		t.Fatalf("ResolveInstrument failed: %v", err)
	}

	for attempt := range 64 {
		got, err := MintInstrumentID(resolved.VenueID, resolved.MarketType,
			resolved.BaseAssetID, resolved.QuoteAssetID, resolved.SettlementAssetID)
		if err != nil {
			t.Fatalf("attempt %d: MintInstrumentID failed: %v", attempt, err)
		}
		if got != resolved.InstrumentID {
			t.Fatalf("attempt %d: MintInstrumentID = %s, want %s (the mint is not a pure function)", attempt, got, resolved.InstrumentID)
		}
	}

	// The order of independent mints must not matter either.
	others := []CanonicalInstrument{}
	for _, c := range []struct {
		exchange, symbol string
		mt               MarketType
	}{{"binance", "ETHUSDT", MarketTypeSpot}, {"mexc", "ETH_USDT", MarketTypeSpot}, {"binance", "ETHUSDT", MarketTypeLinearPerp}} {
		r, err := ResolveInstrument(instrumentFixture(t, c.exchange, c.symbol, c.mt), ref)
		if err != nil {
			t.Fatalf("ResolveInstrument(%s, %s) failed: %v", c.exchange, c.symbol, err)
		}
		others = append(others, r)
	}
	forward := map[string]string{}
	for _, o := range others {
		id, err := MintFor(o)
		if err != nil {
			t.Fatalf("MintFor failed: %v", err)
		}
		forward[o.InstrumentID] = id
	}
	for i := len(others) - 1; i >= 0; i-- {
		o := others[i]
		id, err := MintFor(o)
		if err != nil {
			t.Fatalf("MintFor (reverse) failed: %v", err)
		}
		if forward[o.InstrumentID] != id {
			t.Errorf("minting in reverse order changed the id for %s", o.InstrumentID)
		}
	}
}

// TestResolveInstrumentRefusesUnresolved proves the refusal contract: an unknown
// venue or an unknown base/quote asset is an explicit error, and NO partial id is
// produced. A "best effort" id here would be indistinguishable from a real one.
func TestResolveInstrumentRefusesUnresolved(t *testing.T) {
	ref := mustRegistry(t)

	if _, err := ResolveInstrument(instrumentFixture(t, "binance", "ETHUSDT", MarketTypeSpot), nil); !errors.Is(err, ErrInstrumentUnresolved) {
		t.Errorf("ResolveInstrument with a nil registry = %v, want ErrInstrumentUnresolved", err)
	}

	// Two layers refuse, and they refuse for different reasons. Testing them
	// apart is the point: the registry layer must produce THIS file's sentinels,
	// while the spelling layer answers with the package's pre-existing frozen
	// code, whose behaviour this change does not alter.
	t.Run("the spelling layer refuses before any registry lookup", func(t *testing.T) {
		cases := []struct {
			name string
			inst Instrument
		}{
			{"venue with no known symbol form", instrumentFixture(t, "not-a-venue", "NOTAVENUEUSDT", MarketTypeSpot)},
			{"symbol matching no quote asset", instrumentFixture(t, "binance", "ETH<>USDT", MarketTypeSpot)},
			{"unmodelled market type", instrumentFixture(t, "binance", "ETHUSDT", MarketType("options"))},
		}
		for _, c := range cases {
			got, err := ResolveInstrument(c.inst, ref)
			if err == nil {
				t.Errorf("%s: ResolveInstrument succeeded with id %s, want a refusal", c.name, got.InstrumentID)
				continue
			}
			var apiErr *errs.Error
			if !errors.As(err, &apiErr) || apiErr.Code != CodeSymbolUnknown {
				t.Errorf("%s: error = %v, want the frozen code %s", c.name, err, CodeSymbolUnknown)
			}
			if got.InstrumentID != "" {
				t.Errorf("%s: refusal still produced a partial id %q", c.name, got.InstrumentID)
			}
		}
	})

	t.Run("the registry layer refuses with this file's sentinels", func(t *testing.T) {
		cases := []struct {
			name string
			inst Instrument
		}{
			// binance's concatenated form splits on the USDT suffix, leaving a
			// base asset (ZZZ) that parses but has no canonical id.
			{"base asset has no canonical id", instrumentFixture(t, "binance", "ZZZUSDT", MarketTypeSpot)},
			// mexc's underscored form splits on the underscore, so the spelling
			// is well-formed and the QUOTE asset is what fails to resolve.
			{"quote asset has no canonical id", instrumentFixture(t, "mexc", "ETH_ZZZ", MarketTypeSpot)},
		}
		for _, c := range cases {
			got, err := ResolveInstrument(c.inst, ref)
			if !errors.Is(err, ErrInstrumentUnresolved) {
				t.Errorf("%s: error = %v, want ErrInstrumentUnresolved", c.name, err)
			}
			if got.InstrumentID != "" {
				t.Errorf("%s: refusal still produced a partial id %q", c.name, got.InstrumentID)
			}
		}
	})
}

// TestResolveInstrumentRefusesMalformedComponents proves a hand-assembled
// CanonicalInstrument cannot smuggle a symbol (or any non-id) into the preimage:
// every identity field is shape-checked before it is hashed.
func TestResolveInstrumentRefusesMalformedComponents(t *testing.T) {
	ref := mustRegistry(t)
	base, err := ResolveInstrument(instrumentFixture(t, "binance", "ETHUSDT", MarketTypeSpot), ref)
	if err != nil {
		t.Fatalf("fixture failed: %v", err)
	}

	mutations := map[string]func(*CanonicalInstrument){
		"venue id is a slug":         func(c *CanonicalInstrument) { c.VenueID = "binance" },
		"venue id is another kind":   func(c *CanonicalInstrument) { c.VenueID = c.BaseAssetID },
		"asset id is a symbol":       func(c *CanonicalInstrument) { c.BaseAssetID = "ETH" },
		"settlement id is empty":     func(c *CanonicalInstrument) { c.SettlementAssetID = "" },
		"asset id is not hex":        func(c *CanonicalInstrument) { c.QuoteAssetID = "asset:zzzzzzzzzz" },
		"asset id is the wrong size": func(c *CanonicalInstrument) { c.QuoteAssetID = "asset:abc" },
	}
	for name, mutate := range mutations {
		c := base
		mutate(&c)
		if _, err := MintFor(c); err == nil {
			t.Errorf("%s: MintFor accepted a malformed identity", name)
		} else if !errors.Is(err, ErrInstrumentMalformed) {
			t.Errorf("%s: error = %v, want ErrInstrumentMalformed", name, err)
		}
	}
}

// TestInstrumentIDGoldenVector pins the exact preimage. A change to the
// separators, the salt, the namespace or the truncation length changes every id
// in the system, and that MUST be a deliberate, versioned decision rather than a
// silent edit - which is what this vector detects.
//
// The value was computed independently (sha256 over
// "fudcourt/canonical-instrument/v1" NUL "instrument" NUL
// "instrument/venue:a8792f9e11/spot/asset:d40acc5bec/asset:36fac0c5f6/asset:d40acc5bec")
// before this test was written; it is not a copy of this package's own output.
func TestInstrumentIDGoldenVector(t *testing.T) {
	ref := mustRegistry(t)

	// Resolve the identifiers through the registry rather than hard-coding them,
	// so this test fails loudly if the registry re-mints an id, instead of
	// silently pinning a stale pair.
	venueID := mustInternalVenue(t, ref, "binance")
	ethID := mustAssetSymbol(t, ref, "ETH")
	usdtID := mustAssetSymbol(t, ref, "USDT")
	if venueID != "venue:a8792f9e11" || ethID != "asset:d40acc5bec" || usdtID != "asset:36fac0c5f6" {
		t.Fatalf("reference ids moved: venue=%s eth=%s usdt=%s; the golden vector below is only valid for the pinned registry",
			venueID, ethID, usdtID)
	}

	got, err := ResolveInstrument(instrumentFixture(t, "binance", "ETHUSDT", MarketTypeSpot), ref)
	if err != nil {
		t.Fatalf("ResolveInstrument failed: %v", err)
	}

	want := "instrument:aed45391cb"
	if got.InstrumentID != want {
		t.Errorf("binance spot ETH/USDT minted %s, want the pinned %s", got.InstrumentID, want)
	}

	key, err := got.NaturalKey()
	if err != nil {
		t.Fatalf("NaturalKey failed: %v", err)
	}
	wantKey := "instrument/venue:a8792f9e11/spot/asset:d40acc5bec/asset:36fac0c5f6/asset:d40acc5bec"
	if key != wantKey {
		t.Errorf("natural key = %q, want the pinned %q", key, wantKey)
	}
}

// TestCanonicalAndLegacyIDSpacesNeverCollide proves the legacy spelling and the
// canonical id are different things and stay that way: the legacy form is
// reproduced byte-for-byte, it is parseable, the canonical id deliberately is
// NOT, and neither is ever mistaken for the other.
func TestCanonicalAndLegacyIDSpacesNeverCollide(t *testing.T) {
	ref := mustRegistry(t)
	i := instrumentFixture(t, "binance", "ETHUSDT", MarketTypeSpot)

	// The legacy form is preserved exactly as instrument_test.go pins it.
	legacy, err := MintLegacyInstrumentID("binance", MarketTypeSpot, "BTC/USDT")
	if err != nil {
		t.Fatalf("MintLegacyInstrumentID failed: %v", err)
	}
	if legacy != "binance:spot:BTC/USDT" {
		t.Errorf("legacy id = %q, want %q", legacy, "binance:spot:BTC/USDT")
	}
	if _, err := ParseInstrumentSpelling(legacy); err != nil {
		t.Errorf("the legacy form did not round-trip through ParseInstrumentSpelling: %v", err)
	}

	// SpellingFor must agree with it for the same instrument.
	got, err := SpellingFor(i)
	if err != nil {
		t.Fatalf("SpellingFor failed: %v", err)
	}
	if got.String() != "binance:spot:ETH/USDT" {
		t.Errorf("SpellingFor = %q, want %q", got.String(), "binance:spot:ETH/USDT")
	}

	canonical, err := ResolveInstrument(i, ref)
	if err != nil {
		t.Fatalf("ResolveInstrument failed: %v", err)
	}
	if canonical.InstrumentID == legacy || canonical.InstrumentID == got.String() {
		t.Fatalf("the canonical id %s equals a spelling-form id", canonical.InstrumentID)
	}
	// A canonical id is NOT a spelling, and parsing it as one must fail rather
	// than quietly produce a nonsense instrument.
	if _, err := ParseInstrumentSpelling(canonical.InstrumentID); err == nil {
		t.Errorf("ParseInstrumentSpelling accepted the canonical id %s", canonical.InstrumentID)
	}
	// The reverse: a spelling must never be accepted where an id is expected.
	if err := checkID("id", reference.EntityKind(InstrumentKind), got.String()); err == nil {
		t.Errorf("checkID accepted the spelling %s as a canonical instrument id", got.String())
	}
}

// TestExchangeSymbolInvertsResolution proves the round trip back to the venue's
// own spelling, and that a value missing its resolved symbols refuses rather
// than inventing one.
func TestExchangeSymbolInvertsResolution(t *testing.T) {
	ref := mustRegistry(t)

	for _, c := range []struct {
		exchange, venueSymbol string
		mt                    MarketType
		want                  string
	}{
		{"binance", "ETHUSDT", MarketTypeSpot, "ETHUSDT"},
		{"bybit", "ETHUSDT", MarketTypeSpot, "ETHUSDT"},
		{"mexc", "ETH_USDT", MarketTypeSpot, "ETH_USDT"},
	} {
		got, err := ResolveInstrument(instrumentFixture(t, c.exchange, c.venueSymbol, c.mt), ref)
		if err != nil {
			t.Fatalf("ResolveInstrument(%s, %s) failed: %v", c.exchange, c.venueSymbol, err)
		}
		spelling, err := got.ExchangeSymbol()
		if err != nil {
			t.Fatalf("ExchangeSymbol(%s) failed: %v", c.exchange, err)
		}
		if spelling != c.want {
			t.Errorf("%s: ExchangeSymbol = %q, want %q", c.exchange, spelling, c.want)
		}
	}

	// A hand-built identity with no resolved slug/symbols must refuse.
	bare := CanonicalInstrument{
		VenueID: "venue:a8792f9e11", MarketType: MarketTypeSpot,
		BaseAssetID: "asset:d40acc5bec", QuoteAssetID: "asset:36fac0c5f6", SettlementAssetID: "asset:d40acc5bec",
	}
	if _, err := bare.ExchangeSymbol(); !errors.Is(err, ErrInstrumentMalformed) {
		t.Errorf("ExchangeSymbol on a bare identity = %v, want ErrInstrumentMalformed", err)
	}
}

// TestSettlementIsCarriedInIdentity proves the settlement asset is part of the
// identity rather than a cosmetic field: an explicit settlement that differs
// from the market type's default mints a DIFFERENT id, because a USD-settled and
// a USDT-settled contract are different instruments (the basis between them is
// the whole reason the tree sweeps settlement as its own row).
func TestSettlementIsCarriedInIdentity(t *testing.T) {
	ref := mustRegistry(t)
	base, err := ResolveInstrument(instrumentFixture(t, "binance", "ETHUSDT", MarketTypeLinearPerp), ref)
	if err != nil {
		t.Fatalf("ResolveInstrument failed: %v", err)
	}

	usd := mustAssetSymbol(t, ref, "USD")
	usdc := mustAssetSymbol(t, ref, "USDC")

	settledUSDT, err := MintInstrumentID(base.VenueID, base.MarketType, base.BaseAssetID, base.QuoteAssetID, base.QuoteAssetID)
	if err != nil {
		t.Fatalf("MintInstrumentID(usdt) failed: %v", err)
	}
	if settledUSDT != base.InstrumentID {
		t.Errorf("explicit USDT settlement = %s, want the derived default %s", settledUSDT, base.InstrumentID)
	}

	for _, c := range []struct{ name, settlement string }{{"USD", usd}, {"USDC", usdc}} {
		other, err := MintInstrumentID(base.VenueID, base.MarketType, base.BaseAssetID, base.QuoteAssetID, c.settlement)
		if err != nil {
			t.Fatalf("MintInstrumentID(%s) failed: %v", c.name, err)
		}
		if other == base.InstrumentID {
			t.Errorf("%s settlement minted the same id %s as the default settlement", c.name, other)
		}
	}
}

// TestSpotSettlementDefaultIsBase proves the tree's own settlement rule is
// applied when the caller states none: spot settles in its base asset, a linear
// perpetual in its quote asset.
func TestSpotSettlementDefaultIsBase(t *testing.T) {
	ref := mustRegistry(t)

	spot, err := ResolveInstrument(instrumentFixture(t, "binance", "ETHUSDT", MarketTypeSpot), ref)
	if err != nil {
		t.Fatalf("ResolveInstrument(spot) failed: %v", err)
	}
	if spot.SettlementAssetID != spot.BaseAssetID {
		t.Errorf("spot settlement = %s, want its base asset %s", spot.SettlementAssetID, spot.BaseAssetID)
	}

	perp, err := ResolveInstrument(instrumentFixture(t, "binance", "ETHUSDT", MarketTypeLinearPerp), ref)
	if err != nil {
		t.Fatalf("ResolveInstrument(linear_perp) failed: %v", err)
	}
	if perp.SettlementAssetID != perp.QuoteAssetID {
		t.Errorf("linear_perp settlement = %s, want its quote asset %s", perp.SettlementAssetID, perp.QuoteAssetID)
	}
}

// TestAssetSymbolLookupIsExactNotFuzzy proves the lookup cannot be talked into a
// near-miss: a venue's decorated symbol must NOT resolve to the decorated base
// asset, because the alternative is silently attributing a market to the wrong
// asset.
func TestAssetSymbolLookupIsExactNotFuzzy(t *testing.T) {
	ref := mustRegistry(t)

	if _, err := assetIDForSymbol(ref, "ETH.P"); !errors.Is(err, ErrInstrumentMalformed) {
		t.Errorf("assetIDForSymbol(ETH.P) = %v, want ErrInstrumentMalformed", err)
	}
	if _, err := assetIDForSymbol(ref, "ETH"); err != nil {
		t.Errorf("assetIDForSymbol(ETH) failed for a seeded asset: %v", err)
	}
	// Case is a spelling, so it is normalized; whitespace is not part of a
	// symbol, so it is trimmed. These are the only normalizations.
	if lower, err := assetIDForSymbol(ref, "eth"); err != nil {
		t.Errorf("assetIDForSymbol(eth) failed: %v", err)
	} else if upper, _ := assetIDForSymbol(ref, "ETH"); lower != upper {
		t.Errorf("assetIDForSymbol(eth) = %s but (ETH) = %s; case must not change the asset", lower, upper)
	}
	if _, err := assetIDForSymbol(ref, "NOTASEEDEDASSET"); !errors.Is(err, ErrInstrumentUnresolved) {
		t.Errorf("assetIDForSymbol(unseeded) = %v, want ErrInstrumentUnresolved", err)
	}
}

// TestUnresolvableBaseYieldsNoID is the "no partial id" guarantee stated as a
// direct assertion: whatever the failure, the caller gets an error and an EMPTY
// id - never a plausible-looking one built from the parts that did resolve.
func TestUnresolvableBaseYieldsNoID(t *testing.T) {
	ref := mustRegistry(t)
	got, err := ResolveInstrument(instrumentFixture(t, "binance", "ZZZUSDT", MarketTypeSpot), ref)
	if err == nil {
		t.Fatal("ResolveInstrument resolved an asset that is not in the registry")
	}
	if got.InstrumentID != "" || got.BaseAssetID != "" || got.QuoteAssetID != "" {
		t.Errorf("a failed resolution returned populated fields: %+v", got)
	}
}

// TestInstrumentMarketTypesMatchTheReferenceRegistry pins the one duplicated
// fact in this file: the two market families. `reference.MarketType` and
// `MarketType` are declared separately (neither package may own the other's), so
// a value added to one and not the other would silently make a market
// unresolvable. This test is what makes the duplication safe.
func TestInstrumentMarketTypesMatchTheReferenceRegistry(t *testing.T) {
	if len(reference.MarketTypes) != 2 {
		t.Fatalf("reference.MarketTypes has %d values; this test pins the pair", len(reference.MarketTypes))
	}
	for _, mt := range reference.MarketTypes {
		if !marketTypeModelled(MarketType(mt)) {
			t.Errorf("reference market type %q is not modelled by instruments.MarketType", mt)
		}
	}
	for _, mt := range []MarketType{MarketTypeSpot, MarketTypeLinearPerp} {
		found := false
		for _, rm := range reference.MarketTypes {
			if MarketType(rm) == mt {
				found = true
			}
		}
		if !found {
			t.Errorf("instruments market type %q is not modelled by reference.MarketType", mt)
		}
	}
}

// TestVenueIDForSlugRefusesUnknown proves the venue lookup itself refuses an
// unknown slug.
//
// It is a DIRECT test because ResolveInstrument cannot reach this branch with
// today's seeds: the symbol normalizer only knows binance, bybit and mexc, and
// the reference registry carries all three. The branch is a guard for the day a
// venue is added to one list and not the other, so it is tested where it lives
// rather than left as unreachable-looking code.
func TestVenueIDForSlugRefusesUnknown(t *testing.T) {
	ref := mustRegistry(t)
	if _, err := venueIDForSlug(ref, "not-a-venue"); !errors.Is(err, ErrInstrumentUnresolved) {
		t.Errorf("venueIDForSlug(not-a-venue) = %v, want ErrInstrumentUnresolved", err)
	}
	// Proves the branch is a real guard and not dead: every venue the symbol
	// normalizer knows must resolve, so adding a venue to one list alone breaks
	// this test rather than silently making its markets unmintable.
	for _, slug := range []string{"binance", "bybit", "mexc"} {
		if _, err := venueIDForSlug(ref, slug); err != nil {
			t.Errorf("venue %q is known to CanonicalSymbol but does not resolve: %v", slug, err)
		}
	}
}

// TestCheckVenueSlug proves the standalone venue check agrees with resolution.
func TestCheckVenueSlug(t *testing.T) {
	ref := mustRegistry(t)
	for _, slug := range []string{"binance", "bybit", "mexc", "paper"} {
		if err := CheckVenueSlug(ref, slug); err != nil {
			t.Errorf("CheckVenueSlug(%q) failed for a seeded venue: %v", slug, err)
		}
	}
	if err := CheckVenueSlug(ref, "not-a-venue"); !errors.Is(err, ErrInstrumentUnresolved) {
		t.Errorf("CheckVenueSlug(not-a-venue) = %v, want ErrInstrumentUnresolved", err)
	}
	if err := CheckVenueSlug(nil, "binance"); !errors.Is(err, ErrInstrumentUnresolved) {
		t.Errorf("CheckVenueSlug(nil registry) = %v, want ErrInstrumentUnresolved", err)
	}
}

// mustInternalVenue resolves a venue slug through the registry's internal
// mapping table, failing the test if it is absent.
func mustInternalVenue(t *testing.T, ref *reference.Reference, slug string) string {
	t.Helper()
	got, err := venueIDForSlug(ref, slug)
	if err != nil {
		t.Fatalf("venue %q did not resolve: %v", slug, err)
	}
	return got
}

// mustAssetSymbol resolves an asset symbol through the registry's entity list,
// failing the test if it is absent.
func mustAssetSymbol(t *testing.T, ref *reference.Reference, symbol string) string {
	t.Helper()
	got, err := assetIDForSymbol(ref, symbol)
	if err != nil {
		t.Fatalf("asset %q did not resolve: %v", symbol, err)
	}
	return got
}
