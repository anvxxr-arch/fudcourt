package e2e

import (
	"context"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/exchange/paper"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
)

func TestDbgReject(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, "w1", func(c *paper.PaperConfig) { c.RejectOrders = 1; c.RejectCode = "MIN_NOTIONAL" })
	rec := execRec("e7", executor.StrategyMarket, "0.01", executor.EntryDefinition{Kind: "market"}, executor.ExecutionConfig{})
	_ = h.store.SaveExecution(ctx, rec)
	_, _ = h.w.StartExecution(ctx, "e7")
	for i := 1; i <= 3; i++ {
		h.tick()
		s, _ := h.store.Execution("e7")
		rows := h.children(t, "e7")
		t.Logf("tick %d status=%s childN=%d", i, s.Status, len(rows))
		for _, r := range rows {
			t.Logf("   child %s st=%s exch=%v", r.ClientOrderID, r.Status, r.ExchangeOrderID)
		}
		for _, e := range h.events() {
			t.Logf("   ev %s %v", e.Name, e.Payload)
		}
	}
}
