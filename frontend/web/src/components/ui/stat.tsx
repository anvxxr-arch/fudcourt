import { color, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';

const TONE = {
  neutral: color.accent,
  positive: color.positive,
  negative: color.negative,
} as const;

/**
 * The label/value/hint KPI card. Defaults match the dashboard's NET WORTH card
 * (label muted 12/wider, value `fontSize[24]` accent/bold, surface + border, radius[8],
 * padding `space[12]`). The repeated KPI tiles (chainrank, llama) are the SAME shape at
 * `padding: '8px 10px'` / label `fontSize[9]` uppercase `letterSpacing.xs` / value
 * `fontSize[16]` `fontWeight.heavy` — they were deliberately NOT pinned as defaults
 * because the NET WORTH card is the canonical 24px display figure; a tile adoption
 * passes `valueSize={fontSize[16]}` and `style={{ padding: `${space[8]}px ${space[10]}px` }}`,
 * and the uppercasing/weight styling stays caller-owned. There is no `labelStyle` prop:
 * the label is drawn twice in the tree and its exact treatment differs, so minting a
 * prop for it would freeze the wrong default.
 */
type StatProps = {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: keyof typeof TONE;
  /**
   * Any `fontSize` token key, not a raw px: `Stat` is a token-consumer and the gate
   * forbids a numeric literal reaching `fontSize`. The default is the NET WORTH
   * display figure; the repeated KPI tiles pass `fontSize[16]` (`fontWeight.heavy`,
   * padding `8px 10px`). See `Stat`'s doc for why the tiles are not pixel-identical.
   */
  valueSize?: number;
  style?: React.CSSProperties;
};

export function Stat({ label, value, hint, tone = 'neutral', valueSize = fontSize[24], style }: StatProps) {
  return (
    <div
      style={{
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius[8],
        padding: space[12],
        ...style,
      }}
    >
      <div style={{ color: color.textMuted, fontSize: fontSize[12], letterSpacing: letterSpacing.wide }}>{label}</div>
      <div style={{ color: TONE[tone], fontSize: valueSize, fontWeight: fontWeight.bold }}>{value}</div>
      {hint != null && <div style={{ color: color.textMuted, fontSize: fontSize[12], marginTop: space[6] }}>{hint}</div>}
    </div>
  );
}
