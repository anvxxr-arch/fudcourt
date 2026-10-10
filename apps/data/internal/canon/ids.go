// Package canon is the canonical identity space for the data platform: the
// entity kinds, the id minting rule, the per-kind natural-key builders and the
// canonical structs the providers normalize into.
//
// # The id rule (one line, deterministic)
//
//	id = kind ":" hex(sha256(salt 0x00 kind 0x00 naturalKey))[:10]
//
// with salt = "fudcourt/canonical-reference/v1". The rule is reused bit-for-bit
// from apps/api/internal/markets/reference/ids.go, which owns the existing
// asset/chain/token/venue id space: the same salt, the same NUL framing, the
// same 10-hex-digit truncation. That is what makes the ids in
// contracts/data/reference.json reproducible here without importing apps/api
// (services MUST NOT import each other's implementation; the sharing path is
// the artifact plus this independent re-implementation, and the parity test
// pins the two together).
//
// The rule is a pure function of its arguments - no clock, no randomness, no
// counter, no map order - so two processes mint the same id for the same
// entity. A minted id is OPAQUE: consumers never parse it and never read a
// symbol out of it; the natural key that produced it is the readable part and
// is carried alongside the id wherever an entity is written.
//
// # Natural keys (the readable half of every identity)
//
//	asset      "asset/<kind>/<UPPER symbol>"
//	chain      "chain/<lower name>"
//	token      "token/<lower chain>/<FULL address verbatim>"
//	venue      "venue/<lower venue id>"
//	instrument "instrument/<lower venue>/<market_type>/<UPPER base>/<UPPER quote>[/<STRIKE>][/<YYYYMMDD>][/<C|P>]"
//	protocol   "protocol/<lower slug>"
//	series     "series/<domain>/<metric>/<lower subject key>"
//	country    "country/<UPPER ISO2>"
//	currency   "currency/<UPPER ISO4217>"
//	article    "article/<lower provider>/<provider article id>"
//	pool       "pool/<lower chain>/<address>"
//	prediction "prediction/<lower provider>/<provider market id>"
//
// Only the trailing instrument segments that exist are appended: a spot pair
// stops at the quote symbol; an option adds strike, expiry and option type; a
// dated future adds the expiry. The strike is printed with trailing zeros
// trimmed so "65000.50" and "65000.5" mint the same id.
package canon

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
)

// Salt is the domain-separation string hashed ahead of every (kind,
// naturalKey) pair. It is fixed: changing it changes every canonical id, which
// is why the existing ids are pinned by tests on both sides of the rule.
const Salt = "fudcourt/canonical-reference/v1"

// IDHexLen is the number of sha256 hex digits kept in a minted id: 10 hex
// digits is 40 bits, far beyond the collision horizon of a registry holding
// thousands of entities. Same value as the apps/api rule.
const IDHexLen = 10

// EntityKind is the id NAMESPACE an entity id belongs to. It is the prefix of
// every minted id, so a consumer can tell what an id refers to without a
// lookup while still treating the rest of the id as opaque.
type EntityKind string

// The canonical namespaces. KindAsset..KindVenue reuse the existing
// apps/api id space bit-for-bit (parity-tested against
// contracts/data/reference.json); the remaining kinds are new in this package
// and mint with the same rule.
const (
	KindAsset      EntityKind = "asset"
	KindChain      EntityKind = "chain"
	KindToken      EntityKind = "token"
	KindVenue      EntityKind = "venue"
	KindInstrument EntityKind = "instrument"
	KindProtocol   EntityKind = "protocol"
	KindSeries     EntityKind = "series"
	KindCountry    EntityKind = "country"
	KindCurrency   EntityKind = "currency"
	KindArticle    EntityKind = "article"
	KindPool       EntityKind = "pool"
	KindPrediction EntityKind = "prediction"
)

// EntityKinds lists every namespace in contract order.
var EntityKinds = []EntityKind{
	KindAsset,
	KindChain,
	KindToken,
	KindVenue,
	KindInstrument,
	KindProtocol,
	KindSeries,
	KindCountry,
	KindCurrency,
	KindArticle,
	KindPool,
	KindPrediction,
}

// Valid reports whether k names a namespace this package mints into.
func (k EntityKind) Valid() bool {
	for _, v := range EntityKinds {
		if k == v {
			return true
		}
	}
	return false
}

// Kind returns the namespace prefix of an id: the text before the first ':'.
// An id without a colon is returned whole - the function classifies, it does
// not validate.
func Kind(id string) string {
	if i := strings.IndexByte(id, ':'); i >= 0 {
		return id[:i]
	}
	return id
}

// MintID returns the canonical id for one entity: kind + ":" +
// hex(sha256(salt NUL kind NUL naturalKey)) truncated to IDHexLen hex digits.
//
// naturalKey MUST be the entity's stable natural key as built by the Key
// functions below, not a display name: this function cannot check that, the
// builders construct it, and the tests pin the output.
func MintID(kind EntityKind, naturalKey string) string {
	return MintIDWithSalt(kind, naturalKey, Salt)
}

// MintIDWithSalt is MintID with an explicit salt. It exists so a test can
// prove the salt is actually hashed (changing it must change every id), and so
// the rule can be checked byte-for-byte against the apps/api implementation.
func MintIDWithSalt(kind EntityKind, naturalKey, salt string) string {
	h := sha256.New()
	h.Write([]byte(salt))
	h.Write([]byte{0})
	h.Write([]byte(kind))
	h.Write([]byte{0})
	h.Write([]byte(naturalKey))
	return string(kind) + ":" + hex.EncodeToString(h.Sum(nil))[:IDHexLen]
}

// AssetKey builds an asset's natural key. The asset is the one entity whose
// key is symbol-derived, because native coins and fiat units have no issuer
// identity anywhere in the tree - a recorded cost of the existing id space,
// not an oversight (see the apps/api package doc).
func AssetKey(kind AssetKind, symbol string) string {
	return "asset/" + string(kind) + "/" + strings.ToUpper(strings.TrimSpace(symbol))
}

// TokenKey builds a token's natural key from the chain's canonical lowercase
// name and the FULL contract address. The address keeps its verbatim casing:
// an EVM checksum case is identity, and truncation is refused by the callers
// rather than silently producing a different token.
func TokenKey(chainName, address string) string {
	return "token/" + strings.ToLower(strings.TrimSpace(chainName)) + "/" + strings.TrimSpace(address)
}

// ChainKey builds a chain's natural key from its canonical lowercase name.
func ChainKey(name string) string {
	return "chain/" + strings.ToLower(strings.TrimSpace(name))
}

// VenueKey builds a venue's natural key from the venue id the tree already
// uses, lowercased.
func VenueKey(venueID string) string {
	return "venue/" + strings.ToLower(strings.TrimSpace(venueID))
}

// ProtocolKey builds a protocol's natural key from its slug, lowercased (the
// DefiLlama slug is already lowercase; the builder does not rely on that).
func ProtocolKey(slug string) string {
	return "protocol/" + strings.ToLower(strings.TrimSpace(slug))
}

// SeriesKey builds a series' natural key. The subject key is lowercased: a
// series about "US" and one about "us" are the same series, and the minted id
// must not depend on the caller's spelling.
func SeriesKey(domain, metric, subjectKey string) string {
	return "series/" + domain + "/" + metric + "/" + strings.ToLower(strings.TrimSpace(subjectKey))
}

// CountryKey builds a country's natural key from its ISO 3166-1 alpha-2 code,
// uppercased.
func CountryKey(iso2 string) string {
	return "country/" + strings.ToUpper(strings.TrimSpace(iso2))
}

// CurrencyKey builds a currency's natural key from its ISO 4217 code,
// uppercased.
func CurrencyKey(code string) string {
	return "currency/" + strings.ToUpper(strings.TrimSpace(code))
}

// ArticleKey builds a news article's natural key from the provider name and
// the provider's own article id. The provider is lowercased; the provider id
// is verbatim, because it is the provider's identity, not ours.
func ArticleKey(provider, providerArticleID string) string {
	return "article/" + strings.ToLower(strings.TrimSpace(provider)) + "/" + strings.TrimSpace(providerArticleID)
}

// PoolKey builds a pool's natural key from the chain's canonical lowercase
// name and the pool's FULL contract address, verbatim casing (same rule as
// tokens: the address is the chain's identity for the pair, ours only
// namespaces it).
func PoolKey(chainName, address string) string {
	return "pool/" + strings.ToLower(strings.TrimSpace(chainName)) + "/" + strings.TrimSpace(address)
}

// PredictKey builds a prediction market's natural key from the provider name
// and the provider's own market id — same shape as ArticleKey: the provider
// is lowercased, the provider id is verbatim, because it is the provider's
// identity, not ours.
func PredictKey(provider, providerMarketID string) string {
	return "prediction/" + strings.ToLower(strings.TrimSpace(provider)) + "/" + strings.TrimSpace(providerMarketID)
}

// InstrumentKey builds an instrument's natural key:
//
//	instrument/<lower venue>/<market_type>/<UPPER base>/<UPPER quote>[/STRIKE][/YYYYMMDD][/C|P]
//
// Only the trailing segments that exist are appended: a spot pair stops at the
// quote symbol; an option adds strike, expiry and option type; a dated future
// adds the expiry day. Segment order is fixed - strike before expiry - because
// the contract spells the option branch as /<expiry>/<strike>/<option_type>:
// a strike only exists under it, so appending strike, then expiry, then option
// type keeps every minted key in exactly that shape. The strike is formatted
// with trailing zeros trimmed ("65000.50" -> "65000.5", integral strikes keep
// no decimal point) so the same price spelled two ways mints one id.
func InstrumentKey(r InstrumentRef) string {
	key := "instrument/" + strings.ToLower(strings.TrimSpace(r.VenueID)) + "/" + string(r.MarketType) +
		"/" + strings.ToUpper(strings.TrimSpace(r.Base)) + "/" + strings.ToUpper(strings.TrimSpace(r.Quote))
	if r.Strike != nil {
		key += "/" + trimStrikeZeros(*r.Strike)
	}
	if r.Expiry != nil && !r.Expiry.IsZero() {
		key += "/" + r.Expiry.UTC().Format(instrumentExpiryLayout)
	}
	if r.OptionType != "" {
		key += "/" + strings.ToUpper(r.OptionType)
	}
	return key
}

// instrumentExpiryLayout is the contract's expiry spelling: a UTC calendar day,
// YYYYMMDD, uppercase by construction.
const instrumentExpiryLayout = "20060102"

// trimStrikeZeros renders a strike as the shortest decimal string that parses
// back to the same float64 (trailing zeros trimmed, no bare decimal point), so
// the same price spelled "65000.50" and "65000.5" mints one id.
func trimStrikeZeros(strike float64) string {
	return strconv.FormatFloat(strike, 'f', -1, 64)
}
