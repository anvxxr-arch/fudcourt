import { color, fontSize } from '@/styles/tokens';

/** The project's single spelling of "the upstream published nothing". */
const NO_VALUE = '—';

/**
 * A tiny inline sparkline. Renders nothing (not a flat line) when there is no
 * trend: fewer than two finite points prints the em dash.
 */
export function Sparkline({ points, width = 120, height = 28 }: { points: (number | null)[]; width?: number; height?: number }) {
  const vals = points.filter((p): p is number => p !== null && Number.isFinite(p));
  if (vals.length < 2) return <span style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>{NO_VALUE}</span>;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = width / (vals.length - 1);
  const path = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg width={width} height={height} role="img" aria-label={`trend ${up ? 'up' : 'down'}`} style={{ display: 'block' }}>
      <path d={path} fill="none" stroke={up ? color.green : color.red} strokeWidth={1.5} />
    </svg>
  );
}
