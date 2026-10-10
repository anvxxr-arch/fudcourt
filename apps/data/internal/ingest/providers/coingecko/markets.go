package coingecko

import (
	"context"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// marketsPage is the /coins/markets row (trimmed to the fields the adapter
// reads): {"id":"bitcoin","symbol":"btc","name":"Bitcoin","current_price":
// 42661.0,"market_cap":838421331432.0,"total_volume":34567890012.0,
// "last_updated":"2026-02-05T18:45:02.482Z"}.
type marketsPage struct {
	ID           string  `json:"id"`
	Symbol       string  `json:"symbol"`
	Name         string  `json:"name"`
	CurrentPrice float64 `json:"current_price"`
	MarketCap    float64 `json:"market_cap"`
	TotalVolume  float64 `json:"total_volume"`
	LastUpdated  string  `json:"last_updated"`
}

// markets fetches the asset universe page by page:
// GET /coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=N
// Pages iterate until a short page (fewer rows than per_page) or cfg.MaxPages
// (default 4). Each coin row upserts its asset, registers the provider symbol
// (gecko -> asset id) and writes one crypto observation per metric
// (price / market_cap / volume_24h) on series asset:<asset_id>.
func (c *client) markets(ctx context.Context, w canon.Writer, job ingest.Job, cfg Config) (int, int, error) {
	const perPage = 250
	maxPages := cfg.MaxPages
	if maxPages <= 0 {
		maxPages = defaultMaxPages
	}
	now := time.Now().UTC()
	assets := make([]canon.Asset, 0, perPage)
	symbols := make([]canon.ProviderSymbol, 0, perPage)
	var obs []canon.Observation
	for page := 1; page <= maxPages; page++ {
		url := fmt.Sprintf("%s/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=%d&page=%d",
			Base, perPage, page)
		var pageRows []marketsPage
		if err := c.getJSON(ctx, url, &pageRows); err != nil {
			return 0, 0, err
		}
		for _, r := range pageRows {
			if r.ID == "" || r.Symbol == "" {
				return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "market row missing id/symbol"}
			}
			aid := assetID(r.Symbol)
			assets = append(assets, canon.Asset{
				AssetID: aid,
				Symbol:  upper(r.Symbol),
				Name:    strPtr(r.Name),
				Kind:    assetKind(upper(r.Symbol)),
			})
			symbols = append(symbols, canon.ProviderSymbol{
				Provider:     providerName,
				ProviderSymb: r.ID,
				Kind:         string(canon.KindAsset),
				CanonicalID:  aid,
				LastSeenAt:   &now,
			})
			at := now
			if t, err := time.Parse(time.RFC3339, r.LastUpdated); err == nil {
				at = t.UTC()
			}
			seriesID := canon.MintID(canon.KindSeries, canon.SeriesKey("crypto", "price", "asset:"+aid))
			obs = append(obs, observation(seriesID, at, r.CurrentPrice, now))
			mcapSeries := canon.MintID(canon.KindSeries, canon.SeriesKey("crypto", "market_cap", "asset:"+aid))
			obs = append(obs, observation(mcapSeries, at, r.MarketCap, now))
			volSeries := canon.MintID(canon.KindSeries, canon.SeriesKey("crypto", "volume_24h", "asset:"+aid))
			obs = append(obs, observation(volSeries, at, r.TotalVolume, now))
		}
		if len(pageRows) < perPage {
			break
		}
	}
	if len(assets) == 0 {
		return 0, 0, nil
	}
	if _, err := w.UpsertAssets(ctx, assets); err != nil {
		return 0, 0, err
	}
	if _, err := w.UpsertProviderSymbols(ctx, symbols); err != nil {
		return 0, 0, err
	}
	written, rejected, err := w.WriteObservations(ctx, obs)
	return written, rejected, err
}

// global fetches the global crypto aggregates:
// GET /global -> {"data":{"total_market_cap":{"usd":...},"total_volume":{"usd":...},
// "market_cap_percentage":{"btc":...,"eth":...},"active_cryptocurrencies":...,
// "updated_at":1707163200}}. Each aggregate becomes one series observation
// with subject global, domain crypto, in USD.
func (c *client) global(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	url := Base + "/global"
	var res struct {
		Data struct {
			TotalMarketCap map[string]float64 `json:"total_market_cap"`
			TotalVolume    map[string]float64 `json:"total_volume"`
			ActiveCoins    float64            `json:"active_cryptocurrencies"`
			UpdatedAt      float64            `json:"updated_at"`
		} `json:"data"`
	}
	if err := c.getJSON(ctx, url, &res); err != nil {
		return 0, 0, err
	}
	now := time.Now().UTC()
	at := now
	if res.Data.UpdatedAt > 0 {
		at = secs(res.Data.UpdatedAt)
	}
	var obs []canon.Observation
	add := func(metric string, v float64) {
		seriesID := canon.MintID(canon.KindSeries, canon.SeriesKey("crypto", metric, "global"))
		obs = append(obs, observation(seriesID, at, v, now))
	}
	if mcap, ok := res.Data.TotalMarketCap["usd"]; ok {
		add("total_market_cap", mcap)
	} else {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "global missing total_market_cap.usd"}
	}
	if vol, ok := res.Data.TotalVolume["usd"]; ok {
		add("total_volume", vol)
	}
	if res.Data.ActiveCoins > 0 {
		add("active_cryptocurrencies", res.Data.ActiveCoins)
	}
	if len(obs) == 0 {
		return 0, 0, nil
	}
	return w.WriteObservations(ctx, obs)
}

// marketChart fetches one coin's history:
// GET /coins/{id}/market_chart?vs_currency=usd&days=90 ->
// {"prices":[[1707163200000,42661.0],...],"market_caps":[...],"total_volumes":[...]}
// — arrays of [ms, value] pairs, one point per hour at days=90. Each point
// becomes an observation on the coin's price/market_cap/volume_24h series.
// The coin comes from the cursor (id + symbol, set by the fetcher's Next
// cursor after the first run) or, on a fresh job, from the subject spelled as
// the gecko id; the canonical asset id mints from the symbol. Returns the
// self-contained cursor for the next run.
func (c *client) marketChart(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	id, _ := job.Cursor["id"].(string)
	if id == "" {
		id = job.Subject
	}
	if id == "" {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "market_chart job needs a gecko coin id (cursor id or subject)"}
	}
	sym, _ := job.Cursor["symbol"].(string)
	if sym == "" {
		s, ok := seedSymbols[id]
		if !ok {
			return 0, 0, nil, &HardError{Kind: "shape", Detail: "market_chart job needs cursor symbol for " + id}
		}
		sym = s
	}
	url := fmt.Sprintf("%s/coins/%s/market_chart?vs_currency=usd&days=90", Base, id)
	var res struct {
		Prices       [][2]float64 `json:"prices"`
		MarketCaps   [][2]float64 `json:"market_caps"`
		TotalVolumes [][2]float64 `json:"total_volumes"`
	}
	if err := c.getJSON(ctx, url, &res); err != nil {
		return 0, 0, nil, err
	}
	// The gecko id IS the provider symbol; the canonical asset comes from the
	// cursor's symbol (registered by the markets fetch), so the series ids
	// key on the canonical asset id, not the provider id.
	aid := assetID(sym)
	now := time.Now().UTC()
	obs := make([]canon.Observation, 0, len(res.Prices)+len(res.MarketCaps)+len(res.TotalVolumes))
	priceSeries := canon.MintID(canon.KindSeries, canon.SeriesKey("crypto", "price", "asset:"+aid))
	mcapSeries := canon.MintID(canon.KindSeries, canon.SeriesKey("crypto", "market_cap", "asset:"+aid))
	volSeries := canon.MintID(canon.KindSeries, canon.SeriesKey("crypto", "volume_24h", "asset:"+aid))
	for _, p := range res.Prices {
		at, ok := ms(p[0])
		if !ok {
			return 0, 0, nil, &HardError{Kind: "shape", URL: url, Detail: "prices point timestamp"}
		}
		obs = append(obs, observation(priceSeries, at, p[1], now))
	}
	for _, p := range res.MarketCaps {
		at, ok := ms(p[0])
		if !ok {
			return 0, 0, nil, &HardError{Kind: "shape", URL: url, Detail: "market_caps point timestamp"}
		}
		obs = append(obs, observation(mcapSeries, at, p[1], now))
	}
	for _, p := range res.TotalVolumes {
		at, ok := ms(p[0])
		if !ok {
			return 0, 0, nil, &HardError{Kind: "shape", URL: url, Detail: "total_volumes point timestamp"}
		}
		obs = append(obs, observation(volSeries, at, p[1], now))
	}
	if len(obs) == 0 {
		return 0, 0, ingest.Cursor{"id": id, "symbol": sym}, nil
	}
	written, rejected, err := w.WriteObservations(ctx, obs)
	next := ingest.Cursor{"id": id, "symbol": sym}
	if err != nil {
		return 0, 0, next, err
	}
	return written, rejected, next, nil
}

// seedSymbols maps the seed job subjects (gecko ids) to their canonical
// symbols, so a fresh market-chart job can mint series ids before the
// markets fetch has registered the provider symbol.
var seedSymbols = map[string]string{
	"bitcoin":  "BTC",
	"ethereum": "ETH",
}

// observation builds one latest-revision observation row.
func observation(seriesID string, at time.Time, value float64, retrieved time.Time) canon.Observation {
	v := value
	return canon.Observation{
		SeriesID:    seriesID,
		ObservedAt:  at,
		Value:       &v,
		Source:      "coingecko",
		RetrievedAt: retrieved,
	}
}

// upper is strings.ToUpper local (avoids a strings import per file).
func upper(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'a' && b[i] <= 'z' {
			b[i] -= 'a' - 'A'
		}
	}
	return string(b)
}
