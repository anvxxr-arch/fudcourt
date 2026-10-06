/**
 * ui-composer-build.ts — composer state (PRD §82, §83).
 * Split from ui-composer.tsx (verbatim); single source for ComposerState and
 * INITIAL. Pure builders live in ./ui-composer-builders and are re-exported
 * here so existing importers keep working unchanged. Re-exported through
 * ./ui-composer (and ./ui).
 */
import type {
  BalanceBasis,
  ExecutionMode,
  ExecutionStrategy,
  ExecutionUrgency,
  MarginMode,
  SizingMode,
} from '@/lib/executor';
import { EMPTY_ROW, type LevelRow } from './ui-composer-fields';
// composer state (PRD §82, §83)
// ---------------------------------------------------------------------------

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

export const INITIAL: ComposerState = {
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

export { buildExecution, buildRequest, entryIsLimit, missingRequired } from './ui-composer-builders';
