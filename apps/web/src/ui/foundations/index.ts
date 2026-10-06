/**
 * foundations/index.ts — the design-system foundation layer's public surface.
 *
 * Dependency direction (plan §5):
 *
 *   atoms → foundations → tokens
 *
 * A foundation module imports only `@/styles/tokens` and its siblings here. Nothing in this
 * layer imports React, a feature, the route tree, or server code — it is pure data plus pure
 * functions, which is what makes it testable without a DOM and reusable from a server
 * component.
 */
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
} from './color';

export {
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
} from './typography';

export {
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
} from './spacing';

export {
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
} from './layout';

export {
  motionTokens,
  presetClass,
  presetKeys,
  presets,
  reducedMotionQuery,
  type MotionPreset,
  type Preset,
} from './motion';

export {
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
} from './accessibility';
