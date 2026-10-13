import { alpha, themeColor, fontSize, radius, space } from '@/styles/tokens';

const HUE = {
  error: themeColor.red,
  warn: themeColor.orange,
  info: themeColor.labelTertiary,
  success: themeColor.green,
} as const;

type BannerProps = {
  children: React.ReactNode;
  variant?: keyof typeof HUE;
  style?: React.CSSProperties;
  /**
   * How this banner is announced. `alert` (assertive) is the default because
   * every existing call site renders a Banner to report something the reader
   * must not miss — a failed sync, a refused mutation, a stale read — and an
   * unannounced failure is indistinguishable from a quiet success for anyone
   * not looking at that part of the page. Pass `'none'` for a purely decorative
   * tint, or `'status'` for an advisory that may wait its turn.
   */
  live?: 'alert' | 'status' | 'none';
};

export function Banner({ children, variant = 'error', style, live = 'alert' }: BannerProps) {
  const hue = HUE[variant];
  return (
    <div
      role={live === 'alert' ? 'alert' : live === 'status' ? 'status' : undefined}
      aria-live={live === 'alert' ? 'assertive' : live === 'status' ? 'polite' : undefined}
      style={{
        background: alpha(hue, 0.08),
        border: `1px solid ${alpha(hue, 0.35)}`,
        color: hue,
        padding: `${space[8]}px ${space[8]}px`,
        borderRadius: radius[10],
        fontSize: fontSize[12],
        ...style,
      }}
    >
      {children}
    </div>
  );
}
