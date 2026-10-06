/**
 * ui-shared.tsx — styles + scalar helpers shared by the executor panels.
 * Split from ui.tsx; imported by ui-composer/ui-progress/ui-manage.
 */
import type { CSSProperties } from 'react';
import { color, fontSize, fontWeight, letterSpacing, space } from '@/styles/tokens';
// `num` lives in `@/lib/num` — the executor panels and the trade composer share
// it. Re-exported here so existing `./ui-shared` importers keep working.
import { num } from '@/lib/num';
export { num };

export const pairStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space[8] };
export const h3Style: CSSProperties = { color: color.blue, fontSize: fontSize[12], fontWeight: fontWeight.bold, margin: `0 0 ${space[8]}px`, letterSpacing: letterSpacing.wide };
export const noteStyle: CSSProperties = { color: color.labelTertiary, fontSize: fontSize[11], margin: `${space[4]}px 0 0` };
export const thStyle: CSSProperties = { textAlign: 'left', padding: '5px 6px', color: color.labelTertiary, fontSize: fontSize[11], borderBottom: `1px solid ${color.separator}` };
export const tdStyle: CSSProperties = { padding: '5px 6px', fontSize: fontSize[11], borderBottom: `1px solid ${color.separator}` };

/** Minutes in a text field to whole milliseconds (`30` → `1800000`). */
export function minutesToMs(text: string): number | undefined {
  const minutes = num(text);
  return minutes === undefined ? undefined : Math.round(minutes * 60_000);
}

/** A difference of two returned numbers — the only arithmetic this UI performs. */
export function diff(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}
