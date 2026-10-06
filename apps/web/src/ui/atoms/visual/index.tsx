/**
 * atoms/visual — Icon, AssetIcon, ChainIcon, Avatar, Divider, Surface, Scrim.
 *
 * The icon system: no icon library is installed in this repo, and the plan forbids adding a
 * dependency merely for one atom. So `Icon` takes a Lucide-style component reference (a
 * `({ size, strokeWidth, className }) => JSX` function) and renders it at a token size with
 * the Lucide outline defaults. A caller that later adopts `lucide-react` passes its icons
 * straight in — the API is already the shape that library uses.
 *
 * NO NETWORK FETCHING. `AssetIcon`, `ChainIcon` and `Avatar` render only the asset they are
 * handed: a supplied URL, a supplied glyph, or the fallback. They never resolve a symbol to a
 * logo, never call an explorer, never read a registry.
 */
import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import { cssVar, type SemanticToken } from '@/ui/foundations/color';
import { iconSize } from '@/styles/tokens';

/** A Lucide-style icon component: the shape `lucide-react` exports. */
export type IconComponent = (props: { size?: number | string; strokeWidth?: number; className?: string; 'aria-hidden'?: boolean }) => ReactNode;

/** The controlled tone union. Never an arbitrary colour string. */
export type Tone = 'neutral' | 'brand' | 'positive' | 'negative' | 'warning' | 'info';

/** The semantic role each tone resolves to. */
const TONE_ROLE: Record<Tone, SemanticToken> = {
  neutral: 'text-secondary',
  brand: 'brand-critical',
  positive: 'positive-critical',
  negative: 'negative-critical',
  warning: 'warning-critical',
  info: 'info-critical',
};

const cx = (...parts: (string | undefined | false)[]): string => parts.filter(Boolean).join(' ');

/** An icon size key from the approved scale. */
export type IconSizeKey = keyof typeof iconSize;

type IconProps = {
  /** The icon component to render. Lucide-style. */
  as: IconComponent;
  size?: IconSizeKey | number;
  tone?: Tone;
  className?: string;
  style?: CSSProperties;
  theme?: 'light' | 'dark';
  /**
   * Accessible name. Omit for a decorative icon (it is then hidden from the accessibility
   * tree); supply it when the icon is the only thing conveying the meaning.
   */
  label?: string;
};

/**
 * Icon — a Lucide-style outline glyph at a token size.
 *
 * Default size is `icon-md` (16px), inside the plan's 16–20px default application range.
 * Stroke is 1.75px, inside the approved 1.5–2px band, with round caps and joins.
 */
export const Icon = forwardRef<HTMLSpanElement, IconProps>(function Icon(
  { as: Glyph, size = 'icon-md', tone = 'neutral', className, style, theme = 'light', label },
  ref,
) {
  const px = typeof size === 'number' ? size : iconSize[size];
  return (
    <span
      ref={ref}
      className={cx('fc-icon', className)}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: cssVar(TONE_ROLE[tone]), ...style }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <Glyph size={px} strokeWidth={1.75} className="fc-icon-glyph" aria-hidden={true} />
    </span>
  );
});

type AssetIconProps = {
  /** The asset's image URL. When absent the fallback renders. */
  src?: string | null;
  /** The asset's ticker, used for the fallback initial and the accessible name. */
  symbol: string;
  /** An explicit accessible name; defaults to the symbol. */
  name?: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * AssetIcon — an asset's logo, or its ticker initial when there is no logo.
 *
 * Renders only what it is handed. It does not resolve a symbol to a logo URL, does not call a
 * provider, and does not read a registry — that is a Molecule's job and the plan puts it out
 * of scope. A caller that has a URL passes it; a caller that does not gets the fallback.
 */
export const AssetIcon = forwardRef<HTMLSpanElement, AssetIconProps>(function AssetIcon(
  { src, symbol, name, size = 24, className, style, theme = 'light' },
  ref,
) {
  const label = name ?? symbol;
  const initial = (symbol || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      ref={ref}
      className={cx('fc-asset-icon', className)}
      role="img"
      aria-label={label}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flex: '0 0 auto',
        borderRadius: 'var(--fc-radius-full)',
        overflow: 'hidden',
        background: cssVar('surface-secondary'),
        border: `1px solid ${cssVar('border-subtle')}`,
        fontSize: Math.max(10, Math.round(size * 0.44)),
        fontWeight: 600,
        color: cssVar('text-secondary'),
        ...style,
      }}
    >
      {src ? <img src={src} alt="" width={size} height={size} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }} /> : initial}
    </span>
  );
});

type ChainIconProps = {
  /** The chain's image URL. When absent the fallback renders. */
  src?: string | null;
  /** The chain's name, used for the fallback initial and the accessible name. */
  chain: string;
  name?: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * ChainIcon — a chain's logo, or its initial when there is no logo.
 *
 * Same contract as `AssetIcon`: supplied assets and fallbacks only, no RPC, no explorer API.
 * A chain's brand colour is DATA the caller owns (see `src/lib/format.ts`'s `CHAIN_COLOR`),
 * not a design token, so it is passed in rather than looked up here.
 */
export const ChainIcon = forwardRef<HTMLSpanElement, ChainIconProps>(function ChainIcon(
  { src, chain, name, size = 20, className, style, theme = 'light' },
  ref,
) {
  const label = name ?? chain;
  const initial = (chain || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      ref={ref}
      className={cx('fc-chain-icon', className)}
      role="img"
      aria-label={label}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flex: '0 0 auto',
        borderRadius: 'var(--fc-radius-full)',
        overflow: 'hidden',
        background: cssVar('surface-secondary'),
        border: `1px solid ${cssVar('border-subtle')}`,
        fontSize: Math.max(9, Math.round(size * 0.46)),
        fontWeight: 600,
        color: cssVar('text-secondary'),
        ...style,
      }}
    >
      {src ? <img src={src} alt="" width={size} height={size} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }} /> : initial}
    </span>
  );
});

type AvatarProps = {
  /** The subject's image URL. When absent the fallback renders. */
  src?: string | null;
  /** The accessible name — a person's name, a wallet's alias. */
  name: string;
  /** An explicit fallback glyph (an emoji, a single character). */
  fallback?: ReactNode;
  size?: number;
  className?: string;
  style?: CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Avatar — a subject's image, or a fallback derived from their name.
 *
 * `radius-full` is correct here (the plan names avatar explicitly). No fetching: the caller
 * supplies the URL or the fallback.
 */
export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { src, name, fallback, size = 32, className, style, theme = 'light' },
  ref,
) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      ref={ref}
      className={cx('fc-avatar', className)}
      role="img"
      aria-label={name}
      title={name}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flex: '0 0 auto',
        borderRadius: 'var(--fc-radius-full)',
        overflow: 'hidden',
        background: cssVar('surface-secondary'),
        border: `1px solid ${cssVar('border-subtle')}`,
        fontSize: Math.max(10, Math.round(size * 0.42)),
        fontWeight: 600,
        color: cssVar('text-secondary'),
        ...style,
      }}
    >
      {src ? <img src={src} alt="" width={size} height={size} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} /> : (fallback ?? initial)}
    </span>
  );
});

type DividerProps = {
  /** `horizontal` (default) or `vertical`. */
  orientation?: 'horizontal' | 'vertical';
  /** A label rendered inside the rule — turns it into a section separator. */
  label?: string;
  /** `subtle` is a hairline; `default` is the standard border role. */
  weight?: 'subtle' | 'default' | 'strong';
  className?: string;
  style?: CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Divider — a rule between regions.
 *
 * Border-first: the divider IS a border, not a shadow or a filled bar. `radius` is not
 * applied — a divider is a line.
 */
export const Divider = forwardRef<HTMLDivElement, DividerProps>(function Divider(
  { orientation = 'horizontal', label, weight = 'default', className, style, theme = 'light' },
  ref,
) {
  const role: SemanticToken = weight === 'subtle' ? 'border-subtle' : weight === 'strong' ? 'border-strong' : 'border-default';
  const color = cssVar(role);
  if (label && orientation === 'horizontal') {
    return (
      <div
        ref={ref}
        className={cx('fc-divider', 'fc-divider-labelled', className)}
        role="separator"
        aria-label={label}
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--fc-space-3)', color: cssVar('text-muted'), fontSize: 'var(--fc-type-label-sm-size)', fontWeight: 'var(--fc-type-label-sm-weight)', ...style }}
      >
        <span style={{ flex: 1, height: 1, background: color }} />
        <span>{label}</span>
        <span style={{ flex: 1, height: 1, background: color }} />
      </div>
    );
  }
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={orientation}
      className={cx('fc-divider', className)}
      style={
        orientation === 'horizontal'
          ? { width: '100%', height: 1, background: color, border: 0, flex: '0 0 auto', ...style }
          : { width: 1, alignSelf: 'stretch', background: color, border: 0, flex: '0 0 auto', ...style }
      }
    />
  );
});

type SurfaceProps = {
  children?: ReactNode;
  /**
   * The elevation level. `0` canvas, `1` surface, `2` raised, `3` floating, `4` overlay.
   * Levels 0–2 carry NO shadow — hierarchy comes from surface + border + spacing, which is
   * the plan's primary mechanism. Only 3 and 4 draw a shadow.
   */
  level?: '0' | '1' | '2' | '3' | '4';
  /** Which surface role to paint. Defaults to the level's natural role. */
  as?: 'background' | 'surface-primary' | 'surface-secondary' | 'surface-raised' | 'surface-overlay';
  bordered?: boolean;
  className?: string;
  style?: CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Surface — a container that establishes a hierarchy level.
 *
 * Border-first by construction: a level-1 surface gets a border and no shadow. The two
 * shadowed levels are `3` (popover) and `4` (dialog), and their shadows come from the
 * elevation tokens rather than a hand-written `box-shadow`.
 */
export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { children, level = '1', as, bordered = true, className, style, theme = 'light', ...rest },
  ref,
) {
  const role: SemanticToken = as ?? (level === '0' ? 'background' : level === '1' ? 'surface-primary' : level === '2' ? 'surface-raised' : 'surface-overlay');
  const shadow = level === '3' ? 'var(--fc-elevation-3)' : level === '4' ? 'var(--fc-elevation-4)' : 'none';
  return (
    <div
      ref={ref}
      className={cx('fc-surface', `fc-surface-${level}`, bordered && 'fc-forced-border', className)}
      style={{
        background: cssVar(role),
        border: bordered ? `1px solid ${cssVar(level === '0' ? 'border-subtle' : 'border-default')}` : 'none',
        borderRadius: 'var(--fc-radius-lg)',
        boxShadow: shadow,
        color: cssVar('text-primary'),
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
});

type ScrimProps = {
  children?: ReactNode;
  /** Clicking the scrim (not its children) fires this. */
  onDismiss?: () => void;
  className?: string;
  style?: CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Scrim — the dim layer behind a dialog.
 *
 * The plan pairs a dialog's subtle shadow with a scrim; this is that scrim. It is a real
 * `<button>`-less overlay with `role="presentation"` on the backdrop so a screen reader is
 * not offered a meaningless element, and the caller's dialog carries the semantics.
 */
export const Scrim = forwardRef<HTMLDivElement, ScrimProps>(function Scrim(
  { children, onDismiss, className, style, theme = 'light', ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx('fc-scrim', className)}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--fc-scrim)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // The app's modal layer, not a local stacking context: a scrim sits above every
        // surface and below nothing but a toast.
        zIndex: 'var(--fc-z-index-modal)',
        ...style,
      }}
      {...rest}
    >
      {onDismiss ? (
        <div
          aria-hidden="true"
          onClick={onDismiss}
          style={{ position: 'absolute', inset: 0, cursor: 'pointer' }}
        />
      ) : null}
      {children}
    </div>
  );
});
