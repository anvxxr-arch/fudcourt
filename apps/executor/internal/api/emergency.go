package api

import (
	"encoding/json"
	"net/http"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
)

// handleEmergency ports /api/executor/emergency (emergency/route.ts):
// POST stops every managed strategy the caller owns (optionally scoped to one
// account) and cancels managed open orders. Positions are NEVER closed here
// (PRD §75) — closing stays a separate, explicit action. An empty body means
// "everything I own".
func (s *Server) handleEmergency(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(w, r)
	if !ok {
		return
	}
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	var body struct {
		AccountID *string `json:"accountId"`
	}
	// A malformed body is SWALLOWED, exactly as the TS try/catch does: an
	// unparseable body means "no scope given", which is the valid §75
	// everything-I-own scope. Only a well-formed body with a non-string
	// accountId is a validation error.
	_ = json.Unmarshal(readBody(r), &body)
	if body.AccountID != nil && *body.AccountID == "" {
		validationError(w, []string{"accountId: must be a string when given"})
		return
	}
	accountID := body.AccountID
	result, err := s.emergencyStop(r, userID, accountID)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	var target *string
	if accountID != nil {
		target = accountID
	}
	s.audit(r.Context(), userID, "emergency_stop", target, map[string]any{
		"stopped": result.Stopped, "cancelledOrders": result.CancelledOrders,
	})
	WriteJSON(w, http.StatusOK, result)
}

// emergencyStop is emergencyStop in worker.ts: stop the caller's managed
// strategies and cancel their managed open orders. Ownership is filtered here
// (the store's scan is deliberately unscoped, PRD §68), so a user's emergency
// stop can never reach another account. A venue that cannot cancel a child
// leaves it UNKNOWN rather than pretending it was cancelled.
func (s *Server) emergencyStop(r *http.Request, userID string, accountID *string) (EmergencyStopResponse, error) {
	ctx := r.Context()
	running, err := s.store.ListRunningExecutions(ctx)
	if err != nil {
		return EmergencyStopResponse{}, err
	}
	var out EmergencyStopResponse
	for _, rec := range running {
		if rec.UserID != userID {
			continue
		}
		if accountID != nil && rec.AccountID != *accountID {
			continue
		}
		adapter, _ := s.venues.AdapterSealed(ctx, rec.Exchange, rec.MarketType, rec.AccountID)
		children, err := s.store.ListChildOrders(ctx, rec.ID)
		if err != nil {
			return EmergencyStopResponse{}, err
		}
		for _, child := range children {
			if terminalChild(child.Status) {
				continue
			}
			at := s.now()
			if adapter != nil && child.ExchangeOrderID != nil {
				if _, err := adapter.CancelOrder(ctx, child.Symbol, *child.ExchangeOrderID); err != nil {
					_ = s.store.UpdateChildOrderStatus(ctx, rec.ID, child.ClientOrderID, execution.ChildUnknown, at)
					continue
				}
			}
			if err := s.store.UpdateChildOrderStatus(ctx, rec.ID, child.ClientOrderID, execution.ChildCancelled, at); err != nil {
				return EmergencyStopResponse{}, err
			}
			out.CancelledOrders++
		}
		at := s.now()
		if err := s.store.UpdateExecutionStatus(ctx, rec.ID, execution.StatusStopped, at); err != nil {
			return EmergencyStopResponse{}, err
		}
		_, _ = s.store.AppendEvent(ctx, execution.ExecutionEventRecord{
			ExecutionID: rec.ID, Name: execution.EventExecutionFailed,
			Payload: map[string]any{
				"reason":   "emergency stop (PRD §75): managed orders cancelled, positions NOT closed",
				"workerId": "api-emergency",
			},
			CreatedAt: at,
		})
		out.Stopped++
	}
	return out, nil
}

// terminalChild is isTerminalChild in worker.ts: a child that can no longer be
// cancelled.
func terminalChild(status execution.ChildOrderStatus) bool {
	switch status {
	case execution.ChildFilled, execution.ChildCancelled, execution.ChildRejected, execution.ChildExpired:
		return true
	}
	return false
}
