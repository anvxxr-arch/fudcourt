import { space } from '@/styles/tokens';

/**
 * Measured default. Unit of measurement = ONE title+action row (a `justifyContent:
 * 'space-between'` row that contains a heading AND a button/link — the shape this atom is).
 * Only 3 exist in the tree; all 3 are `alignItems: 'center'`:
 *
 *   alignItems   center 3/3 (100%)   → default (this atom's own population, not the 34 generic
 *                                      space-between rows, which are dominated by cryptorank's
 *                                      sub-headers and are a different shape)
 *   marginBottom 12 2, 8 1           → FLAT (n=3) → no winner, so space[12] stays: it is the
 *                                      value 2 of the 3 use, and the third can say otherwise.
 *   gap / flexWrap: 2 of 3 unset → no default; pass them in `style` (which stays last).
 */
type ToolbarProps = { children: React.ReactNode; actions?: React.ReactNode; style?: React.CSSProperties };

export function Toolbar({ children, actions, style }: ToolbarProps) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[12], ...style }}>
      {children}
      {actions}
    </div>
  );
}
