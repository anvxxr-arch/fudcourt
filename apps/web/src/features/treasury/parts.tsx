'use client';

import { themeColor, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';

/**
 * parts.tsx — the small presentational primitives the treasury family shares.
 * Extracted so the time machine and the leaderboard render a selector and a
 * table cell identically rather than each growing its own near-copy.
 */

/**
 * A segmented control: one row of mutually exclusive buttons. Used for every
 * selector in the family so the range, the grouping, the breakdown dimension
 * and the leaderboard metric all read as one kind of choice.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { key: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: space[8], flexWrap: 'wrap' }}>
      <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], letterSpacing: letterSpacing.xs, textTransform: 'uppercase' }}>{label}</span>
      <div style={{ display: 'flex', gap: space[4], border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: 2 }}>
        {options.map((o) => (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            style={{
              background: value === o.key ? themeColor.blue : 'transparent',
              color: value === o.key ? themeColor.labelOnAccent : themeColor.labelSecondary,
              border: 'none',
              padding: `${space[4]}px ${space[8]}px`,
              borderRadius: radius[8],
              cursor: 'pointer',
              fontSize: fontSize[11],
              fontWeight: value === o.key ? fontWeight.semibold : fontWeight.regular,
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      style={{
        textAlign: right ? 'right' : 'left',
        color: themeColor.labelTertiary,
        fontSize: fontSize[11],
        fontWeight: fontWeight.medium,
        padding: `${space[8]}px ${space[8]}px`,
        borderBottom: `1px solid ${themeColor.separator}`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  );
}

export function Td({ children, right, color }: { children: React.ReactNode; right?: boolean; color?: string }) {
  return (
    <td
      style={{
        textAlign: right ? 'right' : 'left',
        color: color ?? themeColor.labelPrimary,
        fontSize: fontSize[12],
        padding: `${space[8]}px ${space[8]}px`,
        borderBottom: `1px solid ${themeColor.separator}`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </td>
  );
}

/** A titled board: the card the family's tables live in. */
export function Board({ title, right, children }: { title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: themeColor.bgBase, border: `1px solid ${themeColor.separator}`, borderRadius: radius[12], padding: space[12] }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: space[8], marginBottom: space[8] }}>
        <div style={{ color: themeColor.blue, fontSize: fontSize[13], fontWeight: fontWeight.semibold }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

/**
 * A single figure. `sub` carries the qualifier (a timestamp, a window) so a
 * headline number is never read without its context.
 */
export function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: space[12], minWidth: 132 }}>
      <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], letterSpacing: letterSpacing.xs, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ color: color ?? themeColor.labelPrimary, fontSize: fontSize[20], fontWeight: fontWeight.bold, marginTop: space[4] }}>{value}</div>
      {sub && <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: space[4] }}>{sub}</div>}
    </div>
  );
}

/**
 * A two-segment split bar. Widths are the two effects' shares of their combined
 * magnitude, so the split is legible at a glance; the SIGN never lives here —
 * it stays in the numeric columns either side, because a bar cannot honestly
 * show a signed sum.
 */
export function SplitBar({ left, right }: { left: number; right: number }) {
  const total = Math.abs(left) + Math.abs(right);
  if (total === 0) {
    return <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>—</span>;
  }
  const leftPct = (Math.abs(left) / total) * 100;
  return (
    <div
      style={{ display: 'flex', height: 6, minWidth: 64, borderRadius: radius[8], overflow: 'hidden', background: themeColor.bgTertiary }}
      role="img"
      aria-label={`market ${leftPct.toFixed(0)}%, book ${(100 - leftPct).toFixed(0)}%`}
    >
      <div style={{ width: `${leftPct}%`, background: themeColor.blue }} />
      <div style={{ width: `${100 - leftPct}%`, background: themeColor.orange }} />
    </div>
  );
}
