import type { ReactNode } from 'react';
import { color, fontSize, space } from '@/styles/tokens';
import { Label } from '@/ui/primitives';

/**
 * A labelled form row. `hint` states the rule the field enforces, so a limit
 * the engine actually blocks is never mistaken for a stored preference.
 */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
      {hint && <div style={{ fontSize: fontSize[11], color: color.labelTertiary, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}
