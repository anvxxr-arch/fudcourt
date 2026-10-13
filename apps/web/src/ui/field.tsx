'use client';

import { cloneElement, isValidElement, useId, type ReactNode } from 'react';
import { themeColor, fontSize, space } from '@/styles/tokens';
import { Label } from '@/ui/primitives';

/**
 * A labelled form row. `hint` states the rule the field enforces, so a limit
 * the engine actually blocks is never mistaken for a stored preference.
 *
 * The `<Label>` is tied to the control: the field's `useId` is stamped onto the
 * single element child (as `id`) and onto the label (as `htmlFor`), so a screen
 * reader announces "Stop loss" when the input is focused. Before this the label
 * was visual only — `Label` rendered a bare `<label>` with no `htmlFor`, which
 * made every `<Field>`- and `<Label>`-labelled control in the app unlabelled to
 * assistive tech (measured: 0 `htmlFor` attributes tree-wide).
 *
 * The child must be a single element that accepts `id` — every current caller
 * passes one `<Input>`/`<Select>`/`<textarea>`. A caller that passes a bare
 * string or a fragment throws here rather than rendering a silent, unlabelled
 * field: the failure is the whole point, and a compile-time-accepted misuse
 * would put it back out of sight.
 */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  if (!isValidElement(children)) {
    throw new Error(`<Field label="${label}"> needs a single element child it can give an id to`);
  }
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {cloneElement(children as React.ReactElement<{ id?: string }>, { id })}
      {hint && <div style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}
