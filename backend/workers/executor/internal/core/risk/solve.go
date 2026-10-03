package risk

import (
	"fmt"
	"math/big"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
)

// RiskVsProfitConflict builds the PRD §14 response shape: Requested vs Possible
// using current SL/TP, with the printed figures in Detail.
func RiskVsProfitConflict(maxLoss, targetProfit, achievableProfit, requiredRisk *big.Rat) ConstraintConflict {
	return ConstraintConflict{
		Code: "risk_vs_profit",
		Message: fmt.Sprintf(
			"Requested: Max Loss %s, Target Profit %s. Possible using current SL/TP: Max Loss %s, Profit %s. To achieve %s target, Required Risk ≈ %s.",
			usdTrim(maxLoss), usdTrim(targetProfit), usdTrim(maxLoss), usdTrim(achievableProfit), usdTrim(targetProfit), usdTrim(requiredRisk)),
		Detail: map[string]string{
			"maxLoss":          Wire(maxLoss),
			"targetProfit":     Wire(targetProfit),
			"achievableProfit": Wire(achievableProfit),
			"requiredRisk":     Wire(requiredRisk),
		},
	}
}

// consistent mirrors the solver's over-determination check: values within
// max(|a|,|b|,1)·1e-12 agree; anything else is a contradiction, never a pick.
func consistent(a, b *big.Rat) bool {
	if a == nil || b == nil {
		return true
	}
	tol := rmul(maxRat(rabs(a), rabs(b), rone()), big.NewRat(1, 1_000_000_000_000))
	return rabs(rsub(a, b)).Cmp(tol) <= 0
}

func maxRat(vals ...*big.Rat) *big.Rat {
	out := vals[0]
	for _, v := range vals[1:] {
		if v.Cmp(out) > 0 {
			out = v
		}
	}
	return out
}

// SolvePosition is the PRD §15 closed-form propagation over any known subset of
// {entry, stop, target, quantity, risk, profit, margin, notional, leverage}.
// Underdetermined variables are listed in Unsatisfied (never guessed);
// contradictions and the PRD §14 risk+profit pair land in Conflicts. The §15
// example (E=100, TP=120, P=200, margin=250 → Q=10, N=1000, L=4x) reproduces
// exactly at zero fees.
func SolvePosition(input SolveInput) (SolveResult, error) {
	var warnings []string
	var conflicts []ConstraintConflict
	var unsatisfied []SolveKey
	if err := requireInstrument(input.Instrument); err != nil {
		return SolveResult{}, err
	}
	instrument := input.Instrument
	side := input.Side
	if side != execution.SideSell {
		side = execution.SideBuy
	}
	// The solver prices with default entry type (market), mirroring risk.ts.
	rE, rX, err := FeeRates(input.FeeModel, "")
	if err != nil {
		return SolveResult{}, err
	}
	slip, reservePct, err := SlipRates(input.SlippageModel, "")
	if err != nil {
		return SolveResult{}, err
	}
	mult, err := MultOf(instrument)
	if err != nil {
		return SolveResult{}, err
	}
	solved := map[string]string{}
	vals := map[SolveKey]*big.Rat{}
	knownPtrs := map[SolveKey]*string{
		SolveEntry: input.Known.Entry, SolveStop: input.Known.Stop, SolveTarget: input.Known.Target,
		SolveQuantity: input.Known.Quantity, SolveRisk: input.Known.Risk, SolveProfit: input.Known.Profit,
		SolveMargin: input.Known.Margin, SolveNotional: input.Known.Notional, SolveLeverage: input.Known.Leverage,
	}
	for _, name := range SolveKeys {
		v := knownPtrs[name]
		if v == nil {
			continue
		}
		d := readNum(*v, fmt.Sprintf("known.%s", name), &warnings)
		if d == nil {
			continue
		}
		if d.Sign() <= 0 {
			warnings = append(warnings, fmt.Sprintf("%s must be > 0", name))
			continue
		}
		vals[name] = d
		solved[string(name)] = Wire(d)
	}
	contradiction := func(code, message string, detail map[string]string) {
		conflicts = append(conflicts, ConstraintConflict{Code: code, Message: message, Detail: detail})
	}
	agree := func(a, b *big.Rat, label string) bool {
		if consistent(a, b) {
			return true
		}
		contradiction("inconsistent_known_values",
			fmt.Sprintf("%s is over-determined inconsistently (%s vs %s)", label, rstr(a), rstr(b)),
			map[string]string{"left": Wire(a), "right": Wire(b)})
		return false
	}
	e := vals[SolveEntry]
	s := vals[SolveStop]
	t := vals[SolveTarget]
	stopWrong := e != nil && s != nil && (side == execution.SideBuy && s.Cmp(e) >= 0 || side == execution.SideSell && s.Cmp(e) <= 0)
	targetWrong := e != nil && t != nil && (side == execution.SideBuy && t.Cmp(e) <= 0 || side == execution.SideSell && t.Cmp(e) >= 0)
	if stopWrong {
		label := "long"
		if side == execution.SideSell {
			label = "short"
		}
		contradiction("invalid_stop",
			fmt.Sprintf("stop must be on the loss side of entry for a %s", label),
			map[string]string{"entry": Wire(e), "stop": Wire(s)})
	} else if targetWrong {
		label := "long"
		if side == execution.SideSell {
			label = "short"
		}
		contradiction("invalid_target",
			fmt.Sprintf("target must be on the profit side of entry for a %s", label),
			map[string]string{"entry": Wire(e), "target": Wire(t)})
	} else {
		var uRisk, uProfit, qFromR, qFromP, qFromN *big.Rat
		if e != nil && s != nil {
			uRisk = unitRisk(e, s, mult, rE, rX, slip, reservePct)
		}
		if e != nil && t != nil {
			uProfit = unitProfit(e, t, mult, rE, rX, slip)
		}
		if vals[SolveRisk] != nil && uRisk != nil {
			qFromR = rquo(vals[SolveRisk], uRisk)
		}
		if vals[SolveProfit] != nil && uProfit != nil && uProfit.Sign() > 0 {
			qFromP = rquo(vals[SolveProfit], uProfit)
		}
		if vals[SolveNotional] != nil && e != nil {
			qFromN = rquo(vals[SolveNotional], rmul(e, mult))
		}
		// PRD §14: both a risk cap and a profit target over the same SL/TP pair.
		if qFromR != nil && qFromP != nil && input.Known.Risk != nil && input.Known.Profit != nil {
			achievable := rmul(qFromR, uProfit)
			required := rmul(qFromP, uRisk)
			tol := rmul(maxRat(rabs(vals[SolveProfit]), rone()), big.NewRat(1, 1_000_000_000))
			if rabs(rsub(vals[SolveProfit], achievable)).Cmp(tol) > 0 {
				conflicts = append(conflicts, RiskVsProfitConflict(vals[SolveRisk], vals[SolveProfit], achievable, required))
			}
		}
		var q *big.Rat
		switch {
		case vals[SolveQuantity] != nil:
			q = vals[SolveQuantity]
		case qFromR != nil && qFromP != nil:
			q = qFromR
			if qFromP.Cmp(qFromR) < 0 {
				q = qFromP
			}
		case qFromR != nil:
			q = qFromR
		case qFromP != nil:
			q = qFromP
		default:
			q = qFromN
		}
		if q != nil {
			agreed := agree(vals[SolveQuantity], qFromR, "quantity vs risk") &&
				agree(vals[SolveQuantity], qFromP, "quantity vs profit") &&
				agree(vals[SolveQuantity], qFromN, "quantity vs notional") &&
				agree(qFromR, qFromN, "risk-derived vs notional-derived quantity") &&
				agree(qFromP, qFromN, "profit-derived vs notional-derived quantity")
			if agreed {
				if vals[SolveQuantity] == nil {
					solved[string(SolveQuantity)] = Wire(q)
				}
			} else {
				q = nil
			}
		}
		if vals[SolveNotional] == nil && q != nil && e != nil {
			vals[SolveNotional] = rmul(rmul(q, e), mult)
			solved[string(SolveNotional)] = Wire(vals[SolveNotional])
		}
		if vals[SolveRisk] == nil && q != nil && uRisk != nil {
			solved[string(SolveRisk)] = Wire(rmul(q, uRisk))
		}
		if vals[SolveProfit] == nil && q != nil && uProfit != nil {
			solved[string(SolveProfit)] = Wire(rmul(q, uProfit))
		}
		// L·margin = N (PRD §15).
		var n *big.Rat
		if vals[SolveNotional] != nil {
			n = vals[SolveNotional]
		} else if q != nil && e != nil {
			n = rmul(rmul(q, e), mult)
		}
		var lFromM *big.Rat
		if vals[SolveMargin] != nil && vals[SolveMargin].Sign() > 0 && n != nil {
			lFromM = rquo(n, vals[SolveMargin])
		}
		if lFromM != nil {
			if agree(vals[SolveLeverage], lFromM, "leverage vs margin/notional") {
				if vals[SolveLeverage] == nil {
					// Round only when the derived leverage lands on a user-facing
					// integer scale (PRD §15: 4x).
					roundedL := roundHalfUp(lFromM, 0)
					finalL := lFromM
					if rabs(rsub(roundedL, lFromM)).Cmp(big.NewRat(1, 1_000_000_000)) <= 0 {
						finalL = roundedL
					}
					vals[SolveLeverage] = finalL
					solved[string(SolveLeverage)] = Wire(finalL)
				}
			}
		}
		if vals[SolveMargin] == nil && vals[SolveLeverage] != nil && n != nil {
			vals[SolveMargin] = rquo(n, vals[SolveLeverage])
			solved[string(SolveMargin)] = Wire(vals[SolveMargin])
		}
		if vals[SolveLeverage] != nil && vals[SolveMargin] != nil {
			nFromLM := rmul(vals[SolveLeverage], vals[SolveMargin])
			if agree(vals[SolveNotional], nFromLM, "notional vs leverage·margin") && vals[SolveNotional] == nil {
				vals[SolveNotional] = nFromLM
				solved[string(SolveNotional)] = Wire(nFromLM)
			}
		}
	}
	for _, name := range SolveKeys {
		if _, ok := solved[string(name)]; !ok {
			unsatisfied = append(unsatisfied, name)
		}
	}
	return SolveResult{Solved: solved, Unsatisfied: unsatisfied, Conflicts: conflicts, Warnings: warnings}, nil
}
