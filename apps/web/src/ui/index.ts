/**
 * src/ui/index.ts — the design system's public API surface.
 *
 * ONE entry point. A consumer imports from `@/ui` and gets the foundations and the atoms;
 * nothing else is public. Internal paths (`@/ui/atoms/financial/format`) are implementation
 * detail and may move.
 *
 * DEPENDENCY DIRECTION (plan §5), enforced by the structure gate:
 *
 *   atoms -> foundations -> tokens
 *
 * No atom imports a feature, the route tree, server code or a business API. No atom performs
 * a network request. Atoms render the state they are handed.
 *
 * WHAT IS NOT HERE: Molecules, Organisms, Templates, Pages, AssetSelector, MarketSelector,
 * SearchField composition, FilterBar, TableToolbar, Pagination composition, OrderTicket,
 * OrderForm, RiskControl composition, PortfolioCard, MetricCard, MarketCard, PositionCard,
 * Watchlist, navigation composition, breadcrumb composition, Command Palette, modal
 * workflows, execution flows, feature redesigns, page redesigns. Those are later phases.
 */

// ---------------------------------------------------------------------------
// Foundations — the layer an atom reads and a page may compose directly.
// ---------------------------------------------------------------------------
export {
  // colour
  cssVar,
  primitive,
  resolve,
  semanticRoles,
  theme,
  themes,
  tint,
  type PrimitiveToken,
  type SemanticToken,
  type Theme,
  type TypeVariant,
  // typography
  monoVariants,
  numeric,
  sansVariants,
  tabular,
  typeScale,
  typeVariants,
  variant,
  variantClass,
  type TypeFamily,
  type TypeStyle,
  // spacing / radius / density / elevation
  defaultDensity,
  densityKeys,
  densityTokens,
  dims,
  elevationKeys,
  levels,
  radius,
  radiusKeys,
  rhythm,
  space,
  spaceKeys,
  type Density,
  type DensityDims,
  type ElevationLevel,
  type RadiusKey,
  type SpaceKey,
  // layout / grid
  breakpointKeys,
  breakpoints,
  editorialGrid,
  grids,
  gridTokens,
  mq,
  mqBelow,
  mqBetween,
  productGrid,
  workspaceGrid,
  type Breakpoint,
  type GridFamily,
  // motion
  motionTokens,
  presetClass,
  presetKeys,
  presets,
  reducedMotionQuery,
  type MotionPreset,
  type Preset,
  // accessibility
  contrastTargets,
  disabledClass,
  focusRing,
  focusRingClass,
  forcedBorderClass,
  keyboardKeys,
  livePoliteness,
  nonColorCues,
  srOnly,
  srOnlyClass,
  type LivePoliteness,
} from '@/ui/foundations';

// ---------------------------------------------------------------------------
// Atoms — typography
// ---------------------------------------------------------------------------
export type { Tone as TextTone } from '@/ui/atoms/typography';
export { Caption, Code, DataValue, Heading, Label, Text } from '@/ui/atoms/typography';

// ---------------------------------------------------------------------------
// Atoms — actions
// ---------------------------------------------------------------------------
export type { ButtonSize, ButtonVariant, Intensity } from '@/ui/atoms/actions';
export { Button, CopyButton, IconButton, Link } from '@/ui/atoms/actions';

// ---------------------------------------------------------------------------
// Atoms — form (generic)
// ---------------------------------------------------------------------------
export type { FieldSize, FieldState } from '@/ui/atoms/form';
export { Checkbox, Input, Radio, SelectTrigger, Slider, Switch, Textarea } from '@/ui/atoms/form';

// ---------------------------------------------------------------------------
// Atoms — visual
// ---------------------------------------------------------------------------
export type { IconComponent, IconSizeKey } from '@/ui/atoms/visual';
export { AssetIcon, Avatar, ChainIcon, Divider, Icon, Scrim, Surface } from '@/ui/atoms/visual';

// ---------------------------------------------------------------------------
// Atoms — status
// ---------------------------------------------------------------------------
export type { Tone as StatusTone } from '@/ui/atoms/status';
export { Badge, Progress, Skeleton, Spinner, StatusDot, Tag } from '@/ui/atoms/status';

// ---------------------------------------------------------------------------
// Atoms — financial
// ---------------------------------------------------------------------------
export type { DataSize, FinancialState } from '@/ui/atoms/financial';
export {
  APR,
  APY,
  Currency,
  DataNumber,
  Delta,
  MarketCap,
  Percentage,
  PnL,
  Price,
  Quantity,
  Ratio,
  Volume,
  Yield,
} from '@/ui/atoms/financial';

// The formatting core, re-exported so a consumer has one import for both layers.
export type { FormatOptions, LocaleStrategy } from '@/ui/atoms/financial/format';
export {
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

// ---------------------------------------------------------------------------
// Atoms — market
// ---------------------------------------------------------------------------
export type { MarketState, Timeframe as TimeframeValue } from '@/ui/atoms/market';
export {
  AssetPair,
  AssetSymbol,
  Confidence,
  MarketStatus,
  Timeframe,
  Trend,
  TIMEFRAMES,
  confidenceBand,
} from '@/ui/atoms/market';

// ---------------------------------------------------------------------------
// Atoms — blockchain
// ---------------------------------------------------------------------------
export { BlockNumber, GasValue, TransactionHash, WalletAddress } from '@/ui/atoms/blockchain';

// ---------------------------------------------------------------------------
// Atoms — system
// ---------------------------------------------------------------------------
export type { HealthState } from '@/ui/atoms/system';
export {
  CHILD_STATUS,
  ChildOrderStatus,
  Duration,
  ExecutionStatus,
  EXECUTION_STATUS,
  HealthStatus,
  Latency,
  Timestamp,
  latencyBand,
} from '@/ui/atoms/system';

// ---------------------------------------------------------------------------
// Atoms — table
// ---------------------------------------------------------------------------
export type { CellKind, CellState, RowState } from '@/ui/atoms/table';
export {
  ColumnHeader,
  ResizeHandle,
  RowSelector,
  SortIndicator,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHeader,
  TableRow,
} from '@/ui/atoms/table';

// ---------------------------------------------------------------------------
// Atoms — visualization
// ---------------------------------------------------------------------------
export type { LegendEntry, SeriesKind, SparklineSize } from '@/ui/atoms/visualization';
export {
  CATEGORICAL,
  ChartAnnotation,
  ChartAxis,
  ChartCursor,
  ChartGrid,
  ChartLabel,
  ChartLegend,
  ChartMarker,
  ChartReferenceArea,
  ChartReferenceLine,
  ChartSeriesIndicator,
  ChartTooltip,
  SERIES_STYLE,
  Sparkline,
  seriesColor,
} from '@/ui/atoms/visualization';

// ---------------------------------------------------------------------------
// Atoms — layout
// ---------------------------------------------------------------------------
export {
  Cluster,
  Container,
  Grid,
  GridItem,
  Inline,
  ScrollArea,
  Spacer,
  Stack,
  StickyRegion,
} from '@/ui/atoms/layout';
