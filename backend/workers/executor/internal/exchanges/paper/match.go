package paper

import (
	"fmt"
	"strings"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/decimal"
)

// This file mirrors frontend/web/src/platform/executor/exchange.ts matchOrder and
// settle: market orders fill immediately in FillRate chunks at mark ±
// slippage; limit orders fill at their limit price once the mark crosses
// (buy: mark <= price, sell: mark >= price); settlement moves spot balances
// base-vs-quote and linear balances by fee + realized PnL only (the TS
// simulator settles margin-less quote deltas — margin is not modeled here).

// matchLocked runs one matching pass over every order in acceptance order
// (deterministic partial-fill pacing). Matcher errors are surfaced, never
// swallowed.
func (p *Paper) matchLocked() error {
	for _, id := range p.orderSeq {
		if err := p.matchOrderLocked(p.orders[id]); err != nil {
			return err
		}
	}
	return nil
}

// matchOrderLocked fills one order if its cross condition holds — exactly one
// FillRate chunk per pass (the TS matchOrder step-safe chunk: a remainder
// under dustQty finishes the order so fills never leave a dust tail).
func (p *Paper) matchOrderLocked(o *orderState) error {
	if o.order.Status != execution.ChildOpen && o.order.Status != execution.ChildPartial {
		return nil
	}
	mark, ok := p.priceLocked(o.order.Symbol)
	if !ok {
		// No honest price (no mark, or the live source failed/refused): the
		// order rests until a price arrives — it never fills at a guess.
		return nil
	}
	isMarket := o.order.Type == "market"
	if !isMarket {
		limit := *o.order.Price
		c, err := decimal.Cmp(mark, limit)
		if err != nil {
			return err
		}
		crossed := (o.order.Side == execution.SideBuy && c <= 0) || (o.order.Side == execution.SideSell && c >= 0)
		if !crossed {
			return nil
		}
	}

	chunk, err := decimal.Mul(o.order.Quantity, p.fillRate)
	if err != nil {
		return err
	}
	fillQty := chunk
	// Step-safe chunk (TS: remaining - chunk < 1e-12 ? remaining : chunk): a
	// remainder under the dust threshold finishes the order so fills never
	// leave a dust tail. This also covers chunk > remaining on the last pass.
	tail, err := decimal.Sub(o.remaining, chunk)
	if err != nil {
		return err
	}
	tailCmp, err := decimal.Cmp(tail, dustQty)
	if err != nil {
		return err
	}
	if tailCmp < 0 {
		fillQty = o.remaining
	}
	qtyCmp, err := decimal.Cmp(fillQty, "0")
	if err != nil {
		return err
	}
	if qtyCmp <= 0 {
		return nil
	}

	feeRate := p.makerFee
	price := mark
	if isMarket {
		slipBps := p.slippageBps
		if p.rngOn {
			slipBps = p.randBpsLocked()
		}
		if o.order.Side == execution.SideSell {
			slipBps = -slipBps
		}
		price, err = bpsMove(mark, slipBps)
		if err != nil {
			return err
		}
		feeRate = p.takerFee
	} else {
		price = *o.order.Price
	}
	return p.settleLocked(o, fillQty, price, feeRate)
}

// settleLocked applies one fill exactly like the TS settle(): records the
// trade, moves balances, updates the one-way position (including realized PnL
// for linear) and advances the order through OPEN→PARTIAL→FILLED.
//
// SETTLEMENT MODEL:
//   - spot: a buy moves quote → base (quote -= qty*price + fee, base += qty);
//     a sell moves base → quote (base -= qty, quote += qty*price - fee).
//   - linear_perp: balances absorb the quote fee and the realized PnL delta of
//     the closing portion ((fillPrice - entryPrice) × closedQty, signed by the
//     position side) and NOTHING else — margin/marks-to-market are not
//     modeled (mirroring the TS simulator, whose notional term nets to zero).
//     The position's entry price is the quantity-weighted average on increases,
//     resets to the fill price on a side flip, and clears at flat.
//
// Fees are always charged in the quote asset.
func (p *Paper) settleLocked(o *orderState, qty, price, feeRate string) error {
	symbol := o.order.Symbol
	base, quote, err := splitSymbol(symbol)
	if err != nil {
		return err
	}
	notional, err := decimal.Mul(qty, price)
	if err != nil {
		return err
	}
	fee, err := decimal.Mul(notional, feeRate)
	if err != nil {
		return err
	}
	side := o.order.Side

	// Realized PnL is computed against the PRE-trade position (the TS order:
	// pnlDelta first, then the position update).
	pnl, err := p.pnlDeltaLocked(symbol, side, qty, price)
	if err != nil {
		return err
	}

	qb := p.balance(quote)
	switch p.market {
	case execution.MarketSpot:
		bb := p.balance(base)
		if side == execution.SideBuy {
			cost, err := decimal.Add(notional, fee)
			if err != nil {
				return err
			}
			qb.free, err = decimal.Sub(qb.free, cost)
			if err != nil {
				return err
			}
			bb.free, err = decimal.Add(bb.free, qty)
			if err != nil {
				return err
			}
		} else {
			bb.free, err = decimal.Sub(bb.free, qty)
			if err != nil {
				return err
			}
			proceeds, err := decimal.Sub(notional, fee)
			if err != nil {
				return err
			}
			qb.free, err = decimal.Add(qb.free, proceeds)
			if err != nil {
				return err
			}
		}
		p.balances[base] = bb
	default: // linear_perp: quote-settled fee + realized PnL only.
		qb.free, err = decimal.Sub(qb.free, fee)
		if err != nil {
			return err
		}
		if pnl != "0" {
			qb.free, err = decimal.Add(qb.free, pnl)
			if err != nil {
				return err
			}
		}
	}
	p.balances[quote] = qb

	if err := p.updatePositionLocked(symbol, side, qty, price); err != nil {
		return err
	}

	newQty, err := decimal.Add(o.order.FilledQuantity, qty)
	if err != nil {
		return err
	}
	o.order.FilledQuantity = newQty
	o.remaining, err = decimal.Sub(o.remaining, qty)
	if err != nil {
		return err
	}
	status := execution.ChildPartial
	remCmp, err := decimal.Cmp(o.remaining, dustQty)
	if err != nil {
		return err
	}
	if remCmp < 0 {
		status = execution.ChildFilled
		o.remaining = "0"
	}
	if err := p.transitionLocked(o, status); err != nil {
		return err
	}

	p.tradeSeq++
	feeAsset := quote
	p.fills = append(p.fills, paperFill{
		fill: execution.Fill{
			ExchangeTradeID: fmt.Sprintf("paper_trade_%d", p.tradeSeq),
			ClientOrderID:   o.order.ClientOrderID,
			Price:           price,
			Quantity:        qty,
			QuoteQuantity:   notional,
			Fee:             fee,
			FeeAsset:        feeAsset,
			Timestamp:       p.nowLocked(),
		},
		orderID: o.order.ExchangeOrderID,
		symbol:  symbol,
	})
	return nil
}

// pnlDeltaLocked returns the realized PnL delta of a linear fill (quote
// settled): closing the old position realizes (fillPrice - entryPrice) ×
// closedQty signed by the position side; opening/adding realizes nothing. It
// is "0" for spot (no such notion) and when the position is flat.
func (p *Paper) pnlDeltaLocked(symbol string, side execution.Side, qty, price string) (string, error) {
	if p.market != execution.MarketLinearPerp {
		return "0", nil
	}
	pos, ok := p.positions[symbol]
	if !ok || pos.qty == "0" {
		return "0", nil
	}
	posSign, err := decimal.Cmp(pos.qty, "0")
	if err != nil {
		return "", err
	}
	fillSign := 1
	if side == execution.SideSell {
		fillSign = -1
	}
	if fillSign == posSign {
		return "0", nil // open or add: no realized PnL
	}
	posAbs := absDec(pos.qty)
	closing := qty
	if c, err := decimal.Cmp(qty, posAbs); err != nil {
		return "", err
	} else if c > 0 {
		closing = posAbs
	}
	diff, err := decimal.Sub(price, pos.entryPrice)
	if err != nil {
		return "", err
	}
	pnl, err := decimal.Mul(diff, closing)
	if err != nil {
		return "", err
	}
	if posSign < 0 {
		// A short closes favorably when the fill price is BELOW its entry.
		pnl = negDec(pnl)
	}
	return pnl, nil
}

// updatePositionLocked applies one fill to the one-way signed position
// (positive long): adds on an increase (entry = quantity-weighted average),
// clears at flat, and resets the entry to the fill price when the fill flips
// the side.
func (p *Paper) updatePositionLocked(symbol string, side execution.Side, qty, price string) error {
	pos := p.positions[symbol]
	if pos == nil {
		pos = &positionState{qty: "0", entryPrice: "0"}
		p.positions[symbol] = pos
	}
	signed := qty
	if side == execution.SideSell {
		signed = negDec(qty)
	}
	oldSign, err := decimal.Cmp(pos.qty, "0")
	if err != nil {
		return err
	}
	newQty, err := decimal.Add(pos.qty, signed)
	if err != nil {
		return err
	}
	newSign, err := decimal.Cmp(newQty, "0")
	if err != nil {
		return err
	}
	switch {
	case oldSign == 0 || oldSign == signOf(side):
		// Increase (or first fill): entry = (|oldQty|*entry + qty*price) /
		// (|oldQty| + qty).
		oldAbs := absDec(pos.qty)
		weightedEntry, err := decimal.Mul(oldAbs, pos.entryPrice)
		if err != nil {
			return err
		}
		weightedFill, err := decimal.Mul(qty, price)
		if err != nil {
			return err
		}
		numerator, err := decimal.Add(weightedEntry, weightedFill)
		if err != nil {
			return err
		}
		denominator, err := decimal.Add(oldAbs, qty)
		if err != nil {
			return err
		}
		pos.entryPrice, err = decimal.Quo(numerator, denominator)
		if err != nil {
			return err
		}
	case newSign == 0:
		pos.entryPrice = "0"
	case newSign != oldSign:
		// Side flip: the crossing fill is the new position's entry.
		pos.entryPrice = price
	}
	pos.qty = newQty
	if newSign == 0 {
		pos.entryPrice = "0"
	}
	return nil
}

// signOf maps a side to its fill direction sign.
func signOf(side execution.Side) int {
	if side == execution.SideBuy {
		return 1
	}
	return -1
}

// balance returns the wallet row for asset, creating an empty row on first
// use (a venue account has a row per asset it has ever touched).
func (p *Paper) balance(asset string) balanceState {
	b, ok := p.balances[asset]
	if !ok {
		b = balanceState{free: "0", used: "0"}
		p.balances[asset] = b
	}
	return b
}

// initRand arms the seeded xorshift32 stream (the TS rand() contract) for
// market-fill slippage jitter. Seed 0 keeps the simulator fully deterministic:
// no randomness at all, slippage exactly SlippageBps.
func (p *Paper) initRand(seed int64) {
	if seed == 0 {
		return
	}
	state := uint32(seed) // JS ToUint32 semantics: keep the low 32 bits
	if state == 0 {
		state = 1 // xorshift32 is degenerate at 0 (TS: `(seed ?? 42) >>> 0 || 1`)
	}
	p.rngOn = true
	p.rngState = state
}

// randBpsLocked returns one xorshift32 draw mapped to 0..slippageBps (the
// seeded jitter range for a market fill). Identical seeds replay identical
// fills.
func (p *Paper) randBpsLocked() int64 {
	x := p.rngState
	x ^= x << 13
	x ^= x >> 17
	x ^= x << 5
	p.rngState = x
	// Uniform integer bps in [0, slippageBps]: x/2^32 scaled by the span.
	// (x * (span+1)) >> 32 maps the 32-bit draw onto 0..span inclusive.
	span := uint64(p.slippageBps) + 1
	return int64((uint64(x) * span) >> 32)
}

// negDec returns -v; absDec strips the sign. Both operate on normalized
// decimal strings (internal/platform/decimal Trim output: plain notation, zero renders
// "0"), so plain sign manipulation is exact and safe here.
func negDec(v string) string {
	if v == "0" {
		return "0"
	}
	if strings.HasPrefix(v, "-") {
		return strings.TrimPrefix(v, "-")
	}
	return "-" + v
}

// absDec returns |v| for a normalized decimal string.
func absDec(v string) string { return strings.TrimPrefix(v, "-") }
