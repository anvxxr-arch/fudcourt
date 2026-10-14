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

	// DEX Data Platform kinds (docs/dex/audit.md §4). These are NEW namespaces,
	// not reuses: a Swap is pool-keyed (the plan's §15 idempotency key is
	// chain+tx_hash+log_index), where the existing KindTrade/Trade is
	// venue+instrument-keyed with a provider-assigned trade id. Same for
	// KindCandle: a DEX candle is pool-keyed, where Ohlcv is
	// instrument+venue-keyed. They mint with the same MintID rule and the same
	// salt, so a DEX entity and a market entity live in ONE id space.
	KindDeployment     EntityKind = "deployment"
	KindSwap           EntityKind = "swap"
	KindCandle         EntityKind = "candle"
	KindMarketSnapshot EntityKind = "market_snapshot"
	KindLiquiditySnap  EntityKind = "liquidity_snapshot"
	KindLiquidityPos   EntityKind = "liquidity_position"
	KindWalletActivity EntityKind = "wallet_activity"
	KindRouteQuote     EntityKind = "route_quote"
	KindRiskMetric     EntityKind = "risk_metric"
	KindMEVEvent       EntityKind = "mev_event"
	KindPerpMarket     EntityKind = "perp_market"
	KindProviderObs    EntityKind = "provider_observation"
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
	KindDeployment,
	KindSwap,
	KindCandle,
	KindMarketSnapshot,
	KindLiquiditySnap,
	KindLiquidityPos,
	KindWalletActivity,
	KindRouteQuote,
	KindRiskMetric,
	KindMEVEvent,
	KindPerpMarket,
	KindProviderObs,
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

// --- DEX Data Platform natural keys (docs/dex/audit.md §4, plan §5/§15) -------
//
// Every builder composes only STABLE coordinates: a canonical chain name, a
// protocol slug, a contract address verbatim, or a provider-assigned id. No
// display name, no symbol, no timestamp enters a key, so two processes mint the
// same id for the same entity and a renamed token cannot fork its identity.
//
// The one coordinate that is a TIMESTAMP - the candle's open time - is spelled
// as a fixed-width UTC layout so the key is a pure function of the bar it
// names: a 1m bar opening 2026-10-12T00:00:00Z and one opening 12:00:00Z mint
// different ids, and re-deriving either mints the same id again.

// candleTimeLayout is the fixed-width UTC spelling of a candle's open time in
// its natural key. RFC3339 in UTC keeps it lexically sortable and unambiguous.
const candleTimeLayout = "2006-01-02T15:04:05Z"

// DeploymentKey builds a protocol deployment's natural key: one protocol's
// contract set on one chain. A protocol with a distinct deployment per chain
// (every multi-chain DEX) gets one id per chain, so the same protocol on
// Ethereum and Base never collapse.
func DeploymentKey(chainName, protocolSlug string) string {
	return "deployment/" + strings.ToLower(strings.TrimSpace(chainName)) +
		"/" + strings.ToLower(strings.TrimSpace(protocolSlug))
}

// SwapKey builds a swap's natural key from the plan's §15 idempotency tuple:
// the chain, the transaction hash and the in-transaction log/instruction
// index. The hash is verbatim (a chain's identity for the tx); the index
// disambiguates the several swaps one transaction legitimately contains.
func SwapKey(chainName, txHash string, logIndex int) string {
	return "swap/" + strings.ToLower(strings.TrimSpace(chainName)) +
		"/" + strings.TrimSpace(txHash) + "/" + strconv.Itoa(logIndex)
}

// CandleKey builds a pool candle's natural key: the pool id, the interval and
// the bar's open time (plan §15: pool+interval+open_timestamp). The pool id is
// already opaque and unique, so the key is unambiguous across chains.
func CandleKey(poolID, interval string, openUnix int64) string {
	return "candle/" + strings.TrimSpace(poolID) +
		"/" + strings.TrimSpace(interval) +
		"/" + strconv.FormatInt(openUnix, 10)
}

// MarketSnapshotKey builds a market-state snapshot's natural key: one pool at
// one instant. It mirrors CandleKey's shape so a snapshot and a candle of the
// same pool are distinct kinds over the same coordinates.
func MarketSnapshotKey(poolID string, atUnix int64) string {
	return "market_snapshot/" + strings.TrimSpace(poolID) + "/" + strconv.FormatInt(atUnix, 10)
}

// LiquiditySnapshotKey builds a liquidity snapshot's natural key: one pool's
// reserves/depth at one instant.
func LiquiditySnapshotKey(poolID string, atUnix int64) string {
	return "liquidity_snapshot/" + strings.TrimSpace(poolID) + "/" + strconv.FormatInt(atUnix, 10)
}

// LiquidityPositionKey builds an LP position's natural key: one owner's
// position in one pool. The owner address is verbatim (checksum case is
// identity); a position is per (pool, owner), never per token.
func LiquidityPositionKey(poolID, owner string) string {
	return "liquidity_position/" + strings.TrimSpace(poolID) + "/" + strings.TrimSpace(owner)
}

// WalletActivityKey builds a wallet activity's natural key: one provider's
// record of one wallet event. The provider is lowercased; the provider's own
// event id is verbatim (same shape as ArticleKey) because it is the provider's
// identity, not ours.
func WalletActivityKey(provider, providerEventID string) string {
	return "wallet_activity/" + strings.ToLower(strings.TrimSpace(provider)) +
		"/" + strings.TrimSpace(providerEventID)
}

// RouteQuoteKey builds a route quote's natural key from the quote's own
// coordinates: the input token id, the output token id, the input amount as an
// exact decimal string, and the provider. Two quotes for the same pair at
// different sizes, or from different routers, are different rows - which is
// what makes "best execution" a query rather than an overwrite.
func RouteQuoteKey(provider, inTokenID, outTokenID, inAmount string) string {
	return "route_quote/" + strings.ToLower(strings.TrimSpace(provider)) +
		"/" + strings.TrimSpace(inTokenID) +
		"/" + strings.TrimSpace(outTokenID) +
		"/" + strings.TrimSpace(inAmount)
}

// RiskMetricKey builds a risk metric's natural key: one named risk metric about
// one subject (a pool id, a token id, or a chain name) under one algorithm
// version. Versioning in the key means a changed algorithm mints a new series
// instead of silently overwriting the old one (plan §26).
func RiskMetricKey(subjectKey, metric, algorithmVersion string) string {
	return "risk_metric/" + strings.TrimSpace(subjectKey) +
		"/" + strings.ToLower(strings.TrimSpace(metric)) +
		"/" + strings.TrimSpace(algorithmVersion)
}

// MEVEventKey builds an MEV event's natural key: the chain plus the sandwiching
// (or otherwise classified) transaction hash. One transaction is classified
// once; a re-observation of the same tx mints the same id.
func MEVEventKey(chainName, txHash string) string {
	return "mev_event/" + strings.ToLower(strings.TrimSpace(chainName)) + "/" + strings.TrimSpace(txHash)
}

// PerpMarketKey builds a perpetual market's natural key from the venue, the
// market type and the base/quote symbols - the same coordinate shape as
// InstrumentKey, but in its own namespace so a perp market and a spot
// instrument never collide even when they name the same pair.
func PerpMarketKey(venueID, marketType, baseSymbol, quoteSymbol string) string {
	return "perp_market/" + strings.ToLower(strings.TrimSpace(venueID)) +
		"/" + strings.ToLower(strings.TrimSpace(marketType)) +
		"/" + strings.ToUpper(strings.TrimSpace(baseSymbol)) +
		"/" + strings.ToUpper(strings.TrimSpace(quoteSymbol))
}

// ProviderObservationKey builds a raw provider observation's natural key: the
// provider, the dataset and the provider's own record id. It is the raw-tier
// identity (plan §6/§13) - one stored upstream payload, retained briefly and
// never used as a canonical value.
func ProviderObservationKey(provider, dataset, providerRecordID string) string {
	return "provider_observation/" + strings.ToLower(strings.TrimSpace(provider)) +
		"/" + strings.ToLower(strings.TrimSpace(dataset)) +
		"/" + strings.TrimSpace(providerRecordID)
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
