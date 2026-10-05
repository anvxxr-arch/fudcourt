import { color } from '@/styles/tokens';

/** The project's single spelling of "the upstream published nothing". */
const NO_VALUE = '—';

/**
 * Tri-state venue permission: `null` means the venue does not report it.
 * A stated `true` is the accent hue; a stated `false` (or an unreported flag)
 * reads muted — a missing capability is a limitation, not a failure.
 */
export function Perm({ value }: { value: boolean | null }) {
  if (value === null) {
    return <span style={{ color: color.labelTertiary }} title="the venue does not report this flag">{NO_VALUE}</span>;
  }
  return <span style={{ color: value ? color.blue : color.labelTertiary }}>{value ? '✓' : '✕'}</span>;
}
