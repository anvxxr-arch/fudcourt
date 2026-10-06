/**
 * atoms/typography — Text, Heading, Label, Caption, Code, DataValue.
 *
 * Every atom here forwards its ref, extends `className`, consumes a semantic token (never a
 * primitive), and renders semantic HTML where that is the correct element. `Heading` takes an
 * `as` prop so the document outline is independent of the visual size — a section titled at
 * `size="lg"` inside a page whose `<h1>` is elsewhere is still an `<h2>`.
 *
 * House style: inline `style` objects with token values, matching the rest of `src/ui/`. No
 * class utility is introduced, so there is no second styling convention to keep in step.
 */
import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import { cssVar, type SemanticToken } from '@/ui/foundations/color';
import { variant, type TypeVariant } from '@/ui/foundations/typography';

/** The tone a text atom renders in. A controlled union — never an arbitrary colour string. */
export type Tone = 'default' | 'secondary' | 'muted' | 'inverse' | 'brand' | 'positive' | 'negative' | 'warning' | 'info';

/** The semantic colour role each tone resolves to. */
const TONE_ROLE: Record<Tone, SemanticToken> = {
  default: 'text-primary',
  secondary: 'text-secondary',
  muted: 'text-muted',
  inverse: 'text-inverse',
  brand: 'brand-critical',
  positive: 'positive-critical',
  negative: 'negative-critical',
  warning: 'warning-critical',
  info: 'info-critical',
};

/** A tone resolved to a CSS colour for one theme. */
const toneColor = (tone: Tone, theme: 'light' | 'dark'): string => cssVar(TONE_ROLE[tone]);

/** Merge a caller's className with the atom's own. */
const cx = (...parts: (string | undefined | false)[]): string => parts.filter(Boolean).join(' ');

type BaseProps = {
  children?: ReactNode;
  /** Extra classes. The atom's own styling is never replaced, only extended. */
  className?: string;
  style?: CSSProperties;
  /** Which theme's tokens to resolve. Defaults to light; a `.dark` subtree passes 'dark'. */
  theme?: 'light' | 'dark';
  /** Overrides the element's own colour. */
  tone?: Tone;
  /** The `id` for a label/description association. */
  id?: string;
  /** Accessible name when the visible text is not the whole story. */
  title?: string;
};

/**
 * Text — a paragraph or inline run of body copy.
 *
 * `size` picks a body variant; `tone` picks the colour. Renders a `<p>` by default and a
 * `<span>` when `inline` is set, so a sentence inside a label does not become a block.
 */
export const Text = forwardRef<HTMLParagraphElement, BaseProps & { size?: 'lg' | 'md' | 'sm'; inline?: boolean }>(
  function Text({ children, className, style, theme = 'light', tone = 'default', size = 'md', inline, id, title, ...rest }, ref) {
    const v = variant(`body-${size}` as TypeVariant);
    const Tag = (inline ? 'span' : 'p') as 'p';
    return (
      <Tag
        ref={ref}
        id={id}
        title={title}
        className={cx('fc-body-' + size, className)}
        style={{ ...v, margin: 0, color: toneColor(tone, theme), ...style }}
        {...rest}
      >
        {children}
      </Tag>
    );
  },
);

/**
 * Heading — a section title.
 *
 * `as` sets the semantic level; `size` sets the visual weight. They are independent on
 * purpose: the outline follows the document, the appearance follows the hierarchy.
 */
export const Heading = forwardRef<HTMLHeadingElement, BaseProps & { as?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'; size?: 'xl' | 'lg' | 'md' | 'sm' }>(
  function Heading({ children, className, style, theme = 'light', tone = 'default', as = 'h2', size = 'lg', id, title, ...rest }, ref) {
    const v = variant(`heading-${size}` as TypeVariant);
    const Tag = as;
    return (
      <Tag
        ref={ref}
        id={id}
        title={title}
        className={cx('fc-heading-' + size, className)}
        style={{ ...v, margin: 0, color: toneColor(tone, theme), ...style }}
        {...rest}
      >
        {children}
      </Tag>
    );
  },
);

/**
 * Label — the caption above a control or a table column.
 *
 * A `<label>` by default so it associates with a control through `htmlFor`; pass
 * `as="span"` for the non-interactive case (a table header, a metadata key).
 */
export const Label = forwardRef<HTMLLabelElement, BaseProps & { size?: 'lg' | 'md' | 'sm'; htmlFor?: string; as?: 'label' | 'span' }>(
  function Label({ children, className, style, theme = 'light', tone = 'secondary', size = 'md', htmlFor, as = 'label', id, title, ...rest }, ref) {
    const v = variant(`label-${size}` as TypeVariant);
    const Tag = as;
    return (
      <Tag
        ref={ref}
        id={id}
        title={title}
        htmlFor={as === 'label' ? htmlFor : undefined}
        className={cx('fc-label-' + size, className)}
        style={{ ...v, margin: 0, color: toneColor(tone, theme), ...style }}
        {...rest}
      >
        {children}
      </Tag>
    );
  },
);

/**
 * Caption — the smallest supporting text: a hint, a footnote, a timestamp.
 *
 * Always `body-sm` at the muted tone. Deliberately not a `data-*` variant: a caption is
 * narrative, and Geist Mono is reserved for financial and technical numerics.
 */
export const Caption = forwardRef<HTMLParagraphElement, BaseProps & { inline?: boolean }>(
  function Caption({ children, className, style, theme = 'light', tone = 'muted', inline, id, title, ...rest }, ref) {
    const v = variant('body-sm');
    const Tag = (inline ? 'span' : 'p') as 'p';
    return (
      <Tag
        ref={ref}
        id={id}
        title={title}
        className={cx('fc-body-sm', className)}
        style={{ ...v, margin: 0, color: toneColor(tone, theme), ...style }}
        {...rest}
      >
        {children}
      </Tag>
    );
  },
);

/**
 * Code — a literal technical value: a hash, an ID, a config key.
 *
 * Geist Mono and tabular, because these are the values whose width must not shift when a
 * character changes. Not for numbers in prose — that is `Text`.
 */
export const Code = forwardRef<HTMLElement, BaseProps & { size?: 'lg' | 'md' | 'sm' | 'xs'; as?: 'code' | 'span' | 'kbd' | 'samp' }>(
  function Code({ children, className, style, theme = 'light', tone = 'default', size = 'sm', as = 'code', id, title, ...rest }, ref) {
    const v = variant(`data-${size}` as TypeVariant);
    const Tag = as;
    return (
      <Tag
        ref={ref as React.Ref<HTMLElement>}
        id={id}
        title={title}
        className={cx('fc-data-' + size, className)}
        style={{ ...v, margin: 0, color: toneColor(tone, theme), ...style }}
        {...rest}
      >
        {children}
      </Tag>
    );
  },
);

/**
 * DataValue — a financial or technical numeric.
 *
 * Geist Mono and tabular by construction, which is the plan's answer to "financial numerics
 * must not shift width unpredictably when digits update". `size` maps to the `data-*` scale;
 * `tone` colours it, and the positive/negative/warning tones resolve to the AAA critical
 * foregrounds so a PnL figure is legible at 7:1 in both themes.
 */
export const DataValue = forwardRef<HTMLElement, BaseProps & { size?: 'display' | 'lg' | 'md' | 'sm' | 'xs'; as?: 'span' | 'div' | 'td' | 'strong' }>(
  function DataValue({ children, className, style, theme = 'light', tone = 'default', size = 'md', as = 'span', id, title, ...rest }, ref) {
    const v = variant(`data-${size}` as TypeVariant);
    const Tag = as;
    return (
      <Tag
        ref={ref as React.Ref<never>}
        id={id}
        title={title}
        className={cx('fc-data-' + size, 'fc-tabular', className)}
        style={{ ...v, margin: 0, color: toneColor(tone, theme), ...style }}
        {...rest}
      >
        {children}
      </Tag>
    );
  },
);
