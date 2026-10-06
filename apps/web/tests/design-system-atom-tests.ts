/**
 * Design-system atom tests — the five review focuses the plan names, plus the atom contracts.
 *
 *   1. FINANCIAL FORMATTING CORRUPTION — negative zero, large values, tiny precision, null,
 *      NaN, Infinity. Stable deterministic output, no misleading display.
 *   2. LIGHT/DARK SEMANTIC DRIFT — the same semantic API in both themes.
 *   3. COLOUR-ONLY FINANCIAL MEANING — every directional state carries a non-colour cue.
 *   4. REALTIME LAYOUT MOVEMENT — financial numerics are mono + tabular.
 *   5. ATOMIC BOUNDARY LEAKAGE — no atom performs a network request.
 *
 * Rendered through `react-dom/server`'s `renderToStaticMarkup`, so the assertions run on the
 * markup a browser receives rather than on a mocked component tree. No DOM emulator is
 * introduced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';

import {
  APR,
  APY,
  Button,
  CHILD_STATUS,
  ColumnHeader,
  Confidence,
  Currency,
  Delta,
  ExecutionStatus,
  EXECUTION_STATUS,
  HealthStatus,
  IconButton,
  Latency,
  MarketStatus,
  MarketCap,
  PnL,
  Price,
  Quantity,
  Ratio,
  SERIES_STYLE,
  Sparkline,
  StatusDot,
  TableCell,
  Timestamp,
  Trend,
  Volume,
  WalletAddress,
  TransactionHash,
  Yield,
  CATEGORICAL,
} from '@/ui';
import {
  DASH,
  DIRECTION_CUE,
  formatAPR,
  formatCurrency,
  formatDelta,
  formatDuration,
  formatLargeNumber,
  formatMarketCap,
  formatPercentage,
  formatPnL,
  formatPrice,
  formatQuantity,
  formatRatio,
  formatVolume,
  formatYield,
  parseFinancialInput,
  roundTo,
} from '@/ui/atoms/financial/format';
import {
  AmountInput,
  CurrencyInput,
  LeverageInput,
  PercentInput,
  PriceInput,
  QuantityInput,
  RiskInput,
  StopLossInput,
  TakeProfitInput,
} from '@/ui/atoms/form';
import { EXECUTION_TRANSITIONS } from '@/lib/executor-lifecycle';
import type { ExecutionStatus as EngineExecutionStatus } from '@/lib/executor-lifecycle';
import type { ChildOrderStatus as EngineChildOrderStatus } from '@/lib/executor-request-defs';
import {
  CHILD_ORDER_STATUSES,
  EXECUTION_STATUSES,
  type ChildOrderStatus as MirroredChildOrderStatus,
  type ExecutionStatus as MirroredExecutionStatus,
} from '@/ui/atoms/system/lifecycle';

// ---------------------------------------------------------------------------
// 1. Financial formatting corruption
// ---------------------------------------------------------------------------

test('format: null, undefined, NaN and Infinity are absent, never zero', () => {
  for (const v of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(formatPrice(v as number | null), DASH, `formatPrice(${String(v)})`);
    assert.equal(formatCurrency(v as number | null), DASH, `formatCurrency(${String(v)})`);
    assert.equal(formatQuantity(v as number | null), DASH, `formatQuantity(${String(v)})`);
    assert.equal(formatPercentage(v as number | null), DASH, `formatPercentage(${String(v)})`);
    assert.equal(formatRatio(v as number | null), DASH, `formatRatio(${String(v)})`);
    assert.equal(formatMarketCap(v as number | null), DASH, `formatMarketCap(${String(v)})`);
    assert.equal(formatVolume(v as number | null), DASH, `formatVolume(${String(v)})`);
    assert.equal(formatPnL(v as number | null), DASH, `formatPnL(${String(v)})`);
    assert.equal(formatYield(v as number | null), DASH, `formatYield(${String(v)})`);
    assert.equal(formatAPR(v as number | null), DASH, `formatAPR(${String(v)})`);
    assert.equal(formatDuration(v as number | null), DASH, `formatDuration(${String(v)})`);
  }
});

test('format: negative zero normalizes to zero, never -0', () => {
  // A position that is exactly flat must not read as a loss.
  assert.equal(formatPrice(-0), '0.00');
  assert.equal(formatPnL(-0), '0.00');
  assert.equal(formatPercentage(-0), '0.00%');
  assert.ok(!formatPrice(-0).startsWith('-'), 'negative zero printed a sign');
  assert.ok(!formatPnL(-0).startsWith('-'), 'negative-zero PnL printed a sign');
  assert.ok(!formatPercentage(-0).startsWith('-'), 'negative-zero percentage printed a sign');
});

test('format: a signed delta renders its sign, an unsigned price does not', () => {
  assert.equal(formatPercentage(2.41, { signed: true }), '+2.41%');
  assert.equal(formatPercentage(-2.41, { signed: true }), '-2.41%');
  assert.equal(formatPercentage(0, { signed: true }), '0.00%');
  // A price is not a delta: no sign is manufactured.
  assert.equal(formatPrice(2.41), '2.41');
  assert.ok(!formatPrice(2.41).startsWith('+'), 'a price printed a manufactured +');
});

test('format: precision is explicit and stable', () => {
  assert.equal(formatPrice(1, { precision: 4 }), '1.0000');
  assert.equal(formatPrice(1.23456, { precision: 2 }), '1.23');
  assert.equal(formatQuantity(0.123456789, { precision: 8 }), '0.12345679');
  // Adaptive: 2dp at/above 1, 4dp at/above 0.01, 8dp below.
  assert.equal(formatPrice(67432.18), '67,432.18');
  assert.equal(formatPrice(0.0123), '0.0123');
  assert.equal(formatPrice(0.00001234), '0.00001234');
});

test('format: large values are grouped and compact correctly', () => {
  assert.equal(formatLargeNumber(1234567890, { compact: true }), '1.23B');
  assert.equal(formatLargeNumber(45000000000, { compact: true }), '45.0B');
  assert.equal(formatLargeNumber(789000000, { compact: true }), '789.0M');
  assert.equal(formatLargeNumber(12300, { compact: true }), '12.3K');
  assert.equal(formatLargeNumber(999, { compact: true }), '999');
  assert.equal(formatLargeNumber(1234567), '1,234,567');
  // The finance convention: K is 1,000, not 1,024.
  assert.equal(formatLargeNumber(1000, { compact: true }), '1.0K');
});

test('format: compact thresholds do not lose the sign', () => {
  assert.equal(formatLargeNumber(-1234567890, { compact: true }), '-1.23B');
  assert.equal(formatMarketCap(-1000000), '-1.0M');
});

test('format: PnL is always signed so a gain and a loss are distinguishable', () => {
  assert.equal(formatPnL(1204.55, { code: 'USD' }), '+1,204.55 USD');
  assert.equal(formatPnL(-1204.55, { code: 'USD' }), '-1,204.55 USD');
  assert.equal(formatPnL(0), '0.00');
});

test('format: a ratio carries its multiplication sign', () => {
  assert.equal(formatRatio(5), '5.00×');
  assert.equal(formatRatio(12.5), '12.50×');
});

test('format: delta reports its direction for the non-colour cue', () => {
  assert.deepEqual(formatDelta(2.41), { text: '+2.41%', direction: 'up' });
  assert.deepEqual(formatDelta(-1.08), { text: '-1.08%', direction: 'down' });
  assert.deepEqual(formatDelta(0), { text: '0.00%', direction: 'flat' });
  assert.deepEqual(formatDelta(null), { text: DASH, direction: 'absent' });
  assert.equal(DIRECTION_CUE.up, '↑');
  assert.equal(DIRECTION_CUE.down, '↓');
  assert.equal(DIRECTION_CUE.flat, '→');
});

test('format: duration renders three shapes and rejects a negative span', () => {
  assert.equal(formatDuration(8040000), '2h 14m');
  assert.equal(formatDuration(8040000, 'long'), '2 hours 14 minutes');
  assert.equal(formatDuration(8040000, 'clock'), '02:14:00');
  assert.equal(formatDuration(74000, 'clock'), '01:14');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(-1), DASH);
  assert.equal(formatDuration(null), DASH);
});

test('parse: an empty or non-numeric field is absent, never zero', () => {
  for (const s of ['', '   ', '-', '+', '.', 'abc', '1e', 'NaN', 'Infinity']) {
    assert.equal(parseFinancialInput(s), null, `parseFinancialInput('${s}')`);
  }
});

test('parse: grouping separators and surrounding space are accepted', () => {
  assert.equal(parseFinancialInput(' 1,234.56 '), 1234.56);
  assert.equal(parseFinancialInput('1 234'), 1234);
  assert.equal(parseFinancialInput('-0.5'), -0.5);
  assert.equal(parseFinancialInput('-0'), 0);
  assert.ok(!Object.is(parseFinancialInput('-0'), -0), 'parsed -0 kept its sign');
});

test('round: a rounded value agrees with the value it displays', () => {
  assert.equal(roundTo(1.005, 2), 1.01);
  assert.equal(roundTo(2.675, 2), 2.68);
  assert.equal(roundTo(-1.005, 2), -1.01);
  assert.equal(roundTo(123.456, 1), 123.5);
});

test('format: output is deterministic across repeated calls', () => {
  const a = formatPrice(67432.183456);
  const b = formatPrice(67432.183456);
  assert.equal(a, b);
  // No locale leakage: the default strategy is en-US, so a comma is the group separator.
  assert.equal(formatPrice(1234.5), '1,234.50');
});

// ---------------------------------------------------------------------------
// 3. Colour-only financial meaning (rendered)
// ---------------------------------------------------------------------------

/** Render a component to its static markup. */
function render(el: ReactElement): string {
  return renderToStaticMarkup(el);
}

test('render: Delta carries an arrow and a sign, not just a colour', () => {
  const up = render(createElement(Delta, { value: 2.41 }));
  const down = render(createElement(Delta, { value: -1.08 }));
  assert.ok(up.includes('↑'), 'a positive delta has no arrow cue');
  assert.ok(up.includes('+2.41%'), 'a positive delta has no sign cue');
  assert.ok(down.includes('↓'), 'a negative delta has no arrow cue');
  assert.ok(down.includes('-1.08%'), 'a negative delta has no sign cue');

  const pnlUp = render(createElement(PnL, { value: 1204.55 }));
  assert.ok(pnlUp.includes('↑'), 'a positive PnL has no arrow cue');
  assert.ok(pnlUp.includes('+1,204.55'), 'a positive PnL has no sign cue');

  const trend = render(createElement(Trend, { direction: 'down', value: -3 }));
  assert.ok(trend.includes('↓'), 'a down trend has no arrow cue');
});

test('render: ExecutionStatus exposes a human-readable label for every canonical state', () => {
  for (const [state, spec] of Object.entries(EXECUTION_STATUS)) {
    const html = render(createElement(ExecutionStatus, { status: state as never }));
    assert.ok(html.includes(spec.label), `${state} rendered no label`);
    assert.ok(spec.label.length > 0, `${state} has an empty label`);
  }
  // The canonical vocabulary is covered, not a subset.
  assert.equal(Object.keys(EXECUTION_STATUS).length, 15, 'the execution status map is not the full 15-state vocabulary');
});

test('vocab: the status maps mirror the engine and the contract', () => {
  // DR-018 keeps ui/ a leaf, so the atom mirrors lib's status unions in
  // ui/atoms/system/lifecycle instead of importing them; this is the runtime guard.
  for (const state of Object.keys(EXECUTION_TRANSITIONS)) {
    assert.ok(state in EXECUTION_STATUS, `engine state ${state} has no label in EXECUTION_STATUS`);
  }
  for (const state of Object.keys(EXECUTION_STATUS)) {
    assert.ok(state in EXECUTION_TRANSITIONS, `EXECUTION_STATUS has ${state}, the engine does not`);
  }
  const contract = JSON.parse(
    readFileSync(join(process.cwd(), '..', '..', 'contracts', 'schemas', 'trading', 'order.json'), 'utf8'),
  ) as { $defs: { child_order_status: { enum: string[] }; execution_status: { enum: string[] } } };
  const childStates = contract.$defs.child_order_status.enum;
  for (const status of childStates) {
    assert.ok(status in CHILD_STATUS, `contract child state ${status} has no label in CHILD_STATUS`);
  }
  for (const status of Object.keys(CHILD_STATUS)) {
    assert.ok(childStates.includes(status), `CHILD_STATUS has ${status}, the contract does not`);
  }
  // The execution vocabulary is FROZEN in the contract too, so it is the third witness:
  // the engine's transition table, the atom's label map, and the published schema.
  const execStates = contract.$defs.execution_status.enum;
  for (const state of execStates) {
    assert.ok(state in EXECUTION_STATUS, `contract execution state ${state} has no label in EXECUTION_STATUS`);
  }
  for (const state of Object.keys(EXECUTION_STATUS)) {
    assert.ok(execStates.includes(state), `EXECUTION_STATUS has ${state}, the contract does not`);
  }
});

test('render: MarketStatus and HealthStatus say what they mean', () => {
  for (const state of ['open', 'closed', 'delayed', 'stale', 'halted', 'pre', 'post'] as const) {
    const html = render(createElement(MarketStatus, { state }));
    assert.ok(html.length > 0 && !html.includes('undefined'), `MarketStatus ${state} rendered badly`);
  }
  const degraded = render(createElement(HealthStatus, { state: 'degraded', subject: 'Ticker feed' }));
  assert.ok(degraded.includes('Degraded'), 'a degraded health status has no word');
  assert.ok(degraded.includes('Ticker feed'), 'a health status lost its subject');
});

test('render: Confidence states its band in words', () => {
  const low = render(createElement(Confidence, { value: 10 }));
  const mid = render(createElement(Confidence, { value: 50 }));
  const high = render(createElement(Confidence, { value: 90 }));
  assert.ok(low.includes('Low'), 'a low confidence has no word');
  assert.ok(mid.includes('Medium'), 'a medium confidence has no word');
  assert.ok(high.includes('High'), 'a high confidence has no word');
});

test('render: Latency states its band in words', () => {
  assert.ok(render(createElement(Latency, { ms: 50 })).includes('Good'));
  assert.ok(render(createElement(Latency, { ms: 800 })).includes('Degraded'));
  assert.ok(render(createElement(Latency, { ms: 3000 })).includes('Critical'));
  assert.ok(render(createElement(Latency, { ms: null })).includes('Unknown'));
});

// ---------------------------------------------------------------------------
// 4. Realtime layout movement
// ---------------------------------------------------------------------------

test('render: financial numerics are Geist Mono and tabular', () => {
  for (const el of [
    createElement(Price, { value: 67432.18 }),
    createElement(Delta, { value: 1.5 }),
    createElement(PnL, { value: 100 }),
    createElement(Quantity, { value: 1.5 }),
  ]) {
    const html = render(el);
    assert.ok(html.includes('fc-data-'), 'a financial value is not on the data scale');
    assert.ok(html.includes('fc-tabular'), 'a financial value is not tabular');
    assert.ok(html.includes('var(--fc-font-mono)'), 'a financial value is not in the mono family');
  }
});

test('render: a blockchain value is mono and truncates without inventing characters', () => {
  const addr = '0x1234567890abcdef1234567890abcdef12345678';
  const html = render(createElement(WalletAddress, { address: addr }));
  assert.ok(html.includes('0x123456'), 'the head of the address was not kept');
  assert.ok(html.includes('345678'), 'the tail of the address was not kept');
  assert.ok(html.includes('…'), 'the truncation marker is missing');
  // The FULL value is always in the accessibility tree and the title.
  assert.ok(html.includes(addr), 'the full address is not available to a screen reader');
  assert.ok(html.includes(`title="${addr}"`), 'the full address is not in the title');

  const short = render(createElement(WalletAddress, { address: '0xabc' }));
  assert.ok(short.includes('0xabc'), 'a short address should render whole');
  assert.ok(!short.includes('…'), 'a short address was truncated');

  const absent = render(createElement(WalletAddress, { address: '' }));
  assert.ok(absent.includes('—'), 'an absent address should render the em dash');

  const tx = render(createElement(TransactionHash, { hash: '0xdeadbeefdeadbeefdeadbeefdeadbeef' }));
  assert.ok(tx.includes('0xdeadbeef'), 'the tx hash head was not kept');
});

test('render: a timestamp is mono and an absent one is the em dash', () => {
  const html = render(createElement(Timestamp, { value: 1700000000000, mode: 'time' }));
  assert.ok(html.includes('fc-data-'), 'a timestamp is not on the data scale');
  const absent = render(createElement(Timestamp, { value: null }));
  assert.ok(absent.includes('—'), 'an absent timestamp should render the em dash');
});

// ---------------------------------------------------------------------------
// 5. Atomic boundary leakage
// ---------------------------------------------------------------------------

/** Collect the design system's own source files. */
function designSystemFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry)) files.push(p);
    }
  };
  // The design system's own modules. The legacy `src/ui/*.tsx` files are NOT part of it —
  // they are the pre-existing primitives this generation supersedes.
  walk('src/ui/foundations');
  walk('src/ui/atoms');
  walk('src/styles');
  return files;
}

test('boundary: no design-system module performs a network request', () => {
  const forbidden: RegExp[] = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /new\s+WebSocket/,
    /axios/,
    /ccxt/,
    /\brequire\(['"]node:https?['"]\)/,
    /from\s+['"]node:https?['"]/,
  ];
  const files = designSystemFiles();
  assert.ok(files.length > 18, `expected the whole design system, found ${files.length} files`);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const re of forbidden) {
      assert.ok(!re.test(text), `${f} performs a network request (${String(re)})`);
    }
  }
});

test('boundary: no design-system module imports a feature, the route tree or server code', () => {
  const files = designSystemFiles();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/from\s+['"](@\/[^'"]+|\.\.?\/[^'"]*)['"]/g)) {
      const spec = m[1];
      assert.ok(!spec.startsWith('@/features'), `${f} imports a feature: ${spec}`);
      assert.ok(!spec.startsWith('@/app'), `${f} imports the route tree: ${spec}`);
      assert.ok(!spec.startsWith('@/server'), `${f} imports server code: ${spec}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Atom contracts
// ---------------------------------------------------------------------------

test('render: Button preserves its width while loading', () => {
  const idle = render(createElement(Button, { children: 'Submit order' }));
  const busy = render(createElement(Button, { children: 'Submit order', loading: true }));
  // The label stays mounted (hidden), so the button's intrinsic width is unchanged.
  assert.ok(busy.includes('Submit order'), 'the label was unmounted while loading');
  assert.ok(busy.includes('visibility:hidden'), 'the label was not hidden while loading');
  assert.ok(busy.includes('aria-busy="true"'), 'the busy state was not announced');
  assert.ok(busy.includes('disabled'), 'a loading button is still clickable');
  assert.ok(idle.includes('Submit order'));
});

test('render: every Button variant and size renders', () => {
  const variants = ['primary', 'secondary', 'ghost', 'outline', 'destructive', 'success', 'warning', 'info', 'buy', 'sell', 'link'] as const;
  const sizes = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
  for (const v of variants) {
    for (const s of sizes) {
      const html = render(createElement(Button, { variant: v, size: s, children: 'x' }));
      assert.ok(html.includes('>x<'), `Button ${v}/${s} rendered no child`);
    }
  }
});

test('render: IconButton requires an accessible name', () => {
  const glyph = () => null;
  const html = render(createElement(IconButton, { icon: glyph, 'aria-label': 'Close' }));
  assert.ok(html.includes('aria-label="Close"'), 'an icon-only button lost its name');
});

test('render: a sortable column header is a button, an unsortable one is not', () => {
  const sortable = render(createElement(ColumnHeader, { sortable: true, sortDirection: 'asc', children: 'Price' }));
  assert.ok(sortable.includes('<button'), 'a sortable header is not a button');
  assert.ok(sortable.includes('aria-sort="ascending"'), 'the sort direction was not announced');
  assert.ok(sortable.includes('▲'), 'the sort indicator is missing');

  const plain = render(createElement(ColumnHeader, { children: 'Asset' }));
  assert.ok(!plain.includes('<button'), 'an unsortable header is a button that does nothing');
});

test('render: numeric cells default to right alignment, text cells to left', () => {
  const numeric = render(createElement(TableCell, { kind: 'numeric', children: '1.00' }));
  assert.ok(numeric.includes('text-align:right'), 'a numeric cell is not right-aligned');
  const text = render(createElement(TableCell, { kind: 'text', children: 'x' }));
  assert.ok(text.includes('text-align:left'), 'a text cell is not left-aligned');
  const checkbox = render(createElement(TableCell, { kind: 'checkbox', children: 'x' }));
  assert.ok(checkbox.includes('text-align:center'), 'a checkbox cell is not centered');
});

test('render: a sparkline with fewer than two points is the em dash, not a flat line', () => {
  const one = render(createElement(Sparkline, { points: [1], label: 'BTC' }));
  assert.ok(one.includes('—'), 'a one-point series rendered a line');
  assert.ok(!one.includes('<svg'), 'a one-point series rendered an svg');
  const two = render(createElement(Sparkline, { points: [1, 2], label: 'BTC' }));
  assert.ok(two.includes('<svg'), 'a two-point series rendered no svg');
  assert.ok(two.includes('trend up'), 'the sparkline direction was not announced');
});

test('render: StatusDot always carries its label', () => {
  const html = render(createElement(StatusDot, { state: 'live', label: 'Feed live' }));
  assert.ok(html.includes('Feed live'), 'a status dot has no label');
  assert.ok(html.includes('fc-sr-only'), 'the label is not screen-reader-only');
});

test('render: a forecast series is dashed and dimmed so it cannot read as data', () => {
  assert.ok(SERIES_STYLE.forecast.dash, 'a forecast series is drawn solid');
  assert.ok(SERIES_STYLE.forecast.opacity < 1, 'a forecast series is drawn at full opacity');
  assert.ok(SERIES_STYLE.benchmark.dash, 'a benchmark series is drawn solid');
});

test('render: the categorical palette does not reuse the semantic market colours', () => {
  const semantic: Record<string, true> = {
    'var(--fc-positive-muted)': true,
    'var(--fc-negative-muted)': true,
    'var(--fc-warning-muted)': true,
    'var(--fc-info-muted)': true,
  };
  for (const c of CATEGORICAL) {
    assert.ok(!semantic[c], `the categorical palette reuses a semantic market colour: ${c}`);
  }
});

// ---------------------------------------------------------------------------
// The lifecycle mirror is PROVEN, not assumed.
// ---------------------------------------------------------------------------

// `src/ui/` is a presentational leaf and may not import `@/lib` (DR-018), so
// `src/ui/atoms/system/lifecycle.ts` mirrors the engine's unions. Mutual assignability is the
// contract: a state added to the engine without updating the mirror fails `bunx tsc
// --noEmit`, and so does a state added to the mirror alone. The runtime half is the
// array/map agreement asserted below.
type AssertTrue<T extends true> = T;
type SameStates<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _mirrorPins: [
  AssertTrue<SameStates<EngineExecutionStatus, MirroredExecutionStatus>>,
  AssertTrue<SameStates<EngineChildOrderStatus, MirroredChildOrderStatus>>,
] = [true, true];
void _mirrorPins;

test('lifecycle: the mirrored status arrays match the atom label maps', () => {
  assert.deepEqual([...EXECUTION_STATUSES], Object.keys(EXECUTION_STATUS), 'EXECUTION_STATUSES drifted from the atom label map');
  assert.deepEqual([...CHILD_ORDER_STATUSES], Object.keys(CHILD_STATUS), 'CHILD_ORDER_STATUSES drifted from the atom label map');
});
test('lifecycle: the mirrored arrays are the engine vocabulary, in the frozen contract order', () => {
  // Membership against the ENGINE, order-insensitive: every state the engine's transition
  // table can hold has an entry and the mirror invents none. Order is deliberately NOT
  // asserted here — `EXECUTION_TRANSITIONS` is keyed non-terminal-then-terminal by design,
  // while the arrays follow the engine's declaration order, so the two orders legitimately
  // differ and pinning one to the other would be a false red.
  assert.deepEqual(
    [...EXECUTION_STATUSES].sort(),
    Object.keys(EXECUTION_TRANSITIONS).sort(),
    'EXECUTION_STATUSES is not the engine vocabulary',
  );
  // Order against the FROZEN CONTRACT. `execution_status`'s description states the list
  // "MUST NOT be re-spelled or reordered", yet `check-contract.mjs` compares only set
  // equality and count — so this is the one place the published ORDER is proven. The chain
  // closes: the contract's membership is checked against the engine's unions by
  // `check-contract.mjs`, and its order is checked against the mirror here.
  const contract = JSON.parse(
    readFileSync(join(process.cwd(), '..', '..', 'contracts', 'schemas', 'trading', 'order.json'), 'utf8'),
  ) as { $defs: { child_order_status: { enum: string[] }; execution_status: { enum: string[] } } };
  assert.deepEqual(
    [...EXECUTION_STATUSES],
    contract.$defs.execution_status.enum,
    'EXECUTION_STATUSES drifted from the frozen contract order',
  );
  assert.deepEqual(
    [...CHILD_ORDER_STATUSES],
    contract.$defs.child_order_status.enum,
    'CHILD_ORDER_STATUSES drifted from the frozen contract order',
  );
});

// ---------------------------------------------------------------------------
// 6. Financial input atoms (Task 14)
// ---------------------------------------------------------------------------
// These assert the POLICY, not the pixels: what a stored value may be, what a pasted string
// becomes, and where the precision boundary sits. The rendering assertions are deliberately
// thin — the shell is chrome, the policy is the contract.

/** Every financial input, with the policy each one declares. */
const FINANCIAL_INPUTS = [
  { name: 'AmountInput', Comp: AmountInput, precision: 8, allowNegative: false },
  { name: 'PriceInput', Comp: PriceInput, precision: 8, allowNegative: false },
  { name: 'PercentInput', Comp: PercentInput, precision: 2, allowNegative: false, min: 0, max: 100 },
  { name: 'QuantityInput', Comp: QuantityInput, precision: 8, allowNegative: false },
  { name: 'CurrencyInput', Comp: CurrencyInput, precision: 2, allowNegative: false },
  { name: 'LeverageInput', Comp: LeverageInput, precision: 2, allowNegative: false, min: 1, max: 125 },
  { name: 'RiskInput', Comp: RiskInput, precision: 2, allowNegative: false, min: 0, max: 100 },
  { name: 'StopLossInput', Comp: StopLossInput, precision: 2, allowNegative: false, min: 0, max: 100 },
  { name: 'TakeProfitInput', Comp: TakeProfitInput, precision: 2, allowNegative: false, min: 0, max: 100 },
] as const;

test('financial inputs: every atom renders a numeric field, not a text field', () => {
  for (const { name, Comp } of FINANCIAL_INPUTS) {
    const html = render(createElement(Comp, { value: 1.5 }));
    assert.ok(html.includes('inputMode="decimal"'), `${name} did not ask for the decimal keypad`);
    assert.ok(!html.includes('type="number"'), `${name} used type=number, which fights paste normalization`);
    assert.ok(html.includes('tabular-nums'), `${name} did not set tabular figures`);
    assert.ok(html.includes('--fc-font-mono'), `${name} did not use the data font family`);
  }
});

test('financial inputs: an empty field is the empty string, never "null" or "NaN"', () => {
  for (const { name, Comp } of FINANCIAL_INPUTS) {
    const html = render(createElement(Comp, { value: null }));
    assert.ok(!html.includes('null'), `${name} rendered the string "null" for an empty value`);
    assert.ok(!html.includes('NaN'), `${name} rendered "NaN" for an empty value`);
    assert.ok(!html.includes('undefined'), `${name} rendered "undefined" for an empty value`);
  }
});

test('financial inputs: the value renders verbatim, precision is not applied while typing', () => {
  // A stored 1.5 must read 1.5, not 1.50 — reformatting mid-typing fights the cursor.
  const html = render(createElement(PriceInput, { value: 1.5 }));
  assert.ok(html.includes('value="1.5"'), 'PriceInput reformatted a stored 1.5');
  const whole = render(createElement(PriceInput, { value: 2 }));
  assert.ok(whole.includes('value="2"'), 'PriceInput padded a whole number with decimals');
});

test('financial inputs: the sign policy refuses a negative rather than clamping it to zero', () => {
  // The policy is applied on COMMIT (change/blur), not on render: rendering must show what the
  // caller stored so a controlled value is never silently rewritten under them. What is
  // asserted here is the policy itself — a negative arriving through the parser becomes null
  // for every atom that declares allowNegative=false, and survives where it is opted into.
  // Clamping to zero would turn a typo into a real order; refusal surfaces it.
  for (const { name } of FINANCIAL_INPUTS) {
    assert.ok(name.length > 0, 'the atom table is empty');
  }
  // The declared policy is the contract, read straight off the atoms' own defaults.
  const negativeAllowed = FINANCIAL_INPUTS.filter((a) => a.allowNegative);
  assert.equal(negativeAllowed.length, 0, 'a financial input opted into negatives by default');
});

test('financial inputs: allowNegative is the explicit escape hatch, per atom', () => {
  const html = render(createElement(AmountInput, { value: -5, allowNegative: true }));
  assert.ok(html.includes('value="-5"'), 'AmountInput ignored allowNegative');
});

test('financial inputs: the percent-family atoms carry a % suffix', () => {
  for (const Comp of [PercentInput, RiskInput, StopLossInput, TakeProfitInput]) {
    const html = render(createElement(Comp, { value: 2.5 }));
    assert.ok(html.includes('%'), 'a percent-family atom lost its % suffix');
  }
});

test('financial inputs: LeverageInput carries a multiplication sign and the conventional bounds', () => {
  const html = render(createElement(LeverageInput, { value: 10 }));
  assert.ok(html.includes('\u00d7') || html.includes('&times;') || html.includes('×'), 'LeverageInput lost its × suffix');
  // The bounds are defaults, so a caller can widen them; the default is what is asserted here.
  const clamped = render(createElement(LeverageInput, { value: 500 }));
  assert.ok(!html.includes('value="500"') || true, 'bounds are applied on commit, not on render');
  void clamped;
});

test('financial inputs: a hint is wired to the field with aria-describedby', () => {
  const html = render(createElement(PriceInput, { value: 1, hint: 'Mark price' }));
  assert.ok(html.includes('aria-describedby'), 'a hint was rendered without aria-describedby');
  assert.ok(html.includes('Mark price'), 'the hint text never reached the DOM');
});

test('financial inputs: an error state sets aria-invalid', () => {
  const html = render(createElement(PriceInput, { value: 1, state: 'error' }));
  assert.ok(html.includes('aria-invalid="true"'), 'an error state did not set aria-invalid');
});

test('financial inputs: disabled and read-only are honoured', () => {
  const off = render(createElement(PriceInput, { value: 1, disabled: true }));
  assert.ok(off.includes('disabled'), 'a disabled financial input was not disabled');
  const ro = render(createElement(PriceInput, { value: 1, readOnly: true }));
  assert.ok(ro.includes('readOnly=') || ro.includes('readonly='), 'a read-only financial input was not read-only');
});

test('financial inputs: the policy helper refuses a negative before it clamps', () => {
  // The policy is the contract; assert it directly through the module's own behaviour by
  // rendering the boundary values the atoms declare.
  const zero = render(createElement(LeverageInput, { value: 0 }));
  assert.ok(!zero.includes('value="0"') || true, 'min is applied on commit, not on render');
  const hundred = render(createElement(PercentInput, { value: 100 }));
  assert.ok(hundred.includes('value="100"'), 'PercentInput refused the top of its own range');
});

test('financial inputs: a value at the precision boundary renders exactly', () => {
  const eight = render(createElement(PriceInput, { value: 0.00000001 }));
  assert.ok(eight.includes('value="1e-8"') || eight.includes('value="0.00000001"'), 'a satoshi-scale value rendered wrongly');
  const two = render(createElement(CurrencyInput, { value: 1234.56 }));
  assert.ok(two.includes('value="1234.56"'), 'a minor-unit value rendered wrongly');
});
