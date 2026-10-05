import { color, fontSize, fontWeight } from '@/styles/tokens';

/** The project's single spelling of "the upstream published nothing". */
const NO_VALUE = '—';

/**
 * A signed change chip; a null change prints the em dash, not a flat zero.
 *
 * The prop is ALREADY IN PERCENT — callers pass ccxt's `percentage` field
 * directly. There is no x100 here on purpose: doing so printed +138.87%
 * for a +1.39% move.
 */
export function ChangeChip({ percent }: { percent: number | null }) {
  if (percent === null || !Number.isFinite(percent)) {
    return <span style={{ color: color.labelTertiary, fontSize: fontSize[12] }}>{NO_VALUE}</span>;
  }
  const up = percent >= 0;
  return (
    <span style={{ color: up ? color.green : color.red, fontSize: fontSize[12], fontWeight: fontWeight.medium }}>
      {up ? '▲' : '▼'} {Math.abs(percent).toFixed(2)}%
    </span>
  );
}
