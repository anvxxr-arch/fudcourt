package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
)

// handleExecutions ports /api/executor/executions (executions/route.ts):
// GET lists the session user's history with an optional ?status= filter, POST
// creates one with an immutable input snapshot.
func (s *Server) handleExecutions(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.listExecutions(w, r, userID)
	case http.MethodPost:
		s.createExecution(w, r, userID)
	default:
		methodGuard(w, r, http.MethodGet, http.MethodPost)
	}
}

// listExecutions answers `{ executions }`. An unknown status value is a 400
// (`{ error: 'status', detail }`) — never silently ignored (route handler
// checks the value against EXECUTION_TRANSITIONS).
func (s *Server) listExecutions(w http.ResponseWriter, r *http.Request, userID string) {
	var status *execution.ExecutionStatus
	if raw := r.URL.Query().Get("status"); raw != "" {
		if _, known := execution.ExecutionTransitions[execution.ExecutionStatus(raw)]; !known {
			writeDetail(w, http.StatusBadRequest, "status", "unknown execution status '"+raw+"'")
			return
		}
		v := execution.ExecutionStatus(raw)
		status = &v
	}
	records, err := s.store.ListExecutions(r.Context(), userID, status, 200)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]ExecutionRecord, 0, len(records))
	for _, rec := range records {
		out = append(out, toWireExecution(rec))
	}
	WriteJSON(w, http.StatusOK, ListExecutionsResponse{Executions: out})
}

// handleExecutionByID ports /api/executor/executions/{id} and its sub-routes
// (start, pause, resume, cancel, orders, fills, events). The tail is parsed
// here so the mux needs one pattern.
func (s *Server) handleExecutionByID(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(w, r)
	if !ok {
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/executor/executions/")
	if rest == "" || rest == r.URL.Path {
		notFound(w, "execution")
		return
	}
	id, sub, _ := strings.Cut(rest, "/")
	if id == "" {
		notFound(w, "execution")
		return
	}
	switch sub {
	case "":
		if !methodGuard(w, r, http.MethodGet) {
			return
		}
		s.getExecution(w, r, userID, id)
	case "start", "pause", "resume", "cancel":
		if !methodGuard(w, r, http.MethodPost) {
			return
		}
		s.lifecycle(w, r, userID, id, sub)
	case "orders":
		if !methodGuard(w, r, http.MethodGet) {
			return
		}
		s.listChildOrders(w, r, userID, id)
	case "fills":
		if !methodGuard(w, r, http.MethodGet) {
			return
		}
		s.listFills(w, r, userID, id)
	case "events":
		if !methodGuard(w, r, http.MethodGet) {
			return
		}
		s.listEvents(w, r, userID, id)
	default:
		notFound(w, "execution")
	}
}

// getExecution is `{ execution, plan }` — the plan is the immutable
// creation-time snapshot, null only when no plan row exists.
func (s *Server) getExecution(w http.ResponseWriter, r *http.Request, userID, id string) {
	rec, err := s.store.GetExecution(r.Context(), userID, id)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if rec == nil {
		notFound(w, "execution")
		return
	}
	plan, err := s.planJSON(r, rec.ID)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	WriteJSON(w, http.StatusOK, ExecutionDetailResponse{Execution: toWireExecution(*rec), Plan: plan})
}

// listChildOrders is `{ childOrders }`.
func (s *Server) listChildOrders(w http.ResponseWriter, r *http.Request, userID, id string) {
	rec, err := s.store.GetExecution(r.Context(), userID, id)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if rec == nil {
		notFound(w, "execution")
		return
	}
	children, err := s.store.ListChildOrders(r.Context(), rec.ID)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]ChildOrderRecord, 0, len(children))
	for _, c := range children {
		out = append(out, toWireChild(c))
	}
	WriteJSON(w, http.StatusOK, ListOrdersResponse{ChildOrders: out})
}

// listFills is `{ fills }` (deduped by the store/venue).
func (s *Server) listFills(w http.ResponseWriter, r *http.Request, userID, id string) {
	rec, err := s.store.GetExecution(r.Context(), userID, id)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if rec == nil {
		notFound(w, "execution")
		return
	}
	fills, err := s.store.ListFills(r.Context(), rec.ID)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]FillRecord, 0, len(fills))
	for _, f := range fills {
		out = append(out, toWireFill(f))
	}
	WriteJSON(w, http.StatusOK, ListFillsResponse{Fills: out})
}

// listEvents is `{ events }` (the append-only log, oldest first).
func (s *Server) listEvents(w http.ResponseWriter, r *http.Request, userID, id string) {
	rec, err := s.store.GetExecution(r.Context(), userID, id)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if rec == nil {
		notFound(w, "execution")
		return
	}
	events, err := s.store.ListEvents(r.Context(), rec.ID)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]ExecutionEventRecord, 0, len(events))
	for _, e := range events {
		payload := e.Payload
		if payload == nil {
			payload = map[string]any{}
		}
		out = append(out, ExecutionEventRecord{ID: e.ID, ExecutionID: e.ExecutionID, Name: e.Name, Payload: payload, CreatedAt: e.CreatedAt})
	}
	WriteJSON(w, http.StatusOK, ListEventsResponse{Events: out})
}

// lifecycle ports the start/pause/resume/cancel lifecycle intents (runtime.ts
// lifecycle). It maps the op to a target status exactly as the TS does, refuses
// an inapplicable or illegal step with 409 `{ error: 'invalid transition',
// detail }`, persists the status, appends the matching event and answers
// `{ execution }`.
func (s *Server) lifecycle(w http.ResponseWriter, r *http.Request, userID, id, op string) {
	rec, err := s.store.GetExecution(r.Context(), userID, id)
	if err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if rec == nil {
		notFound(w, "execution")
		return
	}
	to := targetStatus(op, rec.Status)
	if to == rec.Status {
		writeDetail(w, http.StatusConflict, "invalid transition", op+" is not applicable in status "+string(rec.Status))
		return
	}
	if !execution.CanTransition(rec.Status, to) {
		writeDetail(w, http.StatusConflict, "invalid transition",
			string(rec.Status)+" → "+string(to)+" is not a legal lifecycle step (PRD §57)")
		return
	}
	at := s.now()
	if err := s.store.UpdateExecutionStatus(r.Context(), rec.ID, to, at); err != nil {
		writeDetail(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	eventName := map[string]execution.ExecutionEventName{
		"start":  execution.EventExecutionStarted,
		"pause":  execution.EventExecutionPaused,
		"resume": execution.EventExecutionResumed,
		"cancel": execution.EventExecutionCancelled,
	}[op]
	_, _ = s.store.AppendEvent(r.Context(), execution.ExecutionEventRecord{
		ExecutionID: rec.ID, Name: eventName,
		Payload:   map[string]any{"from": string(rec.Status), "to": string(to)},
		CreatedAt: at,
	})
	s.audit(r.Context(), userID, "execution_"+op, &rec.ID, map[string]any{"from": string(rec.Status), "to": string(to)})
	fresh, err := s.store.GetExecution(r.Context(), userID, id)
	if err != nil || fresh == nil {
		updated := *rec
		updated.Status = to
		fresh = &updated
	}
	WriteJSON(w, http.StatusOK, LifecycleResponse{Execution: toWireExecution(*fresh)})
}

// targetStatus is the op → target-status map from runtime.ts lifecycle
// (verbatim). A same-status result means "not applicable" (409).
func targetStatus(op string, from execution.ExecutionStatus) execution.ExecutionStatus {
	switch op {
	case "start":
		if from == execution.StatusReady {
			return execution.StatusRunning
		}
	case "pause":
		switch from {
		case execution.StatusRunning, execution.StatusPartiallyFilled, execution.StatusReconciling:
			return execution.StatusPaused
		}
	case "resume":
		if from == execution.StatusPaused {
			return execution.StatusRunning
		}
	case "cancel":
		if from == execution.StatusReady || from == execution.StatusDraft {
			return execution.StatusCancelled
		}
		return execution.StatusCancelRequested
	}
	return from
}

// planJSON returns the immutable plan as raw JSON (null when absent).
func (s *Server) planJSON(r *http.Request, executionID string) (json.RawMessage, error) {
	raw, ok, err := s.store.GetExecutionPlan(r.Context(), executionID)
	if err != nil {
		return nil, err
	}
	if !ok || len(raw) == 0 {
		return json.RawMessage("null"), nil
	}
	return raw, nil
}
