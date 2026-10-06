import { color, letterSpacing } from '@/styles/tokens';

/**
 * An importance rating out of three: filled dots in the warn hue, the rest in
 * the separator colour. The label states the level for a screen reader, since
 * the dots are a colour/shape-only signal.
 */
export function ImportanceDots({ level }: { level: number }) {
  return (
    <span aria-label={`importance ${level} of 3`} style={{ color: color.orange, letterSpacing: letterSpacing.none }}>
      {'●'.repeat(Math.max(0, Math.min(3, level)))}
      <span style={{ color: color.separator }}>{'●'.repeat(Math.max(0, 3 - level))}</span>
    </span>
  );
}
