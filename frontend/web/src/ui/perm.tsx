import { color } from '@/styles/tokens';

/** The project's single spelling of "the upstream published nothing". */
const NO_VALUE = '—';

const TONE = {
  /** Executor's account-permission reading: a stated `false` is a denial (red). */
  risk: { yes: color.blue, no: color.red },
  /** Capability reading: `false` is a stated limitation, not a failure (muted). */
  capability: { yes: color.green, no: color.labelTertiary },
} as const;

/**
 * Tri-state boolean permission/capability: `null` means the source does not
 * report it, and prints the em dash rather than guessing.
 *
 * The two readings the tree actually uses stay distinguishable through `tone`,
 * so adopting this atom changes no rendered colour: the executor paints a
 * denied permission red (`risk`), while a capability matrix paints an absent
 * feature muted (`capability`).
 */
export function Perm({ value, tone = 'risk' }: { value: boolean | null; tone?: keyof typeof TONE }) {
  if (value === null) {
    return <span style={{ color: color.labelTertiary }} title="the source does not report this flag">{NO_VALUE}</span>;
  }
  return <span style={{ color: value ? TONE[tone].yes : TONE[tone].no }}>{value ? '✓' : '✕'}</span>;
}
