import { themeColor, fontSize, fontWeight, space } from '@/styles/tokens';

/**
 * One label/value line. A null value is rendered by the caller as the em
 * dash; the shapers never print a fake 0. `tone` colours the value only.
 */
export function Row({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'pos' | 'neg' }) {
  const toneColor =
    tone === 'good' ? themeColor.blue : tone === 'bad' ? themeColor.red : tone === 'pos' ? themeColor.green : tone === 'neg' ? themeColor.red : themeColor.labelPrimary;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: space[8], padding: '3px 0', borderBottom: `1px solid ${themeColor.separator}` }}>
      <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>{label}</span>
      <span style={{ color: toneColor, fontSize: fontSize[11], fontWeight: fontWeight.bold, textAlign: 'right' }}>{value}</span>
    </div>
  );
}
