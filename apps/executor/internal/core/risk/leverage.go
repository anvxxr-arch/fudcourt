package risk

import (
	"math/big"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
)

// defaultMMR is the maintenance margin rate used when the venue does not report
// one (risk.ts DEFAULT_MMR). Preview-grade only (PRD §21).
var defaultMMR = big.NewRat(5, 1000)

// liquidationPrice computes E·(1 ∓ 1/L + mmr) exactly at a given leverage.
func liquidationPrice(side execution.Side, e, lev, mmr *big.Rat) *big.Rat {
	if side == execution.SideSell {
		return rmul(e, rsub(radd(rone(), rquo(rone(), lev)), mmr))
	}
	return rmul(e, radd(rsub(rone(), rquo(rone(), lev)), mmr))
}

// LiquidationPriceApprox is the preview-grade liquidation estimate (PRD §21):
// long liq ≈ E·(1 − 1/L + mmr), short liq ≈ E·(1 + 1/L − mmr). Never a venue
// figure — the exchange formula wins at execution time.
func LiquidationPriceApprox(side execution.Side, entry, leverage string, maintenanceMarginRate *string) (string, error) {
	e, err := requiredNum(entry, "entry")
	if err != nil {
		return "", err
	}
	lev, err := requiredNum(leverage, "leverage")
	if err != nil {
		return "", err
	}
	if lev.Sign() <= 0 {
		return "", errCode(CodeInvalidLeverage, "leverage", "leverage must be > 0")
	}
	mmr := defaultMMR
	if maintenanceMarginRate != nil {
		mmr, err = requiredNum(*maintenanceMarginRate, "maintenanceMarginRate")
		if err != nil {
			return "", err
		}
	}
	return Wire(liquidationPrice(side, e, lev, mmr)), nil
}

// AutoSafeLeverage (PRD §19–§20): margin feasibility is a LOWER bound on
// leverage (L ≥ ceil(N / (maxMarginPct·availableBalance)), ≥ 1); liquidation
// safety is an UPPER bound (higher leverage pulls liq toward entry). Selection
// is the MINIMUM feasible leverage — it maximizes liquidation distance — capped
// DOWN at min(userMax, exchangeMax) only when that cap is feasible. When the cap
// is BELOW the margin lower bound, margin is infeasible at the cap: the cap
// itself is selected (still ≤ every max — PRD §106 holds in every branch), with
// the warning `insufficient available balance for margin at max leverage` and
// LiquidationSafe forced false — never claimed safe. Otherwise safety is
// decided by evaluating the §20 buffer rule at the selection.
func AutoSafeLeverage(input AutoLeverageInput) (AutoLeverageResult, error) {
	var warnings []string
	side := input.Side
	if side != execution.SideSell {
		side = execution.SideBuy
	}
	e, err := requiredNum(input.Entry, "entry")
	if err != nil {
		return AutoLeverageResult{}, err
	}
	var stop *big.Rat
	if input.Stop != nil {
		stop, err = requiredNum(*input.Stop, "stop")
		if err != nil {
			return AutoLeverageResult{}, err
		}
	}
	notional, err := requiredNum(input.Notional, "notional")
	if err != nil {
		return AutoLeverageResult{}, err
	}
	notional = clampNeg(notional, "notional", &warnings)
	available, err := requiredNum(input.AvailableBalance, "availableBalance")
	if err != nil {
		return AutoLeverageResult{}, err
	}
	userMax, err := requiredNum(input.MaxLeverage, "maxLeverage")
	if err != nil {
		return AutoLeverageResult{}, err
	}
	var exchangeMax *big.Rat
	if input.ExchangeMaxLeverage != nil {
		exchangeMax, err = requiredNum(*input.ExchangeMaxLeverage, "exchangeMaxLeverage")
		if err != nil {
			return AutoLeverageResult{}, err
		}
	}
	bufferPct, err := requiredNum(input.LiquidationBufferPct, "liquidationBufferPct")
	if err != nil {
		return AutoLeverageResult{}, err
	}
	bufferPct = clampNeg(bufferPct, "liquidationBufferPct", &warnings)
	maxMarginPct, err := requiredNum(input.MaxMarginPct, "maxMarginPct")
	if err != nil {
		return AutoLeverageResult{}, err
	}
	mmr := defaultMMR
	if input.MaintenanceMarginRate != nil {
		mmr, err = requiredNum(*input.MaintenanceMarginRate, "maintenanceMarginRate")
		if err != nil {
			return AutoLeverageResult{}, err
		}
	}
	cap := userMax
	if exchangeMax != nil && exchangeMax.Cmp(userMax) < 0 {
		cap = exchangeMax
	}
	unselectable := func(reason string) AutoLeverageResult {
		warnings = append(warnings, reason)
		return AutoLeverageResult{
			Selected: "1", EstimatedMargin: "0", LiquidationPrice: nil,
			LiquidationSafe: false, Warnings: warnings,
		}
	}
	if cap.Sign() <= 0 {
		return unselectable("leverage caps are non-positive; cannot select leverage"), nil
	}
	if e.Sign() <= 0 {
		return unselectable("entry price must be > 0"), nil
	}
	if maxMarginPct.Sign() <= 0 {
		return unselectable("maxMarginPct must be > 0; cannot size margin"), nil
	}
	availNonNeg := available
	if availNonNeg.Sign() < 0 {
		availNonNeg = rzero()
	}
	// Lower bound from margin policy; at least 1 (PRD §19). Ceiling division.
	// A zero available balance makes the bound unbounded (decimal.js yields
	// Infinity here) — the infeasible branch below then selects the cap.
	sel := (*big.Rat)(nil)
	if denom := rmul(maxMarginPct, availNonNeg); denom.Sign() > 0 {
		sel = ceilDiv(notional, denom)
		if sel.Cmp(rone()) < 0 {
			sel = rone()
		}
	}
	infeasibleMargin := false
	if available.Sign() <= 0 || sel == nil || sel.Cmp(cap) > 0 {
		sel = cap
		infeasibleMargin = true
		warnings = append(warnings, "insufficient available balance for margin at max leverage")
	}
	estimatedMargin := rquo(notional, sel)
	liq := liquidationPrice(side, e, sel, mmr)
	liquidationSafe := false
	if stop == nil {
		warnings = append(warnings, "no stop configured; liquidation safety cannot be verified")
	} else if checkPrices(e, stop, nil, side, &warnings) {
		// §20 buffer rule at `selected`: safe ⟺ liq beyond S ∓ bufferPct·|E−S|.
		distance := rabs(rsub(e, stop))
		var safe bool
		if side == execution.SideSell {
			target := radd(stop, rmul(distance, bufferPct))
			safe = liq.Cmp(target) >= 0
		} else {
			target := rsub(stop, rmul(distance, bufferPct))
			safe = liq.Cmp(target) <= 0
		}
		liquidationSafe = safe
		if !safe {
			warnings = append(warnings, "liquidation price is inside the SL-to-liquidation buffer at the minimum feasible leverage")
		}
	}
	if infeasibleMargin {
		liquidationSafe = false
	}
	return AutoLeverageResult{
		Selected:         Wire(sel),
		EstimatedMargin:  Wire(estimatedMargin),
		LiquidationPrice: strPtr(Wire(liq)),
		LiquidationSafe:  liquidationSafe,
		Warnings:         warnings,
	}, nil
}

// ceilDiv returns ceil(a/b) for positive b (mirrors decimal.js ROUND_UP).
func ceilDiv(a, b *big.Rat) *big.Rat {
	q := rquo(a, b)
	if q.IsInt() {
		return q
	}
	whole := new(big.Rat).SetInt(new(big.Int).Quo(q.Num(), q.Denom()))
	if q.Sign() > 0 {
		whole = radd(whole, rone())
	}
	return whole
}

func strPtr(s string) *string { return &s }
