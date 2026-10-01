package instruments

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/markets/reference"
	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

// This file closes the gap `docs/architecture/canonical-model.md` recorded as
// open question O4: `InstrumentID` was defined and pinned to
// `binance:spot:BTC/USDT`, but NOTHING minted it, and the form is built out of
// the venue's SPELLING - which is not identity.
//
// Two spellings of one market must not be two instruments. Binance reports
// `BTCUSDT`, ccxt reports `BTC/USDT:USDT`, the executor writes `BTC/USDT`; they
// are one market. The spelling form turns each into a different string, so a
// consumer keying on it silently fragments one market into three.
//
// The canonical id is therefore minted from the RESOLVED COMPONENTS - venue,
// market family, base asset, quote asset, settlement asset - each of which is
// already a canonical reference id (`backend/api/internal/markets/reference`).
// No spelling, and no symbol string, takes part in the identity.
//
// # The exact preimage (stated so a change cannot happen silently)
//
//	instrument_id = "instrument:" + hex(sha256(salt NUL "instrument" NUL naturalKey))[0:10]
//	salt          = "fudcourt/canonical-instrument/v1"
//	naturalKey    = "instrument/" + venue_id + "/" + market_type
//	                            + "/" + base_asset_id + "/" + quote_asset_id
//	                            + "/" + settlement_asset_id
//
// hashed by `reference.MintIDWithSalt`, so this package and the reference
// registry share ONE hashing implementation rather than two that can drift.
// The salt is distinct from the registry's, so an instrument id can never
// collide with a reference id even if a kind were misspelled. `InstrumentKind`
// is deliberately NOT a `reference.EntityKind`: instruments are per-venue
// markets, not reference data, and are therefore not emitted into
// `shared/contracts/data/reference.json`. A consumer obtains an instrument id
// from ResolveInstrument (or a future emitted artifact of this package); it MUST
// NOT expect one in the reference document, which is bounded reference data.
//
// Changing any component, the separator, the salt or the truncation changes
// every id. That is a breaking change and MUST be a new version, not an edit -
// `TestInstrumentIDGoldenVector` pins the current one.
const (
	// InstrumentKind is the id namespace prefix for a canonical instrument id.
	// It is the string `MintIDWithSalt` is given; it is not a reference.
	// EntityKind value.
	InstrumentKind = "instrument"

	// InstrumentIDSalt versions the instrument id space. Bumping it re-mints
	// every instrument id, which is why it carries a version.
	InstrumentIDSalt = "fudcourt/canonical-instrument/v1"
)

// Refusal sentinels for this file. They are distinct values so a caller can
// tell "I cannot identify this market" from "this market is not one I know",
// and both are wrapped in the package's frozen errs code so a client can branch
// on the wire code too.
var (
	// ErrInstrumentMalformed marks an identity that is malformed on its face:
	// an empty component, a symbol that is not a symbol, a market type this
	// build does not model, an id that was not minted by the reference
	// registry. Nothing was looked up; the input itself is wrong.
	ErrInstrumentMalformed = errors.New("instruments: malformed instrument identity")

	// ErrInstrumentUnresolved marks a well-formed identity that names something
	// absent from the canonical reference registry: an unknown venue, or a
	// base/quote asset this build has no canonical id for. NEVER resolved by
	// guessing, fuzzy-matching or falling back to the spelling - the whole point
	// of the canonical id is that an unknown market stays unknown.
	ErrInstrumentUnresolved = errors.New("instruments: instrument is not in the canonical registry")
)

// assetSymbolShape is the shape a base/quote symbol must have before it is even
// looked up. It is a shape check, not a match: the lookup is the exact,
// case-preserving `reference.Resolve`. Restricting the character set keeps a
// venue's punctuation (`.P` market suffixes, `-` separators) from being
// silently trimmed into a DIFFERENT asset that does exist.
var assetSymbolShape = regexp.MustCompile(`^[A-Z0-9]{1,16}$`)

// CanonicalInstrument is the resolved identity of one tradable market on one
// venue, in canonical terms.
//
// The five identity fields, in the order listed, are the entire id preimage.
// The three below them are RESOLVED CONVENIENCES: they are not part of the
// identity, they are what a caller needs in order to print, route or key the
// instrument, and they are derived from the registry rather than from the id.
// Keeping both in one value is what makes this usable without a second lookup -
// and the comment is what stops a reader treating `VenueSlug` as identity.
type CanonicalInstrument struct {
	// --- identity (the id preimage, in this order) ---

	// VenueID is the canonical venue id (`venue:<hex>`).
	VenueID string
	// MarketType is the market family.
	MarketType MarketType
	// BaseAssetID is the canonical asset id of the base asset.
	BaseAssetID string
	// QuoteAssetID is the canonical asset id of the quote asset.
	QuoteAssetID string
	// SettlementAssetID is the canonical asset id the contract settles in. It
	// is always populated, including for spot (where the base asset settles):
	// a uniform preimage is what lets `instrument_id` be computed once, without
	// a branch that a later reader could invert.
	SettlementAssetID string

	// --- resolved, NOT identity ---

	// InstrumentID is the minted canonical id for the fields above.
	InstrumentID string
	// VenueSlug is the venue id this repo already writes in spellings
	// ("binance"), i.e. the value `CanonicalSymbol`/`VenueSymbol` switch on.
	VenueSlug string
	// BaseSymbol and QuoteSymbol are the canonical asset symbols. They are what
	// the legacy spelling form is rebuilt from; they are never parsed back into
	// identity.
	BaseSymbol  string
	QuoteSymbol string
}

// NaturalKey returns the exact string hashed into InstrumentID. It is exported
// so a second implementation in another language can be proven identical rather
// than assumed identical, and so a test can pin the preimage directly.
func (c CanonicalInstrument) NaturalKey() (string, error) {
	if err := c.validate(); err != nil {
		return "", err
	}
	return instrumentNaturalKey(c.VenueID, c.MarketType, c.BaseAssetID, c.QuoteAssetID, c.SettlementAssetID), nil
}

// validate checks the five identity components in isolation - shape only, no
// registry lookup. Every constructor here calls it before minting, so a partial
// or malformed identity cannot reach the hash function.
func (c CanonicalInstrument) validate() error {
	if err := checkID("venue", reference.KindVenue, c.VenueID); err != nil {
		return err
	}
	if !marketTypeModelled(c.MarketType) {
		return errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown,
			fmt.Sprintf("market type %q is not one this build models", string(c.MarketType)), ErrInstrumentMalformed)
	}
	for _, a := range []struct{ field, id string }{
		{"base_asset_id", c.BaseAssetID},
		{"quote_asset_id", c.QuoteAssetID},
		{"settlement_asset_id", c.SettlementAssetID},
	} {
		if err := checkID(a.field, reference.KindAsset, a.id); err != nil {
			return err
		}
	}
	return nil
}

// InstrumentID returns the canonical id for these components. It re-derives the
// id from the identity fields rather than returning the cached InstrumentID, so
// a value assembled by hand cannot report an id its components do not mint.
func (c CanonicalInstrument) Mint() (string, error) {
	key, err := c.NaturalKey()
	if err != nil {
		return "", err
	}
	return reference.MintIDWithSalt(reference.EntityKind(InstrumentKind), key, InstrumentIDSalt), nil
}

// InstrumentSpelling is the LEGACY, human-readable identity:
// `exchange:marketType:BASE/QUOTE` (e.g. `binance:spot:BTC/USDT`).
//
// It is a SPELLING. It is stable and it is what the OpenAPI surface, the web
// executor's `venueKey()` and `docs/architecture/canonical-model.md` already
// carry, so it is kept rather than replaced. It is NOT an identity: it uses the
// canonical `BASE/QUOTE` spelling, which is one of several a venue may use, and
// it is derived from a venue slug rather than a canonical venue id.
//
// The form is preserved byte-for-byte so that existing values keep their
// meaning. Nothing was re-pointed at the canonical id in this change; a
// consumer may hold either, and the two are distinguishable on sight
// (`instrument:` prefix vs a `:`-joined triple).
type InstrumentSpelling struct {
	// Exchange is the venue id the repo already uses in spellings ("binance").
	Exchange string
	// MarketType is the market family.
	MarketType MarketType
	// Symbol is the canonical BASE/QUOTE symbol.
	Symbol string
}

// String renders the legacy form. It cannot fail: an InstrumentSpelling is
// validated at construction (ParseInstrumentSpelling, SpellingFor).
func (s InstrumentSpelling) String() string {
	return s.Exchange + ":" + string(s.MarketType) + ":" + s.Symbol
}

// ParseInstrumentSpelling parses the legacy `exchange:marketType:BASE/QUOTE`
// form. It REFUSES anything else - including a canonical `instrument:<hex>` id,
// which is deliberately not parseable as a spelling: the two id spaces are not
// interchangeable, and silently accepting one where the other is meant is how a
// field's meaning changes without anyone deciding it.
func ParseInstrumentSpelling(s string) (InstrumentSpelling, error) {
	parts := strings.Split(s, ":")
	if len(parts) != 3 {
		return InstrumentSpelling{}, errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown,
			fmt.Sprintf("instrument spelling %q must be exchange:marketType:BASE/QUOTE", s), ErrInstrumentMalformed)
	}
	out := InstrumentSpelling{Exchange: parts[0], MarketType: MarketType(parts[1]), Symbol: parts[2]}
	if err := out.validate(); err != nil {
		return InstrumentSpelling{}, err
	}
	return out, nil
}

// validate checks a spelling without any registry lookup.
func (s InstrumentSpelling) validate() error {
	if s.Exchange == "" || strings.ContainsAny(s.Exchange, ":/") {
		return errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown,
			fmt.Sprintf("spelling exchange %q is empty or contains a separator", s.Exchange), ErrInstrumentMalformed)
	}
	if !marketTypeModelled(s.MarketType) {
		return errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown,
			fmt.Sprintf("spelling market type %q is not one this build models", string(s.MarketType)), ErrInstrumentMalformed)
	}
	base, quote, ok := strings.Cut(s.Symbol, "/")
	if !ok || !assetSymbolShape.MatchString(base) || !assetSymbolShape.MatchString(quote) {
		return errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown,
			fmt.Sprintf("spelling symbol %q must be BASE/QUOTE", s.Symbol), ErrInstrumentMalformed)
	}
	return nil
}

// marketTypeModelled reports whether m is one of the two market families this
// build models. It is a local check rather than a method on MarketType because
// instrument.go is owned by another change in flight and this file must not
// modify it; `reference.MarketType` carries the same two values and the same
// check, and `TestInstrumentMarketTypesMatchTheReferenceRegistry` pins them
// equal so the duplication cannot drift.
func marketTypeModelled(m MarketType) bool {
	switch m {
	case MarketTypeSpot, MarketTypeLinearPerp:
		return true
	}
	return false
}

// ---- minting ---------------------------------------------------------------

// MintInstrumentID mints the canonical instrument id from RESOLVED components.
//
// venueID, baseAssetID, quoteAssetID and settlementAssetID MUST be canonical
// ids already minted by `backend/api/internal/markets/reference`; this function
// checks their shape and refuses anything else rather than hashing a symbol
// into an id-shaped string, which would produce a stable id for an entity that
// does not exist.
//
// settlementAssetID may be empty, in which case it is DERIVED the way the tree
// already derives it (`frontend/web/src/platform/executor/exchange.ts:380`
// `settlementAsset: marketType === 'linear_perp' ? (str(m.settle) ?? quoteAsset)
// : baseAsset`): spot settles in its base asset, a linear perpetual settles in
// its quote asset. Pass it explicitly when the venue reports a settlement
// currency that differs from the quote (e.g. a USDC-settled perpetual).
func MintInstrumentID(venueID string, marketType MarketType, baseAssetID, quoteAssetID, settlementAssetID string) (string, error) {
	c := CanonicalInstrument{
		VenueID:           venueID,
		MarketType:        marketType,
		BaseAssetID:       baseAssetID,
		QuoteAssetID:      quoteAssetID,
		SettlementAssetID: defaultSettlement(marketType, baseAssetID, quoteAssetID, settlementAssetID),
	}
	return c.Mint()
}

// MintFor mints the canonical id for an already-resolved instrument.
func MintFor(c CanonicalInstrument) (string, error) { return c.Mint() }

// defaultSettlement applies the tree's settlement rule when the caller did not
// state one. It never GUESSES from a symbol: the derivation only picks between
// the two asset ids it was handed.
func defaultSettlement(marketType MarketType, baseAssetID, quoteAssetID, settlementAssetID string) string {
	if settlementAssetID != "" {
		return settlementAssetID
	}
	if marketType == MarketTypeSpot {
		return baseAssetID
	}
	return quoteAssetID
}

// instrumentNaturalKey is the single place the preimage string is built, so the
// doc comment above and the implementation cannot disagree.
func instrumentNaturalKey(venueID string, marketType MarketType, baseAssetID, quoteAssetID, settlementAssetID string) string {
	return "instrument/" + venueID +
		"/" + string(marketType) +
		"/" + baseAssetID +
		"/" + quoteAssetID +
		"/" + settlementAssetID
}

// MintLegacyInstrumentID mints the LEGACY spelling form
// `exchange:marketType:BASE/QUOTE` from its parts. It is kept so the existing
// field keeps its exact meaning; new identity MUST use MintInstrumentID.
//
// This form is plain concatenation, which is exactly why it is not identity: it
// is a function of a venue slug plus a spelling, so it carries neither a
// canonical venue id nor a canonical asset id. It cannot be confused with a
// canonical id - that always begins `instrument:` - and
// `TestCanonicalAndLegacyIDSpacesNeverCollide` holds that line.
func MintLegacyInstrumentID(exchange string, marketType MarketType, canonicalSymbol string) (string, error) {
	s := InstrumentSpelling{Exchange: exchange, MarketType: marketType, Symbol: canonicalSymbol}
	if err := s.validate(); err != nil {
		return "", err
	}
	return s.String(), nil
}

// SpellingFor derives the legacy spelling from an instrument the caller already
// holds, so a producer that has an Instrument can emit the legacy id without
// re-deriving the symbol by hand.
func SpellingFor(i Instrument) (InstrumentSpelling, error) {
	canonical, err := CanonicalSymbol(i.Exchange, i.ExchangeSymbol)
	if err != nil {
		return InstrumentSpelling{}, err
	}
	s := InstrumentSpelling{Exchange: i.Exchange, MarketType: i.MarketType, Symbol: canonical}
	if err := s.validate(); err != nil {
		return InstrumentSpelling{}, err
	}
	return s, nil
}

// ---- resolution ------------------------------------------------------------

// ResolveInstrument turns a venue-spelled instrument into its canonical
// identity, in both directions of meaning: it parses the exchange spelling, and
// it resolves every component through the canonical reference registry.
//
// It is the only supported way to obtain an instrument_id from a venue payload.
// It REFUSES rather than guesses at every step, which is the property that makes
// the result trustworthy:
//
//   - an unknown venue is refused (`ErrInstrumentUnresolved`);
//   - a base or quote asset with no canonical id is refused
//     (`ErrInstrumentUnresolved`) - and NO partial id is minted, because a
//     half-canonical id is worse than none: it looks resolvable;
//   - a malformed spelling is refused via the package's existing
//     `CanonicalSymbol`, whose behaviour is unchanged;
//   - an id that is not an id (a symbol passed where a canonical id belongs) is
//     refused (`ErrInstrumentMalformed`) before it can reach the hash.
func ResolveInstrument(i Instrument, ref *reference.Reference) (CanonicalInstrument, error) {
	if ref == nil {
		return CanonicalInstrument{}, errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown,
			"nil canonical reference registry", ErrInstrumentUnresolved)
	}
	spelling, err := SpellingFor(i)
	if err != nil {
		return CanonicalInstrument{}, err
	}
	venueID, err := venueIDForSlug(ref, spelling.Exchange)
	if err != nil {
		return CanonicalInstrument{}, err
	}
	base, quote, _ := strings.Cut(spelling.Symbol, "/")
	baseID, err := assetIDForSymbol(ref, base)
	if err != nil {
		return CanonicalInstrument{}, err
	}
	quoteID, err := assetIDForSymbol(ref, quote)
	if err != nil {
		return CanonicalInstrument{}, err
	}

	// Settlement. `Settle` is not a field of Instrument in this build (see
	// docs/architecture/canonical-model.md section 2.1: the repo carries
	// settlement on the market-data row as ccxt's `settle`, and on the executor's
	// InstrumentMetadata as `settlementAsset`; the Go Instrument struct has no
	// such field and this change does NOT add one - adding a field to the shared
	// contract is a migration, not a minter). So the derivation below is the
	// tree's own rule, applied with no venue-reported override available yet:
	// spot settles in its base, a linear perpetual in its quote. When a venue
	// starts reporting a different settlement currency, it belongs in an
	// explicit parameter here - NOT in a new field guessed onto this struct.
	settlement := defaultSettlement(i.MarketType, baseID, quoteID, "")

	c := CanonicalInstrument{
		VenueID:           venueID,
		MarketType:        i.MarketType,
		BaseAssetID:       baseID,
		QuoteAssetID:      quoteID,
		SettlementAssetID: settlement,
		VenueSlug:         spelling.Exchange,
		BaseSymbol:        base,
		QuoteSymbol:       quote,
	}
	id, err := c.Mint()
	if err != nil {
		return CanonicalInstrument{}, err
	}
	c.InstrumentID = id
	return c, nil
}

// ExchangeSymbol renders the canonical identity back into the venue's own
// spelling, using the same unmodified `VenueSymbol` the package already had.
//
// It refuses when the caller assembled a CanonicalInstrument without the
// resolved slug/symbols (e.g. by hand from ids), rather than inventing a
// spelling: a wrong spelling would route an order to a market that does not
// exist.
func (c CanonicalInstrument) ExchangeSymbol() (string, error) {
	if _, err := c.NaturalKey(); err != nil {
		return "", err
	}
	if c.VenueSlug == "" || c.BaseSymbol == "" || c.QuoteSymbol == "" {
		return "", errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown,
			"instrument has no resolved venue slug or asset symbols; resolve it with ResolveInstrument before rendering a venue symbol", ErrInstrumentMalformed)
	}
	return VenueSymbol(c.VenueSlug, c.BaseSymbol+"/"+c.QuoteSymbol)
}

// ---- registry lookups ------------------------------------------------------

// assetIDForSymbol resolves an asset SYMBOL to its canonical asset id.
//
// It reads the registry's own entity list, not the provider mapping table: the
// registry already carries the symbol as a FIELD of every asset
// (`reference.Asset.Symbol`), so looking it up there uses the fact rather than a
// duplicate row. The mapping table is deliberately NOT used - its `internal`
// namespace holds one asset row (MATIC, seeded to prove the Symbol-uppercase
// normalization) and venue slugs, and re-stating every asset symbol as a
// provider_id would create a second copy of data the entity already owns, free
// to drift from it.
//
// The match is EXACT after upper-casing, which is a pure spelling normalization
// and the only one applied: the registry stores symbols upper-case, so `eth` and
// `ETH` cannot name different things. No punctuation is trimmed and no fuzzy
// match is attempted - a venue's `.P` or `-` suffix therefore fails rather than
// silently naming a DIFFERENT asset that does exist.
//
// An ambiguous symbol is REFUSED. The registry keys assets by
// `asset/<kind>/<SYMBOL>`, so `asset/native/FOO` and `asset/fiat/FOO` may both
// exist; picking one silently would attribute a market to the wrong asset, which
// is exactly the failure this whole file exists to prevent.
func assetIDForSymbol(ref *reference.Reference, symbol string) (string, error) {
	s := strings.ToUpper(strings.TrimSpace(symbol))
	if !assetSymbolShape.MatchString(s) {
		return "", errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown,
			fmt.Sprintf("asset symbol %q is not a symbol this build can look up", symbol), ErrInstrumentMalformed)
	}
	found := ""
	for _, a := range ref.Assets {
		if strings.ToUpper(strings.TrimSpace(a.Symbol)) != s {
			continue
		}
		if found != "" {
			return "", errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown,
				fmt.Sprintf("asset symbol %q is ambiguous: %s and %s both carry it", s, found, a.AssetID), ErrInstrumentUnresolved)
		}
		found = a.AssetID
	}
	if found == "" {
		return "", errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown,
			fmt.Sprintf("asset %q has no canonical id in the reference registry", s), ErrInstrumentUnresolved)
	}
	if err := checkID("asset", reference.KindAsset, found); err != nil {
		return "", err
	}
	return found, nil
}

// venueIDForSlug resolves a venue slug ("binance") to its canonical venue id.
//
// It reads the registry's `internal` mapping table, which is the curated list of
// what this repo calls each thing, so the match is an exact table lookup and not
// a guess about a naming convention. It is the inverse of venueSlugForID, and
// the two are tested to agree.
func venueIDForSlug(ref *reference.Reference, slug string) (string, error) {
	s := strings.TrimSpace(slug)
	for _, m := range ref.Mappings {
		if m.Provider == reference.ProviderInternal && m.ProviderID == s &&
			strings.HasPrefix(m.CanonicalID, string(reference.KindVenue)+":") {
			return m.CanonicalID, nil
		}
	}
	return "", errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown,
		fmt.Sprintf("venue %q has no canonical id in the reference registry", slug), ErrInstrumentUnresolved)
}

// CheckVenueSlug reports whether the venue slug resolves, without minting
// anything. It exists so a producer can validate a venue before it has an
// instrument in hand.
func CheckVenueSlug(ref *reference.Reference, slug string) error {
	if ref == nil {
		return errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown, "nil canonical reference registry", ErrInstrumentUnresolved)
	}
	_, err := venueIDForSlug(ref, slug)
	return err
}

// checkID refuses an id that is not `<prefix>:<IDHexLen hex>`, i.e. that was not
// minted by the reference registry. It is a shape check on purpose: this package
// may not re-derive the registry's ids (that is the registry's job), so the
// strongest thing it can honestly assert is that it was handed an id-shaped
// value of the right kind.
func checkID(field string, kind reference.EntityKind, id string) error {
	prefix := string(kind) + ":"
	body, ok := strings.CutPrefix(id, prefix)
	if !ok || len(body) != reference.IDHexLen {
		return errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown,
			fmt.Sprintf("%s %q is not a canonical %s id (%s<hex, %d chars>)", field, id, kind, prefix, reference.IDHexLen), ErrInstrumentMalformed)
	}
	for _, r := range body {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return errs.Wrap(errs.CategoryValidation, CodeSymbolUnknown,
				fmt.Sprintf("%s %q is not a canonical %s id", field, id, kind), ErrInstrumentMalformed)
		}
	}
	return nil
}
