package cryptorank

// Types mirror apps/web/lib/cryptorank.ts's Cr* interfaces exactly: the JSON
// tags are the wire contract (another session is writing a client against
// them). `undefined` in TS means "absent from JSON.stringify" and maps to
// `omitempty` here; `| null` is a present null and must NOT be omitted.

type CrGlobal struct {
	TotalMarketCap              *float64 `json:"totalMarketCap"`
	TotalMarketCapChangePercent *float64 `json:"totalMarketCapChangePercent"`
	TotalVolume24h              *float64 `json:"totalVolume24h"`
	TotalVolume24hChangePercent *float64 `json:"totalVolume24hChangePercent"`
	BtcDominance                *float64 `json:"btcDominance"`
	BtcDominanceChangePercent   *float64 `json:"btcDominanceChangePercent"`
	EthDominance                *float64 `json:"ethDominance"`
	EthDominanceChangePercent   *float64 `json:"ethDominanceChangePercent"`
	AllCurrencies               *float64 `json:"allCurrencies"`
	GasGwei                     *float64 `json:"gasGwei"`
}

type CrCoin struct {
	Rank         *float64 `json:"rank"`
	Key          string   `json:"key"`
	Name         string   `json:"name"`
	Symbol       string   `json:"symbol"`
	Image        *string  `json:"image"`
	PriceUsd     *float64 `json:"priceUsd"`
	MarketCap    *float64 `json:"marketCap"`
	Volume24hUsd *float64 `json:"volume24hUsd"`
	Category     *string  `json:"category"`
	ListingDate  *string  `json:"listingDate"`
	LifeCycle    *string  `json:"lifeCycle"`
	AthUsd       *float64 `json:"athUsd"`
	Change24h    *float64 `json:"change24h"`
	// listings widget only: derived from histPrices['7D'] anchor.
	Change7d *float64 `json:"change7d,omitempty"`
}

type CrTrendingRow struct {
	Rank         *float64 `json:"rank"`
	Key          string   `json:"key"`
	Name         string   `json:"name"`
	Symbol       string   `json:"symbol"`
	Image        *string  `json:"image"`
	PriceUsd     *float64 `json:"priceUsd"`
	Change24h    *float64 `json:"change24h"`
	MarketCap    *float64 `json:"marketCap"`
	Volume24hUsd *float64 `json:"volume24hUsd"`
	High24h      *float64 `json:"high24h"`
	Low24h       *float64 `json:"low24h"`
}

type CrFundingRound struct {
	Date         *string  `json:"date"`
	Type         *string  `json:"type"`
	RaiseUsd     *float64 `json:"raiseUsd"`
	ValuationUsd *float64 `json:"valuationUsd"`
	CoinName     *string  `json:"coinName"`
	CoinKey      *string  `json:"coinKey"`
	CoinIcon     *string  `json:"coinIcon"`
	Funds        []string `json:"funds"`
}

type CrUpcomingIco struct {
	Name     *string  `json:"name"`
	Symbol   *string  `json:"symbol"`
	Key      *string  `json:"key"`
	Platform *string  `json:"platform"`
	RaiseUsd *float64 `json:"raiseUsd"`
	Date     *string  `json:"date"`
}

type CrExchangeRow struct {
	Rank            *float64 `json:"rank"`
	Key             string   `json:"key"`
	Name            string   `json:"name"`
	Image           *string  `json:"image"`
	DayVolUsd       *float64 `json:"dayVolUsd"`
	WeekVolUsd      *float64 `json:"weekVolUsd"`
	MonthVolUsd     *float64 `json:"monthVolUsd"`
	PercentVolume   *float64 `json:"percentVolume"`
	PairsCount      *float64 `json:"pairsCount"`
	CurrenciesCount *float64 `json:"currenciesCount"`
	ExchangeType    *string  `json:"exchangeType"`
}

// CrExchangeTransparencyRow is the same interface with the reserve columns
// present (the cex-transparency variant is a different schema upstream, so the
// optional columns must be emitted, as null or value, on exactly that variant).
type CrExchangeTransparencyRow struct {
	CrExchangeRow
	ReservesUsd        *float64 `json:"reservesUsd"`
	CleanReservesUsd   *float64 `json:"cleanReservesUsd"`
	StablecoinsPercent *float64 `json:"stablecoinsPercent"`
	WalletsCount       *float64 `json:"walletsCount"`
	AuditorName        *string  `json:"auditorName"`
	AuditDate          *string  `json:"auditDate"`
}

// CrListingCoin is the listings-widget coin: identical to CrCoin plus a
// present `change7d` (TS's shapeListing returns `{...shapeCoin, change7d}`).
type CrListingCoin struct {
	CrCoin
	Change7d *float64 `json:"change7d"`
}

type CrCoinDetail struct {
	Key                   string   `json:"key"`
	Name                  string   `json:"name"`
	Symbol                string   `json:"symbol"`
	Image                 *string  `json:"image"`
	PriceUsd              *float64 `json:"priceUsd"`
	Change24h             *float64 `json:"change24h"`
	MarketCap             *float64 `json:"marketCap"`
	FullyDilutedMarketCap *float64 `json:"fullyDilutedMarketCap"`
	Volume24h             *float64 `json:"volume24h"`
	AvailableSupply       *float64 `json:"availableSupply"`
	TotalSupply           *float64 `json:"totalSupply"`
	MaxSupply             *float64 `json:"maxSupply"`
	CirculatingPct        *float64 `json:"circulatingPct"`
	AthUsd                *float64 `json:"athUsd"`
	AthDate               *string  `json:"athDate"`
	AtlUsd                *float64 `json:"atlUsd"`
	AtlDate               *string  `json:"atlDate"`
	FromAthPct            *float64 `json:"fromAthPct"`
	FromAtlPct            *float64 `json:"fromAtlPct"`
	ListingDate           *string  `json:"listingDate"`
	LifeCycle             *string  `json:"lifeCycle"`
	Rank                  *float64 `json:"rank"`
}

type CrChainRow struct {
	Slug        string   `json:"slug"`
	Name        string   `json:"name"`
	Image       *string  `json:"image"`
	Network     *string  `json:"network"`
	ExplorerURL *string  `json:"explorerUrl"`
	MarketCap   *float64 `json:"marketCap"`
}

type CrChainInfo struct {
	Slug        string   `json:"slug"`
	Name        string   `json:"name"`
	Network     *string  `json:"network"`
	MarketCap   *float64 `json:"marketCap"`
	ExplorerURL *string  `json:"explorerUrl"`
	Ecosystem   *string  `json:"ecosystem"`
}

// RelatedCoin is the news row's relatedCoins snapshot.
type RelatedCoin struct {
	Symbol    string   `json:"symbol"`
	PriceUsd  *float64 `json:"priceUsd"`
	Change24h *float64 `json:"change24h"`
}

type CrNewsRow struct {
	ID              *float64      `json:"id"`
	Title           string        `json:"title"`
	URL             *string       `json:"url"`
	Source          *string       `json:"source"`
	Date            *string       `json:"date"`
	Status          *string       `json:"status"`
	ReadingMinutes  *float64      `json:"readingMinutes"`
	IsAdvertisement bool          `json:"isAdvertisement"`
	RelatedCoins    []RelatedCoin `json:"relatedCoins"`
}

type CrLaunchpoolRow struct {
	Key           string   `json:"key"`
	Name          string   `json:"name"`
	Symbol        string   `json:"symbol"`
	Category      *string  `json:"category"`
	TotalRaiseUsd *float64 `json:"totalRaiseUsd"`
	PriceUsd      *float64 `json:"priceUsd"`
	Launchpads    []string `json:"launchpads"`
	When          *string  `json:"when"`
	Till          *string  `json:"till"`
}

type CrNodeSaleRow struct {
	Key              string   `json:"key"`
	Name             string   `json:"name"`
	Symbol           string   `json:"symbol"`
	Image            *string  `json:"image"`
	Category         *string  `json:"category"`
	When             *string  `json:"when"`
	Till             *string  `json:"till"`
	NodePriceFromUsd *float64 `json:"nodePriceFromUsd"`
	NodePriceToUsd   *float64 `json:"nodePriceToUsd"`
	RaiseUsd         *float64 `json:"raiseUsd"`
	TotalRaiseUsd    *float64 `json:"totalRaiseUsd"`
}

type CrEcosystemRow struct {
	Key                   string   `json:"key"`
	Name                  string   `json:"name"`
	Logo                  *string  `json:"logo"`
	Projects              *float64 `json:"projects"`
	ProjectsChange3m      *float64 `json:"projectsChange3m"`
	MarketCapUsd          *float64 `json:"marketCapUsd"`
	MarketCapChange24hPct *float64 `json:"marketCapChange24hPct"`
	TvlUsd                *float64 `json:"tvlUsd"`
	TvlChange24hPct       *float64 `json:"tvlChange24hPct"`
	Tags                  []string `json:"tags"`
}

type EcoBlockchain struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

type EcoCoin struct {
	Key       string   `json:"key"`
	Name      string   `json:"name"`
	Symbol    string   `json:"symbol"`
	PriceUsd  *float64 `json:"priceUsd"`
	Change24h *float64 `json:"change24h"`
}

type CrEcosystemInfo struct {
	Slug        string         `json:"slug"`
	Name        string         `json:"name"`
	Description *string        `json:"description"`
	Blockchain  *EcoBlockchain `json:"blockchain"`
	Coin        *EcoCoin       `json:"coin"`
}

type CrRwaRow struct {
	Rank                  *float64 `json:"rank"`
	Slug                  string   `json:"slug"`
	DetailKey             string   `json:"detailKey"`
	Ticker                string   `json:"ticker"`
	Name                  string   `json:"name"`
	Type                  string   `json:"type"`
	Image                 *string  `json:"image"`
	PriceUsd              *float64 `json:"priceUsd"`
	Change24h             *float64 `json:"change24h"`
	Change7d              *float64 `json:"change7d"`
	MarketCapUsd          *float64 `json:"marketCapUsd"`
	Volume24hUsd          *float64 `json:"volume24hUsd"`
	TokenizedPriceUsd     *float64 `json:"tokenizedPriceUsd"`
	TokenizedMcapUsd      *float64 `json:"tokenizedMcapUsd"`
	TokenizedVolume24hUsd *float64 `json:"tokenizedVolume24hUsd"`
	IsLeveraged           bool     `json:"isLeveraged"`
	MarketState           *string  `json:"marketState"`
	MainTokenKey          *string  `json:"mainTokenKey"`
}

type CrRwaAsset struct {
	Slug           string   `json:"slug"`
	DetailKey      string   `json:"detailKey"`
	Ticker         string   `json:"ticker"`
	Name           string   `json:"name"`
	Type           string   `json:"type"`
	Image          *string  `json:"image"`
	PriceUsd       *float64 `json:"priceUsd"`
	Change24h      *float64 `json:"change24h"`
	Change24hAbs   *float64 `json:"change24hAbs"`
	MarketState    *string  `json:"marketState"`
	Currency       *string  `json:"currency"`
	QuoteUpdatedAt *string  `json:"quoteUpdatedAt"`
	IsLeveraged    bool     `json:"isLeveraged"`
	Country        *string  `json:"country"`
	Exchange       *string  `json:"exchange"`
	Sector         *string  `json:"sector"`
	Industry       *string  `json:"industry"`
	Website        *string  `json:"website"`
}

type CrQuarterQ struct {
	OpenUsd  *float64 `json:"openUsd"`
	CloseUsd *float64 `json:"closeUsd"`
	IsFull   bool     `json:"isFull"`
}

type CrQuarterlyYear struct {
	Year *float64    `json:"year"`
	Q1   *CrQuarterQ `json:"q1"`
	Q2   *CrQuarterQ `json:"q2"`
	Q3   *CrQuarterQ `json:"q3"`
	Q4   *CrQuarterQ `json:"q4"`
}

type PredictionPlatform struct {
	Platform        string   `json:"platform"`
	VolumeUsd       *float64 `json:"volumeUsd"`
	MarketsCount    *float64 `json:"marketsCount"`
	OpenInterestUsd *float64 `json:"openInterestUsd"`
}

type CrPredictionAgg struct {
	TotalVolumeUsd   *float64             `json:"totalVolumeUsd"`
	VolumeChangePct  *float64             `json:"volumeChangePct"`
	MarketsCount     *float64             `json:"marketsCount"`
	MarketsChangePct *float64             `json:"marketsChangePct"`
	OpenInterestUsd  *float64             `json:"openInterestUsd"`
	OiChangePct      *float64             `json:"oiChangePct"`
	Platforms        []PredictionPlatform `json:"platforms"`
}

type CrPredictionRow struct {
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	Platform     *string  `json:"platform"`
	Category     *string  `json:"category"`
	EndDate      *string  `json:"endDate"`
	Volume24hUsd *float64 `json:"volume24hUsd"`
	Bid          *float64 `json:"bid"`
	Ask          *float64 `json:"ask"`
	Spread       *float64 `json:"spread"`
	ExternalURL  *string  `json:"externalUrl"`
}

type RankedCoin struct {
	Name string  `json:"name"`
	Key  *string `json:"key"`
}

type CrTagRow struct {
	ID          *float64     `json:"id"`
	Slug        string       `json:"slug"`
	Name        string       `json:"name"`
	Description *string      `json:"description"`
	MarketCap   *float64     `json:"marketCap"`
	Volume24h   *float64     `json:"volume24h"`
	Dominance   *float64     `json:"dominance"`
	Gainers     *float64     `json:"gainers"`
	Losers      *float64     `json:"losers"`
	Change24h   *float64     `json:"change24h"`
	RankedCoins []RankedCoin `json:"rankedCoins"`
}

type CrTagInfo struct {
	Slug     string  `json:"slug"`
	Name     string  `json:"name"`
	Subtitle *string `json:"subtitle"`
}

type CrConverterRow struct {
	Key      string   `json:"key"`
	Name     string   `json:"name"`
	Symbol   string   `json:"symbol"`
	Icon     *string  `json:"icon"`
	PriceUsd *float64 `json:"priceUsd"`
}

type CrMediaRow struct {
	ID              string   `json:"id"`
	Title           string   `json:"title"`
	ChannelTitle    *string  `json:"channelTitle"`
	PublishedAt     *string  `json:"publishedAt"`
	DurationSeconds *float64 `json:"durationSeconds"`
	Tags            []string `json:"tags"`
}

type AiMarket struct {
	Summary   *string `json:"summary"`
	UpdatedAt *string `json:"updatedAt"`
}

type AiNews struct {
	ID        *float64 `json:"id"`
	Title     string   `json:"title"`
	Date      *string  `json:"date"`
	IsBullish *bool    `json:"isBullish"`
}

type AiFundingRound struct {
	Key       *string  `json:"key"`
	Name      string   `json:"name"`
	Stage     *string  `json:"stage"`
	RaisedUsd *float64 `json:"raisedUsd"`
}

type AiFunding struct {
	Summary *string          `json:"summary"`
	Rounds  []AiFundingRound `json:"rounds"`
}

type AiActivity struct {
	Key      string  `json:"key"`
	Type     *string `json:"type"`
	CoinName *string `json:"coinName"`
}

type AiDropHunting struct {
	Summary    *string      `json:"summary"`
	Activities []AiActivity `json:"activities"`
}

type AiUnlock struct {
	Date          *string  `json:"date"`
	UnlockPercent *float64 `json:"unlockPercent"`
	CoinName      *string  `json:"coinName"`
}

type AiVesting struct {
	Summary *string    `json:"summary"`
	Unlocks []AiUnlock `json:"unlocks"`
}

type CrAiOverview struct {
	Market      AiMarket      `json:"market"`
	News        []AiNews      `json:"news"`
	Funding     AiFunding     `json:"funding"`
	DropHunting AiDropHunting `json:"dropHunting"`
	Vesting     AiVesting     `json:"vesting"`
}

type CrCategoryInfo struct {
	Slug    string   `json:"slug"`
	Name    string   `json:"name"`
	Gainers *float64 `json:"gainers"`
	Losers  *float64 `json:"losers"`
}

type AnchorCount struct {
	RecentlyAdded int `json:"recentlyAdded"`
	MostSearched  int `json:"mostSearched"`
	MostVisited   int `json:"mostVisited"`
}

type Listings struct {
	RecentlyAdded []CrListingCoin `json:"recentlyAdded"`
	MostSearched  []CrListingCoin `json:"mostSearched"`
	MostVisited   []CrListingCoin `json:"mostVisited"`
}

type RelatedTag struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// CrEnvelope is the wire envelope. Optional fields use omitempty to reproduce
// TS's "undefined keys are absent"; nullable-everywhere fields deliberately do
// not, so nulls stay present.
type CrEnvelope struct {
	Kind     string `json:"kind"`
	Upstream string `json:"upstream"`
	// Actual data route fetched (disabled modes only; live HTML modes omit it).
	DataRoute *string `json:"dataRoute,omitempty"`
	FetchedAt int64   `json:"fetchedAt"`
	Cache     string  `json:"cache"`
	Count     int     `json:"count"`
	// Full upstream table size when the page states it (trending: 266).
	UpstreamTotal *Num `json:"upstreamTotal,omitempty"`
	// Slice provenance: homepage slices are partial BY DESIGN.
	Slice *string `json:"slice,omitempty"`
	// How change24h was obtained for this payload.
	ChangeSource *string `json:"changeSource,omitempty"`
	// listings only: rows whose histPrices anchor upstream actually shipped.
	Anchor24h *AnchorCount `json:"anchor24h,omitempty"`
	Anchor7d  *AnchorCount `json:"anchor7d,omitempty"`

	Global        *CrGlobal        `json:"global,omitempty"`
	FundingRounds []CrFundingRound `json:"fundingRounds,omitempty"`
	UpcomingIco   []CrUpcomingIco  `json:"upcomingIco,omitempty"`
	Category      *CrCategoryInfo  `json:"category,omitempty"`
	TagRows       []CrTagRow       `json:"tagRows,omitempty"`
	Tag           *CrTagInfo       `json:"tag,omitempty"`
	Detail        *CrCoinDetail    `json:"detail,omitempty"`
	Chain         *CrChainInfo     `json:"chain,omitempty"`
	ChainRows     []CrChainRow     `json:"chainRows,omitempty"`
	Listings      *Listings        `json:"listings,omitempty"`

	LaunchpoolRows []CrLaunchpoolRow `json:"launchpoolRows,omitempty"`
	NodesaleRows   []CrNodeSaleRow   `json:"nodesaleRows,omitempty"`
	EcosystemRows  []CrEcosystemRow  `json:"ecosystemRows,omitempty"`
	Ecosystem      *CrEcosystemInfo  `json:"ecosystem,omitempty"`
	RwaRows        []CrRwaRow        `json:"rwaRows,omitempty"`
	RwaAsset       *CrRwaAsset       `json:"rwaAsset,omitempty"`
	QuarterlyBtc   []CrQuarterlyYear `json:"quarterlyBtc,omitempty"`
	QuarterlyEth   []CrQuarterlyYear `json:"quarterlyEth,omitempty"`
	Prediction     *CrPredictionAgg  `json:"prediction,omitempty"`
	PredictionRows []CrPredictionRow `json:"predictionRows,omitempty"`
	NewsRows       []CrNewsRow       `json:"newsRows,omitempty"`
	ConverterRows  []CrConverterRow  `json:"converterRows,omitempty"`
	MediaRows      []CrMediaRow      `json:"mediaRows,omitempty"`
	RelatedTags    []RelatedTag      `json:"relatedTags,omitempty"`
	AiOverview     *CrAiOverview     `json:"aiOverview,omitempty"`

	// Union of the three shared row shapes, discriminated by which keys they
	// carry (CrCoin / CrTrendingRow / CrExchangeRow). Encoded custom so the
	// per-mode key sets match TS exactly: `change7d` (listings-only, optional)
	// and the exchange reserve variant's optional columns.
	Rows []Row `json:"rows,omitempty"`
}
