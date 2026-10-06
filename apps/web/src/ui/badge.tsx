import { alpha, themeColor, fontSize, radius, space } from '@/styles/tokens';

const HUE = {
  accent: themeColor.blue,
  positive: themeColor.green,
  negative: themeColor.red,
  warn: themeColor.orange,
  attention: themeColor.orange,
  muted: themeColor.labelTertiary,
  neutral: themeColor.labelTertiary,
} as const;

const SIZE = {
  // No 2/3 step exists in `space` (and the token spec forbids minting one), so the
  // chip insets stay the literals the existing badges already use.
  sm: { fontSize: fontSize[11], padding: '2px 6px' },
  md: { fontSize: fontSize[11], padding: '3px 8px' },
} as const;

type BadgeProps = {
  children: React.ReactNode;
  variant?: keyof typeof HUE;
  size?: keyof typeof SIZE;
  style?: React.CSSProperties;
};

export function Badge({ children, variant = 'accent', size = 'md', style }: BadgeProps) {
  const hue = HUE[variant];
  return (
    <span
      style={{
        color: hue,
        background: alpha(hue, 0.08),
        border: `1px solid ${alpha(hue, 0.35)}`,
        borderRadius: radius[8],
        fontSize: SIZE[size].fontSize,
        padding: SIZE[size].padding,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
