package polymarket

import (
	"context"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// marketsPage is the /markets page size. Gamma's own default is 100; pinned
// here so the cursor arithmetic and the endpoint shape stay in one place.
const marketsPage = 100

// markets fetches the open-market pages:
//
//	GET {Base}/markets?limit=100&offset=<offset>&active=true&closed=false
//
// Pages iterate until a short page (fewer rows than the limit) or maxPages.
// The job cursor carries "offset" (the next page's offset). Every decoded row
// writes one canon.PredictionMarket (market_id minted with the prediction
// kind over canon.PredictKey) and registers the provider symbol (gamma id ->
// prediction id). Rows with malformed outcomes/prices arrays are counted as
// rejected, never guessed.
func (c *client) markets(ctx context.Context, w canon.Writer, job ingest.Job, maxPages int) (int, int, ingest.Cursor, error) {
	if maxPages <= 0 {
		maxPages = defaultMaxPages
	}
	offset := 0
	if n, ok := job.Cursor["offset"].(float64); ok && n > 0 {
		offset = int(n)
	}
	now := time.Now().UTC()
	var rows []canon.PredictionMarket
	var symbols []canon.ProviderSymbol
	rejected := 0
	for range maxPages {
		url := fmt.Sprintf("%s/markets?limit=%d&offset=%d&active=true&closed=false", Base, marketsPage, offset)
		var raw []marketRow
		if err := c.getJSON(ctx, url, &raw); err != nil {
			return 0, 0, nil, err
		}
		for _, r := range raw {
			if r.ID == "" || r.Question == "" {
				rejected++
				continue
			}
			outcomes, ok := decodeStrings(r.Outcomes)
			if !ok {
				rejected++
				continue
			}
			prices, ok := decodeFloats(r.OutcomePrices)
			if !ok {
				rejected++
				continue
			}
			if len(prices) == 0 && len(outcomes) == 0 {
				// A market with neither outcomes nor prices carries no
				// readable state; count it, write nothing.
				rejected++
				continue
			}
			mid := canon.MintID(canon.KindPrediction, canon.PredictKey(Source, r.ID))
			rows = append(rows, canon.PredictionMarket{
				MarketID:         mid,
				Question:         r.Question,
				Outcomes:         outcomes,
				Prices:           prices,
				LiquidityUSD:     f64Ptr(r.LiquidityNum),
				Volume24hUSD:     f64Ptr(r.Volume24hr),
				EndDate:          parseTime(r.EndDate),
				ResolutionStatus: resolution(r.Active, r.Closed),
				Source:           Source,
				RetrievedAt:      now,
			})
			symbols = append(symbols, canon.ProviderSymbol{
				Provider:     Source,
				ProviderSymb: r.ID,
				Kind:         string(canon.KindPrediction),
				CanonicalID:  mid,
				LastSeenAt:   &now,
			})
		}
		offset += len(raw)
		if len(raw) < marketsPage {
			break
		}
	}
	if len(rows) > 0 {
		if _, err := w.UpsertProviderSymbols(ctx, symbols); err != nil {
			return 0, 0, nil, err
		}
	}
	written, rej, err := w.WritePredictionMarkets(ctx, rows)
	next := ingest.Cursor{"offset": float64(offset)}
	if err != nil {
		return written, rej + rejected, next, err
	}
	return written, rej + rejected, next, nil
}
