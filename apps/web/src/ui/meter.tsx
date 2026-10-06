import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';

/**
 * Composition bar for part-to-whole data already in hand (asset allocation,
 * bucket composition, divergence columns). One stacked horizontal bar with
 * token-hued segments plus a legend; the caller passes raw segments and owns
 * the total. Values <= 0 are skipped so a zero bucket never paints a sliver.
 * Negative magnitudes still render (absolute value) — a divergence column is
 * about size, not sign; the sign belongs to the row's label/value text.
 */
const HUES = [color.blue, color.green, color.orange, color.red, color.labelSecondary, color.labelTertiary] as const;
export type MeterPart = { label: string; value: number; color?: string };
type MeterProps = {
  parts: MeterPart[];
  style?: React.CSSProperties;
};
export function Meter({ parts, style }: MeterProps) {
  const live = parts.filter((p) => Math.abs(p.value) > 0);
  const total = live.reduce((s, p) => s + Math.abs(p.value), 0);
  if (total <= 0) return null;
  return (
    <div className="fc-fade-in-slow" style={style}>
      <div
        role="img"
        aria-label={live.map((p) => `${p.label} ${Math.round((Math.abs(p.value) / total) * 100)}%`).join(', ')}
        style={{ display: 'flex', height: space[16], borderRadius: radius[8], overflow: 'hidden', border: `1px solid ${color.separator}` }}
      >
        {live.map((p, i) => (
          <div
            key={p.label}
            style={{ flexGrow: Math.abs(p.value), flexBasis: 0, background: p.color ?? HUES[i % HUES.length] }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${space[4]}px ${space[12]}px`, marginTop: space[8] }}>
        {live.map((p, i) => (
          <span key={p.label} style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>
            <span style={{ color: p.color ?? HUES[i % HUES.length], fontWeight: fontWeight.bold }}>■</span>{' '}
            {p.label} {Math.round((Math.abs(p.value) / total) * 100)}%
          </span>
        ))}
      </div>
    </div>
  );
}
