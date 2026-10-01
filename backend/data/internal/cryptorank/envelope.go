package cryptorank

import (
	"fmt"
	"time"
)

// ShapeError is one of the ~18 loud refusals: a missing expected upstream
// slice must be an error, never an empty envelope.
type ShapeError struct {
	Kind   string
	Detail string
}

func (e *ShapeError) Error() string { return e.Detail }

func missing(kind, what string) error {
	return &ShapeError{Kind: kind, Detail: kind + ": missing " + what}
}

// Opts mirrors the TS route's `{key, upstream}`.
type Opts struct {
	Key      string // resolved key ("" -> the mode's documented default)
	Upstream string // canonical upstream URL ("" -> the mode table's default)
}

// changeSourceLabel values used by the envelope.
const (
	csDirect      = "direct"
	csDerived24H  = "derived-from-histPrices-24H"
	csUnavailable = "unavailable"
)

// Envelope is the port of lib/shapers.ts's `envelope()`. kind must be a live
// mode; (funding, unlocks) are refused upstream of this function by the route.
func Envelope(kind string, h *HelperOut, opts Opts) (CrEnvelope, error) {
	pp := h.PageProps
	if pp == nil {
		pp = map[string]interface{}{}
	}
	upstream := opts.Upstream
	if upstream == "" {
		upstream = Upstream(kind)
	}
	fetchedAt := h.FetchedAt
	if fetchedAt == 0 {
		fetchedAt = time.Now().Unix()
	}
	cache := h.Cache
	if cache == "" {
		cache = "MISS"
	}
	base := CrEnvelope{Kind: kind, Upstream: upstream, FetchedAt: fetchedAt, Cache: cache}
	key := opts.Key

	switch kind {
	case "home":
		fundingRaw := dictArray(pp["fallbackRecentFundingRounds"])
		icoRaw := dictArray(pp["upcomingIco"])
		g := ShapeGlobal(pp)
		out := base
		out.Count = len(fundingRaw) + len(icoRaw)
		out.Slice = ptr(fmt.Sprintf(
			"homepage slice: %d most recent rounds + %d upcoming IDOs; "+
				"the full fundraising boards (/funding-rounds, /ico*) are WAF-challenged to every non-browser client",
			len(fundingRaw), len(icoRaw)))
		out.Global = &g
		out.FundingRounds = make([]CrFundingRound, 0, len(fundingRaw))
		for _, r := range fundingRaw {
			out.FundingRounds = append(out.FundingRounds, ShapeFunding(r))
		}
		out.UpcomingIco = make([]CrUpcomingIco, 0, len(icoRaw))
		for _, r := range icoRaw {
			out.UpcomingIco = append(out.UpcomingIco, ShapeIco(r))
		}
		return out, nil

	case "coins":
		coins := dictArray(pp["coins"])
		if len(coins) == 0 {
			// Upstream moved /all-coins-list to a wrapper payload
			// ({"coins":{"data":[...],"total":N}}); the bare array is the older
			// shape. Reading only the bare form shipped count=0 with a 200 -- a
			// silent empty envelope, which the contract forbids.
			coins = dictArray(objOrEmpty(pp["coins"])["data"])
		}
		out := base
		out.Count = len(coins)
		out.UpstreamTotal = &Num{ptr(float64(len(coins)))}
		out.ChangeSource = ptr(csUnavailable)
		out.Rows = make([]Row, 0, len(coins))
		for _, r := range coins {
			out.Rows = append(out.Rows, Row{Coin: ptr(ShapeCoin(r, nil))})
		}
		return out, nil

	case "trending":
		table := objOrEmpty(pp["fallbackTableData"])
		rows := dictArray(table["data"])
		out := base
		out.Count = len(rows)
		total := asNum(table["total"])
		if total == nil {
			total = ptr(float64(len(rows)))
		}
		out.UpstreamTotal = &Num{total}
		out.ChangeSource = ptr(csDirect)
		out.Rows = make([]Row, 0, len(rows))
		for _, r := range rows {
			out.Rows = append(out.Rows, Row{Trend: ptr(ShapeTrending(r))})
		}
		return out, nil

	case "categories":
		fallbackCoins, ok := pp["fallbackCoins"].([]interface{})
		if !ok {
			return CrEnvelope{}, missing("categories", "fallbackCoins")
		}
		if key == "" {
			key = DefaultKeys["categories"]
		}
		cat := objOrEmpty(pp["category"])
		gl := objOrEmpty(pp["gainersLosersData"])
		name := key
		if s, ok := cat["name"].(string); ok {
			name = s
		}
		info := CrCategoryInfo{Slug: key, Name: name, Gainers: asNum(gl["gainers"]), Losers: asNum(gl["losers"])}
		out := base
		out.Count = len(fallbackCoins)
		out.Slice = ptr(fmt.Sprintf(
			"category '%s' overview — %d coins by mcap; category breadth gainers %s / losers %s",
			info.Slug, len(fallbackCoins), numOrDash(info.Gainers), numOrDash(info.Losers)))
		out.ChangeSource = ptr(csUnavailable)
		out.Category = &info
		out.Rows = make([]Row, 0, len(fallbackCoins))
		for _, r := range dictArray(pp["fallbackCoins"]) {
			out.Rows = append(out.Rows, Row{Coin: ptr(ShapeCoin(r, nil))})
		}
		return out, nil

	case "exchanges":
		if _, ok := pp["fallbackData"].([]interface{}); !ok {
			return CrEnvelope{}, missing("exchanges", "fallbackData")
		}
		if key == "" {
			key = DefaultExchange
		}
		rows := dictArray(pp["fallbackData"])
		out := base
		if key == "cex-transparency" {
			// Reserve-transparency rows carry NO volume fields (different
			// schema): volume stays null (honest), reserves map to their own
			// columns.
			out.Count = len(rows)
			out.Slice = ptr(fmt.Sprintf(
				"%d exchanges with published reserve wallets — cryptorank reported proof-of-reserves "+
					"(their aggregation, NOT an independent attestation); 12/14 keys cross-check against their own "+
					"spot list; volume absent on this surface (null, never 0)", len(rows)))
			out.Rows = make([]Row, 0, len(rows))
			for i, r := range rows {
				tr := CrExchangeTransparencyRow{
					CrExchangeRow: CrExchangeRow{
						Rank:  ptr(float64(i + 1)),
						Key:   strOr(r["key"], ""),
						Name:  strOr(r["name"], ""),
						Image: asStr(r["icon"]),
					},
					ReservesUsd:        asNum(r["reserves"]),
					CleanReservesUsd:   asNum(r["cleanReserves"]),
					StablecoinsPercent: asNum(r["stablecoinsPercent"]),
					WalletsCount:       asNum(r["walletsCount"]),
					AuditorName:        asStr(r["auditorName"]),
					AuditDate:          asStr(r["auditDate"]),
				}
				out.Rows = append(out.Rows, Row{ExchTransparency: &tr})
			}
			return out, nil
		}
		variant := "spot CEX"
		if key == "dex/spot" {
			variant = "DEX spot"
		} else if key == "perpetuals" {
			variant = "perpetuals (futures)"
		}
		out.Count = len(rows)
		out.Slice = ptr(fmt.Sprintf(
			"top %d %s — cryptorank's OWN reported 24h volume (their methodology, not independent); "+
				"per-row %% share of listed total", len(rows), variant))
		out.Rows = make([]Row, 0, len(rows))
		for i, r := range rows {
			x := ShapeExchange(r, i)
			out.Rows = append(out.Rows, Row{Exch: &x})
		}
		return out, nil

	case "listings":
		ra, okRA := pp["recentlyAddedCoins"].([]interface{})
		ms, okMS := pp["mostSearchedCoins"].([]interface{})
		mv, okMV := pp["mostVisitedCoins"].([]interface{})
		if !okRA || !okMS || !okMV {
			return CrEnvelope{}, missing("listings", "widget arrays")
		}
		// How many rows upstream actually shipped a usable anchor for -- the
		// same condition shapeListing() derives with. Reported per widget so
		// consumers can assert non-null == anchors (a world-state-proof
		// equality that catches both missed derivation and fabrication).
		cov := func(period string) *AnchorCount {
			return &AnchorCount{
				RecentlyAdded: anchorCount(ra, period),
				MostSearched:  anchorCount(ms, period),
				MostVisited:   anchorCount(mv, period),
			}
		}
		out := base
		out.Count = len(ra) + len(ms) + len(mv)
		out.Slice = ptr(fmt.Sprintf(
			"three /listings widgets: %d recently added + %d most searched + %d most visited; "+
				"chg24h/chg7d derived from histPrices[\"24H\"]/[\"7D\"] anchors where the widget ships them, "+
				"em-dash otherwise; anchor24h/anchor7d report how many rows upstream shipped each anchor "+
				"(derived count must equal them)", len(ra), len(ms), len(mv)))
		out.ChangeSource = ptr(csDerived24H)
		out.Anchor24h = cov("24H")
		out.Anchor7d = cov("7D")
		out.Listings = &Listings{
			RecentlyAdded: listingCoins(ra),
			MostSearched:  listingCoins(ms),
			MostVisited:   listingCoins(mv),
		}
		return out, nil

	case "coin":
		if !truthy(pp["coin"]) {
			return CrEnvelope{}, missing("coin", "pageProps.coin")
		}
		if key == "" {
			key = DefaultKeys["coin"]
		}
		detail := ShapeCoinDetail(pp, key)
		out := base
		out.Count = 1
		out.Slice = ptr(fmt.Sprintf(
			"coin detail '%s' — price from page payload; change24h derived from histPrices['24H'] anchor",
			detail.Key))
		out.ChangeSource = ptr(csDerived24H)
		out.Detail = &detail
		return out, nil

	case "blockchains":
		chains, ok := pp["blockchains"].([]interface{})
		if !ok {
			return CrEnvelope{}, missing("blockchains", "blockchains array")
		}
		out := base
		out.Count = len(chains)
		out.Slice = ptr(fmt.Sprintf(
			"chain directory from /blockchains — %d chains (slug feed for ?key= chain detail); "+
				"explorer links are upstream's own", len(chains)))
		out.ChainRows = make([]CrChainRow, 0, len(chains))
		for _, r := range dictArray(pp["blockchains"]) {
			out.ChainRows = append(out.ChainRows, ShapeChainRow(r))
		}
		return out, nil

	case "chain":
		bc := pp["blockchain"]
		fc, okFC := pp["fallbackCoins"].([]interface{})
		if !truthy(bc) || !okFC {
			return CrEnvelope{}, missing("chain", "blockchain/fallbackCoins")
		}
		if key == "" {
			key = DefaultKeys["chain"]
		}
		info := CrChainInfo{
			Slug:        key,
			Name:        strOr(field(bc, "name"), key),
			Network:     asStr(field(bc, "network")),
			MarketCap:   asNum(field(bc, "marketCap")),
			ExplorerURL: asStr(field(bc, "explorerUrl")),
			Ecosystem:   asStr(field(bc, "ecosystem")),
		}
		out := base
		out.Count = len(fc)
		out.UpstreamTotal = &Num{ptr(float64(len(fc)))}
		out.Slice = ptr(fmt.Sprintf(
			"chain '%s' ecosystem — %d tokens by mcap "+
				"(native coin lives outside the ecosystem list upstream); chg columns unavailable, never faked",
			info.Slug, len(fc)))
		out.ChangeSource = ptr(csUnavailable)
		out.Chain = &info
		out.Rows = make([]Row, 0, len(fc))
		for _, r := range dictArray(pp["fallbackCoins"]) {
			out.Rows = append(out.Rows, Row{Coin: ptr(ShapeCoin(r, nil))})
		}
		return out, nil

	case "launchpool":
		fd := obj(pp["fallbackData"])
		if fd == nil {
			return CrEnvelope{}, missing("launchpool", "fallbackData.data")
		}
		data, ok := fd["data"].([]interface{})
		if !ok {
			return CrEnvelope{}, missing("launchpool", "fallbackData.data")
		}
		rows := make([]CrLaunchpoolRow, 0, len(data))
		for _, r := range dictArray(fd["data"]) {
			rows = append(rows, ShapeLaunchpoolRow(r))
		}
		total := asNum(fd["total"])
		variant := "past"
		if key == "upcoming" {
			variant = "upcoming"
		} else if key == "active" {
			variant = "active"
		}
		out := base
		out.Count = len(rows)
		out.UpstreamTotal = &Num{total}
		out.Slice = ptr(fmt.Sprintf(
			"%s launchpool events — %d rows shown%s; windows are upstream ISO dates, "+
				"null = not announced (em-dash)", variant, len(rows), ofTotal(total)))
		out.LaunchpoolRows = rows
		return out, nil

	case "nodesale":
		// nodesale pages ship `initialData` (launchpool uses `fallbackData`).
		fd := obj(nullish(pp["initialData"], pp["fallbackData"]))
		if fd == nil {
			return CrEnvelope{}, missing("nodesale", "initialData/fallbackData.data")
		}
		data, ok := fd["data"].([]interface{})
		if !ok {
			return CrEnvelope{}, missing("nodesale", "initialData/fallbackData.data")
		}
		rows := make([]CrNodeSaleRow, 0, len(data))
		for _, r := range dictArray(fd["data"]) {
			rows = append(rows, ShapeNodesaleRow(r))
		}
		total := asNum(fd["total"])
		variant := "past"
		if key == "upcoming" {
			variant = "upcoming"
		} else if key == "active" {
			variant = "active"
		}
		out := base
		out.Count = len(rows)
		out.UpstreamTotal = &Num{total}
		out.Slice = ptr(fmt.Sprintf(
			"%s node sales — %d rows shown%s; node prices are upstream tier ranges in USD "+
				"(never market price); windows null = not announced (em-dash)", variant, len(rows), ofTotal(total)))
		out.NodesaleRows = rows
		return out, nil

	case "ecosystems":
		fe := obj(pp["fallbackEcosystems"])
		if fe == nil {
			return CrEnvelope{}, missing("ecosystems", "fallbackEcosystems.data")
		}
		data, ok := fe["data"].([]interface{})
		if !ok {
			return CrEnvelope{}, missing("ecosystems", "fallbackEcosystems.data")
		}
		rows := make([]CrEcosystemRow, 0, len(data))
		for _, r := range dictArray(fe["data"]) {
			rows = append(rows, ShapeEcosystemRow(r))
		}
		count := asNum(fe["count"])
		out := base
		out.Count = len(rows)
		out.UpstreamTotal = &Num{count}
		out.Slice = ptr(fmt.Sprintf(
			"ecosystem index — %d of %s ecosystems (SSR ships page 1 only); mcap/tvl/change "+
				"figures are cryptorank's OWN ecosystem aggregates (their methodology)",
			len(rows), countOrQ(count)))
		out.EcosystemRows = rows
		return out, nil

	case "ecosystem":
		fc := obj(pp["fallbackCoins"])
		if fc == nil {
			return CrEnvelope{}, missing("ecosystem", "fallbackCoins.data")
		}
		data, ok := fc["data"].([]interface{})
		if !ok {
			return CrEnvelope{}, missing("ecosystem", "fallbackCoins.data")
		}
		if key == "" {
			key = DefaultKeys["ecosystem"]
		}
		info := ShapeEcosystemInfo(pp, key)
		rows := make([]Row, 0, len(data))
		for _, r := range dictArray(fc["data"]) {
			rows = append(rows, Row{Coin: ptr(ShapeCoin(r, nil))})
		}
		count := asNum(fc["count"])
		out := base
		out.Count = len(rows)
		out.UpstreamTotal = &Num{count}
		out.Slice = ptr(fmt.Sprintf(
			"'%s' ecosystem — %d of %s coins (SSR page 1); eco rows carry NO price upstream -> "+
				"chg columns null, never faked; native coin quote above is upstream's own",
			info.Name, len(rows), countOrQ(count)))
		out.ChangeSource = ptr(csUnavailable)
		out.Ecosystem = &info
		out.Rows = rows
		return out, nil

	case "rwa":
		af := obj(pp["assetsFallback"])
		if af == nil {
			return CrEnvelope{}, missing("rwa", "assetsFallback.data")
		}
		data, ok := af["data"].([]interface{})
		if !ok {
			return CrEnvelope{}, missing("rwa", "assetsFallback.data")
		}
		rows := make([]CrRwaRow, 0, len(data))
		for _, r := range dictArray(af["data"]) {
			rows = append(rows, ShapeRwaRow(r))
		}
		total := asNum(af["total"])
		out := base
		out.Count = len(rows)
		out.UpstreamTotal = &Num{total}
		out.Slice = ptr(fmt.Sprintf(
			"RWA assets — %d of %s upstream (SSR page 1); price = upstream quote "+
				"(marketState may be CLOSED = last session close); tokenized* = cryptorank tokenized-asset "+
				"metrics (their methodology)", len(rows), countOrQ(total)))
		out.RwaRows = rows
		return out, nil

	case "rwaasset":
		af := obj(pp["assetFallback"])
		if af == nil || !isObject(af["data"]) {
			return CrEnvelope{}, missing("rwaasset", "assetFallback.data")
		}
		asset := ShapeRwaAsset(objOrEmpty(af["data"]), key)
		out := base
		out.Count = 1
		label := asset.Ticker
		if label == "" {
			label = asset.Slug
		}
		out.Slice = ptr(fmt.Sprintf(
			"asset detail '%s' — upstream quote at %s (marketState %s); exchange/sector = upstream metadata",
			label, dash(asset.QuoteUpdatedAt, "unknown time"), dash(asset.MarketState, "?")))
		out.RwaAsset = &asset
		return out, nil

	case "quarterly":
		btc, okB := pp["initialQuarterlyReturnsBtc"].([]interface{})
		eth, okE := pp["initialQuarterlyReturnsEth"].([]interface{})
		if !okB || !okE {
			return CrEnvelope{}, missing("quarterly", "initialQuarterlyReturnsBtc/Eth")
		}
		out := base
		out.Count = len(btc) + len(eth)
		out.Slice = ptr(fmt.Sprintf(
			"BTC (%d years) + ETH (%d years) quarterly open/close — "+
				"upstream values; return%% is computed in the UI from these numbers (labelled); "+
				"isFull=false = quarter in progress; 2026 closes verified vs independent "+
				"daily history (0.03-0.40%% on 2026-09-27)", len(btc), len(eth)))
		out.QuarterlyBtc = make([]CrQuarterlyYear, 0, len(btc))
		for _, y := range btc {
			out.QuarterlyBtc = append(out.QuarterlyBtc, ShapeQuarterYear(y))
		}
		out.QuarterlyEth = make([]CrQuarterlyYear, 0, len(eth))
		for _, y := range eth {
			out.QuarterlyEth = append(out.QuarterlyEth, ShapeQuarterYear(y))
		}
		return out, nil

	case "prediction":
		agg, rows := ShapePrediction(pp)
		var total *float64
		if tb := obj(pp["tableFallbackData"]); tb != nil {
			total = asNum(tb["total"])
		}
		out := base
		out.Count = len(rows)
		out.UpstreamTotal = &Num{total}
		out.Prediction = &agg
		out.PredictionRows = rows
		out.Slice = ptr(fmt.Sprintf(
			"prediction markets — %d of %s listings (SSR page 1); "+
				"volume/markets/OI aggregates + platform split are upstream figures (window NOT "+
				"disclosed upstream); row volume24h is explicitly 24h; external links go to "+
				"the venue (kalshi/polymarket)", len(rows), countOrQ(total)))
		return out, nil

	case "news":
		list, ok := pp["news"].([]interface{})
		if !ok {
			return CrEnvelope{}, missing("news", "news array")
		}
		rows := make([]CrNewsRow, 0, len(list))
		for _, r := range dictArray(pp["news"]) {
			rows = append(rows, ShapeNewsRow(r))
		}
		out := base
		out.Count = len(rows)
		out.Slice = ptr(fmt.Sprintf(
			"%d latest items — links out to the original publishers; "+
				"upstream ships the first page only (?page= is a no-op upstream); "+
				"date null = pinned promo slot (em-dash); status = upstream sentiment tag", len(rows)))
		out.NewsRows = rows
		return out, nil

	case "tags":
		list, ok := pp["tags"].([]interface{})
		if !ok {
			return CrEnvelope{}, missing("tags", "tags array")
		}
		rows := make([]CrTagRow, 0, len(list))
		for _, r := range dictArray(pp["tags"]) {
			rows = append(rows, ShapeTagRow(r))
		}
		out := base
		out.Count = len(rows)
		out.UpstreamTotal = &Num{ptr(float64(len(rows)))}
		out.Slice = ptr(fmt.Sprintf(
			"%d tags (topic taxonomy, distinct from categories) — "+
				"breadth stats + avgPriceChange are upstream tag averages; rankedCoins = index-card top coins",
			len(rows)))
		out.TagRows = rows
		return out, nil

	case "tag":
		tg := pp["tag"]
		coins, ok := pp["coins"].([]interface{})
		if !truthy(tg) || !ok {
			return CrEnvelope{}, missing("tag", "tag/coins")
		}
		keyDef := key
		if keyDef == "" {
			keyDef = DefaultKeys["tag"]
		}
		info := CrTagInfo{
			Slug:     strOr(field(tg, "slug"), keyDef),
			Name:     strOr(field(tg, "name"), keyDef),
			Subtitle: asStr(field(tg, "subtitle")),
		}
		gl := objOrEmpty(pp["gainersLosersData"])
		rows := make([]Row, 0, len(coins))
		for _, r := range dictArray(pp["coins"]) {
			rows = append(rows, Row{Coin: ptr(ShapeCoin(r, nil))})
		}
		out := base
		out.Count = len(rows)
		out.UpstreamTotal = &Num{ptr(float64(len(rows)))}
		out.ChangeSource = ptr(csUnavailable)
		out.Slice = ptr(fmt.Sprintf(
			"tag '%s' — %d coins by mcap; breadth %s gainers / %s losers; "+
				"chg columns absent upstream (measured), never faked",
			info.Slug, len(rows), numOrDash(asNum(gl["gainers"])), numOrDash(asNum(gl["losers"]))))
		out.Tag = &info
		out.Rows = rows
		return out, nil

	case "converter":
		icc, ok := pp["initialCompactCoins"].([]interface{})
		if !ok {
			return CrEnvelope{}, missing("converter", "initialCompactCoins")
		}
		rows := make([]CrConverterRow, 0, len(icc))
		for _, r := range dictArray(pp["initialCompactCoins"]) {
			rows = append(rows, CrConverterRow{
				Key:      strOr(r["key"], ""),
				Name:     strOr(r["name"], ""),
				Symbol:   strOr(r["symbol"], ""),
				Icon:     asStr(r["icon"]),
				PriceUsd: asNum(r["price"]),
			})
		}
		out := base
		out.Count = len(rows)
		out.UpstreamTotal = &Num{ptr(float64(len(rows)))}
		out.ChangeSource = ptr(csUnavailable)
		out.Slice = ptr(fmt.Sprintf(
			"full price list — all %d coins with live price "+
				"(converter page payload: /all-coins-list ships only the top 100); "+
				"price only — no 24h change upstream (em-dash, never 0)", len(rows)))
		out.ConverterRows = rows
		return out, nil

	case "media":
		fd := obj(pp["fallbackData"])
		if fd == nil {
			return CrEnvelope{}, missing("media", "fallbackData.data")
		}
		data, ok := fd["data"].([]interface{})
		if !ok {
			return CrEnvelope{}, missing("media", "fallbackData.data")
		}
		rows := make([]CrMediaRow, 0, len(data))
		for _, r := range dictArray(fd["data"]) {
			tags := []string{}
			if a, ok := r["tags"].([]interface{}); ok {
				for i, t := range a {
					if i == 6 {
						break
					}
					tags = append(tags, jsString(t))
				}
			}
			rows = append(rows, CrMediaRow{
				ID:              strOr(r["id"], ""),
				Title:           strOr(r["title"], ""),
				ChannelTitle:    asStr(r["channelTitle"]),
				PublishedAt:     asStr(r["publishedAt"]),
				DurationSeconds: asNum(r["durationSeconds"]),
				Tags:            tags,
			})
		}
		total := asNum(fd["count"])
		out := base
		out.Count = len(rows)
		out.UpstreamTotal = &Num{total}
		out.ChangeSource = ptr(csUnavailable)
		out.Slice = ptr(fmt.Sprintf(
			"video feed — %d of %s videos (SSR page 1 only); "+
				"id = YouTube video id (ground truth: youtube oembed title+channel match, verified); "+
				"duration/published straight from upstream", len(rows), countOrQ(total)))
		out.MediaRows = rows
		return out, nil

	case "newstag":
		tg := pp["tag"]
		list, ok := pp["news"].([]interface{})
		if !truthy(tg) || !ok {
			// GET maps tag=null to a real 404 before shaping; reaching here with
			// a missing array is a schema break, not a missing tag.
			return CrEnvelope{}, missing("newstag", "news array")
		}
		keyDef := key
		if keyDef == "" {
			keyDef = DefaultKeys["newstag"]
		}
		info := CrTagInfo{
			Slug:     strOr(field(tg, "key"), keyDef),
			Name:     strOr(field(tg, "name"), keyDef),
			Subtitle: nil,
		}
		rows := make([]CrNewsRow, 0, len(list))
		for _, r := range dictArray(pp["news"]) {
			rows = append(rows, ShapeNewsRow(r))
		}
		rel := []RelatedTag{}
		if a, ok := pp["tags"].([]interface{}); ok {
			for _, t := range a {
				m := obj(t)
				if m == nil {
					continue
				}
				slug := strOr(m["key"], "")
				if slug == "" {
					continue
				}
				rel = append(rel, RelatedTag{Slug: slug, Name: strOr(m["name"], "")})
			}
		}
		out := base
		out.Count = len(rows)
		out.UpstreamTotal = &Num{ptr(float64(len(rows)))}
		out.Slice = ptr(fmt.Sprintf(
			"articles tagged '%s' — %d shown (upstream ships no tag total); "+
				"unknown slugs are answered locally as 404 from upstream's tag=null soft-404 marker "+
				"(never an unfiltered feed under a tag label); relatedCoins prices llama-verified",
			info.Slug, len(rows)))
		out.NewsRows = rows
		out.Tag = &info
		out.RelatedTags = rel
		return out, nil

	case "aioverview":
		ov := obj(pp["overviewData"])
		if ov == nil {
			return CrEnvelope{}, missing("aioverview", "overviewData")
		}
		market := objOrEmpty(ov["market"])
		funding := objOrEmpty(ov["fundingRound"])
		drop := objOrEmpty(ov["dropHunting"])
		vest := objOrEmpty(ov["vesting"])

		ai := CrAiOverview{
			Market: AiMarket{
				Summary:   asStr(market["aiSummary"]),
				UpdatedAt: asStr(market["updatedAt"]),
			},
			News: []AiNews{},
			Funding: AiFunding{
				Summary: asStr(funding["aiSummary"]),
				Rounds:  []AiFundingRound{},
			},
			DropHunting: AiDropHunting{
				Summary:    asStr(drop["aiSummary"]),
				Activities: []AiActivity{},
			},
			Vesting: AiVesting{
				Summary: asStr(vest["aiSummary"]),
				Unlocks: []AiUnlock{},
			},
		}
		for _, n := range dictArray(ov["news"]) {
			var isBullish *bool
			if b, ok := n["isBullish"].(bool); ok {
				isBullish = &b
			}
			ai.News = append(ai.News, AiNews{
				ID:        asNum(n["id"]),
				Title:     strOr(n["title"], ""),
				Date:      asStr(n["date"]),
				IsBullish: isBullish,
			})
		}
		for _, r := range dictArray(funding["rounds"]) {
			ai.Funding.Rounds = append(ai.Funding.Rounds, AiFundingRound{
				Key:       asStr(r["key"]),
				Name:      strOr(r["name"], ""),
				Stage:     asStr(r["stage"]),
				RaisedUsd: asNum(r["raised"]),
			})
		}
		for _, a := range dictArray(drop["activities"]) {
			coin := obj(a["coin"])
			var coinName *string
			if coin != nil {
				coinName = asStr(coin["name"])
			}
			ai.DropHunting.Activities = append(ai.DropHunting.Activities, AiActivity{
				Key:      strOr(a["key"], ""),
				Type:     asStr(a["type"]),
				CoinName: coinName,
			})
		}
		for _, v := range dictArray(vest["vesting"]) {
			coin := obj(v["coin"])
			var coinName *string
			if coin != nil {
				coinName = asStr(coin["name"])
			}
			ai.Vesting.Unlocks = append(ai.Vesting.Unlocks, AiUnlock{
				Date:          asStr(v["date"]),
				UnlockPercent: asNum(v["unlockPercent"]),
				CoinName:      coinName,
			})
		}
		out := base
		out.Count = len(ai.News) + len(ai.Funding.Rounds) + len(ai.DropHunting.Activities) + len(ai.Vesting.Unlocks)
		out.Slice = ptr("upstream AI digest — summaries are cryptorank's own generated text " +
			"(their words, labelled as theirs); structured slices are plain rows; " +
			"cross-surface coherence vs mode=home enforced in harness " +
			"(mcap/volume/dominance <= 0.5%), CoinGecko total-cap sanity band 5%")
		out.AiOverview = &ai
		return out, nil
	}

	if kind == "gainers" || kind == "losers" {
		// gainers / losers -- same upstream row shape, change derived from anchor
		rows := dictArray(pp["fallbackData"])
		out := base
		out.Count = len(rows)
		out.UpstreamTotal = &Num{ptr(float64(len(rows)))}
		out.ChangeSource = ptr(csDerived24H)
		out.Rows = make([]Row, 0, len(rows))
		for _, r := range rows {
			out.Rows = append(out.Rows, Row{Coin: ptr(ShapeCoin(r, ChangeFromAnchor(r)))})
		}
		return out, nil
	}

	return CrEnvelope{}, &ShapeError{Kind: kind, Detail: fmt.Sprintf("envelope: unhandled live mode %q", kind)}
}

// anchorCount counts rows upstream shipped a usable, non-zero `period` anchor
// for -- the same condition shapeListing derives with.
func anchorCount(rows []interface{}, period string) int {
	n := 0
	for _, row := range rows {
		hp := objOrEmpty(field(row, "histPrices"))
		a := asNum(field(hp[period], "USD"))
		if a != nil && *a != 0 {
			n++
		}
	}
	return n
}

func listingCoins(rows []interface{}) []CrListingCoin {
	out := make([]CrListingCoin, 0, len(rows))
	for _, r := range dictArray(rows) {
		out = append(out, ShapeListing(r))
	}
	return out
}

// ofTotal renders the ` of N upstream` clause the slice strings add.
//
// This is a TRUTHY test, not a nullish one: the TS source is
// `(total ? ` of ${total} upstream (...)` : ”)`, so `total === 0` AND
// `total === null` both render the empty string. Do not "fix" it to a nullish
// check -- that would print ` of 0 upstream (...)` for a zero total, which TS
// never does.
func ofTotal(total *float64) string {
	if total == nil || *total == 0 {
		return ""
	}
	return " of " + jsNumStr(*total) + " upstream (SSR ships page 1 only; upstream ignores ?page=)"
}

// countOrQ is the `count ?? '?'` interpolation -- NULLISH, unlike ofTotal
// above: `0 ?? '?'` is `0` in JS, so a zero total must print "0" here and the
// empty clause in ofTotal. The two helpers deliberately differ.
func countOrQ(total *float64) string {
	if total == nil {
		return "?"
	}
	return jsNumStr(*total)
}

// dash is the `x ?? fallback` interpolation -- nullish: always a nil pointer
// here, never "".
//
// Both call sites in the rwaasset slice read a value built by asStr(), which
// maps "" to nil (`typeof v === 'string' && v ? v : null`), so a "" can never
// reach this function and the nullish-vs-falsy distinction is unobservable.
// That is measured, not assumed: `node` reports asStr(”) === null and
// `” ?? 'unknown time'` === ” while TS never evaluates the latter with a ”.
// TestDashSemantics pins both the helper and the unreachability.
func dash(v *string, fallback string) string {
	if v == nil {
		return fallback
	}
	return *v
}

// numOrDash is the `${x ?? '—'}` interpolation -- nullish, not falsy, so a
// zero (gainers/losers counts are the only numeric users) prints "0", never an
// em-dash.
func numOrDash(f *float64) string {
	if f == nil {
		return "—"
	}
	return jsNumStr(*f)
}
