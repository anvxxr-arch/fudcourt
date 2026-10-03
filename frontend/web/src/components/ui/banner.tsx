import { alpha, color, fontSize, radius, space } from '@/styles/tokens';

const HUE = {
  error: color.negative,
  warn: color.warn,
  info: color.textMuted,
  success: color.positive,
} as const;

type BannerProps = {
  children: React.ReactNode;
  variant?: keyof typeof HUE;
  style?: React.CSSProperties;
};

export function Banner({ children, variant = 'error', style }: BannerProps) {
  const hue = HUE[variant];
  return (
    <div
      style={{
        background: alpha(hue, 0.08),
        border: `1px solid ${alpha(hue, 0.35)}`,
        color: hue,
        padding: `${space[8]}px ${space[10]}px`,
        borderRadius: radius[6],
        fontSize: fontSize[12],
        ...style,
      }}
    >
      {children}
    </div>
  );
}
