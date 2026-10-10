package canon

import "time"

// AssetKind is the closed vocabulary of contracts/schemas/assets/asset.json
// (the `kind` enum), reused so a canon asset and a reference asset classify
// the same way.
type AssetKind string

// The asset kinds in contract order.
const (
	AssetNative     AssetKind = "native"
	AssetToken      AssetKind = "token"
	AssetFiat       AssetKind = "fiat"
	AssetStablecoin AssetKind = "stablecoin"
	AssetOther      AssetKind = "other"
)

// Valid reports whether k is one of the contract's asset kinds.
func (k AssetKind) Valid() bool {
	switch k {
	case AssetNative, AssetToken, AssetFiat, AssetStablecoin, AssetOther:
		return true
	}
	return false
}

// Asset is a canonical asset: a symbol-addressable unit of value (a native
// coin, a fiat currency, a stablecoin) keyed by kind + uppercase symbol. ID
// parity with contracts/data/reference.json is tested.
type Asset struct {
	AssetID   string     `json:"asset_id"`
	Symbol    string     `json:"symbol"`
	Name      *string    `json:"name"`
	Kind      AssetKind  `json:"kind"`
	ChainID   *string    `json:"chain_id"`
	Decimals  *int       `json:"decimals"`
	CreatedAt *time.Time `json:"created_at,omitempty"`
	UpdatedAt *time.Time `json:"updated_at,omitempty"`
}

// Token is one contract deployment on one chain, keyed by (chain, FULL
// address, verbatim casing). A truncated display label can never become a
// token id.
type Token struct {
	TokenID     string     `json:"token_id"`
	ChainID     string     `json:"chain_id"`
	Address     string     `json:"address"`
	AddressKind string     `json:"address_kind"`
	AssetID     *string    `json:"asset_id"`
	Symbol      string     `json:"symbol"`
	Name        *string    `json:"name"`
	Decimals    *int       `json:"decimals"`
	CreatedAt   *time.Time `json:"created_at,omitempty"`
	UpdatedAt   *time.Time `json:"updated_at,omitempty"`
}

// Chain is a canonical chain keyed by its lowercase name - the label the rest
// of the tree canonicalizes on.
type Chain struct {
	ChainID        string     `json:"chain_id"`
	Name           string     `json:"name"`
	DisplayName    *string    `json:"display_name"`
	Kind           string     `json:"kind"`
	NativeAssetID  *string    `json:"native_asset_id"`
	ChainNumericID *int       `json:"chain_numeric_id"`
	CreatedAt      *time.Time `json:"created_at,omitempty"`
	UpdatedAt      *time.Time `json:"updated_at,omitempty"`
}

// Venue is one trading venue. `known` says whether THIS build can place an
// order there, which is a different question from whether the venue appears in
// the data.
type Venue struct {
	VenueID     string     `json:"venue_id"`
	Name        *string    `json:"name"`
	Kind        string     `json:"kind"`
	Known       bool       `json:"known"`
	MarketTypes []string   `json:"market_types"`
	URL         *string    `json:"url"`
	CreatedAt   *time.Time `json:"created_at,omitempty"`
	UpdatedAt   *time.Time `json:"updated_at,omitempty"`
}

// Instrument is one tradable market on one venue. Optional grid fields follow
// the absent-vs-zero rule: a nil pointer means "the venue did not report it",
// never 0.
type Instrument struct {
	InstrumentID string `json:"instrument_id"`
	VenueID      string `json:"venue_id"`
	// VenueName is the venue's natural-key string (the VenueKey input, e.g.
	// "bybit") the fetcher minted InstrumentID over. VenueID alone is the
	// minted id — a hash, not reversible — so the store needs the name to
	// re-derive the natural key for validation and the natural_key column.
	VenueName    string     `json:"venue_name,omitempty"`
	MarketType   string     `json:"market_type"`
	BaseAssetID  *string    `json:"base_asset_id"`
	QuoteAssetID *string    `json:"quote_asset_id"`
	BaseSymbol   string     `json:"base_symbol"`
	QuoteSymbol  string     `json:"quote_symbol"`
	Expiry       *time.Time `json:"expiry"`
	Strike       *float64   `json:"strike"`
	OptionType   string     `json:"option_type"`
	TickSize     *float64   `json:"tick_size"`
	LotSize      *float64   `json:"lot_size"`
	ContractSize *float64   `json:"contract_size"`
	ISIN         *string    `json:"isin"`
	CUSIP        *string    `json:"cusip"`
	FIGI         *string    `json:"figi"`
	Ticker       *string    `json:"ticker"`
	Status       string     `json:"status"`
	CreatedAt    *time.Time `json:"created_at,omitempty"`
	UpdatedAt    *time.Time `json:"updated_at,omitempty"`
}

// Protocol is a DeFi protocol keyed by its slug.
type Protocol struct {
	ProtocolID string     `json:"protocol_id"`
	Slug       string     `json:"slug"`
	Name       *string    `json:"name"`
	Category   *string    `json:"category"`
	CreatedAt  *time.Time `json:"created_at,omitempty"`
	UpdatedAt  *time.Time `json:"updated_at,omitempty"`
}

// Country is an ISO 3166-1 alpha-2 country entity.
type Country struct {
	CountryID string  `json:"country_id"`
	ISO2      string  `json:"iso2"`
	Name      *string `json:"name"`
}

// Currency is an ISO 4217 currency entity.
type Currency struct {
	CurrencyID string  `json:"currency_id"`
	Code       string  `json:"code"`
	Name       *string `json:"name"`
	Kind       *string `json:"kind"`
}

// Article is one news article from one provider, keyed by (provider,
// provider article id).
type Article struct {
	ArticleID   string     `json:"article_id"`
	Headline    string     `json:"headline"`
	Summary     *string    `json:"summary"`
	URL         string     `json:"url"`
	Publisher   *string    `json:"publisher"`
	PublishedAt *time.Time `json:"published_at"`
	Language    *string    `json:"language"`
	Topics      []string   `json:"topics"`
	Assets      []string   `json:"assets"`
	Sentiment   *float64   `json:"sentiment"`
	Source      string     `json:"source"`
	RetrievedAt time.Time  `json:"retrieved_at"`
}

// PredictionMarket is one market on a prediction platform, keyed by (provider,
// provider market id).
type PredictionMarket struct {
	MarketID         string     `json:"market_id"`
	Question         string     `json:"question"`
	Outcomes         []string   `json:"outcomes"`
	Prices           []float64  `json:"prices"`
	LiquidityUSD     *float64   `json:"liquidity_usd"`
	Volume24hUSD     *float64   `json:"volume_24h_usd"`
	EndDate          *time.Time `json:"end_date"`
	ResolutionStatus string     `json:"resolution_status"`
	Source           string     `json:"source"`
	RetrievedAt      time.Time  `json:"retrieved_at"`
}

// ProviderSymbol is one row of the (provider, symbol) -> canonical id
// resolution table: the canon-side equivalent of the reference artifact's
// `mappings`. Kind is the EntityKind spelling of the canonical id's namespace.
type ProviderSymbol struct {
	Provider     string     `json:"provider"`
	ProviderSymb string     `json:"provider_symbol"`
	Kind         string     `json:"kind"`
	CanonicalID  string     `json:"canonical_id"`
	Verified     bool       `json:"verified"`
	LastSeenAt   *time.Time `json:"last_seen_at"`
}

// InstrumentRef names an instrument by its natural coordinates instead of its
// id: the fields InstrumentKey builds the natural key from. It is what
// providers hand around before the resolver has minted the instrument id. The
// optional coordinates are pointers: nil means the instrument has no such
// coordinate, never zero.
type InstrumentRef struct {
	VenueID    string     `json:"venue_id"`
	MarketType string     `json:"market_type"`
	Base       string     `json:"base"`
	Quote      string     `json:"quote"`
	Expiry     *time.Time `json:"expiry,omitempty"`
	Strike     *float64   `json:"strike,omitempty"`
	OptionType string     `json:"option_type,omitempty"`
}

// SeriesQuery selects series by domain, metric and/or subject key. Empty
// fields are wildcards.
type SeriesQuery struct {
	Domain     string `json:"domain,omitempty"`
	Metric     string `json:"metric,omitempty"`
	SubjectKey string `json:"subject_key,omitempty"`
	// Optional entity anchors: when set, the query narrows to series bound to
	// that entity.
	CountryID    string `json:"country_id,omitempty"`
	AssetID      string `json:"asset_id,omitempty"`
	InstrumentID string `json:"instrument_id,omitempty"`
	ChainID      string `json:"chain_id,omitempty"`
	ProtocolID   string `json:"protocol_id,omitempty"`
	VenueID      string `json:"venue_id,omitempty"`
	Limit        int    `json:"limit,omitempty"`
}

// PoolQuery selects pools by chain, DEX venue, base and/or quote asset symbol.
// Empty fields are wildcards.
type PoolQuery struct {
	ChainID         string  `json:"chain_id,omitempty"`
	DEXID           string  `json:"dex_id,omitempty"`
	Base            string  `json:"base,omitempty"`
	Quote           string  `json:"quote,omitempty"`
	MinLiquidityUSD float64 `json:"min_liquidity_usd,omitempty"`
	Limit           int     `json:"limit,omitempty"`
}

// ChainRef names a chain by its canonical id or its lowercase name; a resolver
// accepts either, since the natural key is derived from the name.
type ChainRef struct {
	ChainID string `json:"chain_id,omitempty"`
	Name    string `json:"name,omitempty"`
}

// JobRef identifies one dataset job without loading it: the (provider,
// dataset, subject, mode) tuple that data.job keys on.
type JobRef struct {
	Provider string `json:"provider"`
	Dataset  string `json:"dataset"`
	Subject  string `json:"subject,omitempty"`
	Mode     string `json:"mode,omitempty"`
}

// ListQuery is the common shape of the entity list endpoints: page through a
// stable, naturally-ordered listing. Zero Limit means "provider default".
type ListQuery struct {
	Limit  int    `json:"limit,omitempty"`
	Offset int    `json:"offset,omitempty"`
	Search string `json:"search,omitempty"`
}

// InstrumentQuery selects instruments by venue and/or market type, optionally
// narrowed to one base/quote pair. Empty fields are wildcards.
type InstrumentQuery struct {
	VenueID    string `json:"venue_id,omitempty"`
	MarketType string `json:"market_type,omitempty"`
	Base       string `json:"base,omitempty"`
	Quote      string `json:"quote,omitempty"`
	Limit      int    `json:"limit,omitempty"`
	Offset     int    `json:"offset,omitempty"`
}

// Ohlcv is one Open/High/Low/Close/Volume bar for one instrument on one venue.
type Ohlcv struct {
	InstrumentID string    `json:"instrument_id"`
	VenueID      string    `json:"venue_id"`
	Timeframe    string    `json:"timeframe"`
	OpenTime     time.Time `json:"open_time"`
	CloseTime    time.Time `json:"close_time"`
	O            float64   `json:"o"`
	H            float64   `json:"h"`
	L            float64   `json:"l"`
	C            float64   `json:"c"`
	VolumeBase   *float64  `json:"volume_base"`
	VolumeQuote  *float64  `json:"volume_quote"`
	TradeCount   *int64    `json:"trade_count"`
	VWAP         *float64  `json:"vwap"`
	Source       string    `json:"source"`
	RetrievedAt  time.Time `json:"retrieved_at"`
}

// Trade is one executed trade.
type Trade struct {
	InstrumentID    string    `json:"instrument_id"`
	VenueID         string    `json:"venue_id"`
	ProviderTradeID string    `json:"provider_trade_id"`
	TradeTime       time.Time `json:"trade_time"`
	Price           float64   `json:"price"`
	Quantity        float64   `json:"quantity"`
	Side            *string   `json:"side"`
	Aggressor       *string   `json:"aggressor"`
	Source          string    `json:"source"`
	RetrievedAt     time.Time `json:"retrieved_at"`
}

// Quote is one best bid/ask snapshot for one instrument on one venue.
type Quote struct {
	InstrumentID string    `json:"instrument_id"`
	VenueID      string    `json:"venue_id"`
	At           time.Time `json:"at"`
	Bid          *float64  `json:"bid"`
	Ask          *float64  `json:"ask"`
	BidSize      *float64  `json:"bid_size"`
	AskSize      *float64  `json:"ask_size"`
	Last         *float64  `json:"last"`
	Source       string    `json:"source"`
	RetrievedAt  time.Time `json:"retrieved_at"`
}

// OrderbookSnap is one depth snapshot: both sides as price/size pairs.
type OrderbookSnap struct {
	InstrumentID string       `json:"instrument_id"`
	VenueID      string       `json:"venue_id"`
	At           time.Time    `json:"at"`
	Depth        int          `json:"depth"`
	Bids         [][2]float64 `json:"bids"`
	Asks         [][2]float64 `json:"asks"`
	Source       string       `json:"source"`
	RetrievedAt  time.Time    `json:"retrieved_at"`
}

// Ticker is one 24h rolling statistics snapshot for one instrument.
type Ticker struct {
	InstrumentID   string    `json:"instrument_id"`
	VenueID        string    `json:"venue_id"`
	At             time.Time `json:"at"`
	Last           *float64  `json:"last"`
	Bid            *float64  `json:"bid"`
	Ask            *float64  `json:"ask"`
	BidSize        *float64  `json:"bid_size"`
	AskSize        *float64  `json:"ask_size"`
	Volume24hBase  *float64  `json:"volume_24h_base"`
	Volume24hQuote *float64  `json:"volume_24h_quote"`
	Change24hPct   *float64  `json:"change_24h_pct"`
	Source         string    `json:"source"`
	RetrievedAt    time.Time `json:"retrieved_at"`
}

// FundingRate is one funding settlement (or prediction) for one perpetual.
type FundingRate struct {
	InstrumentID string    `json:"instrument_id"`
	VenueID      string    `json:"venue_id"`
	FundingTime  time.Time `json:"funding_time"`
	Rate         float64   `json:"rate"`
	Cap          *float64  `json:"cap"`
	Source       string    `json:"source"`
	RetrievedAt  time.Time `json:"retrieved_at"`
}

// OpenInterest is one open-interest snapshot for one instrument.
type OpenInterest struct {
	InstrumentID     string    `json:"instrument_id"`
	VenueID          string    `json:"venue_id"`
	OIAt             time.Time `json:"oi_at"`
	OpenInterestUSD  *float64  `json:"open_interest_usd"`
	OpenInterestBase *float64  `json:"open_interest_base"`
	Source           string    `json:"source"`
	RetrievedAt      time.Time `json:"retrieved_at"`
}

// Liquidation is one liquidation event.
type Liquidation struct {
	InstrumentID string    `json:"instrument_id"`
	VenueID      string    `json:"venue_id"`
	At           time.Time `json:"at"`
	Side         *string   `json:"side"`
	Price        *float64  `json:"price"`
	Quantity     *float64  `json:"quantity"`
	ValueUSD     *float64  `json:"value_usd"`
	Source       string    `json:"source"`
	RetrievedAt  time.Time `json:"retrieved_at"`
}

// Observation is one value of one economic/metric series at one period, under
// one revision. A nil Value is a REAL row: the provider published the period
// but the value is absent (never-fake: absent becomes NULL, never 0).
type Observation struct {
	SeriesID    string     `json:"series_id"`
	Period      string     `json:"period"`
	ObservedAt  time.Time  `json:"observed_at"`
	Value       *float64   `json:"value"`
	Revision    string     `json:"revision"`
	Vintage     *time.Time `json:"vintage"`
	Source      string     `json:"source"`
	RetrievedAt time.Time  `json:"retrieved_at"`
}

// SeriesMeta describes one series: what it measures, about what subject, from
// whom, under which schema. The entity anchors (CountryID..VenueID) are the
// canonical ids the subject key encodes, surfaced as columns for querying.
type SeriesMeta struct {
	SeriesID             string     `json:"series_id"`
	Domain               string     `json:"domain"`
	Metric               string     `json:"metric"`
	SubjectKey           string     `json:"subject_key"`
	Title                *string    `json:"title"`
	Unit                 *string    `json:"unit"`
	Frequency            string     `json:"frequency"`
	CountryID            *string    `json:"country_id"`
	AssetID              *string    `json:"asset_id"`
	InstrumentID         *string    `json:"instrument_id"`
	ChainID              *string    `json:"chain_id"`
	ProtocolID           *string    `json:"protocol_id"`
	VenueID              *string    `json:"venue_id"`
	Source               string     `json:"source"`
	Provider             string     `json:"provider"`
	ProviderSeriesID     string     `json:"provider_series_id"`
	Revision             string     `json:"revision"`
	IsDerived            bool       `json:"is_derived"`
	SchemaVersion        string     `json:"schema_version"`
	NormalizationVersion string     `json:"normalization_version"`
	CreatedAt            *time.Time `json:"created_at,omitempty"`
	UpdatedAt            *time.Time `json:"updated_at,omitempty"`
}

// ProtocolTVL is one total-value-locked observation for one protocol, on one
// chain or chain-aggregated (empty ChainID).
type ProtocolTVL struct {
	ProtocolID string    `json:"protocol_id"`
	ChainID    string    `json:"chain_id"`
	TVLUSD     float64   `json:"tvl_usd"`
	At         time.Time `json:"at"`
	Source     string    `json:"source"`
}

// ChainTVL is one total-value-locked observation for one chain.
type ChainTVL struct {
	ChainID string    `json:"chain_id"`
	TVLUSD  float64   `json:"tvl_usd"`
	At      time.Time `json:"at"`
	Source  string    `json:"source"`
}

// Pool is one DEX liquidity pool at one point in time. Optional fields are nil
// when the provider did not report them (never-fake).
type Pool struct {
	PoolID       string    `json:"pool_id"`
	ChainID      string    `json:"chain_id"`
	DEXVenueID   string    `json:"dex_venue_id"`
	Address      string    `json:"address"`
	BaseAssetID  *string   `json:"base_asset_id"`
	QuoteAssetID *string   `json:"quote_asset_id"`
	FeeTierBps   *int      `json:"fee_tier_bps"`
	Price        *float64  `json:"price"`
	LiquidityUSD *float64  `json:"liquidity_usd"`
	Volume24hUSD *float64  `json:"volume_24h_usd"`
	FdvUsd       *float64  `json:"fdv_usd"`
	At           time.Time `json:"at"`
	Source       string    `json:"source"`
	RetrievedAt  time.Time `json:"retrieved_at"`
}

// SupplySnapshot is one token supply reading for one contract on one chain.
// Absent supply kinds stay nil: NULL, never 0.
type SupplySnapshot struct {
	ChainID           string    `json:"chain_id"`
	Address           string    `json:"address"`
	AssetID           *string   `json:"asset_id"`
	TotalSupply       *float64  `json:"total_supply"`
	CirculatingSupply *float64  `json:"circulating_supply"`
	At                time.Time `json:"at"`
	Source            string    `json:"source"`
}

// MetricPoint is one derived datapoint of a series: the row shape of the
// data.metric table. Meta carries whatever the deriving job wants to record.
type MetricPoint struct {
	At     time.Time      `json:"at"`
	Value  *float64       `json:"value"`
	Meta   map[string]any `json:"meta,omitempty"`
	Source string         `json:"source"`
}
