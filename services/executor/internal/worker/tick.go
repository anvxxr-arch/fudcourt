package worker

import (
	"context"
	"encoding/json"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/exchange"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/idempotency"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/orders"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/strategy"
)

// driveStatuses are the executions the worker actively drives (§57):
// working, partially filled, reconciling, or carrying a pending cancel intent.
func driveStatuses(s executor.ExecutionStatus) bool {
	switch s {
	case executor.StatusRunning, executor.StatusPartiallyFilled,
		executor.StatusReconciling, executor.StatusCancelRequested:
		return true
	}
	return false
}

// drive runs one execution for one pass: acquire lease (fail-closed), reconcile
// with the venue FIRST (§41/§95, §114), risk-check (§39), then — only when the
// pass permits placement — one deterministic strategy step with the over-order
// clamp in front of every CreateOrder (§107).
//
// INVARIANT: without a held lease the execution is not read for action, not
// written and not traded — "no lease = no trading" (§65).
func (w *Worker) drive(ctx context.Context, rec executor.ExecutionRecord, placementEnabled bool) {
	if !driveStatuses(rec.Status) {
		return
	}
	ttl := w.cfg.LockTTL.Milliseconds()
	acquired, err := w.cfg.Lock.Acquire(rec.ID, w.cfg.Owner, ttl)
	if err != nil || !acquired {
		return // contention or lock failure: leave the execution untouched (§65)
	}
	defer func() { _ = w.cfg.Lock.Release(rec.ID, w.cfg.Owner) }()

	ex, err := w.cfg.Exchanges(rec)
	if err != nil {
		w.event(ctx, rec.ID, executor.EventExternalStateChange,
			map[string]any{"detail": "exchange unavailable", "error": err.Error()}, w.clock.Now())
		return
	}
	now := w.clock.Now()

	// ---- 1. venue truth first (§41/§95/§114) ------------------------------
	venueOrders, err := ex.GetOpenOrders(ctx, rec.Symbol)
	if err != nil {
		w.event(ctx, rec.ID, executor.EventExternalStateChange,
			map[string]any{"detail": "get open orders failed", "error": err.Error()}, now)
		return // degraded: no new children this pass (§76)
	}
	w.reconcile(ctx, rec, venueOrders, now)

	// ---- 2. risk stop (§39): breach cancels entries and stops, never trades --
	if w.cfg.RiskCheck != nil {
		if breached, reason := w.cfg.RiskCheck(rec); breached {
			w.stopRisk(ctx, rec, ex, reason)
			return
		}
	}

	// ---- 3. cancel intent: perform it, then land CANCELLED ----------------
	if rec.Status == executor.StatusCancelRequested {
		w.cancelEntryAndFinish(ctx, rec, ex, executor.StatusCancelled, executor.EventExecutionCancelled, "cancel requested")
		return
	}

	// ---- 4. one deterministic strategy step -------------------------------
	strat, state, err := w.strategyFor(rec)
	if err != nil {
		// An unbuildable strategy is a FAILED execution, never a guessed one.
		agg := execution.New(rec)
		updated, transitioned, terr := agg.Apply(execution.CommandFail, now)
		if terr == nil && transitioned {
			_ = w.cfg.Store.SaveExecution(ctx, updated)
			w.event(ctx, updated.ID, executor.EventExecutionFailed,
				map[string]any{"reason": err.Error()}, now)
		}
		return
	}
	sctx := w.strategyContext(ctx, rec, ex, venueOrders, placementEnabled)
	newState, actions := strat.Step(state, sctx)

	// ---- 5. persist opaque strategy state BEFORE acting (PRD §130) ---------
	// MUST precede runActions: a pass that lands a terminal/paused status
	// (complete/cancel/risk-stop) writes that status to the row inside
	// runActions, so re-saving `rec` afterwards would restore the PRE-action
	// status — silently resurrecting a completed execution as RUNNING forever.
	rec.EngineState = newState
	_ = w.cfg.Store.SaveExecution(ctx, rec)

	// ---- 6. execute actions behind the hard clamp (§107) -------------------
	stopped := w.runActions(ctx, rec, ex, actions, placementEnabled)
	if stopped {
		return
	}

	// ---- 7. partial-fill bookkeeping (§57) ---------------------------------
	w.markProgress(ctx, rec)
}

// strategyFor returns the strategy and its state: the persisted opaque state
// when one exists (PRD §130 — resume the schedule, don't re-derive it), else a
// deterministic rebuild from (record, seed) whose child ids collide with this
// worker's earlier ones and are therefore ADOPTED, not re-created (§66/§114).
func (w *Worker) strategyFor(rec executor.ExecutionRecord) (strategy.Strategy, strategy.State, error) {
	strat, fresh, err := strategy.New(rec, w.cfg.Seed)
	if err != nil {
		return nil, nil, err
	}
	if rec.EngineState == nil {
		return strat, fresh, nil
	}
	raw, err := json.Marshal(rec.EngineState)
	if err != nil {
		return strat, fresh, nil // unreadable state: fall back to the rebuild
	}
	st := &strategy.StrategyState{}
	if err := json.Unmarshal(raw, st); err != nil || st.Version != 1 {
		return strat, fresh, nil
	}
	return strat, st, nil
}

// strategyContext assembles one tick's inputs. Ticker and position come from
// the venue every pass; a failed fetch is reported honestly (empty ticker, zero
// position — which makes reduce-only sizing place NOTHING rather than guess).
// FilledQuantity is the entry-side figure summed from entry child rows (a close
// never counts entry fills, PRD §40).
func (w *Worker) strategyContext(ctx context.Context, rec executor.ExecutionRecord,
	ex exchange.Exchange, venueOrders []executor.NormalizedOrder, placementEnabled bool) strategy.StrategyContext {
	now := w.clock.Now()
	filled := "0"
	for _, c := range w.children(ctx, rec.ID) {
		if !c.IsExit {
			filled, _ = addDec(filled, c.FilledQuantity)
		}
	}
	ticker, err := ex.GetTicker(ctx, rec.Symbol)
	if err != nil {
		ticker = executor.Ticker{Symbol: rec.Symbol, Ts: now} // honest empty quote
	}
	position := "0"
	if rec.Intent != executor.IntentOpen {
		// A reduce-only child is capped by the position actually open (PRD §40);
		// flat or unreported means no exit may be sized — never a guessed one.
		if p, err := ex.GetPosition(ctx, rec.Symbol); err == nil {
			if q := absDec(p.Quantity); q != "" {
				position = q
			}
		}
	}
	return strategy.StrategyContext{
		Now:                  now,
		Ticker:               ticker,
		OpenOrders:           venueOrders,
		FilledQuantity:       filled,
		OpenPositionQuantity: position,
		PlacementEnabled:     placementEnabled,
	}
}

// runActions executes strategy actions against the venue with the hard clamps
// (§107). Returns true when the execution reached a terminal/paused state and
// the caller must stop this pass immediately.
func (w *Worker) runActions(ctx context.Context, rec executor.ExecutionRecord, ex exchange.Exchange, actions []strategy.Action, placementEnabled bool) bool {
	for _, a := range actions {
		switch a.Kind {
		case strategy.ActionSubmit:
			if !placementEnabled {
				break // recovery reconciles first (§114); belt and braces on the gate
			}
			if w.placeChild(ctx, rec, ex, a) {
				return true
			}
		case strategy.ActionCancel:
			for _, c := range w.children(ctx, rec.ID) {
				if c.ClientOrderID == a.ClientOrderID && !terminalChild(c.Status) {
					w.cancelChild(ctx, rec, ex, c)
				}
			}
		case strategy.ActionComplete:
			w.cancelEntryAndFinish(ctx, rec, ex, executor.StatusFilled, executor.EventExecutionCompleted, "target quantity filled")
			return true
		}
	}
	return false
}

// placeChild clamps ONE placement (§107), persists the child row, then creates
// the venue order idempotently. Returns true when the pass must stop (a
// non-retryable rejection that pauses trading).
//
// INVARIANT: CreateOrder is called ONLY with a clamped quantity — the sum of
// entry quantities can never exceed planned − filled (§107/§128.15). A clamp
// emits PLAN_RESIZED with both quantities.
func (w *Worker) placeChild(ctx context.Context, rec executor.ExecutionRecord, ex exchange.Exchange, a strategy.Action) bool {
	now := w.clock.Now()
	req := a.Order
	ledger := w.ledger(ctx, rec.ID)
	clamped, err := orders.ClampChild(orders.Request{
		ClientOrderID: req.ClientOrderID,
		Quantity:      req.Quantity,
		StepSize:      w.cfg.QuantityStep(rec),
		IsExit:        req.ReduceOnly || req.Intent == executor.IntentClose || req.Intent == executor.IntentReduce,
		Intent:        req.Intent,
		ReduceOnly:    req.ReduceOnly,
	}, ledger, rec.PlannedQuantity)
	if err != nil || clamped.Quantity == "0" {
		if err == nil {
			w.event(ctx, rec.ID, executor.EventPlanResized, map[string]any{
				"clientOrderId": req.ClientOrderID,
				"requested":     req.Quantity,
				"clamped":       clamped.Quantity,
			}, now)
		}
		return false // nothing legal left to send
	}
	if clamped.Clamped {
		w.event(ctx, rec.ID, executor.EventPlanResized, map[string]any{
			"clientOrderId": req.ClientOrderID,
			"requested":     req.Quantity,
			"clamped":       clamped.Quantity,
		}, now)
		req.Quantity = clamped.Quantity
	}
	// Renew the lease BEFORE the money moves (§65 fail-closed): a lost lease
	// must stop placement cold. No child row is written on failure, so the
	// deterministic id is simply re-minted on a later owned pass.
	renewed, err := w.cfg.Lock.Renew(rec.ID, w.cfg.Owner, w.cfg.LockTTL.Milliseconds())
	if err != nil || !renewed {
		return true // lease lost: stop this pass entirely
	}
	_ = w.cfg.Store.SaveChildOrder(ctx, executor.ChildOrderRecord{
		ID:             childRowID(rec.ID, req.ClientOrderID),
		ExecutionID:    rec.ID,
		ClientOrderID:  req.ClientOrderID,
		Symbol:         req.Symbol,
		Side:           req.Side,
		Type:           req.OrderType,
		Price:          strPtr(req.Price),
		Quantity:       req.Quantity,
		FilledQuantity: "0",
		Status:         executor.ChildSubmitting,
		IsExit:         req.ReduceOnly,
		SubmittedAt:    now,
		UpdatedAt:      now,
	})
	placed, err := ex.CreateOrder(context.Background(), req)
	if err != nil {
		// A retryable failure may still have reached the venue: leave the row
		// SUBMITTING and let reconciliation adopt/correct it (§66). Anything
		// else REJECTS the child, which releases its room (§107 freed room).
		if isRetryable(err) {
			w.event(ctx, rec.ID, executor.EventOrderSubmitted, map[string]any{
				"clientOrderId": req.ClientOrderID,
				"deferred":      true,
				"error":         err.Error(),
			}, now)
			return false
		}
		w.event(ctx, rec.ID, executor.EventOrderRejected, map[string]any{
			"clientOrderId": req.ClientOrderID,
			"error":         err.Error(),
		}, now)
		return w.rejectChild(ctx, rec.ID, req.ClientOrderID, now)
	}
	status := placed.Status
	if status == "" {
		status = executor.ChildOpen
	}
	_ = w.cfg.Store.SaveChildOrder(ctx, executor.ChildOrderRecord{
		ID:              childRowID(rec.ID, req.ClientOrderID),
		ExecutionID:     rec.ID,
		ExchangeOrderID: strPtr(placed.ExchangeOrderID),
		ClientOrderID:   req.ClientOrderID,
		Symbol:          req.Symbol,
		Side:            req.Side,
		Type:            req.OrderType,
		Price:           strPtr(req.Price),
		Quantity:        req.Quantity,
		FilledQuantity:  placed.FilledQuantity,
		Status:          status,
		IsExit:          req.ReduceOnly,
		SubmittedAt:     now,
		UpdatedAt:       now,
	})
	w.event(ctx, rec.ID, executor.EventOrderSubmitted, map[string]any{
		"clientOrderId":   req.ClientOrderID,
		"exchangeOrderId": placed.ExchangeOrderID,
		"quantity":        req.Quantity,
	}, now)
	return false
}

// rejectChild marks a child REJECTED (releasing its clamp room, §107) and
// pauses trading when the rejection is an account-level problem (§76).
func (w *Worker) rejectChild(ctx context.Context, executionID, clientOrderID string, now int64) bool {
	for _, c := range w.children(ctx, executionID) {
		if c.ClientOrderID != clientOrderID {
			continue
		}
		c.Status = executor.ChildRejected
		c.UpdatedAt = now
		_ = w.cfg.Store.SaveChildOrder(ctx, c)
	}
	return false
}

// reconcile merges venue truth into the child rows (§41/§95) and ADOPTS venue
// orders carrying this execution's deterministic client order id that were
// never recorded locally (§114 crash window: the same stable id space means a
// retry that DID reach the venue is adopted, never re-placed).
//
// INVARIANT: a non-terminal child with no venue row and no SUBMITTING grace is
// marked UNKNOWN + EXTERNAL_STATE_CHANGE — fill ingestion decides the truth
// (§94); a SUBMITTING row may still be in flight and is left alone.
func (w *Worker) reconcile(ctx context.Context, rec executor.ExecutionRecord, venueOrders []executor.NormalizedOrder, now int64) {
	children := w.children(ctx, rec.ID)
	known := map[string]bool{}
	for _, c := range children {
		known[c.ClientOrderID] = true
		venue, found := matchVenue(venueOrders, c)
		if !found {
			if !terminalChild(c.Status) && c.Status != executor.ChildSubmitting {
				c.Status = executor.ChildUnknown
				c.UpdatedAt = now
				_ = w.cfg.Store.SaveChildOrder(ctx, c)
				w.event(ctx, rec.ID, executor.EventExternalStateChange, map[string]any{
					"clientOrderId": c.ClientOrderID,
					"detail":        "child order no longer open on the venue",
				}, now)
			}
			continue
		}
		changed := false
		if venue.Status != "" && venue.Status != c.Status {
			if next, err := strategy.TransitionChildOrder(c.Status, childEventFor(venue.Status)); err == nil {
				fillEvent := ""
				switch {
				case next == executor.ChildFilled && c.Status != executor.ChildFilled:
					fillEvent = "filled"
				case next == executor.ChildPartial:
					fillEvent = "partial"
				}
				c.Status = next
				changed = true
				if fillEvent == "filled" {
					w.event(ctx, rec.ID, executor.EventOrderFilled,
						map[string]any{"clientOrderId": c.ClientOrderID}, now)
				} else if fillEvent == "partial" {
					w.event(ctx, rec.ID, executor.EventOrderPartiallyFilled,
						map[string]any{"clientOrderId": c.ClientOrderID}, now)
				}
			}
		}
		if cmpDec(venue.FilledQuantity, c.FilledQuantity) > 0 {
			c.FilledQuantity = venue.FilledQuantity
			changed = true
		}
		if venue.ExchangeOrderID != "" {
			c.ExchangeOrderID = strPtr(venue.ExchangeOrderID)
		}
		if changed {
			c.UpdatedAt = now
			_ = w.cfg.Store.SaveChildOrder(ctx, c)
		}
	}
	// Crash-window adoption (§114): our id space only (idempotency.Parse).
	for _, o := range venueOrders {
		if known[o.ClientOrderID] {
			continue
		}
		execID, _, err := idempotency.ParseClientOrderID(o.ClientOrderID)
		if err != nil || execID != rec.ID {
			continue // foreign or another execution's order: never adopted
		}
		_ = w.cfg.Store.SaveChildOrder(ctx, executor.ChildOrderRecord{
			ID:              childRowID(rec.ID, o.ClientOrderID),
			ExecutionID:     rec.ID,
			ExchangeOrderID: strPtr(o.ExchangeOrderID),
			ClientOrderID:   o.ClientOrderID,
			Symbol:          o.Symbol,
			Side:            o.Side,
			Type:            o.Type,
			Price:           o.Price,
			Quantity:        o.Quantity,
			FilledQuantity:  o.FilledQuantity,
			Status:          o.Status,
			IsExit:          o.IsExit,
			SubmittedAt:     o.SubmittedAt,
			UpdatedAt:       now,
		})
		w.event(ctx, rec.ID, executor.EventOrderSubmitted, map[string]any{
			"clientOrderId":   o.ClientOrderID,
			"exchangeOrderId": o.ExchangeOrderID,
			"adopted":         true,
		}, now)
	}
}

// stopRisk is the §39 risk-stop path: cancel entry children, land RISK_STOPPED,
// emit EXECUTION_RISK_STOPPED. Positions are NEVER closed here (§75: closing is
// a separate, explicit user action).
func (w *Worker) stopRisk(ctx context.Context, rec executor.ExecutionRecord, ex exchange.Exchange, reason string) {
	now := w.clock.Now()
	for _, c := range w.children(ctx, rec.ID) {
		if !c.IsExit && !terminalChild(c.Status) {
			w.cancelChild(ctx, rec, ex, c)
		}
	}
	agg := execution.New(rec)
	updated, transitioned, err := agg.Transition(executor.StatusRiskStopped, now)
	if err != nil || !transitioned {
		return // terminal already: idempotent no-op (objective §23)
	}
	_ = w.cfg.Store.SaveExecution(ctx, updated)
	w.event(ctx, updated.ID, executor.EventExecutionRiskStopped, map[string]any{
		"reason": reason,
	}, now)
}

// cancelEntryAndFinish cancels every live entry child and lands the execution
// in `to`, emitting `eventName` (§57/§115). Exit children survive — they are
// what closes the position (§40).
func (w *Worker) cancelEntryAndFinish(ctx context.Context, rec executor.ExecutionRecord, ex exchange.Exchange,
	to executor.ExecutionStatus, eventName executor.ExecutionEventName, reason string) {
	now := w.clock.Now()
	for _, c := range w.children(ctx, rec.ID) {
		if !c.IsExit && !terminalChild(c.Status) {
			w.cancelChild(ctx, rec, ex, c)
		}
	}
	agg := execution.New(rec)
	updated, transitioned, err := agg.Transition(to, now)
	if err != nil {
		// CancelRequested→… lands through the same table; anything refused is a
		// no-op rather than a corrupt transition (§57).
		return
	}
	if !transitioned {
		return
	}
	_ = w.cfg.Store.SaveExecution(ctx, updated)
	w.event(ctx, updated.ID, eventName, map[string]any{"reason": reason}, now)
}

// cancelChild cancels ONE child at the venue and records the outcome.
func (w *Worker) cancelChild(ctx context.Context, rec executor.ExecutionRecord, ex exchange.Exchange, c executor.ChildOrderRecord) {
	now := w.clock.Now()
	if c.ExchangeOrderID != nil && *c.ExchangeOrderID != "" {
		if _, err := ex.CancelOrder(context.Background(), c.Symbol, *c.ExchangeOrderID); err != nil {
			if isRetryable(err) {
				return // try again next pass; row stays live
			}
			c.Status = executor.ChildUnknown
			c.UpdatedAt = now
			_ = w.cfg.Store.SaveChildOrder(ctx, c)
			w.event(ctx, rec.ID, executor.EventExternalStateChange, map[string]any{
				"clientOrderId": c.ClientOrderID,
				"detail":        "cancel failed: " + err.Error(),
			}, now)
			return
		}
	}
	if next, err := strategy.TransitionChildOrder(c.Status, strategy.ChildEventCancel); err == nil {
		c.Status = next
	} else if c.Status == executor.ChildSubmitting {
		c.Status = executor.ChildCancelled // never reached the venue: dead on arrival
	}
	c.UpdatedAt = now
	_ = w.cfg.Store.SaveChildOrder(ctx, c)
	w.event(ctx, rec.ID, executor.EventOrderCancelled, map[string]any{
		"clientOrderId": c.ClientOrderID,
	}, now)
}

// markProgress moves RUNNING → PARTIALLY_FILLED once an entry child has a fill
// and entry work remains (§57). The matching child-level ORDER_* events were
// emitted at the fill itself (§63 vocabulary).
func (w *Worker) markProgress(ctx context.Context, rec executor.ExecutionRecord) {
	if rec.Status != executor.StatusRunning {
		return
	}
	anyFilled, entryDone := false, true
	for _, c := range w.children(ctx, rec.ID) {
		if c.IsExit {
			continue
		}
		if cmpDec(c.FilledQuantity, "0") > 0 {
			anyFilled = true
		}
		if !terminalChild(c.Status) {
			entryDone = false
		}
	}
	if !anyFilled || entryDone {
		return
	}
	agg := execution.New(rec)
	updated, transitioned, err := agg.Transition(executor.StatusPartiallyFilled, w.clock.Now())
	if err != nil || !transitioned {
		return
	}
	_ = w.cfg.Store.SaveExecution(ctx, updated)
}

// children returns the execution's child rows (a copy).
func (w *Worker) children(ctx context.Context, executionID string) []executor.ChildOrderRecord {
	rows, err := w.cfg.Store.ListChildOrders(ctx, executionID)
	if err != nil {
		return nil
	}
	return rows
}

// ledger projects the child rows onto the clamp's quantity ledger (§107).
func (w *Worker) ledger(ctx context.Context, executionID string) *orders.Ledger {
	l := orders.NewLedger()
	for _, c := range w.children(ctx, executionID) {
		l.Track(orders.Child{
			ClientOrderID:  c.ClientOrderID,
			Quantity:       c.Quantity,
			FilledQuantity: c.FilledQuantity,
			IsExit:         c.IsExit,
			Status:         c.Status,
		})
	}
	return l
}
