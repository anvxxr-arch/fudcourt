/**
 * foundations/spacing.ts — spacing, radius, density and elevation as typed data.
 *
 * All four are frozen by the spec (§5–§8). The point of this module is that a component
 * reads a NAMED dimension rather than picking a pixel value: `space[4]` is 16px, and a
 * component that wants 16px says so in the vocabulary the scale defines.
 *
 * DENSITY IS A DIMENSION PROVIDER, NOT A COMPONENT FORK. There are no
 * `CompactTable`/`DefaultTable`/`ComfortableTable` implementations — a component takes a
 * `density` prop and reads the row height, control height and gap from `dims()`.
 *
 * ELEVATION IS BORDER-FIRST. Only two of the five levels carry a shadow; a normal
 * card/panel carries none and gets its hierarchy from surface + border + spacing.
 *
 * Leaf module: imports only `@/styles/tokens`. No JSX, no React.
 */
import { density, elevation, fcRadius, fcSpace } from '@/styles/tokens';

/** A spacing scale key. */
export type SpaceKey = keyof typeof fcSpace;
/** A radius scale key. */
export type RadiusKey = keyof typeof fcRadius;
/** A density contract. */
export type Density = keyof typeof density.row;
/** An elevation level. */
export type ElevationLevel = keyof typeof elevation;

/** The 8pt-first spacing scale, px values. */
export const space = fcSpace;

/** The spacing keys, in declaration order. */
export const spaceKeys: readonly SpaceKey[] = Object.keys(fcSpace) as SpaceKey[];

/** The primary layout rhythm: 8, 16, 24, 32, 48, 64. */
export const rhythm: readonly SpaceKey[] = ['space-2', 'space-4', 'space-6', 'space-8', 'space-12', 'space-16'];

/** The soft institutional radius scale, px values. */
export const radius = fcRadius;

/** The radius keys, in declaration order. */
export const radiusKeys: readonly RadiusKey[] = Object.keys(fcRadius) as RadiusKey[];

/** The elevation levels. `0`/`1`/`2` carry no shadow by design. */
export const levels = elevation;

/** The elevation level names, in declaration order. */
export const elevationKeys: readonly ElevationLevel[] = Object.keys(elevation) as ElevationLevel[];

/** The density contracts. */
export const densityTokens = density;

/** The density contract names. */
export const densityKeys: readonly Density[] = Object.keys(density.row) as Density[];

/** The resolved dimensions for one density contract. */
export interface DensityDims {
  /** A control's height (button, input, select trigger). */
  control: number;
  /** A table row's height. */
  row: number;
  /** A form field's height. */
  field: number;
  /** The gap between stacked items. */
  gap: number;
  /** A container's internal padding. */
  pad: number;
}

/**
 * The dimensions one density contract implies.
 *
 * A component reads these instead of forking itself: `<Table density="compact" />` is one
 * implementation that reads `dims('compact').row`, not three tables.
 */
export const dims = (d: Density): DensityDims => ({
  control: density.control[d],
  row: density.row[d],
  field: density.field[d],
  gap: density.gap[d],
  pad: density.pad[d],
});

/** The default density. FUDCourt ships balanced. */
export const defaultDensity: Density = 'default';
