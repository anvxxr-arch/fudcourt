import { color, fontSize, fontWeight, space } from '@/styles/tokens';

/**
 * One label/value line. A null value is rendered by the caller as the em
 * dash; the shapers never print a fake 0. `tone` colours the value only.
 */
export function Row({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  const toneColor = tone === 'good' ? color.blue : tone === 'bad' ? color.red : color.labelPrimary;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: space[8], padding: '3px 0', borderBottom: `1px solid ${color.separator}` }}>
      <span style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>{label}</span>
      <span style={{ color: toneColor, fontSize: fontSize[11], fontWeight: fontWeight.bold, textAlign: 'right' }}>{value}</span>
    </div>
  );
}
