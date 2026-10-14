package jupiter

import (
	"context"
	"encoding/json"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/cache"
)

// hotCacheQuote writes the freshest route quote into the Valkey L2 under the
// plan §29 key shape (`dex:quote:{chain}:{in}:{out}:{amount}`) with a short TTL.
// The cache is an OPTIMISATION, never a source of truth (plan §16): a failed
// write is swallowed, and the Postgres row is the record. The write is
// best-effort and never fails the fetch.
func hotCacheQuote(ctx context.Context, q canon.RouteQuote) {
	if !cache.Enabled() {
		return
	}
	payload, err := json.Marshal(q)
	if err != nil {
		return
	}
	key := "dex:quote:" + q.ChainID + ":" + q.TokenIn + ":" + q.TokenOut + ":" + q.AmountIn.RawString()
	// Quotes decay in seconds; 10s is the plan §29 "quotes: seconds" window.
	cache.Set(ctx, key, string(payload), 10*time.Second)
}
