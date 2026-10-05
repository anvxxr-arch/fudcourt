import type { ReactNode } from 'react';
import { color, fontSize, lineHeight, radius, space } from '@/styles/tokens';

/**
 * A calm, non-error notice — the "nothing to do yet" state. A dashed-border
 * panel in the tertiary label colour, so it reads as an empty state rather
 * than a failure (a failure renders `Banner` variant="error").
 */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p style={{ margin: 0, padding: `${space[8]}px ${space[12]}px`, border: `1px dashed ${color.separator}`, borderRadius: radius[8], fontSize: fontSize[11], color: color.labelTertiary, lineHeight: lineHeight.normal }}>
      {children}
    </p>
  );
}
