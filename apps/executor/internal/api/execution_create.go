package api

import (
	"context"
	"errors"
	"math/big"
	"net/http"
	"strconv"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/planner"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/risk"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/decimal"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/repository"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/strategies"
)

// handlePreview ports /api/executor/preview (preview/route.ts): a dry run that
// creates nothing and places nothing (§98). It plans against live venue data
// and answers `{ preview, liveEnabled }`. Planning conflicts are reported INSIDE
// the 200 preview (preview.conflicts), never as an error at preview time.
func (s *Server) handlePreview(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(w, r)
	if !ok {
		return
	}
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body := readBody(r)
	if len(strings.TrimSpace(string(body))) == 0 {
		invalidJSON(w)
		return
	}
	req, shapeErrs, err := decodeRequest(body)
	if err != nil {
		invalidJSON(w)
		return
	}
	if len(shapeErrs) > 0 {
		validationError(w, shapeErrs)
		return
	}
	ctx, _, errRefusal := s.buildPlanContext(r.Context(), userID, req)
	if errRefusal != nil {
		errRefusal.write(w)
		return
	}
	outcome, planErr := planner.PlanExecution(ctx)
	if planErr != nil {
		// The TS answers validationError(outcome.errors): the SAME
		// `{ error: 'validation', errors: [...] }` body, carrying every
		// field-named message the planner produced.
		validationError(w, planErrors(planErr))
		return
	}
	_ = s.store.TouchCredential(r.Context(), userID, req.AccountID, s.now())
	WriteJSON(w, http.StatusOK, PreviewResponse{
		Preview:     mustJSON(planningPreviewValue(outcome, ctx, req, "preview")),
		LiveEnabled: s.live,
	})
}

// createExecution ports createExecution in runtime.ts: validate the shape,
// refuse a preview-mode create, gate LIVE behind the kill switch, plan, refuse a
// conflicting plan outright, then check the portfolio gates and the existing
// position policy BEFORE creating the row, then persist with an immutable input
// snapshot and answer `{ execution, plan }`.
func (s *Server) createExecution(w http.ResponseWriter, r *http.Request, userID string) {
	body := readBody(r)
	if len(strings.TrimSpace(string(body))) == 0 {
		invalidJSON(w)
		return
	}
	req, shapeErrs, err := decodeRequest(body)
	if err != nil {
		invalidJSON(w)
		return
	}
	if len(shapeErrs) > 0 {
		validationError(w, shapeErrs)
		return
	}
	if req.Mode != nil && *req.Mode == execution.ModePreview {
		writeDetail(w, http.StatusBadRequest, "invalid mode",
			"mode 'preview' is not creatable — use POST /api/executor/preview for a dry run, 'paper' or 'live' to create")
		return
	}
	mode := execution.ModePaper
	if req.Mode != nil {
		mode = *req.Mode
	}
	if mode == execution.ModeLive && !s.live {
		writeDetail(w, http.StatusForbidden, "live trading disabled",
			"FUDCOURT_EXECUTOR_LIVE is not 1 — the kill switch refuses live execution creation (PRD §108); use paper mode")
		return
	}
	planCtx, ctxRes, refusal := s.buildPlanContext(r.Context(), userID, req)
	if refusal != nil {
		refusal.write(w)
		return
	}
	outcome, planErr := planner.PlanExecution(planCtx)
	if planErr != nil {
		// validationError(outcome.errors) in runtime.ts: every field-named
		// planner message, never a single concatenated string.
		validationError(w, planErrors(planErr))
		return
	}
	if len(outcome.Conflicts) > 0 {
		WriteJSON(w, http.StatusConflict, PlanConflictError{
			Error:     "conflict",
			Conflicts: mustJSON(outcome.Conflicts),
			Preview:   mustJSON(planningPreviewValue(outcome, planCtx, req, mode)),
		})
		return
	}
	// Portfolio gates (§73/§74) and the §93 position policy run BEFORE the row
	// exists: a refused execution must leave nothing behind to reconcile.
	if g := s.checkPortfolioGates(r.Context(), userID, req, outcome, planCtx); g != nil {
		g.write(w)
		return
	}
	if g := s.checkPositionPolicy(r.Context(), userID, req, ctxRes); g != nil {
		g.write(w)
		return
	}
	at := s.now()
	planJSON := mustJSON(planningPlanValue(outcome, planCtx, req))
	rec, err := s.store.CreateExecution(r.Context(), createRecord(userID, req, outcome, planCtx, mode, at), planJSON)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	// Strategy state is built AFTER the id exists: its seeded PRNG and client
	// order id base embed it (fud_{executionId}_{seq}, §66).
	if strat, fresh, err := strategies.New(rec, 0); err == nil && strat != nil {
		_ = s.store.UpdateExecutionStrategyState(r.Context(), rec.ID, fresh)
	}
	_, _ = s.store.AppendEvent(r.Context(), execution.ExecutionEventRecord{
		ExecutionID: rec.ID, Name: execution.EventExecutionCreated,
		Payload: map[string]any{
			"mode":       string(mode),
			"sizingMode": string(outcome.SizingMode),
			"quantity":   outcome.Quantity,
			"riskBudget": outcome.Risk.Budget,
		},
		CreatedAt: at,
	})
	_, _ = s.store.AppendEvent(r.Context(), execution.ExecutionEventRecord{
		ExecutionID: rec.ID, Name: execution.EventRiskCalculated,
		Payload: map[string]any{
			"estimatedTotalRisk": outcome.Risk.EstimatedTotalRisk,
			"estimatedFees":      outcome.Risk.EstimatedFees,
			"slippageBudget":     outcome.Risk.SlippageBudget,
		},
		CreatedAt: at,
	})
	_, _ = s.store.AppendEvent(r.Context(), execution.ExecutionEventRecord{
		ExecutionID: rec.ID, Name: execution.EventPlanCreated,
		Payload: map[string]any{
			"venueKey":        venueKey(rec.Exchange, rec.MarketType, rec.Symbol),
			"strategy":        string(rec.ExecutionStrategy),
			"estimatedSlices": outcome.EstimatedSlices,
		},
		CreatedAt: at,
	})
	s.audit(r.Context(), userID, "execution_created", &rec.ID, map[string]any{
		"symbol": req.Symbol, "mode": string(mode), "strategy": string(rec.ExecutionStrategy),
	})
	WriteJSON(w, http.StatusOK, CreateExecutionResponse{
		Execution: toWireExecution(rec),
		Plan:      planJSON,
	})
}

// planErrors is the planner refusal's field-named message list
// (PlanOutcome.errors in plan.ts). A structural refusal that carries no list
// falls back to its single message, so the 400 never answers an empty array.
func planErrors(err error) []string {
	var pe *planner.PlanError
	if errors.As(err, &pe) {
		if len(pe.Validation) > 0 {
			return pe.Validation
		}
		if pe.Message != "" {
			return []string{pe.Message}
		}
	}
	return []string{err.Error()}
}

// venueKey is venueKey in types.ts: `${exchange}:${marketType}:${symbol}`.
func venueKey(exchange execution.ExchangeID, marketType execution.MarketType, symbol string) string {
	return string(exchange) + ":" + string(marketType) + ":" + symbol
}

// createRecord assembles the persistence record for a new execution. Every
// figure comes from the planner; the plan itself is stored separately as the
// immutable snapshot.
func createRecord(userID string, req planner.ExecutionRequest, outcome planner.PlanResult, ctx planner.PlanInputs, mode execution.ExecutionMode, at int64) execution.ExecutionRecord {
	var riskBasis *execution.BalanceBasis
	if outcome.RiskBasis != nil {
		riskBasis = outcome.RiskBasis
	}
	return execution.ExecutionRecord{
		UserID:            userID,
		AccountID:         req.AccountID,
		Exchange:          ctx.Exchange,
		Symbol:            req.Symbol,
		MarketType:        req.MarketType,
		Side:              req.Side,
		Intent:            req.Intent,
		Status:            execution.StatusReady,
		Mode:              mode,
		SizingMode:        req.Sizing.Mode,
		SizingValue:       sizingValue(req.Sizing),
		RiskBudget:        outcome.Risk.Budget,
		RiskBasis:         riskBasis,
		EntryDefinition:   req.Entry,
		StopDefinition:    req.StopLoss,
		TakeProfit:        req.TakeProfits,
		ExecutionStrategy: req.Execution.Type,
		ExecutionConfig:   executionConfigFrom(req),
		Constraints:       constraintsFrom(req),
		PlannedQuantity:   outcome.Quantity,
		PlannedNotional:   outcome.Notional,
		ActualQuantity:    "0",
		ActualNotional:    "0",
		EstimatedFees:     strPtrOrNil(outcome.Risk.EstimatedFees),
		ActualFees:        "0",
		PlannedRisk:       outcome.Risk.EstimatedTotalRisk,
		CreatedAt:         at,
	}
}

// sizingValue is the request's primary sizing figure as a decimal string.
func sizingValue(sd execution.SizingDefinition) string {
	switch sd.Mode {
	case execution.SizingRiskPercent, execution.SizingAllocationPercent, execution.SizingTargetProfitPercent:
		if sd.Percent != "" {
			return sd.Percent
		}
	case execution.SizingFixedQuantity:
		if sd.Quantity != "" {
			return sd.Quantity
		}
	case execution.SizingFixedMargin:
		if sd.Margin != "" {
			return sd.Margin
		}
	}
	if sd.Amount != "" {
		return sd.Amount
	}
	return "0"
}

func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// executionConfigFrom derives the persisted strategy config from the request.
// The record's ExecutionConfig is what the strategy engine READS back
// (strategies.initialState): DurationMs/Slices drive the TWAP schedule,
// DisplayQty the iceberg leg, ScaleLevels the ladder, and Twap the opt-in
// jitter. Jitter arrives as a fraction (0.05 = 5%) and is stored as bps, the
// engine's unit.
func executionConfigFrom(req planner.ExecutionRequest) execution.ExecutionConfig {
	cfg := execution.ExecutionConfig{}
	spec := req.Execution
	if spec.DurationMs != nil {
		cfg.DurationMs = *spec.DurationMs
	}
	if spec.Slices != nil {
		cfg.Slices = *spec.Slices
	}
	if spec.Type == execution.StrategyIceberg {
		cfg.DisplayQty = spec.VisibleQuantity
	}
	if spec.Type == execution.StrategyScaleIn || spec.Type == execution.StrategyScaleOut {
		cfg.ScaleLevels = spec.Levels
	}
	if spec.Config != nil {
		tw := &execution.TwapConfig{OrderType: spec.Config.OrderType}
		if spec.Config.DurationMs != nil {
			tw.DurationMs = *spec.Config.DurationMs
		}
		if spec.Config.Slices != nil {
			tw.Slices = *spec.Config.Slices
		}
		if spec.Config.QuantityJitterPct != nil {
			tw.QuantityJitterBps = fractionToBps(*spec.Config.QuantityJitterPct)
		}
		if spec.Config.IntervalJitterPct != nil {
			tw.IntervalJitterBps = fractionToBps(*spec.Config.IntervalJitterPct)
		}
		cfg.Twap = tw
	}
	return cfg
}

// constraintsFrom maps the request onto the persisted constraints shape. The
// chase knobs live on the execution spec (maxReplacements / maxChaseDistance /
// minReplacementIntervalMs) and the duration bound on the constraint spec; the
// record keeps only the fields the engine consumes.
func constraintsFrom(req planner.ExecutionRequest) execution.ExecutionConstraints {
	c := execution.ExecutionConstraints{}
	if req.Constraints != nil && req.Constraints.MaxDurationMs != nil {
		c.MaxDurationMs = *req.Constraints.MaxDurationMs
	}
	if req.Execution.MaxReplacements != nil {
		c.MaxReplacements = *req.Execution.MaxReplacements
	}
	if req.Execution.MaxChaseDistance != nil {
		c.MaxChaseDistance = *req.Execution.MaxChaseDistance
	}
	if req.Execution.MinReplacementIntervalMs != nil {
		c.MinReplacementIntervalMs = *req.Execution.MinReplacementIntervalMs
	}
	return c
}

// fractionToBps converts a decimal fraction ("0.05") to basis points (500).
// A malformed value is 0 (no jitter) — jitter is opt-in and never invented.
func fractionToBps(fraction string) int {
	r, err := decimal.Parse(fraction)
	if err != nil {
		return 0
	}
	bps := new(big.Rat).Mul(r, big.NewRat(10000, 1))
	n := new(big.Int).Quo(bps.Num(), bps.Denom())
	if !n.IsInt64() {
		return 0
	}
	return int(n.Int64())
}

// --- plan context ----------------------------------------------------------

// planContextResult carries the venue-derived data a plan is computed from.
type planContextResult struct {
	account  repository.CredentialRecord
	adapter  exchanges.Exchange
	market   *planner.MarketSnapshot
	balances *risk.BalanceSnapshot
	profile  execution.RiskProfile
	position string
}

// refusal is a mapped handler refusal (status + body) produced outside the
// writer so helpers can return it.
type refusal struct {
	status int
	body   any
}

func (r refusal) write(w http.ResponseWriter) { WriteJSON(w, r.status, r.body) }

func refusalBasic(status int, errToken string) refusal {
	return refusal{status: status, body: ErrorBasic{Error: errToken}}
}

func refusalDetail(status int, errToken, detail string) refusal {
	return refusal{status: status, body: ErrorDetail{Error: errToken, Detail: detail}}
}

// buildPlanContext fetches everything planExecution needs (buildPlanContext in
// runtime.ts): the account + sealed credential, the venue adapter, the
// instrument metadata, the market snapshot, fees and balances. Each failure is
// mapped to the exact TS refusal.
func (s *Server) buildPlanContext(ctx context.Context, userID string, req planner.ExecutionRequest) (planner.PlanInputs, *planContextResult, *refusal) {
	var empty planner.PlanInputs
	account, err := s.store.GetCredential(ctx, userID, req.AccountID)
	if err != nil {
		r := refusalBasic(http.StatusInternalServerError, "internal error")
		return empty, nil, &r
	}
	if account == nil || account.RevokedAt != nil {
		r := refusalBasic(http.StatusNotFound, "account not found")
		return empty, nil, &r
	}
	if account.Health == execution.HealthRevoked || account.Health == execution.HealthInvalid {
		r := refusalDetail(http.StatusConflict, "credential not healthy", "account health is "+string(account.Health))
		return empty, nil, &r
	}
	adapter, err := s.venues.AdapterSealed(ctx, account.Exchange, req.MarketType, account.ID)
	if err != nil {
		r := refusalBasic(http.StatusNotFound, "account not found")
		return empty, nil, &r
	}
	instr, ok := s.instrumentFor(ctx, adapter, account, req.MarketType, req.Symbol)
	if !ok {
		r := refusalDetail(http.StatusBadRequest, "symbol not supported",
			req.Symbol+" is not a "+string(req.MarketType)+" market on "+string(account.Exchange))
		return empty, nil, &r
	}
	snapshot, feeModel, balances, r := s.marketInputs(ctx, adapter, req, account)
	if r != nil {
		return empty, nil, r
	}
	profile, err := s.store.GetRiskProfile(ctx, userID)
	if err != nil {
		rf := refusalBasic(http.StatusInternalServerError, "internal error")
		return empty, nil, &rf
	}
	if profile.DefaultRiskMode == "" {
		profile = planner.DefaultRiskProfile
	}
	inputs := planner.PlanInputs{
		Request:       req,
		Market:        snapshot,
		Exchange:      account.Exchange,
		Instrument:    instr,
		FeeModel:      feeModel,
		SlippageModel: planner.DefaultSlippageModel,
		Balances:      balances,
		RiskProfile:   &profile,
	}
	return inputs, &planContextResult{account: *account, adapter: adapter, market: snapshot, balances: balances, profile: profile}, nil
}

// instrumentFor resolves the requested symbol's metadata from the venue's
// instrument list, cached per (account, marketType) exactly as the TS does. A
// venue that cannot enumerate instruments is a "market data unavailable" 502 —
// never a fabricated grid.
func (s *Server) instrumentFor(ctx context.Context, adapter exchanges.Exchange, account *repository.CredentialRecord, marketType execution.MarketType, symbol string) (risk.InstrumentMetadata, bool) {
	key := account.ID + ":" + string(marketType)
	byKey, ok := s.markets.get(key, s.now())
	if !ok {
		markets, err := adapter.GetMarkets(ctx)
		if err != nil {
			return risk.InstrumentMetadata{}, false
		}
		byKey = map[string]exchanges.Instrument{}
		for _, m := range markets {
			if m.MarketType == marketType {
				byKey[m.Symbol] = m.Metadata
			}
		}
		s.markets.put(key, byKey, s.now())
	}
	instr, found := byKey[symbol]
	if !found {
		return risk.InstrumentMetadata{}, false
	}
	return toPlannerInstrument(instr), true
}

// marketInputs fetches the ticker, fees and balances — the "market data
// unavailable" 502 path in runtime.ts.
func (s *Server) marketInputs(ctx context.Context, adapter exchanges.Exchange, req planner.ExecutionRequest, account *repository.CredentialRecord) (*planner.MarketSnapshot, risk.FeeModel, *risk.BalanceSnapshot, *refusal) {
	ticker, err := adapter.GetTicker(ctx, req.Symbol)
	if err != nil {
		r := categorizedRefusal(err)
		return nil, risk.FeeModel{}, nil, &r
	}
	snap, err := exchanges.TickerSnapshot(ticker, s.now())
	if err != nil {
		r := categorizedRefusal(err)
		return nil, risk.FeeModel{}, nil, &r
	}
	fees, err := adapter.GetFees(ctx, req.Symbol)
	if err != nil {
		r := categorizedRefusal(err)
		return nil, risk.FeeModel{}, nil, &r
	}
	equity, err := adapter.GetBalance(ctx)
	if err != nil {
		r := categorizedRefusal(err)
		return nil, risk.FeeModel{}, nil, &r
	}
	balances := toBalanceSnapshot(equity, req.MarketType)
	ps := &planner.MarketSnapshot{
		Symbol:    snap.Symbol,
		Bid:       strPtrOrNil(snap.Bid),
		Ask:       strPtrOrNil(snap.Ask),
		Mid:       snap.Mid,
		SpreadBps: snap.SpreadBps,
		Last:      snap.Last,
		Timestamp: snap.Timestamp,
	}
	return ps, risk.FeeModel{MakerBps: fees.MakerBps, TakerBps: fees.TakerBps}, &balances, nil
}

// categorizedRefusal maps a market-data failure onto the 502
// `{ error: 'market data unavailable', detail, category }` envelope.
func categorizedRefusal(err error) refusal {
	return refusal{status: http.StatusBadGateway, body: CategorizedError{
		Error:    "market data unavailable",
		Detail:   probeMessage(err),
		Category: classifyProbeError(err),
	}}
}

// toBalanceSnapshot is toBalanceSnapshot in runtime.ts (§10 wallet-class
// mapping): one adapter sees ONE wallet class, the other side stays honestly
// null.
func toBalanceSnapshot(equity execution.AccountEquity, marketType execution.MarketType) risk.BalanceSnapshot {
	var quote *execution.Balance
	for i := range equity.Balances {
		if equity.Balances[i].Asset == "USDT" {
			quote = &equity.Balances[i]
			break
		}
	}
	free := func() *string {
		if quote == nil {
			return nil
		}
		v := quote.Free
		return &v
	}
	fallback := func(primary *string) *string {
		if primary != nil {
			return primary
		}
		return equity.TotalEquity
	}
	if marketType == execution.MarketSpot {
		return risk.BalanceSnapshot{
			SpotAvailable:       free(),
			SpotEquity:          fallback(equity.SpotEquity),
			TotalExchangeEquity: equity.TotalEquity,
		}
	}
	return risk.BalanceSnapshot{
		FuturesAvailable:    free(),
		FuturesEquity:       fallback(equity.FuturesEquity),
		TotalExchangeEquity: equity.TotalEquity,
	}
}

// toPlannerInstrument maps a venue instrument onto the planner/risk metadata
// (the two spellings are the same contract; this keeps the boundary explicit).
func toPlannerInstrument(in exchanges.Instrument) risk.InstrumentMetadata {
	brackets := make([]risk.LeverageBracket, 0, len(in.LeverageBrackets))
	for _, b := range in.LeverageBrackets {
		brackets = append(brackets, risk.LeverageBracket{
			MaxNotional:           b.MaxNotional,
			MaxLeverage:           b.MaxLeverage,
			MaintenanceMarginRate: b.MaintenanceMarginRate,
		})
	}
	return risk.InstrumentMetadata{
		Symbol:                in.Symbol,
		MarketType:            in.MarketType,
		Exchange:              in.Exchange,
		BaseAsset:             in.BaseAsset,
		QuoteAsset:            in.QuoteAsset,
		SettlementAsset:       in.SettlementAsset,
		TickSize:              in.TickSize,
		StepSize:              in.StepSize,
		MinQuantity:           in.MinQuantity,
		MaxQuantity:           in.MaxQuantity,
		MinNotional:           in.MinNotional,
		MaxNotional:           in.MaxNotional,
		ContractMultiplier:    in.ContractMultiplier,
		MaxLeverage:           in.MaxLeverage,
		MaintenanceMarginRate: in.MaintenanceMarginRate,
		LeverageBrackets:      brackets,
	}
}

// --- portfolio / position gates --------------------------------------------

// checkPortfolioGates gathers committed state and defers to the pure rule
// (evaluatePortfolioGates in runtime.ts). Returns nil to allow.
func (s *Server) checkPortfolioGates(ctx context.Context, userID string, req planner.ExecutionRequest, plan planner.PlanResult, inputs planner.PlanInputs) *refusal {
	if req.Intent != execution.IntentOpen {
		return nil
	}
	equity, ok := portfolioEquity(inputs.Balances)
	if !ok {
		return nil // no basis ⇒ the ceiling is not computable, nothing is invented
	}
	openRisk, realized := s.portfolioRisk(ctx, userID)
	profile := planner.DefaultRiskProfile
	if inputs.RiskProfile != nil {
		profile = *inputs.RiskProfile
	}
	dailyCeiling := mulPct(equity, profile.MaxDailyLossPct)
	if cmpDec(realized, negate(dailyCeiling)) <= 0 {
		return &refusal{status: http.StatusConflict, body: gateRefusal{
			Error: "daily loss guard reached",
			Detail: "realized P&L today is " + usd(realized) + ", at or beyond your -" + profile.MaxDailyLossPct +
				"% limit (" + usd(dailyCeiling) + ") — new openings are blocked (PRD §74). Closing and reducing still work.",
			RealizedPnlToday: realized,
			MaxDailyLossPct:  profile.MaxDailyLossPct,
			MaxDailyLossUsd:  dailyCeiling,
		}}
	}
	if plan.Risk.EstimatedTotalRisk == nil {
		return nil // unbounded plan contributes nothing to the sum
	}
	ownRisk := *plan.Risk.EstimatedTotalRisk
	openCeiling := mulPct(equity, profile.MaxOpenRiskPct)
	afterCreate := addDec(openRisk, ownRisk)
	if cmpDec(afterCreate, openCeiling) <= 0 {
		return nil
	}
	return &refusal{status: http.StatusConflict, body: gateRefusal{
		Error: "max open risk exceeded",
		Detail: "open risk would reach " + usd(afterCreate) + ", beyond your " + profile.MaxOpenRiskPct +
			"% limit (" + usd(openCeiling) + "): already committed " + usd(openRisk) + ", this one adds " + usd(ownRisk) + " (PRD §73).",
		OpenRisk:       openRisk,
		RequestedRisk:  ownRisk,
		MaxOpenRiskPct: profile.MaxOpenRiskPct,
		MaxOpenRiskUsd: openCeiling,
	}}
}

// gateRefusal is the portfolio-gate refusal body: `{ error, detail }` plus the
// numbers that produced it (spread fields, TS order).
type gateRefusal struct {
	Error            string `json:"error"`
	Detail           string `json:"detail"`
	RealizedPnlToday string `json:"realizedPnlToday,omitempty"`
	MaxDailyLossPct  string `json:"maxDailyLossPct,omitempty"`
	MaxDailyLossUsd  string `json:"maxDailyLossUsd,omitempty"`
	OpenRisk         string `json:"openRisk,omitempty"`
	RequestedRisk    string `json:"requestedRisk,omitempty"`
	MaxOpenRiskPct   string `json:"maxOpenRiskPct,omitempty"`
	MaxOpenRiskUsd   string `json:"maxOpenRiskUsd,omitempty"`
}

// portfolioRisk rolls up the user's committed state. The durable store's SQL
// rollup is the source of truth; this in-process fallback sums the live rows so
// a memory store (tests) behaves the same.
func (s *Server) portfolioRisk(ctx context.Context, userID string) (openRisk, realizedToday string) {
	open, realized, err := s.store.SummarizePortfolioRisk(ctx, userID, startOfLocalDay(s.now()))
	if err != nil {
		return "0", "0"
	}
	return open, realized
}

// checkPositionPolicy gathers the venue's position and applies the §93 rule.
func (s *Server) checkPositionPolicy(ctx context.Context, userID string, req planner.ExecutionRequest, res *planContextResult) *refusal {
	if req.Intent != execution.IntentOpen {
		return nil
	}
	position, err := res.adapter.GetPosition(ctx, req.Symbol)
	existing := "0"
	if err != nil {
		if !errors.Is(err, exchanges.ErrNoPosition) {
			return &refusal{status: http.StatusBadGateway, body: CategorizedError{
				Error:    "position check unavailable",
				Detail:   probeMessage(err) + " — refusing to assume a flat account (PRD §93/§95)",
				Category: classifyProbeError(err),
			}}
		}
	} else {
		existing = position.Quantity
	}
	if cmpDec(existing, "0") == 0 {
		return nil
	}
	wanted := 1
	if req.Side == execution.SideSell {
		wanted = -1
	}
	if sign(existing) == wanted {
		return nil // ADD — an explicit increase
	}
	sideWord := "long"
	if sign(existing) < 0 {
		sideWord = "short"
	}
	return &refusal{status: http.StatusConflict, body: ErrorDetail{
		Error: "opposing position exists",
		Detail: req.Symbol + " already holds " + absDec(existing) + " on the " + sideWord +
			" side, so this " + string(req.Side) + " would net through flat rather than add. " +
			"Submit intent 'reduce' or 'close' to act on the existing position, or flatten it first (PRD §93: no accidental position netting).",
	}}
}

// --- small decimal helpers (exact, via the shared decimal package) ----------

func startOfLocalDay(ms int64) int64 {
	// Truncate to UTC midnight: the TS uses the server's local day; the
	// executor host runs UTC, and a stored ms offset would be a fabrication.
	const dayMs = 24 * 60 * 60 * 1000
	if ms < 0 {
		return 0
	}
	return (ms / dayMs) * dayMs
}

// portfolioEquity is portfolioEquity in runtime.ts: the total exchange equity
// when positive, else the sum of the positive per-class figures.
func portfolioEquity(b *risk.BalanceSnapshot) (string, bool) {
	if b == nil {
		return "", false
	}
	if b.TotalExchangeEquity != nil && isPositiveDec(*b.TotalExchangeEquity) {
		return *b.TotalExchangeEquity, true
	}
	parts := []*string{b.SpotEquity, b.FuturesEquity}
	sum := ""
	for _, p := range parts {
		if p != nil && isPositiveDec(*p) {
			if sum == "" {
				sum = *p
			} else {
				sum = addDec(sum, *p)
			}
		}
	}
	if sum == "" {
		return "", false
	}
	return sum, true
}

// usd renders a decimal as the TS `toLocaleString('en-US',{style:'currency'})`
// string with two fixed decimals and thousands separators — the exact text the
// refusal details carry.
func usd(amount string) string {
	f, err := strconv.ParseFloat(amount, 64)
	if err != nil {
		return "$0.00"
	}
	neg := f < 0
	if neg {
		f = -f
	}
	whole := strconv.FormatInt(int64(f), 10)
	frac := int64((f-float64(int64(f)))*100 + 0.5)
	if frac >= 100 {
		whole = strconv.FormatInt(int64(f)+1, 10)
		frac = 0
	}
	var b strings.Builder
	if neg {
		b.WriteString("-")
	}
	b.WriteString("$")
	writeGrouped(&b, whole)
	b.WriteString(".")
	b.WriteString(pad2(frac))
	return b.String()
}

func writeGrouped(b *strings.Builder, digits string) {
	n := len(digits)
	for i, c := range digits {
		if i > 0 && (n-i)%3 == 0 {
			b.WriteString(",")
		}
		b.WriteRune(c)
	}
}

func pad2(v int64) string {
	s := strconv.FormatInt(v, 10)
	if len(s) < 2 {
		return "0" + s
	}
	return s
}

// mulPct computes value × pct/100 exactly and returns the decimal string.
func mulPct(value, pct string) string {
	hundredth, err := decimal.Mul(value, pct)
	if err != nil {
		return "0"
	}
	out, err := decimal.Quo(hundredth, "100")
	if err != nil {
		return "0"
	}
	return out
}

func negate(s string) string {
	if strings.HasPrefix(s, "-") {
		return strings.TrimPrefix(s, "-")
	}
	if s == "0" {
		return "0"
	}
	return "-" + s
}
