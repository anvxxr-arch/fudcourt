import type { ReactNode } from 'react';
import { themeColor, fontSize, fontWeight, letterSpacing, space } from '@/styles/tokens';

/**
 * The one label/value pair. Supersedes the two private copies (economy's
 * numeric `Value` and trade's ReactNode `Value`), which were the same shape:
 * a muted uppercase label over a semibold value, with an optional hint.
 * Trade's `tone` maps to the tone vocabulary below; the missing-value rule
 * stays caller-owned — the caller passes the already-formatted em dash (and
 * `tone="muted"` when the value is absent) so a null never prints as zero.
 */
const TONE = {
  default: themeColor.labelPrimary,
  positive: themeColor.green,
  negative: themeColor.red,
  muted: themeColor.labelTertiary,
} as const;

type ValueProps = {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: keyof typeof TONE;
  /** A trailing unit (economy's `%`, `pp`), rendered muted at caption size. */
  unit?: string;
};

export function Value({ label, value, hint, tone = 'default', unit }: ValueProps) {
  return (
    <div title={hint} style={{ display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 0 }}>
      <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, letterSpacing: letterSpacing.sm, textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: fontSize[17], fontWeight: fontWeight.semibold, color: TONE[tone], fontFamily: 'inherit' }}>
        {value}
        {unit ? <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, marginLeft: space[4] }}>{unit}</span> : null}
      </span>
    </div>
  );
}
