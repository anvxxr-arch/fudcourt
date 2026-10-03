package cryptorank

import (
	"math"
	"strings"
	"time"
)

/* ------------------------------- shaping ------------------------------- */
//
// Port of lib/shapers.ts's shape functions. Each function mirrors its TS
// original expression-for-expression so the emitted JSON is byte-compatible:
// `??` is nullish (never falsy), `typeof x === 'string'` keeps empty strings,
// and an absent upstream value becomes null rather than 0.

// ShapeCoin is shapeCoin.
func ShapeCoin(r map[string]interface{}, change24h *float64) CrCoin {
	ath := obj(r["athPrice"])

	return CrCoin{
		Rank:         asNum(r["rank"]),
		Key:          strOr(r["key"], ""),
		Name:         strOr(nullish(r["name"], r["fullName"]), ""),
		Symbol:       strOr(r["symbol"], ""),
		Image:        asStr(r["image"]),
		PriceUsd:     asPriceUsd(r["price"]),
		MarketCap:    asNum(r["marketCap"]),
		Volume24hUsd: numOrNull(r["volume24hUsd"], r["volume24h"]),
		Category:     categoryName(r["category"]),
		ListingDate:  asStr(r["listingDate"]),
		LifeCycle:    asStr(r["lifeCycle"]),
		AthUsd:       athPrice(ath),
		Change24h:    change24h,
	}
}

func categoryName(v interface{}) *string {
	m := obj(v)
	if m == nil {
		return nil
	}
	s, ok := m["name"].(string)
	if !ok {
		return nil
	}
	return &s
}

func athPrice(ath map[string]interface{}) *float64 {
	if ath == nil {
		return nil
	}
	return asPriceUsd(ath)
}

// ChangeFromAnchor is changeFromAnchor: 24h change from upstream's own
// histPrices['24H'].USD anchor (the price 24h ago).
func ChangeFromAnchor(r map[string]interface{}) *float64 {
	anchor := asNum(field(field(r["histPrices"], "24H"), "USD"))
	now := asNum(field(r["price"], "USD"))
	if anchor == nil || now == nil || *anchor == 0 {
		return nil
	}
	return ptr(((*now - *anchor) / *anchor) * 100)
}

// ShapeListing is shapeListing: listings widgets may ship the price only in
// price.USD or only in priceUsd; chg24h/chg7d are derived from the histPrices
// anchors where shipped.
func ShapeListing(r map[string]interface{}) CrListingCoin {
	var price *float64
	if p := asPriceUsd(r["price"]); p != nil {
		price = p
	} else {
		price = asNum(r["priceUsd"])
	}
	hist := objOrEmpty(r["histPrices"])
	chg := func(period string) *float64 {
		a := asNum(field(hist[period], "USD"))
		if a != nil && price != nil && *a != 0 {
			return ptr(((*price - *a) / *a) * 100)
		}
		return nil
	}
	coin := ShapeCoin(r, nil)
	coin.PriceUsd = price
	coin.Change24h = chg("24H")
	c7 := chg("7D")
	return CrListingCoin{CrCoin: coin, Change7d: c7}
}

// ShapeChainRow is shapeChainRow (/blockchains index row).
func ShapeChainRow(r map[string]interface{}) CrChainRow {
	images := objOrEmpty(r["images"])
	return CrChainRow{
		Slug:        strOr(nullish(r["slug"], r["key"]), ""),
		Name:        strOr(r["name"], ""),
		Image:       stringOf(images["x60"], r["image"]),
		Network:     stringOf(r["tokenPlatformName"], r["network"]),
		ExplorerURL: asStr(r["explorerUrl"]),
		MarketCap:   asNum(r["marketCap"]),
	}
}

// ShapeGlobal is shapeGlobal.
func ShapeGlobal(pp map[string]interface{}) CrGlobal {
	init := objOrEmpty(pp["initData"])
	g := objOrEmpty(init["globalData"])
	gas := objOrEmpty(g["gas"])
	avg := objOrEmpty(gas["average"])
	return CrGlobal{
		TotalMarketCap:              asNum(g["totalMarketCap"]),
		TotalMarketCapChangePercent: asNum(g["totalMarketCapChangePercent"]),
		TotalVolume24h:              asNum(g["totalVolume24h"]),
		TotalVolume24hChangePercent: asNum(g["totalVolume24hChangePercent"]),
		BtcDominance:                asNum(g["btcDominance"]),
		BtcDominanceChangePercent:   asNum(g["btcDominanceChangePercent"]),
		EthDominance:                asNum(g["ethDominance"]),
		EthDominanceChangePercent:   asNum(g["ethDominanceChangePercent"]),
		AllCurrencies:               asNum(g["allCurrencies"]),
		GasGwei:                     asNum(avg["gasPriceGwei"]),
	}
}

// ShapeFunding is shapeFunding.
func ShapeFunding(r map[string]interface{}) CrFundingRound {
	coin := objOrEmpty(r["coin"])
	funds := dictArray(r["funds"])
	out := CrFundingRound{
		Date:         asStrOrDash(r["date"]),
		Type:         asStrOrDash(r["type"]),
		RaiseUsd:     asNum(r["raise"]),
		ValuationUsd: asNum(r["valuation"]),
		CoinName:     asStrOrDash(coin["name"]),
		CoinKey:      asStr(coin["key"]),
		CoinIcon:     asStr(coin["icon"]),
		Funds:        []string{},
	}
	for _, f := range funds {
		if n := asStrOrDash(f["name"]); n != nil {
			out.Funds = append(out.Funds, *n)
		}
	}
	return out
}

// ShapeIco is shapeIco.
func ShapeIco(r map[string]interface{}) CrUpcomingIco {
	coin := objOrEmpty(r["coin"])
	platform := objOrEmpty(r["platform"])
	return CrUpcomingIco{
		Name:     asStrOrDash(coin["name"]),
		Symbol:   asStrOrDash(coin["symbol"]),
		Key:      asStr(coin["key"]),
		Platform: asStrOrDash(platform["name"]),
		RaiseUsd: asNum(r["raise"]),
		Date:     asStr(r["date"]),
	}
}

// ShapeTrending is shapeTrending.
func ShapeTrending(r map[string]interface{}) CrTrendingRow {
	return CrTrendingRow{
		Rank:         asNum(r["rank"]),
		Key:          strOr(r["key"], ""),
		Name:         strOr(r["name"], ""),
		Symbol:       strOr(r["symbol"], ""),
		Image:        asStr(r["image"]),
		PriceUsd:     asPriceUsd(r["price"]),
		Change24h:    asNum(r["priceChange24h"]),
		MarketCap:    asNum(r["marketCap"]),
		Volume24hUsd: numOrNull(r["volume24hUsd"], r["volume24h"]),
		High24h:      asNum(r["highPrice24h"]),
		Low24h:       asNum(r["lowPrice24h"]),
	}
}

// ShapeExchange is shapeExchange (exchanges/cex/spot HTML: fallbackData, 50
// rows, cryptorank REPORTED volume).
func ShapeExchange(r map[string]interface{}, i int) CrExchangeRow {
	volumes := objOrEmpty(r["volumes"])
	return CrExchangeRow{
		Rank:            ptr(float64(i + 1)),
		Key:             rawString(r["key"]),
		Name:            rawString(r["name"]),
		Image:           rawStringPtr(r["icon"]),
		DayVolUsd:       asNum(obj(volumes["day"])["toUSD"]),
		WeekVolUsd:      asNum(obj(volumes["week"])["toUSD"]),
		MonthVolUsd:     asNum(obj(volumes["month"])["toUSD"]),
		PercentVolume:   asNum(r["percentVolume"]),
		PairsCount:      asNum(r["pairsCount"]),
		CurrenciesCount: asNum(r["currenciesCount"]),
		ExchangeType:    rawStringPtr(r["exchangeType"]),
	}
}

// rawString is TS's `typeof v === 'string' ? v : ”` (empty string survives).
func rawString(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// rawStringPtr is TS's `typeof v === 'string' ? v : null`.
func rawStringPtr(v interface{}) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

// ShapeCoinDetail is shapeCoinDetail (/price/<key> HTML).
func ShapeCoinDetail(pp map[string]interface{}, key string) CrCoinDetail {
	coin := objOrEmpty(pp["coin"])
	stats := objOrEmpty(pp["priceStatistics"])
	hist := objOrEmpty(coin["histPrices"])
	p24 := asNum(field(hist["24H"], "USD"))
	price := asPriceUsd(coin["price"])
	var change24h *float64
	if p24 != nil && price != nil && *p24 != 0 {
		change24h = ptr(((*price - *p24) / *p24) * 100)
	}
	return CrCoinDetail{
		Key:                   key,
		Name:                  rawString(coin["name"]),
		Symbol:                rawString(coin["symbol"]),
		Image:                 rawStringPtr(coin["image"]),
		PriceUsd:              price,
		Change24h:             change24h,
		MarketCap:             numOrNull(stats["marketCap"], coin["marketCap"]),
		FullyDilutedMarketCap: asNum(stats["fullyDilutedMarketCap"]),
		Volume24h:             numOrNull(stats["volume24h"], coin["volume24h"]),
		AvailableSupply:       asNum(stats["availableSupply"]),
		TotalSupply:           asNum(stats["totalSupply"]),
		MaxSupply:             asNum(stats["maxSupply"]),
		CirculatingPct:        asNum(stats["availableSupplyPercent"]),
		AthUsd:                asPriceUsd(stats["athPrice"]),
		AthDate:               rawStringPtr(stats["athPriceDate"]),
		AtlUsd:                asPriceUsd(stats["atlPrice"]),
		AtlDate:               rawStringPtr(stats["atlPriceDate"]),
		FromAthPct:            asNum(stats["fromAthPrice"]),
		FromAtlPct:            asNum(stats["fromAtlPrice"]),
		ListingDate:           rawStringPtr(stats["listingDate"]),
		LifeCycle:             rawStringPtr(coin["lifeCycle"]),
		Rank:                  numOrNull(coin["rank"], coin["cRank"]),
	}
}

// ShapeLaunchpoolRow is shapeLaunchpoolRow: upstream ships price as a STRING
// (JS Number() coercion) and the window as ISO strings.
func ShapeLaunchpoolRow(r map[string]interface{}) CrLaunchpoolRow {
	var cat *string
	if c := obj(r["category"]); c != nil {
		cat = asStr(c["name"])
	}
	pads := []string{}
	for _, p := range dictArray(r["launchpads"]) {
		if n := asStr(p["name"]); n != nil {
			pads = append(pads, *n)
		}
	}
	var price *float64
	switch v := r["price"].(type) {
	case string, float64:
		pv, ok := jsNumber(jsString(v))
		if ok && !math.IsNaN(pv) && !math.IsInf(pv, 0) {
			price = ptr(pv)
		}
	}
	return CrLaunchpoolRow{
		Key:           strOr(r["key"], ""),
		Name:          strOr(r["name"], ""),
		Symbol:        strOr(r["symbol"], ""),
		Category:      cat,
		TotalRaiseUsd: asNum(r["totalRaise"]),
		PriceUsd:      price,
		Launchpads:    pads,
		When:          asStr(r["when"]),
		Till:          asStr(r["till"]),
	}
}

// ShapeNodesaleRow is shapeNodesaleRow (nodePriceFrom/To = upstream tier range
// in USD, NOT market price).
func ShapeNodesaleRow(r map[string]interface{}) CrNodeSaleRow {
	var cat *string
	if c := obj(r["category"]); c != nil {
		cat = asStr(c["name"])
	}
	return CrNodeSaleRow{
		Key:              strOr(r["key"], ""),
		Name:             strOr(r["name"], ""),
		Symbol:           strOr(r["symbol"], ""),
		Image:            asStr(r["image"]),
		Category:         cat,
		When:             asStr(r["when"]),
		Till:             asStr(r["till"]),
		NodePriceFromUsd: asNum(r["nodePriceFrom"]),
		NodePriceToUsd:   asNum(r["nodePriceTo"]),
		RaiseUsd:         asNum(r["raise"]),
		TotalRaiseUsd:    asNum(r["totalRaise"]),
	}
}

// ShapeEcosystemRow is shapeEcosystemRow.
func ShapeEcosystemRow(r map[string]interface{}) CrEcosystemRow {
	tags := []string{}
	if a, ok := r["tags"].([]interface{}); ok {
		for _, t := range a {
			var s string
			if str, ok := t.(string); ok {
				s = str
			} else if m := obj(t); m != nil {
				if v := asStr(m["name"]); v != nil {
					s = *v
				}
			}
			if s != "" {
				tags = append(tags, s)
			}
		}
	}
	return CrEcosystemRow{
		Key:                   strOr(r["key"], ""),
		Name:                  strOr(r["name"], ""),
		Logo:                  asStr(r["logo"]),
		Projects:              asNum(r["projects"]),
		ProjectsChange3m:      asNum(r["projectsChange3M"]),
		MarketCapUsd:          asNum(r["marketCap"]),
		MarketCapChange24hPct: asNum(r["marketCapChangePercent24H"]),
		TvlUsd:                asNum(r["tvl"]),
		TvlChange24hPct:       asNum(r["tvlChangePercent24H"]),
		Tags:                  tags,
	}
}

// ShapeEcosystemInfo is shapeEcosystemInfo.
func ShapeEcosystemInfo(pp map[string]interface{}, slug string) CrEcosystemInfo {
	info := objOrEmpty(pp["ecosystemData"])
	out := CrEcosystemInfo{
		Slug:        slug,
		Name:        strOr(info["name"], slug),
		Description: asStr(info["description"]),
	}
	if bc := obj(info["blockchain"]); bc != nil && asStr(bc["key"]) != nil {
		out.Blockchain = &EcoBlockchain{
			Key:  strOr(bc["key"], ""),
			Name: strOr(nullish(bc["name"], bc["key"]), ""),
		}
	}
	if coin := obj(info["coin"]); coin != nil && asStr(coin["key"]) != nil {
		out.Coin = &EcoCoin{
			Key:       strOr(coin["key"], ""),
			Name:      strOr(coin["name"], ""),
			Symbol:    strOr(coin["symbol"], ""),
			PriceUsd:  asNum(coin["priceUSD"]),
			Change24h: asNum(coin["priceChangePercent24H"]),
		}
	}
	return out
}

// RwaDetailKey is rwaDetailKey: upstream's detail path needs the PLURAL type
// segment (commodity -> commodities).
func RwaDetailKey(typ, slug string) string {
	var plural string
	switch typ {
	case "commodity":
		plural = "commodities"
	case "stock":
		plural = "stocks"
	case "etf":
		plural = "etfs"
	case "bond":
		plural = "bonds"
	default:
		plural = typ + "s"
	}
	return plural + "/" + slug
}

// ShapeRwaRow is shapeRwaRow.
func ShapeRwaRow(r map[string]interface{}) CrRwaRow {
	slug := strOr(r["slug"], "")
	typ := strOr(r["type"], "")
	detailKey := ""
	if slug != "" && typ != "" {
		detailKey = RwaDetailKey(typ, slug)
	}
	return CrRwaRow{
		Rank:                  asNum(r["rank"]),
		Slug:                  slug,
		DetailKey:             detailKey,
		Ticker:                strOr(r["ticker"], ""),
		Name:                  strOr(r["name"], ""),
		Type:                  typ,
		Image:                 asStr(r["image"]),
		PriceUsd:              asNum(r["price"]),
		Change24h:             asNum(r["change24h"]),
		Change7d:              asNum(r["change7d"]),
		MarketCapUsd:          asNum(r["marketCap"]),
		Volume24hUsd:          asNum(r["volume24h"]),
		TokenizedPriceUsd:     asNum(r["tokenizedPrice"]),
		TokenizedMcapUsd:      asNum(r["tokenizedMarketCap"]),
		TokenizedVolume24hUsd: asNum(r["tokenizedVolume24h"]),
		IsLeveraged:           r["isLeveraged"] == true,
		MarketState:           asStr(r["marketState"]),
		MainTokenKey:          asStr(r["mainTokenKey"]),
	}
}

// ShapeRwaAsset is shapeRwaAsset.
func ShapeRwaAsset(d map[string]interface{}, detailKey string) CrRwaAsset {
	info := objOrEmpty(d["info"])
	slug := strOr(d["slug"], "")
	if s := asStr(d["slug"]); s == nil {
		parts := strings.Split(detailKey, "/")
		slug = parts[len(parts)-1]
	}
	return CrRwaAsset{
		Slug:           slug,
		DetailKey:      detailKey,
		Ticker:         strOr(d["ticker"], ""),
		Name:           strOr(d["name"], ""),
		Type:           strOr(d["type"], ""),
		Image:          asStr(d["image"]),
		PriceUsd:       asNum(d["price"]),
		Change24h:      asNum(d["change24h"]),
		Change24hAbs:   asNum(d["change24hAbs"]),
		MarketState:    asStr(d["marketState"]),
		Currency:       asStr(d["currency"]),
		QuoteUpdatedAt: asStr(d["quoteUpdatedAt"]),
		IsLeveraged:    d["isLeveraged"] == true,
		Country:        asStr(info["country"]),
		Exchange:       asStr(info["exchange"]),
		Sector:         asStr(info["sector"]),
		Industry:       asStr(info["industry"]),
		Website:        asStr(info["website"]),
	}
}

// ShapeQuarterQ is shapeQuarterQ.
func ShapeQuarterQ(q interface{}) *CrQuarterQ {
	if !isObject(q) {
		return nil
	}
	m := objOrEmpty(q)
	return &CrQuarterQ{
		OpenUsd:  asNum(m["openUSD"]),
		CloseUsd: asNum(m["closeUSD"]),
		IsFull:   m["isFull"] != false,
	}
}

// ShapeQuarterYear is shapeQuarterYear.
func ShapeQuarterYear(y interface{}) CrQuarterlyYear {
	y0 := objOrEmpty(y)
	return CrQuarterlyYear{
		Year: asNum(y0["year"]),
		Q1:   ShapeQuarterQ(y0["q1"]),
		Q2:   ShapeQuarterQ(y0["q2"]),
		Q3:   ShapeQuarterQ(y0["q3"]),
		Q4:   ShapeQuarterQ(y0["q4"]),
	}
}

// ShapePrediction is shapePrediction: 3 responses, platformData merged by
// platform name (insertion order preserved, as JS object key order is).
func ShapePrediction(pp map[string]interface{}) (CrPredictionAgg, []CrPredictionRow) {
	tv := objOrEmpty(pp["totalVolumeResponse"])
	mk := objOrEmpty(pp["marketsResponse"])
	oi := objOrEmpty(pp["openInterestResponse"])

	byPlat := map[string]*PredictionPlatform{}
	order := []string{}
	addPlat := func(list interface{}, target string, src string) {
		arr, ok := list.([]interface{})
		if !ok {
			return
		}
		for _, p := range arr {
			m := obj(p)
			if m == nil {
				continue
			}
			name := asStr(m["platform"])
			if name == nil {
				continue
			}
			row, seen := byPlat[*name]
			if !seen {
				row = &PredictionPlatform{Platform: *name}
				byPlat[*name] = row
				order = append(order, *name)
			}
			v := asNum(m[src])
			switch target {
			case "volumeUsd":
				row.VolumeUsd = v
			case "marketsCount":
				row.MarketsCount = v
			default:
				row.OpenInterestUsd = v
			}
		}
	}
	addPlat(tv["platformData"], "volumeUsd", "volume")
	addPlat(mk["platformData"], "marketsCount", "marketsCount")
	addPlat(oi["platformData"], "openInterestUsd", "openInterest")

	platforms := make([]PredictionPlatform, 0, len(order))
	for _, n := range order {
		platforms = append(platforms, *byPlat[n])
	}
	agg := CrPredictionAgg{
		TotalVolumeUsd:   asNum(tv["totalVolume"]),
		VolumeChangePct:  asNum(tv["changePercent"]),
		MarketsCount:     asNum(mk["totalMarketsCount"]),
		MarketsChangePct: asNum(mk["changePercent"]),
		OpenInterestUsd:  asNum(oi["totalOpenInterest"]),
		OiChangePct:      asNum(oi["changePercent"]),
		Platforms:        platforms,
	}

	tb := objOrEmpty(pp["tableFallbackData"])
	rows := []CrPredictionRow{}
	for _, raw := range dictArray(tb["data"]) {
		rows = append(rows, CrPredictionRow{
			ID:           strOr(raw["id"], ""),
			Title:        strOr(raw["title"], ""),
			Platform:     asStr(raw["platform"]),
			Category:     asStr(raw["categoryName"]),
			EndDate:      asStr(raw["endDate"]),
			Volume24hUsd: asNum(raw["volume24h"]),
			Bid:          asNum(raw["bid"]),
			Ask:          asNum(raw["ask"]),
			Spread:       asNum(raw["spread"]),
			ExternalURL:  asStr(raw["externalUrl"]),
		})
	}
	return agg, rows
}

// ShapeNewsRow is shapeNewsRow: date is epoch MILLISECONDS upstream (null =
// pinned promo slot -> em-dash).
func ShapeNewsRow(r map[string]interface{}) CrNewsRow {
	var ms *float64
	if f, ok := r["date"].(float64); ok && f > 1e12 {
		ms = &f
	}
	var status *string
	if s, ok := r["status"].(string); ok && (s == "bullish" || s == "bearish") {
		status = &s
	}
	related := []RelatedCoin{}
	if arr, ok := r["relatedCoins"].([]interface{}); ok {
		for _, c := range arr {
			m := obj(c)
			if m == nil {
				continue
			}
			sym, ok := m["symbol"].(string)
			if !ok {
				continue
			}
			if len(related) == 6 {
				break
			}
			rc := RelatedCoin{Symbol: sym}
			if f, ok := m["price"].(float64); ok {
				rc.PriceUsd = &f
			}
			if f, ok := m["priceChange"].(float64); ok {
				rc.Change24h = &f
			}
			related = append(related, rc)
		}
	}
	var date *string
	if ms != nil {
		if s, ok := isoTimestamp(*ms); ok {
			date = &s
		}
	}
	var source *string
	switch s := r["source"].(type) {
	case string:
		source = &s
	case nil:
	default:
		if m := obj(s); m != nil {
			source = asStr(m["name"])
		}
	}
	var reading *float64
	if f, ok := r["readingTimeMinutes"].(float64); ok {
		reading = &f
	}
	return CrNewsRow{
		ID:              numAsNum(r["id"]),
		Title:           strOr(r["title"], ""),
		URL:             asStr(r["url"]),
		Source:          source,
		Date:            date,
		Status:          status,
		ReadingMinutes:  reading,
		IsAdvertisement: r["isAdvertisement"] == true,
		RelatedCoins:    related,
	}
}

// numAsNum is TS's `typeof v === 'number' ? v : null` (NaN is not JSON).
func numAsNum(v interface{}) *float64 {
	if f, ok := v.(float64); ok {
		return &f
	}
	return nil
}

// isoTimestamp renders epoch-ms the way JS Date#toISOString does.
func isoTimestamp(ms float64) (string, bool) {
	if math.IsNaN(ms) || math.IsInf(ms, 0) || math.Abs(ms) > 8.64e15 {
		return "", false
	}
	t := time.Unix(0, int64(ms)*int64(time.Millisecond)).UTC()
	return t.Format("2006-01-02T15:04:05.000Z"), true
}

// ShapeTagRow is shapeTagRow: avgPriceChange is upstream's own per-tag average.
func ShapeTagRow(r map[string]interface{}) CrTagRow {
	apc := obj(r["avgPriceChange"])
	ranked := []RankedCoin{}
	if arr, ok := r["rankedCoins"].([]interface{}); ok {
		for _, c := range arr {
			if len(ranked) == 4 {
				break
			}
			m := obj(c)
			if m == nil {
				continue
			}
			ranked = append(ranked, RankedCoin{Name: strOr(m["name"], ""), Key: asStr(m["key"])})
		}
	}
	var change *float64
	if apc != nil {
		change = asNum(apc["24H"])
	}
	return CrTagRow{
		ID:          numAsNum(r["id"]),
		Slug:        strOr(r["slug"], ""),
		Name:        strOr(nullish(r["name"], asStrPtr(r["slug"])), ""),
		Description: asStr(r["description"]),
		MarketCap:   asNum(r["marketCap"]),
		Volume24h:   asNum(r["volume24h"]),
		Dominance:   asNum(r["dominance"]),
		Gainers:     asNum(r["gainers"]),
		Losers:      asNum(r["losers"]),
		Change24h:   change,
		RankedCoins: ranked,
	}
}

func asStrPtr(v interface{}) interface{} {
	if s := asStr(v); s != nil {
		return *s
	}
	return nil
}

func ptr[T any](v T) *T { return &v }
