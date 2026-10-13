import { alpha, marketRamp, themeColor, fontSize, radius, space } from '@/styles/tokens';

type EmptyStateProps = { children: React.ReactNode; style?: React.CSSProperties };
export function EmptyState({ children, style }: EmptyStateProps) {
  return (
    <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[12], padding: `${space[20]}px 0`, textAlign: 'center', ...style }}>
      {children}
    </div>
  );
}

/**
 * The loading state, announced to assistive tech.
 *
 * `role="status"` + `aria-live="polite"` is what makes the swap audible: a
 * client component that mounts on a fetch boundary and later replaces this with
 * rows produces NO announcement for a screen reader without a live region, so
 * the user is left on a surface that silently changed. `polite` (not
 * `assertive`) because a board arriving is not an error and must not interrupt
 * mid-sentence — the same rule `foundations/accessibility.ts` sets for live
 * financial values.
 *
 * `aria-busy` is set on the same node so the region reports that it is still
 * pending and suppresses intermediate renders. This is the ONE place the
 * pattern needs to live: 49 boards render `Loading`, so the fix propagates
 * without touching any caller.
 */
export function Loading({ label, what }: { label?: string; what?: string }) {
  const text = label ?? (what ? `Loading ${what}…` : 'Loading…');
  return (
    <p role="status" aria-live="polite" aria-busy="true" style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>
      {text}
    </p>
  );
}

/**
 * The module's error panel: a red tint banner with the title and optional
 * detail. Carries `role="alert"` so a failed read is announced the moment it
 * renders — an error a user cannot see is an error they will attribute to the
 * board being empty, which is the misread the never-fake doctrine exists to
 * prevent. `alert` (not `status`) is correct here: this IS the interruption.
 */
export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div role="alert" style={{ background: alpha(themeColor.red, 0.08), border: `1px solid ${alpha(themeColor.red, 0.4)}`, borderRadius: radius[8], padding: `${space[12]}px ${space[12]}px`, color: themeColor.labelPrimary }}>
      <strong style={{ color: themeColor.labelPrimary }}>{title}</strong>
      {detail ? <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[12], color: themeColor.labelTertiary }}>{detail}</p> : null}
    </div>
  );
}

/** A compact age label for a stale read: "45s", "12m", "2h 13m". */
function ageLabel(ageSec: number): string {
  if (ageSec < 60) return `${ageSec}s`;
  const m = Math.floor(ageSec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The stale-read banner: the upstream is refusing, so the board is showing its
 * LAST GOOD read. The label is mandatory — a stale figure presented as current
 * is the fabrication the never-fake rule exists to prevent. The sidecar sets
 * `stale`/`staleAgeSec` on the envelope; this renders them.
 */
export function StaleNotice({ source, fetchedAt, ageSec }: { source: string; fetchedAt: number; ageSec: number }) {
  const at = `${new Date(fetchedAt * 1000).toISOString().slice(11, 16)} UTC`;
  return (
    <div
      style={{
        background: alpha(marketRamp['warning-muted'], 0.08),
        border: `1px solid ${alpha(marketRamp['warning-muted'], 0.4)}`,
        borderRadius: radius[8],
        padding: space[12],
        color: themeColor.labelPrimary,
      }}
    >
      <strong style={{ color: themeColor.labelPrimary }}>
        {source} upstream is refusing requests — showing the last good read
      </strong>
      <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[12], color: themeColor.labelTertiary }}>
        fetched {at} · {ageLabel(ageSec)} old · a stale figure is labelled here, never presented as current
      </p>
    </div>
  );
}
