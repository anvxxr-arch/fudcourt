'use client';
/**
 * ui.tsx — the CEX Executor panels (PRD §81 information architecture,
 * §82–§88 screens).
 *
 *   ExecutorFrame        the area chrome every route shares
 *   ExecutorComposer     account → market → risk preview → create (§82, §83, §84, §80)
 *   ExecutorProgress     one execution's progress, orders, fills, log (§85, §86)
 *   ExecutorHistory      the session user's executions (§22)
 *   ExecutorAccounts     BYOK connect / test / delete (§87)
 *   ExecutorSettings     the risk profile (§88)
 *
 * House rules this file keeps:
 * - No invented numbers. Every figure is a value the server returned; anything
 *   the server did not compute is `—` (`DASH`), never 0. The only arithmetic
 *   here is the difference of two returned values, which the PRD itself asks
 *   for (filled %, remaining quantity, remaining risk budget).
 * - No polling library and no SWR: fetch on mount plus a manual Refresh.
 * - No secret is ever rendered — the API never returns one (`apiKeyMasked`
 *   only), so the connect form is the single place key material is typed.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { C } from '@/styles/shared';
import { Card, Label } from '@/components/ui/primitives';
import {
  DEFAULT_RISK_PROFILE,
  isTerminalExecution,
  type BalanceBasis,
  type ChildOrderRecord,
  type CredentialRecord,
  type ExecutionDefinition,
  type ExecutionEventRecord,
  type ExecutionMode,
  type ExecutionRecord,
  type ExecutionRequest,
  type ExecutionStatus,
  type ExecutionStrategy,
  type TwapConfig,
  type ExecutionUrgency,
  type FillRecord,
  type LeverageDefinition,
  type MarginMode,
  type PreviewResult,
  type RiskProfile,
  type SizingDefinition,
  type SizingMode,
  type TakeProfitDefinition,
} from '@/platform/executor/types';
import {
  DASH,
  decimalsForStep,
  formatAgo,
  formatBps,
  formatCompletionPct,
  formatDuration,
  formatMoney,
  formatPct,
  formatPrice,
  formatQty,
  formatRiskReward,
  formatTimestamp,
  progressBar,
} from './shapers';
import {
  cancelExecution,
  connectAccount,
  createExecution,
  deleteAccount,
  errorMessage,
  getExecution,
  getSettings,
  listAccounts,
  listEvents,
  listExecutions,
  listFills,
  listOrders,
  pauseExecution,
  preview,
  putSettings,
  resumeExecution,
  startExecution,
  testAccount,
  type PreviewResponse,
} from './client';

// ---------------------------------------------------------------------------
// shared chrome
// ---------------------------------------------------------------------------

const inputStyle: CSSProperties = {
  width: '100%',
  background: C.bg,
  color: C.white,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 12,
  boxSizing: 'border-box',
};

const pairStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 };

const h3Style: CSSProperties = { color: C.accent, fontSize: 12, fontWeight: 800, margin: '0 0 8px', letterSpacing: 1 };

const noteStyle: CSSProperties = { color: C.dim, fontSize: 10, margin: '4px 0 0' };

/** A `<select>` over a closed option list, so the value stays a real union member. */
function Choice<T extends string, U extends T = T>({ value, onChange, options, disabled }: {
  value: T;
  /** Widenable to `U` so a setState of a WIDER union (e.g. a nullable filter) accepts the `T` member. */
  onChange: (value: U) => void;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      // Closed list, every member a `T`: the standard boundary where a DOM
      // string becomes the union member the state already holds.
      onChange={(e) => onChange(e.target.value as U)}
      style={{ ...inputStyle, opacity: disabled ? 0.5 : 1 }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function Text({ value, onChange, placeholder, type = 'text', disabled }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      autoComplete={type === 'password' ? 'new-password' : 'off'}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, opacity: disabled ? 0.5 : 1 }}
    />
  );
}

/**
 * A labelled form row. `hint` states the rule the field enforces, so a limit the
 * engine actually blocks is never mistaken for a stored preference (§88).
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
      {hint && <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.white, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Btn({ onClick, children, disabled, tone = 'ghost' }: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  tone?: 'primary' | 'ghost' | 'danger';
}) {
  const toneStyle: CSSProperties =
    tone === 'primary'
      ? { background: C.accent, color: '#04140f', border: `1px solid ${C.accent}`, fontWeight: 700 }
      : tone === 'danger'
        ? { background: 'transparent', color: C.red, border: `1px solid ${C.red}` }
        : { background: C.card, color: C.white, border: `1px solid ${C.border}` };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...toneStyle,
        padding: '6px 12px',
        borderRadius: 6,
        fontSize: 11,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {children}
    </button>
  );
}

function ErrorBanner({ text }: { text: string }) {
  if (text === '') return null;
  return (
    <p style={{
      color: C.red,
      fontSize: 11,
      fontWeight: 700,
      background: 'rgba(255,80,80,0.08)',
      border: '1px solid rgba(255,80,80,0.35)',
      padding: '8px 10px',
      borderRadius: 6,
      margin: '0 0 8px',
      whiteSpace: 'pre-wrap',
    }}>
      ⚠ {text}
    </p>
  );
}

/** One label/value line. A null value is `—`; the shapers never print a fake 0. */
function Row({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  const color = tone === 'good' ? C.accent : tone === 'bad' ? C.red : C.white;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '3px 0', borderBottom: `1px solid ${C.border}` }}>
      <span style={{ color: C.dim, fontSize: 11 }}>{label}</span>
      <span style={{ color, fontSize: 11, fontWeight: 700, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

const thStyle: CSSProperties = { textAlign: 'left', padding: '5px 6px', color: C.dim, fontSize: 10, borderBottom: `1px solid ${C.border}` };

const tdStyle: CSSProperties = { padding: '5px 6px', fontSize: 11, borderBottom: `1px solid ${C.border}` };

/** A status badge: colour carries meaning, the text always carries it too. */
function StatusPill({ status }: { status: string }) {
  const good = status === 'ACTIVE' || status === 'FILLED' || status === 'READY' || status === 'RUNNING' || status === 'VALIDATED';
  const bad = status === 'INVALID' || status === 'EXPIRED' || status === 'REVOKED'
    || status === 'PERMISSION_ERROR' || status === 'REJECTED' || status === 'FAILED' || status === 'RISK_STOPPED';
  const color = good ? C.accent : bad ? C.red : C.white;
  return (
    <span style={{ color, border: `1px solid ${color}`, borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>
      {status}
    </span>
  );
}

/** Tri-state venue permission: `null` means the venue does not report it (§48). */
function Perm({ value }: { value: boolean | null }) {
  if (value === null) {
    return <span style={{ color: C.dim }} title="the venue does not report this flag">{DASH}</span>;
  }
  return <span style={{ color: value ? C.accent : C.red }}>{value ? '✓' : '✕'}</span>;
}

/** Numbers arrive from inputs as text: empty stays absent, never a silent 0. */
function num(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** Minutes in a text field to whole milliseconds (`30` → `1800000`). */
function minutesToMs(text: string): number | undefined {
  const minutes = num(text);
  return minutes === undefined ? undefined : Math.round(minutes * 60_000);
}

/** A difference of two returned numbers — the only arithmetic this UI performs. */
function diff(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}

// ---------------------------------------------------------------------------
// ExecutorFrame — §81
// ---------------------------------------------------------------------------

const NAV_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/executor/history', label: 'History' },
  { href: '/executor/new', label: 'New execution' },
  { href: '/executor/accounts', label: 'Accounts' },
  { href: '/executor/settings', label: 'Risk settings' },
];

export function ExecutorFrame({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main style={{ background: C.bg, minHeight: '100vh', color: C.white, fontFamily: 'ui-monospace, monospace', padding: 20 }}>
      <h1 style={{ margin: 0, color: C.accent, letterSpacing: 2, fontSize: 18 }}>CEX EXECUTOR</h1>
      <p style={{ margin: '4px 0 0', color: C.dim, fontSize: 11 }}>{title} · {subtitle}</p>
      <p style={noteStyle}>
        non-custodial · your exchange keys, never ours · every figure on this page is what the risk engine returned
        for your own account — a `—` means the engine did not compute it
      </p>
      <div style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '0 0 14px' }}>
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              style={{
                background: C.card,
                color: C.accent,
                border: `1px solid ${C.border}`,
                padding: '6px 12px',
                borderRadius: 6,
                fontSize: 11,
                textDecoration: 'none',
              }}
            >
              {link.label}
            </Link>
          ))}
          <Link href="/team/balance" style={{ color: C.dim, fontSize: 11, padding: '6px 4px' }}>← back to store</Link>
        </div>
        {children}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// composer state (PRD §82, §83)
// ---------------------------------------------------------------------------

type LevelRow = { price: string; fraction: string };
export type ComposerState = {
  accountId: string;
  marketType: 'spot' | 'linear_perp';
  symbol: string;
  side: 'buy' | 'sell';
  intent: 'open' | 'close' | 'reduce';
  entryType: 'market' | 'limit';
  entryPrice: string;
  postOnly: boolean;
  stopLoss: string;
  takeProfits: LevelRow[];
  sizingMode: SizingMode;
  sizingValue: string;
  basis: BalanceBasis;
  leverageMode: 'manual' | 'auto_safe';
  manualLeverage: string;
  marginMode: MarginMode | '';
  strategy: ExecutionStrategy;
  durationMinutes: string;
  slices: string;
  urgency: ExecutionUrgency;
  quantityJitterPct: string;
  intervalJitterPct: string;
  visibleQty: string;
  maxChaseDistance: string;
  maxReplacements: string;
  levels: LevelRow[];
  maxSlippageBps: string;
  maxSpreadBps: string;
  maxPrice: string;
  minPrice: string;
  maxDurationMinutes: string;
  makerOnly: boolean;
  allowMarketFallback: boolean;
  cancelIfRiskExceeded: boolean;
  stopIfDisconnected: boolean;
  riskPolicy: 'resize_then_stop' | 'pause' | 'stop';
  existingPositionPolicy: 'add' | 'reject';
  mode: ExecutionMode;
};

const EMPTY_ROW: LevelRow = { price: '', fraction: '' };

const INITIAL: ComposerState = {
  accountId: '',
  marketType: 'linear_perp',
  symbol: 'BTC/USDT',
  side: 'buy',
  intent: 'open',
  entryType: 'market',
  entryPrice: '',
  postOnly: false,
  stopLoss: '',
  takeProfits: [{ ...EMPTY_ROW }],
  sizingMode: 'risk_percent',
  sizingValue: '1',
  basis: 'futures_equity',
  leverageMode: 'auto_safe',
  manualLeverage: '5',
  marginMode: '',
  strategy: 'adaptive_twap',
  durationMinutes: '30',
  slices: '',
  urgency: 'balanced',
  quantityJitterPct: '',
  intervalJitterPct: '',
  visibleQty: '',
  maxChaseDistance: '',
  maxReplacements: '',
  levels: [{ ...EMPTY_ROW }],
  maxSlippageBps: '',
  maxSpreadBps: '',
  maxPrice: '',
  minPrice: '',
  maxDurationMinutes: '',
  makerOnly: false,
  allowMarketFallback: false,
  cancelIfRiskExceeded: false,
  stopIfDisconnected: false,
  riskPolicy: 'resize_then_stop',
  existingPositionPolicy: 'reject',
  mode: 'paper',
};

const MARKET_OPTIONS = [{ value: 'linear_perp', label: 'USDT perpetual' }, { value: 'spot', label: 'Spot' }] as const;
const SIDE_OPTIONS = [{ value: 'buy', label: 'Long / buy' }, { value: 'sell', label: 'Short / sell' }] as const;
const INTENT_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'close', label: 'Close' },
  { value: 'reduce', label: 'Reduce' },
] as const;
const ENTRY_OPTIONS = [{ value: 'market', label: 'Market' }, { value: 'limit', label: 'Limit' }] as const;
const SIZING_OPTIONS: ReadonlyArray<{ value: SizingMode; label: string }> = [
  { value: 'risk_percent', label: 'Risk % of basis' },
  { value: 'risk_usd', label: 'Risk $' },
  { value: 'allocation_percent', label: 'Allocation % of basis' },
  { value: 'allocation_usd', label: 'Allocation $' },
  { value: 'notional_usd', label: 'Notional $' },
  { value: 'fixed_quantity', label: 'Fixed quantity' },
  { value: 'fixed_margin', label: 'Fixed margin $' },
  { value: 'target_profit_percent', label: 'Target profit % of basis' },
  { value: 'target_profit_usd', label: 'Target profit $' },
];
const BASIS_OPTIONS: ReadonlyArray<{ value: BalanceBasis; label: string }> = [
  { value: 'spot_available', label: 'Spot available' },
  { value: 'spot_equity', label: 'Spot equity' },
  { value: 'futures_available', label: 'Futures available' },
  { value: 'futures_equity', label: 'Futures equity' },
  { value: 'total_exchange_equity', label: 'Total exchange equity' },
  { value: 'asset_equity', label: 'Asset equity' },
  { value: 'custom', label: 'Custom' },
];
const STRATEGY_OPTIONS: ReadonlyArray<{ value: ExecutionStrategy; label: string }> = [
  { value: 'market', label: 'Market' },
  { value: 'limit', label: 'Limit' },
  { value: 'twap', label: 'TWAP' },
  { value: 'adaptive_twap', label: 'Adaptive TWAP' },
  { value: 'iceberg', label: 'Iceberg' },
  { value: 'chase_limit', label: 'Chase limit' },
  { value: 'scale_in', label: 'Scale in' },
  { value: 'scale_out', label: 'Scale out' },
];
const URGENCY_OPTIONS: ReadonlyArray<{ value: ExecutionUrgency; label: string }> = [
  { value: 'passive', label: 'Passive' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'aggressive', label: 'Aggressive' },
  { value: 'immediate', label: 'Immediate' },
];
const MARGIN_OPTIONS: ReadonlyArray<{ value: MarginMode | ''; label: string }> = [
  { value: '', label: 'Risk profile default' },
  { value: 'isolated', label: 'Isolated' },
  { value: 'cross', label: 'Cross' },
];
const RISK_POLICY_OPTIONS = [
  { value: 'resize_then_stop', label: 'Resize then stop' },
  { value: 'pause', label: 'Pause' },
  { value: 'stop', label: 'Stop' },
] as const;
const POSITION_POLICY_OPTIONS = [
  { value: 'reject', label: 'Reject if a position exists' },
  { value: 'add', label: 'Add to the position' },
] as const;
const MODE_OPTIONS: ReadonlyArray<{ value: ExecutionMode; label: string }> = [
  { value: 'paper', label: 'Paper (simulated)' },
  { value: 'live', label: 'LIVE (real order)' },
];
const LEVERAGE_MODE_OPTIONS = [
  { value: 'auto_safe', label: 'Auto safe' },
  { value: 'manual', label: 'Manual' },
] as const;

/** Sizing modes that must name their balance basis (PRD §10). */
const BASIS_SIZING: ReadonlySet<SizingMode> = new Set<SizingMode>([
  'risk_percent',
  'allocation_percent',
  'target_profit_percent',
]);

/** Risk-based sizing needs a stop; a stop needs a price (§38). */
const RISK_SIZING: ReadonlySet<SizingMode> = new Set<SizingMode>(['risk_usd', 'risk_percent']);

/** A required numeric field's value. The gate below blocks the request before it could reach the wire. */
function required(text: string): number {
  const value = num(text);
  return value === undefined ? 0 : value;
}

function buildSizing(state: ComposerState): SizingDefinition {
  const value = required(state.sizingValue);
  if (state.sizingMode === 'risk_percent') return { mode: 'risk_percent', value, balanceBasis: state.basis };
  if (state.sizingMode === 'allocation_percent') return { mode: 'allocation_percent', value, balanceBasis: state.basis };
  if (state.sizingMode === 'target_profit_percent') return { mode: 'target_profit_percent', value, balanceBasis: state.basis };
  return { mode: state.sizingMode, value };
}

function buildLeverage(state: ComposerState): LeverageDefinition | undefined {
  // §89: spot has no leverage and the planner rejects the field outright.
  if (state.marketType === 'spot') return undefined;
  return state.leverageMode === 'manual'
    ? { mode: 'manual', leverage: required(state.manualLeverage) }
    : { mode: 'auto_safe' };
}

function buildLevels(rows: LevelRow[]): { levels: { price: number; fraction: number }[]; incomplete: boolean } {
  const levels: { price: number; fraction: number }[] = [];
  let incomplete = false;
  for (const row of rows) {
    const price = num(row.price);
    const fraction = num(row.fraction);
    // A half-typed row must never become level 0 at price 0: the planner's own
    // "non-empty array" / "fractions must sum to 1" rules are the right gate.
    if (price === undefined || fraction === undefined) {
      incomplete = true;
      continue;
    }
    levels.push({ price, fraction });
  }
  return { levels, incomplete };
}

/**
 * The composer's execution-method body, as a PURE function of the form state.
 *
 * Exported because this is the seam where a control can be present in the markup
 * and still silently dropped from the request the server validates — precisely
 * the §29/§32 defect the engine audit found. Testing it needs no router and no
 * DOM, and it fails loudly if a field is added to the form but not the request.
 */
export function buildExecution(state: ComposerState): ExecutionDefinition {
  const durationMs = minutesToMs(state.durationMinutes) ?? 0;
  const sliceCount = optionalInt(state.slices);
  // Jitter is opt-in (PRD §28/§29): blank means the naive equal schedule. Keys are
  // omitted rather than sent as 0, so "unset" stays distinguishable from "no jitter".
  const qJit = num(state.quantityJitterPct);
  const iJit = num(state.intervalJitterPct);
  const config: TwapConfig | undefined = qJit === undefined && iJit === undefined
    ? undefined
    : {
        durationMs,
        orderType: state.makerOnly ? 'maker' : 'market',
        ...withOptional('quantityJitterPct', qJit),
        ...withOptional('intervalJitterPct', iJit),
      };
  switch (state.strategy) {
    case 'market':
      return { type: 'market' };
    case 'limit':
      return { type: 'limit', price: required(state.entryPrice), postOnly: state.postOnly };
    case 'twap':
      return { type: 'twap', durationMs, ...withOptional('slices', sliceCount), ...withOptional('config', config) };
    case 'adaptive_twap':
      return { type: 'adaptive_twap', durationMs, urgency: state.urgency, ...withOptional('slices', sliceCount), ...withOptional('config', config) };
    case 'iceberg':
      return { type: 'iceberg', visibleQuantity: required(state.visibleQty) };
    case 'chase_limit':
      return {
        type: 'chase_limit',
        urgency: state.urgency,
        ...withOptional('maxChaseDistance', num(state.maxChaseDistance)),
        ...withOptional('maxReplacements', optionalInt(state.maxReplacements)),
      };
    case 'scale_in':
      return { type: 'scale_in', levels: buildLevels(state.levels).levels };
    case 'scale_out':
      return { type: 'scale_out', levels: buildLevels(state.levels).levels };
  }
}

/**
 * Spreads a key ONLY when it holds a value, so an untouched optional field is
 * omitted from the request rather than sent as 0/false/'' — the server must be
 * able to tell "not set" from "set to zero".
 */
function withOptional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** An optional integer field: blank ⇒ undefined, else rounded (slice counts). */
function optionalInt(text: string): number | undefined {
  const value = num(text);
  return value === undefined ? undefined : Math.round(value);
}

/** Optional constraint keys are omitted, never sent as 0/false placeholders. */
function buildConstraints(state: ComposerState): NonNullable<ExecutionRequest['constraints']> {
  const constraints: NonNullable<ExecutionRequest['constraints']> = {};
  const maxSlippageBps = num(state.maxSlippageBps);
  const maxSpreadBps = num(state.maxSpreadBps);
  const maxPrice = num(state.maxPrice);
  const minPrice = num(state.minPrice);
  const maxDurationMs = minutesToMs(state.maxDurationMinutes);
  if (maxSlippageBps !== undefined) constraints.maxSlippageBps = maxSlippageBps;
  if (maxSpreadBps !== undefined) constraints.maxSpreadBps = maxSpreadBps;
  if (maxPrice !== undefined) constraints.maxPrice = maxPrice;
  if (minPrice !== undefined) constraints.minPrice = minPrice;
  if (maxDurationMs !== undefined) constraints.maxDurationMs = maxDurationMs;
  if (state.makerOnly) constraints.makerOnly = true;
  if (state.allowMarketFallback) constraints.allowMarketFallback = true;
  if (state.cancelIfRiskExceeded) constraints.cancelIfRiskExceeded = true;
  if (state.stopIfDisconnected) constraints.stopIfDisconnected = true;
  return constraints;
}

/** True when the entry/execution pairing of §54 forces a limit entry. */
function entryIsLimit(state: ComposerState): boolean {
  return state.strategy === 'limit' || (state.strategy !== 'market' && state.entryType === 'limit');
}

function buildRequest(state: ComposerState): ExecutionRequest {
  const stopPrice = num(state.stopLoss);
  const takeProfits: TakeProfitDefinition[] = [];
  for (const row of state.takeProfits) {
    const price = num(row.price);
    if (price === undefined) continue;
    const fraction = num(row.fraction);
    takeProfits.push(fraction === undefined ? { price } : { price, fraction });
  }
  const leverage = buildLeverage(state);
  const request: ExecutionRequest = {
    accountId: state.accountId,
    symbol: state.symbol.trim().toUpperCase(),
    marketType: state.marketType,
    side: state.side,
    intent: state.intent,
    entry: entryIsLimit(state)
      ? { type: 'limit', price: required(state.entryPrice), postOnly: state.postOnly }
      : { type: 'market' },
    sizing: buildSizing(state),
    execution: buildExecution(state),
    constraints: buildConstraints(state),
    riskPolicy: state.riskPolicy,
    existingPositionPolicy: state.existingPositionPolicy,
    mode: state.mode,
  };
  if (stopPrice !== undefined) request.stopLoss = { price: stopPrice };
  if (takeProfits.length > 0) request.takeProfits = takeProfits;
  if (leverage !== undefined) request.leverage = leverage;
  // §92: an empty selection means "use the risk profile's default".
  if (state.marketType === 'linear_perp' && state.marginMode !== '') request.marginMode = state.marginMode;
  return request;
}

/**
 * Only the checks that keep an obviously impossible request off the wire.
 * Every other rule — stop vs entry side, profile caps, fraction sums, venue
 * minimums, conflict detection — belongs to the planner, whose field-named
 * message this panel shows verbatim.
 */
function missingRequired(state: ComposerState): string[] {
  const missing: string[] = [];
  const sizingValue = num(state.sizingValue);
  const slices = num(state.slices);
  if (state.accountId === '') missing.push('accountId: choose a connected account');
  if (state.symbol.trim() === '') missing.push('symbol: e.g. BTC/USDT');
  if (sizingValue === undefined || sizingValue <= 0) missing.push('sizing.value: must be a positive number');
  if (RISK_SIZING.has(state.sizingMode) && num(state.stopLoss) === undefined) {
    missing.push(`stopLoss: required for ${state.sizingMode} sizing — without a stop the position risk is unbounded`);
  }
  if (entryIsLimit(state) && num(state.entryPrice) === undefined) {
    missing.push(state.strategy === 'limit' ? 'execution.price: must match entry.price' : 'entry.price: must be a positive number');
  }
  if ((state.strategy === 'twap' || state.strategy === 'adaptive_twap') && minutesToMs(state.durationMinutes) === undefined) {
    missing.push('execution.durationMs: must be a positive number');
  }
  if (slices !== undefined && slices < 1) missing.push('execution.slices: must be a positive integer');
  if (state.strategy === 'iceberg' && num(state.visibleQty) === undefined) {
    missing.push('execution.visibleQuantity: must be a positive number');
  }
  if (state.strategy === 'scale_in' || state.strategy === 'scale_out') {
    const { levels, incomplete } = buildLevels(state.levels);
    if (levels.length === 0 || incomplete) missing.push('execution.levels: must be a non-empty array');
    else {
      const sum = levels.reduce((total, level) => total + level.fraction, 0);
      if (Math.abs(sum - 1) > 1e-9) missing.push(`execution.levels: fractions must sum to 1 (got ${sum.toFixed(4)})`);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// risk preview block (PRD §84, §80, §23)
// ---------------------------------------------------------------------------

function PreviewBlock({ shown, stale }: { shown: PreviewResponse | null; stale: boolean }) {
  const preview: PreviewResult | null = shown === null ? null : shown.preview;
  const plan = preview === null ? null : preview.plan;
  const balances = plan?.balanceSnapshot ?? null;
  const stepDecimals = plan === null ? null : decimalsForStep(plan.instrument.stepSize);
  const tickSize = plan === null ? null : plan.instrument.tickSize;
  const equity = balances === null || plan === null
    ? null
    : plan.marketType === 'spot' ? balances.spotEquity : balances.futuresEquity;
  const conflictCount = preview?.conflicts.length ?? 0;
  return (
    <Card style={{ borderColor: conflictCount > 0 ? C.red : C.border }}>
      <h3 style={h3Style}>RISK PREVIEW · §84</h3>
      {preview === null && (
        <p style={noteStyle}>
          {stale
            ? 'the form changed since this preview — the figures were cleared because they no longer describe this request; press Preview again'
            : 'no preview yet — nothing is sized, priced or sent until the engine answers for this exact request'}
        </p>
      )}
      {plan !== null && (
        <>
          <p style={{ color: C.white, fontSize: 13, fontWeight: 800, margin: '0 0 2px' }}>
            {plan.symbol} · {plan.side.toUpperCase()} · {plan.venueKey}
          </p>
          <p style={noteStyle}>
            {plan.sizingMode} {plan.sizingValue}
            {plan.riskBasis === null ? '' : ` of ${plan.riskBasis}`}
            {' · '}{plan.execution.strategy}
            {plan.execution.durationMs === null ? '' : ` over ${formatDuration(plan.execution.durationMs)}`}
            {plan.execution.estimatedSlices === null ? '' : ` · ${plan.execution.estimatedSlices} slices`}
            {plan.execution.urgency === null ? '' : ` · ${plan.execution.urgency}`}
          </p>
          <div style={{ marginTop: 8 }}>
            <Row label="Account Equity" value={formatMoney(equity)} />
            <Row label="Risk Budget" value={formatMoney(plan.risk.budget)} />
            <Row label="Sizing Reference Balance" value={formatMoney(plan.balanceReference)} />
            <Row label="Quantity" value={formatQty(plan.quantity, stepDecimals)} />
            <Row label="Notional" value={formatMoney(plan.notional)} />
            <Row label="Margin Required" value={formatMoney(plan.margin.estimatedInitial)} />
            <Row
              label="Leverage"
              value={plan.leverage.selected === null
                ? DASH
                : `${plan.leverage.selected}x · ${plan.leverage.mode === 'auto_safe' ? 'AUTO SAFE' : 'MANUAL'}`}
            />
            <Row label="Margin Mode" value={plan.margin.mode ?? DASH} />
            <Row label="Entry Estimate" value={formatPrice(plan.estimatedEntry, tickSize)} />
            <Row label="Stop" value={formatPrice(plan.stopLoss, tickSize)} />
            <Row
              label="Take Profit(s)"
              value={plan.takeProfits.length === 0
                ? DASH
                : plan.takeProfits
                  .map((tp) => `${formatPrice(tp.price, tickSize)}${tp.fraction === undefined ? '' : ` (${formatPct(tp.fraction)})`}`)
                  .join(' · ')}
            />
            <Row label="Estimated Fees" value={formatMoney(plan.risk.estimatedFees)} />
            <Row label="Estimated Slippage" value={`${formatMoney(plan.risk.slippageBudget)} · ${formatBps(plan.slippageModel.slippageBps)}`} />
            <Row label="Price Risk" value={formatMoney(plan.risk.priceRisk)} />
            <Row label="Safety Reserve" value={formatMoney(plan.risk.safetyReserve)} />
            <Row label="Total Planned Risk" value={formatMoney(plan.risk.estimatedTotalRisk)} />
            <Row label="Loss @ SL" value={formatMoney(preview?.expectedLossAtStop, { signed: true })} tone="bad" />
            <Row label="Profit @ TP" value={formatMoney(preview?.expectedProfitAtTarget, { signed: true })} tone="good" />
            <Row label="Risk / Reward" value={formatRiskReward(preview?.riskReward)} />
            <Row label="Liquidation Price" value={formatPrice(plan.liquidation.priceApprox, tickSize)} />
            <Row
              label="SL → Liquidation Buffer"
              value={plan.liquidation.stopToLiquidationBuffer === null
                ? DASH
                : `${formatMoney(plan.liquidation.stopToLiquidationBuffer)}${plan.liquidation.safe === false ? ' · UNSAFE' : plan.liquidation.safe === true ? ' · safe' : ''}`}
              tone={plan.liquidation.safe === false ? 'bad' : undefined}
            />
          </div>
        </>
      )}
      {preview !== null && conflictCount > 0 && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${C.red}`, paddingTop: 8 }}>
          <p style={{ color: C.red, fontSize: 11, fontWeight: 800, margin: '0 0 4px' }}>
            {conflictCount} CONFLICT{conflictCount === 1 ? '' : 'S'} — creation is blocked (PRD §117)
          </p>
          {preview.conflicts.map((conflict) => (
            <p key={conflict.code} style={{ color: C.white, fontSize: 11, margin: '0 0 4px' }}>
              <span style={{ color: C.red, fontWeight: 700 }}>{conflict.code}</span> — {conflict.message}
              {conflict.detail !== undefined && (
                <span style={{ color: C.dim }}>{' '}({Object.entries(conflict.detail).map(([key, value]) => `${key}=${value}`).join(', ')})</span>
              )}
            </p>
          ))}
        </div>
      )}
      {preview !== null && preview.warnings.length > 0 && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
          <p style={{ color: C.accent, fontSize: 11, fontWeight: 800, margin: '0 0 4px' }}>
            {preview.warnings.length} WARNING{preview.warnings.length === 1 ? '' : 'S'} — shown, not blocking
          </p>
          {preview.warnings.map((warning) => (
            <p key={warning} style={{ color: C.dim, fontSize: 11, margin: '0 0 3px' }}>· {warning}</p>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ExecutorComposer — §82, §83, §84, §80
// ---------------------------------------------------------------------------

function LevelEditor({ title, rows, onChange }: { title: string; rows: LevelRow[]; onChange: (rows: LevelRow[]) => void }) {
  return (
    <div style={{ marginTop: 8 }}>
      <Label>{title}</Label>
      {rows.map((row, index) => (
        <div key={index} style={{ ...pairStyle, marginBottom: 6 }}>
          <Text
            value={row.price}
            onChange={(price) => {
              const next = rows.slice();
              next[index] = { ...row, price };
              onChange(next);
            }}
            placeholder="price"
            type="number"
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <Text
              value={row.fraction}
              onChange={(fraction) => {
                const next = rows.slice();
                next[index] = { ...row, fraction };
                onChange(next);
              }}
              placeholder="fraction 0..1"
              type="number"
            />
            <Btn onClick={() => onChange(rows.filter((_, i) => i !== index))} tone="danger" disabled={rows.length === 1}>
              ✕
            </Btn>
          </div>
        </div>
      ))}
      <Btn onClick={() => onChange([...rows, { ...EMPTY_ROW }])}>+ level</Btn>
    </div>
  );
}

export function ExecutorComposer() {
  const router = useRouter();
  const [state, setState] = useState<ComposerState>(INITIAL);
  const [accounts, setAccounts] = useState<CredentialRecord[]>([]);
  const [accountsError, setAccountsError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  // `request` is the serialized body that produced it, so the block can refuse to
  // show a preview that no longer describes the form.
  const [result, setResult] = useState<{ request: string; preview: PreviewResponse } | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState('');

  const patch = useCallback((change: Partial<ComposerState>) => {
    setState((prev) => ({ ...prev, ...change }));
  }, []);

  const loadAccounts = useCallback(async () => {
    setAccountsError('');
    try {
      const body = await listAccounts();
      setAccounts(body.accounts);
      setState((prev) => (prev.accountId === '' && body.accounts[0] !== undefined ? { ...prev, accountId: body.accounts[0].id } : prev));
    } catch (err) {
      setAccountsError(errorMessage(err));
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const request = useMemo(() => buildRequest(state), [state]);
  const blocking = useMemo(() => missingRequired(state), [state]);
  const serializedRequest = JSON.stringify(request);
  // The preview block is bound to the request that produced it: a form edit
  // invalidates it instead of leaving stale risk figures beside new inputs.
  const shown = result === null || result.request !== serializedRequest ? null : result.preview;
  const conflictCount = shown === null ? 0 : shown.preview.conflicts.length;
  const liveEnabled = result?.preview.liveEnabled ?? false;
  const isSpot = state.marketType === 'spot';

  const runPreview = useCallback(async () => {
    setBusy(true);
    setPreviewError('');
    setSubmitError('');
    try {
      // §98: a preview creates nothing and places nothing, whatever the mode.
      const answer = await preview(buildRequest(state));
      setResult({ request: JSON.stringify(request), preview: answer });
    } catch (err) {
      setPreviewError(errorMessage(err));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [request, state]);

  const submit = useCallback(async () => {
    if (blocking.length > 0) {
      setSubmitError(blocking.join('\n'));
      return;
    }
    setBusy(true);
    setSubmitError('');
    try {
      const created = await createExecution(request);
      setCreatedId(created.execution.id);
      setResult(null);
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [blocking, request]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(320px, 420px)', gap: 14, alignItems: 'start' }}>
      <Card>
        <h3 style={h3Style}>NEW EXECUTION · §82</h3>
        <ErrorBanner text={accountsError} />

        <Field label="Account">
          <Choice
            value={state.accountId}
            onChange={(accountId) => patch({ accountId })}
            options={[
              { value: '', label: accounts.length === 0 ? 'no account connected — connect one first' : 'select an account' },
              ...accounts.map((account) => ({
                value: account.id,
                label: `${account.label} · ${account.exchange} · ${account.health}${account.revokedAt === null ? '' : ' · revoked'}`,
              })),
            ]}
          />
        </Field>
        {accounts.length === 0 && (
          <p style={noteStyle}>
            <Link href="/executor/accounts" style={{ color: C.accent }}>connect an exchange account →</Link>
          </p>
        )}

        <div style={{ ...pairStyle, marginTop: 8 }}>
          <Field label="Market">
            <Choice value={state.marketType} onChange={(marketType) => patch({ marketType })} options={MARKET_OPTIONS} />
          </Field>
          <Field label="Symbol (BASE/QUOTE)">
            <Text value={state.symbol} onChange={(symbol) => patch({ symbol })} placeholder="BTC/USDT" />
          </Field>
        </div>
        <div style={{ ...pairStyle, marginTop: 8 }}>
          <Field label="Side">
            <Choice value={state.side} onChange={(side) => patch({ side })} options={SIDE_OPTIONS} />
          </Field>
          <Field label="Intent">
            <Choice value={state.intent} onChange={(intent) => patch({ intent })} options={INTENT_OPTIONS} />
          </Field>
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 10 }}>
          <p style={{ color: C.accent, fontSize: 11, fontWeight: 700, margin: '0 0 6px' }}>ENTRY · STOP · TARGETS</p>
          <div style={pairStyle}>
            <Field label="Entry type">
              <Choice
                value={state.entryType}
                onChange={(entryType) => patch({ entryType })}
                options={ENTRY_OPTIONS}
                disabled={state.strategy === 'market' || state.strategy === 'limit'}
              />
            </Field>
            <Field label={state.strategy === 'limit' ? 'Limit price' : 'Entry price'}>
              <Text
                value={state.entryPrice}
                onChange={(entryPrice) => patch({ entryPrice })}
                placeholder={entryIsLimit(state) ? 'e.g. 100000' : 'market'}
                type="number"
                disabled={!entryIsLimit(state)}
              />
            </Field>
          </div>
          {entryIsLimit(state) && (
            <div style={{ marginTop: 8 }}>
              <Checkbox label="Post only (maker)" checked={state.postOnly} onChange={(postOnly) => patch({ postOnly })} />
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <Field label={`Stop loss${RISK_SIZING.has(state.sizingMode) ? ' (required by §38)' : ''}`}>
              <Text value={state.stopLoss} onChange={(stopLoss) => patch({ stopLoss })} placeholder="e.g. 98000" type="number" />
            </Field>
          </div>
          <LevelEditor
            title="Take profit(s) — fraction 0..1, blank = close everything at that level"
            rows={state.takeProfits}
            onChange={(takeProfits) => patch({ takeProfits })}
          />
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 10 }}>
          <p style={{ color: C.accent, fontSize: 11, fontWeight: 700, margin: '0 0 6px' }}>SIZING · LEVERAGE</p>
          <div style={pairStyle}>
            <Field label="Sizing mode">
              <Choice value={state.sizingMode} onChange={(sizingMode) => patch({ sizingMode })} options={SIZING_OPTIONS} />
            </Field>
            <Field label={BASIS_SIZING.has(state.sizingMode) ? 'Risk %' : 'Sizing value'}>
              <Text value={state.sizingValue} onChange={(sizingValue) => patch({ sizingValue })} placeholder="e.g. 1" type="number" />
            </Field>
          </div>
          {BASIS_SIZING.has(state.sizingMode) && (
            <div style={{ marginTop: 8 }}>
              <Field label="Risk basis (PRD §10 — percentage sizing must name its source)">
                <Choice value={state.basis} onChange={(basis) => patch({ basis })} options={BASIS_OPTIONS} />
              </Field>
            </div>
          )}
          <div style={{ ...pairStyle, marginTop: 8 }}>
            <Field label="Leverage mode">
              <Choice value={state.leverageMode} onChange={(leverageMode) => patch({ leverageMode })} options={LEVERAGE_MODE_OPTIONS} disabled={isSpot} />
            </Field>
            {state.leverageMode === 'manual' ? (
              <Field label="Leverage (x)">
                <Text value={state.manualLeverage} onChange={(manualLeverage) => patch({ manualLeverage })} type="number" disabled={isSpot} />
              </Field>
            ) : (
              <Field label="Margin mode">
                <Choice value={state.marginMode} onChange={(marginMode) => patch({ marginMode })} options={MARGIN_OPTIONS} disabled={isSpot} />
              </Field>
            )}
          </div>
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 10 }}>
          <p style={{ color: C.accent, fontSize: 11, fontWeight: 700, margin: '0 0 6px' }}>EXECUTION METHOD</p>
          <Field label="Method">
            <Choice value={state.strategy} onChange={(strategy) => patch({ strategy })} options={STRATEGY_OPTIONS} />
          </Field>
          {(state.strategy === 'twap' || state.strategy === 'adaptive_twap') && (
            <div style={{ ...pairStyle, marginTop: 8 }}>
              <Field label="Duration (minutes)">
                <Text value={state.durationMinutes} onChange={(durationMinutes) => patch({ durationMinutes })} type="number" />
              </Field>
              <Field label="Slices (blank = engine decides)">
                <Text value={state.slices} onChange={(slices) => patch({ slices })} placeholder="auto" type="number" />
              </Field>
            </div>
          )}
          {(state.strategy === 'twap' || state.strategy === 'adaptive_twap') && (
            <div style={{ ...pairStyle, marginTop: 8 }}>
              <Field
                label="Quantity jitter (%)"
                hint="PRD §28/§29 — blank means equal slices; otherwise each slice is randomly scaled by ±this share, then normalized so the total is unchanged"
              >
                <Text value={state.quantityJitterPct} onChange={(quantityJitterPct) => patch({ quantityJitterPct })} placeholder="0" type="number" />
              </Field>
              <Field
                label="Interval jitter (%)"
                hint="randomizes the gap between slices; the schedule stays monotonic and inside the duration"
              >
                <Text value={state.intervalJitterPct} onChange={(intervalJitterPct) => patch({ intervalJitterPct })} placeholder="0" type="number" />
              </Field>
            </div>
          )}
          {(state.strategy === 'adaptive_twap' || state.strategy === 'chase_limit') && (
            <div style={{ marginTop: 8 }}>
              <Field label="Urgency">
                <Choice value={state.urgency} onChange={(urgency) => patch({ urgency })} options={URGENCY_OPTIONS} />
              </Field>
            </div>
          )}
          {state.strategy === 'iceberg' && (
            <div style={{ marginTop: 8 }}>
              <Field label="Visible quantity">
                <Text value={state.visibleQty} onChange={(visibleQty) => patch({ visibleQty })} type="number" />
              </Field>
            </div>
          )}
          {state.strategy === 'chase_limit' && (
            <div style={{ ...pairStyle, marginTop: 8 }}>
              <Field label="Max chase distance ($)" hint="PRD §32 — how far the peg may travel from arrival before it holds position">
                <Text value={state.maxChaseDistance} onChange={(maxChaseDistance) => patch({ maxChaseDistance })} placeholder="unbounded" type="number" />
              </Field>
              <Field label="Max replacements" hint="cancel/replace cycles before the strategy stops (or falls back to market, if enabled)">
                <Text value={state.maxReplacements} onChange={(maxReplacements) => patch({ maxReplacements })} placeholder="100" type="number" />
              </Field>
            </div>
          )}
          {(state.strategy === 'scale_in' || state.strategy === 'scale_out') && (
            <LevelEditor title="Scale levels — fractions must sum to 1" rows={state.levels} onChange={(levels) => patch({ levels })} />
          )}
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 10 }}>
          <button
            onClick={() => setShowAdvanced((open) => !open)}
            style={{ background: 'transparent', color: C.accent, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: 0 }}
          >
            {showAdvanced ? '▾' : '▸'} ADVANCED CONSTRAINTS
          </button>
          {showAdvanced && (
            <div style={{ marginTop: 8 }}>
              <div style={pairStyle}>
                <Field label="Max slippage (bps)">
                  <Text value={state.maxSlippageBps} onChange={(maxSlippageBps) => patch({ maxSlippageBps })} type="number" />
                </Field>
                <Field label="Max spread (bps)">
                  <Text value={state.maxSpreadBps} onChange={(maxSpreadBps) => patch({ maxSpreadBps })} type="number" />
                </Field>
              </div>
              <div style={{ ...pairStyle, marginTop: 8 }}>
                <Field label="Max price (cap)">
                  <Text value={state.maxPrice} onChange={(maxPrice) => patch({ maxPrice })} type="number" />
                </Field>
                <Field label="Min price (floor)">
                  <Text value={state.minPrice} onChange={(minPrice) => patch({ minPrice })} type="number" />
                </Field>
              </div>
              <div style={{ marginTop: 8 }}>
                <Field label="Max duration (minutes)">
                  <Text value={state.maxDurationMinutes} onChange={(maxDurationMinutes) => patch({ maxDurationMinutes })} type="number" />
                </Field>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
                <Checkbox label="Maker only" checked={state.makerOnly} onChange={(makerOnly) => patch({ makerOnly })} />
                <Checkbox label="Allow market fallback" checked={state.allowMarketFallback} onChange={(allowMarketFallback) => patch({ allowMarketFallback })} />
                <Checkbox label="Cancel if risk exceeded" checked={state.cancelIfRiskExceeded} onChange={(cancelIfRiskExceeded) => patch({ cancelIfRiskExceeded })} />
                <Checkbox label="Stop if disconnected" checked={state.stopIfDisconnected} onChange={(stopIfDisconnected) => patch({ stopIfDisconnected })} />
              </div>
              <div style={{ ...pairStyle, marginTop: 8 }}>
                <Field label="Risk breach policy">
                  <Choice value={state.riskPolicy} onChange={(riskPolicy) => patch({ riskPolicy })} options={RISK_POLICY_OPTIONS} />
                </Field>
                <Field label="Existing position">
                  <Choice
                    value={state.existingPositionPolicy}
                    onChange={(existingPositionPolicy) => patch({ existingPositionPolicy })}
                    options={POSITION_POLICY_OPTIONS}
                  />
                </Field>
              </div>
            </div>
          )}
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 10 }}>
          <div style={pairStyle}>
            <Field label="Execution mode">
              <Choice value={state.mode} onChange={(mode) => patch({ mode })} options={MODE_OPTIONS} />
            </Field>
            <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 4 }}>
              <span style={{ color: state.mode === 'live' ? C.red : C.dim, fontSize: 10 }}>
                {state.mode === 'live'
                  ? `live is ${liveEnabled ? 'enabled' : 'BLOCKED by the server kill switch'}`
                  : 'paper — the venue adapter simulates the fills'}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Btn onClick={runPreview} disabled={busy || blocking.length > 0} tone="primary">Preview</Btn>
            <Btn onClick={submit} disabled={busy || conflictCount > 0 || blocking.length > 0} tone={state.mode === 'live' ? 'danger' : 'primary'}>
              {state.mode === 'live' ? 'Create LIVE execution' : 'Create execution'}
            </Btn>
            <Btn onClick={() => { setResult(null); setPreviewError(''); setSubmitError(''); setState(INITIAL); }}>Reset</Btn>
          </div>
          {blocking.length > 0 && (
            <ul style={{ color: C.dim, fontSize: 10, margin: '8px 0 0', paddingLeft: 16 }}>
              {blocking.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {state.mode === 'live' && !liveEnabled && (
            <p style={{ ...noteStyle, color: C.red }}>
              live creation is refused by the server unless FUDCOURT_EXECUTOR_LIVE=1 (PRD §108) — paper mode works now
            </p>
          )}
        </div>
      </Card>

      <div>
        <ErrorBanner text={previewError} />
        <ErrorBanner text={submitError} />
        {createdId !== '' && (
          <Card style={{ borderColor: C.accent }}>
            <h3 style={h3Style}>CREATED · READY</h3>
            <p style={{ color: C.white, fontSize: 11, margin: '0 0 8px' }}>
              execution <span style={{ color: C.accent }}>{createdId}</span> exists and is waiting — start it from its
              own page, or keep composing.
            </p>
            <Btn onClick={() => router.push(`/executor/${createdId}`)} tone="primary">go to execution →</Btn>
          </Card>
        )}
        <PreviewBlock shown={shown} stale={result !== null} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExecutorProgress — §85, §86
// ---------------------------------------------------------------------------

/** Progress as a fraction, only when a planned quantity exists (§86's bar). */
function fillFraction(execution: ExecutionRecord): number | null {
  return execution.plannedQuantity > 0 ? execution.actualQuantity / execution.plannedQuantity : null;
}

/** Elapsed / remaining from the record's own timestamps and configured duration. */
function ElapsedRows({ execution }: { execution: ExecutionRecord }) {
  const config = execution.executionConfig;
  const plannedDuration = config.type === 'twap' || config.type === 'adaptive_twap' ? config.durationMs : null;
  const elapsed = execution.startedAt === null ? null : Date.now() - execution.startedAt;
  const remaining = plannedDuration === null || elapsed === null ? null : Math.max(0, plannedDuration - elapsed);
  return (
    <>
      <Row label="Elapsed" value={formatDuration(elapsed)} />
      <Row label="Remaining" value={formatDuration(remaining)} />
    </>
  );
}

function ChildOrderTable({ orders }: { orders: ChildOrderRecord[] }) {
  return (
    <Card>
      <h3 style={h3Style}>CHILD ORDERS · {orders.length}</h3>
      {orders.length === 0 && <p style={noteStyle}>no child orders yet — the worker plans them when the execution starts</p>}
      {orders.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>Client Order Id</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Side</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Price</th>
              <th style={thStyle}>Qty</th>
              <th style={thStyle}>Filled</th>
              <th style={thStyle}>Leg</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td style={{ ...tdStyle, color: C.dim }}>{order.clientOrderId}</td>
                <td style={tdStyle}><StatusPill status={order.status} /></td>
                <td style={{ ...tdStyle, color: order.side === 'buy' ? C.accent : C.red }}>{order.side.toUpperCase()}</td>
                <td style={tdStyle}>{order.type}</td>
                <td style={tdStyle}>{formatPrice(order.price)}</td>
                <td style={tdStyle}>{formatQty(order.quantity)}</td>
                <td style={tdStyle}>{formatQty(order.filledQuantity)}</td>
                <td style={{ ...tdStyle, color: order.isExit ? C.accent : C.dim }}>{order.isExit ? 'exit' : 'entry'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function FillTable({ fills }: { fills: FillRecord[] }) {
  return (
    <Card>
      <h3 style={h3Style}>FILLS · {fills.length}</h3>
      {fills.length === 0 && <p style={noteStyle}>no fills recorded</p>}
      {fills.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>Time</th>
              <th style={thStyle}>Price</th>
              <th style={thStyle}>Qty</th>
              <th style={thStyle}>Quote</th>
              <th style={thStyle}>Fee</th>
              <th style={thStyle}>Trade Id</th>
            </tr>
          </thead>
          <tbody>
            {fills.map((fill) => (
              <tr key={fill.id}>
                <td style={{ ...tdStyle, color: C.dim }}>{formatTimestamp(fill.timestamp)}</td>
                <td style={tdStyle}>{formatPrice(fill.price)}</td>
                <td style={tdStyle}>{formatQty(fill.quantity)}</td>
                <td style={tdStyle}>{formatMoney(fill.quoteQuantity)}</td>
                <td style={tdStyle}>{formatMoney(fill.fee)} {fill.feeAsset}</td>
                <td style={{ ...tdStyle, color: C.dim }}>{fill.exchangeTradeId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function EventTable({ events }: { events: ExecutionEventRecord[] }) {
  return (
    <Card>
      <h3 style={h3Style}>EVENT LOG · {events.length}</h3>
      {events.length === 0 && <p style={noteStyle}>no events recorded</p>}
      {events.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>Time</th>
              <th style={thStyle}>Event</th>
              <th style={thStyle}>Payload</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td style={{ ...tdStyle, color: C.dim }}>{formatTimestamp(event.createdAt)}</td>
                <td style={{ ...tdStyle, color: C.accent, fontWeight: 700 }}>{event.name}</td>
                <td style={{ ...tdStyle, color: C.dim }}>{JSON.stringify(event.payload)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function ExecutorProgress({ executionId }: { executionId: string }) {
  const [execution, setExecution] = useState<ExecutionRecord | null>(null);
  const [orders, setOrders] = useState<ChildOrderRecord[]>([]);
  const [fills, setFills] = useState<FillRecord[]>([]);
  const [events, setEvents] = useState<ExecutionEventRecord[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  // The record and its three sub-resources load independently: an orders or
  // events failure must not blank the progress figures the record already
  // answers, so each one is applied (or reported) on its own.
  const load = useCallback(async () => {
    setError('');
    const failures: string[] = [];
    const detail = await getExecution(executionId).catch((err: unknown) => {
      failures.push(errorMessage(err));
      return null;
    });
    if (detail !== null) setExecution(detail.execution);
    const [ordersResult, fillsResult, eventsResult] = await Promise.allSettled([
      listOrders(executionId),
      listFills(executionId),
      listEvents(executionId),
    ]);
    if (ordersResult.status === 'fulfilled') setOrders(ordersResult.value.childOrders);
    else failures.push(`child orders: ${errorMessage(ordersResult.reason)}`);
    if (fillsResult.status === 'fulfilled') setFills(fillsResult.value.fills);
    else failures.push(`fills: ${errorMessage(fillsResult.reason)}`);
    if (eventsResult.status === 'fulfilled') setEvents(eventsResult.value.events);
    else failures.push(`events: ${errorMessage(eventsResult.reason)}`);
    if (failures.length > 0) setError(failures.join('\n'));
  }, [executionId]);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (op: 'start' | 'pause' | 'resume' | 'cancel') => {
    setBusy(true);
    setError('');
    try {
      if (op === 'start') await startExecution(executionId);
      else if (op === 'pause') await pauseExecution(executionId);
      else if (op === 'resume') await resumeExecution(executionId);
      else await cancelExecution(executionId);
      setConfirmingCancel(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [executionId, load]);

  if (execution === null) {
    return (
      <Card>
        <ErrorBanner text={error} />
        {error === '' && <p style={noteStyle}>loading execution {executionId}…</p>}
        <Link href="/executor/history" style={{ color: C.accent, fontSize: 11 }}>← back to history</Link>
      </Card>
    );
  }

  const terminal = isTerminalExecution(execution.status);
  const remainingQuantity = execution.plannedQuantity - execution.actualQuantity;
  const remainingRisk = diff(execution.plannedRisk, execution.currentRisk);
  const targets = execution.takeProfitDefinition.map((tp) => formatPrice(tp.price)).join(' · ');

  return (
    <>
      <Card style={{ borderColor: C.accent }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ ...h3Style, margin: 0 }}>{execution.executionStrategy.toUpperCase()} · {execution.status}</h3>
            <p style={{ ...noteStyle, marginTop: 4 }}>
              {execution.symbol} · {execution.side.toUpperCase()} · {execution.intent} · {execution.mode.toUpperCase()}
              {' · '}{execution.exchange} · <span style={{ color: C.dim }}>{execution.id}</span>
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn onClick={load} disabled={busy}>↻ Refresh</Btn>
            <Btn onClick={() => act('start')} disabled={busy || execution.status !== 'READY'} tone="primary">Start</Btn>
            <Btn
              onClick={() => act('pause')}
              disabled={busy || (execution.status !== 'RUNNING' && execution.status !== 'PARTIALLY_FILLED' && execution.status !== 'RECONCILING')}
            >
              Pause
            </Btn>
            <Btn onClick={() => act('resume')} disabled={busy || execution.status !== 'PAUSED'} tone="primary">Resume</Btn>
            <Btn
              onClick={() => setConfirmingCancel(true)}
              disabled={busy || terminal || execution.status === 'CANCEL_REQUESTED' || execution.status === 'DRAFT'}
              tone="danger"
            >
              Cancel
            </Btn>
          </div>
        </div>

        {confirmingCancel && (
          <div style={{ marginTop: 10, border: `1px solid ${C.red}`, borderRadius: 6, padding: 10 }}>
            <p style={{ color: C.white, fontSize: 11, margin: '0 0 8px' }}>
              Cancel this execution and the child orders it manages? It cancels open orders — it does <b>not</b> close
              a position that has already opened (PRD §75); closing is a separate, explicit action.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn onClick={() => setConfirmingCancel(false)} disabled={busy}>Keep it running</Btn>
              <Btn onClick={() => act('cancel')} disabled={busy} tone="danger">Yes, cancel</Btn>
            </div>
          </div>
        )}

        <ErrorBanner text={error} />

        <div style={{ marginTop: 12 }}>
          <p style={{ color: C.white, fontSize: 12, fontFamily: 'monospace', margin: '0 0 4px' }}>
            {progressBar(fillFraction(execution))}{' '}
            <span style={{ color: C.accent, fontWeight: 700 }}>{formatCompletionPct(fillFraction(execution))}</span>
          </p>
          <div style={{ marginTop: 6 }}>
            <Row label="Filled / Planned" value={`${formatQty(execution.actualQuantity)} / ${formatQty(execution.plannedQuantity)}`} />
            <Row label="Remaining Quantity" value={formatQty(remainingQuantity)} />
            <Row label="Average Fill" value={formatPrice(execution.averageFillPrice)} />
            <Row label="Notional (actual / planned)" value={`${formatMoney(execution.actualNotional)} / ${formatMoney(execution.plannedNotional)}`} />
            <ElapsedRows execution={execution} />
            <Row label="Planned Risk" value={formatMoney(execution.plannedRisk)} />
            <Row
              label="Current Projected Risk"
              value={formatMoney(execution.currentRisk)}
              tone={execution.currentRisk === null ? undefined : 'good'}
            />
            <Row label="Remaining Risk Budget" value={formatMoney(remainingRisk)} />
            <Row label="Fees (actual / estimated)" value={`${formatMoney(execution.actualFees)} / ${formatMoney(execution.estimatedFees)}`} />
            <Row
              label="Stop / Targets"
              value={`${formatPrice(execution.stopDefinition?.price ?? null)}${targets === '' ? '' : ` · ${targets}`}`}
            />
            <Row
              label="Created / Started / Completed"
              value={`${formatTimestamp(execution.createdAt)} · ${formatTimestamp(execution.startedAt)} · ${formatTimestamp(execution.completedAt)}`}
            />
          </div>
        </div>
      </Card>

      <ChildOrderTable orders={orders} />
      <FillTable fills={fills} />
      <EventTable events={events} />
    </>
  );
}

// ---------------------------------------------------------------------------
// ExecutorHistory — §22
// ---------------------------------------------------------------------------

const STATUS_FILTERS: ReadonlyArray<{ value: ExecutionStatus | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'RUNNING', label: 'Running' },
  { value: 'PARTIALLY_FILLED', label: 'Partially filled' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'READY', label: 'Ready' },
  { value: 'FILLED', label: 'Filled' },
  { value: 'CANCEL_REQUESTED', label: 'Cancel requested' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'RISK_STOPPED', label: 'Risk stopped' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'STOPPED', label: 'Stopped' },
  { value: 'RECONCILING', label: 'Reconciling' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'CALCULATED', label: 'Calculated' },
  { value: 'VALIDATED', label: 'Validated' },
];

export function ExecutorHistory() {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [status, setStatus] = useState<ExecutionStatus | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const body = await listExecutions(status === '' ? undefined : status);
      setExecutions(body.executions);
    } catch (err) {
      setError(errorMessage(err));
      setExecutions([]);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ ...h3Style, margin: 0 }}>EXECUTIONS · §22</h3>
        <Choice value={status} onChange={setStatus} options={STATUS_FILTERS} />
        <Btn onClick={load} disabled={loading}>↻ Refresh</Btn>
        <Link
          href="/executor/new"
          style={{ background: C.accent, color: '#04140f', padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, textDecoration: 'none' }}
        >
          + New execution
        </Link>
        <span style={{ color: C.dim, fontSize: 10 }}>{loading ? 'loading…' : `${executions.length} shown`}</span>
      </div>
      <ErrorBanner text={error} />
      <Card>
        {executions.length === 0 && !loading && <p style={noteStyle}>no executions recorded for this account yet</p>}
        {executions.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Mode</th>
                <th style={thStyle}>Symbol</th>
                <th style={thStyle}>Side</th>
                <th style={thStyle}>Strategy</th>
                <th style={thStyle}>Planned Qty</th>
                <th style={thStyle}>Filled Qty</th>
                <th style={thStyle}>Risk Budget</th>
                <th style={thStyle}>Projected Risk</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {executions.map((execution) => (
                <tr key={execution.id}>
                  <td style={{ ...tdStyle, color: C.dim }}>{formatAgo(execution.createdAt)}</td>
                  <td style={tdStyle}><StatusPill status={execution.status} /></td>
                  <td style={{ ...tdStyle, color: execution.mode === 'live' ? C.red : C.dim }}>{execution.mode}</td>
                  <td style={tdStyle}>{execution.symbol}</td>
                  <td style={{ ...tdStyle, color: execution.side === 'buy' ? C.accent : C.red }}>{execution.side.toUpperCase()}</td>
                  <td style={tdStyle}>{execution.executionStrategy}</td>
                  <td style={tdStyle}>{formatQty(execution.plannedQuantity)}</td>
                  <td style={tdStyle}>{formatQty(execution.actualQuantity)}</td>
                  <td style={tdStyle}>{formatMoney(execution.riskBudget)}</td>
                  <td style={tdStyle}>{formatMoney(execution.currentRisk)}</td>
                  <td style={tdStyle}>
                    <Link href={`/executor/${execution.id}`} style={{ color: C.accent, fontSize: 11 }}>open →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// ExecutorAccounts — §87
// ---------------------------------------------------------------------------

const EXCHANGE_OPTIONS = [
  { value: 'binance', label: 'Binance' },
  { value: 'bybit', label: 'Bybit' },
  { value: 'mexc', label: 'MEXC' },
] as const;

function ConnectForm({ onConnected }: { onConnected: () => void }) {
  const [exchange, setExchange] = useState('binance');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const submit = useCallback(async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      // Secrets leave the browser exactly once and are cleared immediately; the
      // API only ever answers with the masked key (PRD §109).
      const body = await connectAccount({
        exchange,
        label,
        apiKey,
        apiSecret,
        ...(passphrase.trim() === '' ? {} : { passphrase }),
      });
      setApiKey('');
      setApiSecret('');
      setPassphrase('');
      setLabel('');
      setNotice(`connected ${body.account.label} on ${body.account.exchange} · key ${body.metadata.apiKeyMasked ?? DASH} · health ${body.metadata.health}`);
      onConnected();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [apiKey, apiSecret, exchange, label, onConnected, passphrase]);

  return (
    <Card>
      <h3 style={h3Style}>CONNECT AN EXCHANGE · §43</h3>
      <ErrorBanner text={error} />
      {notice !== '' && <p style={{ color: C.accent, fontSize: 11, fontWeight: 700, margin: '0 0 8px' }}>✓ {notice}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <Field label="Exchange">
          <Choice value={exchange} onChange={setExchange} options={EXCHANGE_OPTIONS} />
        </Field>
        <Field label="Label">
          <Text value={label} onChange={setLabel} placeholder="e.g. Binance Main" />
        </Field>
        <Field label="API key">
          <Text value={apiKey} onChange={setApiKey} placeholder="paste key" type="password" />
        </Field>
        <Field label="API secret">
          <Text value={apiSecret} onChange={setApiSecret} placeholder="paste secret" type="password" />
        </Field>
        <Field label="Passphrase (only if your key needs one)">
          <Text value={passphrase} onChange={setPassphrase} placeholder="optional" type="password" />
        </Field>
        <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
          <Btn onClick={submit} disabled={busy} tone="primary">Connect</Btn>
        </div>
      </div>
      <p style={noteStyle}>
        the key is verified on connect and refused if it grants withdrawal permission (PRD §43) · secrets are sealed
        server-side and never displayed again · FUDCourt never takes custody
      </p>
    </Card>
  );
}

export function ExecutorAccounts() {
  const [accounts, setAccounts] = useState<CredentialRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');
  const [confirming, setConfirming] = useState<CredentialRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const body = await listAccounts();
      setAccounts(body.accounts);
    } catch (err) {
      setError(errorMessage(err));
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runTest = useCallback(async (account: CredentialRecord) => {
    setBusyId(account.id);
    setError('');
    setNotice('');
    try {
      const body = await testAccount(account.id);
      setNotice(`${body.account.label} · key ${body.metadata.apiKeyMasked ?? DASH} · health ${body.metadata.health} · account type ${body.metadata.accountType ?? DASH}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId('');
      await load();
    }
  }, [load]);

  const runDelete = useCallback(async (account: CredentialRecord) => {
    setBusyId(account.id);
    setError('');
    setNotice('');
    try {
      await deleteAccount(account.id);
      setNotice(`${account.label} revoked — its sealed key is destroyed and no execution can use it again`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId('');
      setConfirming(null);
      await load();
    }
  }, [load]);

  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ ...h3Style, margin: 0 }}>EXCHANGE ACCOUNTS · §87</h3>
        <Btn onClick={load} disabled={loading}>↻ Refresh</Btn>
        <span style={{ color: C.dim, fontSize: 10 }}>{loading ? 'loading…' : `${accounts.length} connected`}</span>
      </div>
      <ErrorBanner text={error} />
      {notice !== '' && <p style={{ color: C.accent, fontSize: 11, fontWeight: 700, margin: '0 0 8px' }}>✓ {notice}</p>}

      <Card>
        {accounts.length === 0 && !loading && <p style={noteStyle}>no accounts connected yet — add one below to size a trade</p>}
        {accounts.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Label</th>
                <th style={thStyle}>Exchange</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Key</th>
                <th style={thStyle}>Read</th>
                <th style={thStyle}>Spot</th>
                <th style={thStyle}>Futures</th>
                <th style={thStyle}>Withdraw</th>
                <th style={thStyle}>Last Sync</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td style={tdStyle}>{account.label}</td>
                  <td style={tdStyle}>{account.exchange}</td>
                  <td style={tdStyle}>
                    <StatusPill status={account.revokedAt === null ? account.health : 'REVOKED'} />
                  </td>
                  <td style={{ ...tdStyle, color: C.dim }}>{account.apiKeyMasked}</td>
                  <td style={tdStyle}><Perm value={account.permissions.read} /></td>
                  <td style={tdStyle}><Perm value={account.permissions.spotTrade} /></td>
                  <td style={tdStyle}><Perm value={account.permissions.futuresTrade} /></td>
                  <td style={tdStyle}>
                    <Perm value={account.permissions.withdraw} />
                    {account.permissions.withdraw === true && <span style={{ color: C.red, fontWeight: 700 }}> · remove it</span>}
                  </td>
                  <td style={{ ...tdStyle, color: C.dim }}>{formatAgo(account.lastUsedAt)}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Btn onClick={() => runTest(account)} disabled={busyId === account.id || account.revokedAt !== null}>Test</Btn>
                      <Btn onClick={() => setConfirming(account)} disabled={account.revokedAt !== null} tone="danger">Delete</Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {confirming !== null && (
        <Card style={{ borderColor: C.red }}>
          <h3 style={{ ...h3Style, color: C.red }}>REVOKE {confirming.label.toUpperCase()}?</h3>
          <p style={{ color: C.white, fontSize: 11, margin: '0 0 8px' }}>
            This destroys the sealed key for {confirming.exchange} ({confirming.apiKeyMasked}). Any execution that still
            needs it can no longer place or cancel orders through FUDCourt, and the secret cannot be recovered. It
            cannot be undone.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn onClick={() => setConfirming(null)} disabled={busyId === confirming.id}>Keep it</Btn>
            <Btn onClick={() => runDelete(confirming)} disabled={busyId === confirming.id} tone="danger">Revoke key</Btn>
          </div>
        </Card>
      )}

      <ConnectForm onConnected={load} />
    </>
  );
}

// ---------------------------------------------------------------------------
// ExecutorSettings — §88
// ---------------------------------------------------------------------------

export function ExecutorSettings() {
  const [profile, setProfile] = useState<RiskProfile>(DEFAULT_RISK_PROFILE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const body = await getSettings();
      setProfile(body.profile);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setNumber = useCallback((key: keyof RiskProfile) => (text: string) => {
    const value = Number(text);
    if (text.trim() !== '' && Number.isFinite(value)) setProfile((prev) => ({ ...prev, [key]: value }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const body = await putSettings(profile);
      setProfile(body.profile);
      setNotice('risk profile saved — every new execution is validated against it (PRD §88)');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [profile]);

  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ ...h3Style, margin: 0 }}>RISK SETTINGS · §88</h3>
        <Btn onClick={load} disabled={loading}>↻ Refresh</Btn>
        <Btn onClick={save} disabled={saving || loading} tone="primary">Save profile</Btn>
        <span style={{ color: C.dim, fontSize: 10 }}>{loading ? 'loading…' : ''}</span>
      </div>
      <ErrorBanner text={error} />
      {notice !== '' && <p style={{ color: C.accent, fontSize: 11, fontWeight: 700, margin: '0 0 8px' }}>✓ {notice}</p>}

      <Card>
        <div style={{ ...pairStyle }}>
          <Field label="Default risk mode">
            <Choice
              value={profile.defaultRiskMode}
              onChange={(defaultRiskMode) => setProfile((prev) => ({ ...prev, defaultRiskMode }))}
              options={[{ value: 'risk_percent', label: 'Risk % of basis' }, { value: 'risk_usd', label: 'Risk $' }]}
            />
          </Field>
          <Field label={profile.defaultRiskMode === 'risk_percent' ? 'Default risk (%)' : 'Default risk ($)'}>
            <Text value={String(profile.defaultRisk)} onChange={setNumber('defaultRisk')} type="number" />
          </Field>
          <Field label="Maximum risk / trade (%)">
            <Text value={String(profile.maxRiskPerTradePct)} onChange={setNumber('maxRiskPerTradePct')} type="number" />
          </Field>
          <Field label="Max total open risk (%)" hint="committed risk across all live executions, as a % of total exchange equity — a new opening that would exceed it is REFUSED, not resized">
            <Text value={String(profile.maxOpenRiskPct)} onChange={setNumber('maxOpenRiskPct')} type="number" />
          </Field>
          <Field label="Max daily loss (%)" hint="once today's realized P&L reaches -this, new openings are blocked; closing and reducing stay available">
            <Text value={String(profile.maxDailyLossPct)} onChange={setNumber('maxDailyLossPct')} type="number" />
          </Field>
          <Field label="Max leverage (x)">
            <Text value={String(profile.maxLeverage)} onChange={setNumber('maxLeverage')} type="number" />
          </Field>
          <Field label="Default margin mode">
            <Choice
              value={profile.defaultMarginMode}
              onChange={(defaultMarginMode) => setProfile((prev) => ({ ...prev, defaultMarginMode }))}
              options={[{ value: 'isolated', label: 'Isolated' }, { value: 'cross', label: 'Cross' }]}
            />
          </Field>
          <Field label="Default execution urgency">
            <Choice
              value={profile.defaultExecutionUrgency}
              onChange={(defaultExecutionUrgency) => setProfile((prev) => ({ ...prev, defaultExecutionUrgency }))}
              options={URGENCY_OPTIONS}
            />
          </Field>
        </div>
        <p style={noteStyle}>
          `maxRiskPerTradePct` and `maxLeverage` block a request that exceeds them at creation (PRD §79); the portfolio
          limits are stored for the later enforcement phase · per-account overrides are not available yet (PRD §88)
        </p>
      </Card>
    </>
  );
}
