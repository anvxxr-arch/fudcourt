/**
 * AdapterContractTest (PRD §126) — offline compliance suite for every
 * ExchangeAdapter implementation. Run 4× against scripted ccxt-like mock
 * venues (binance spot, binance linear, bybit, mexc) + 1× against
 * PaperExchangeAdapter. No network: ccxt may be imported but is never used to
 * reach a venue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ExchangeAdapter,
  NormalizedOrder,
} from '@/platform/executor/types';
import {
  EXCHANGE_CAPABILITIES,
  PaperExchangeAdapter,
  createAdapter,
  fromVenueSymbol,
  mapError,
  toVenueSymbol,
} from '@/platform/executor/exchange';

test('placeholder: suite wiring', () => {
  assert.equal(typeof createAdapter, 'function');
  assert.equal(typeof mapError, 'function');
  assert.equal(toVenueSymbol('BTC/USDT', 'linear_perp'), 'BTC/USDT:USDT');
  assert.equal(fromVenueSymbol('BTC/USDT:USDT'), 'BTC/USDT');
  assert.equal(typeof EXCHANGE_CAPABILITIES.binance.spot, 'boolean');
  assert.equal(typeof PaperExchangeAdapter, 'function');
  const _o: NormalizedOrder | null = null;
  const _a: ExchangeAdapter | null = null;
  void _o;
  void _a;
});
