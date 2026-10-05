'use client';

/**
 * Shared presentational pieces for the trade module.
 *
 * Kept in one small file so every board renders the same way: one Card, one
 * table, one value, one error state. The alternative — each board rolling its
 * own table — is how two pages end up disagreeing about what an em dash looks
 * like, which for a trading surface is a correctness bug, not a style one.
 *
 * All numbers go through `client.ts`'s formatters, so `NO_VALUE` is spelled once.
 * All visual values come from `@/styles/tokens`, so the design gate stays green.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { alpha, color, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import { NO_VALUE } from '@/features/trade/client';

export function Card({ title, subtitle, right, children }: { title?: string; subtitle?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section
      style={{
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius[8],
        padding: `${space[14]}px ${space[16]}px`,
      }}
    >
      {(title || right) && (
        <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: space[8], marginBottom: space[10] }}>
          <div>
            {title && <h2 style={{ margin: 0, fontSize: fontSize[13], fontWeight: fontWeight.semibold, color: color.text, letterSpacing: letterSpacing.xs }}>{title}</h2>}
            {subtitle && <p style={{ margin: `${space[4]}px 0 0`, fontSize: fontSize[11], color: color.textMuted }}>{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

/** A label/value pair; a null value prints the module's single em dash. */
export function Value({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'default' | 'positive' | 'negative' | 'muted' }) {
  const toneColor =
    tone === 'positive' ? color.positive : tone === 'negative' ? color.negative : tone === 'muted' ? color.textMuted : color.text;
  return (
    <div title={hint} style={{ display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 0 }}>
      <span style={{ fontSize: fontSize[10], color: color.textMuted, letterSpacing: letterSpacing.sm, textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: fontSize[18], fontWeight: fontWeight.semibold, color: toneColor, fontFamily: 'inherit' }}>{value}</span>
    </div>
  );
}

/**
 * A signed change chip; a null change prints the em dash, not a flat zero.
 *
 * The prop is ALREADY IN PERCENT — the ticker reports ccxt's `percentage`
 * field directly. There is no x100 here on purpose: doing so printed +138.87%
 * for a +1.39% move.
 */
export function ChangeChip({ percent }: { percent: number | null }) {
  if (percent === null || !Number.isFinite(percent)) {
    return <span style={{ color: color.textMuted, fontSize: fontSize[12] }}>{NO_VALUE}</span>;
  }
  const up = percent >= 0;
  return (
    <span style={{ color: up ? color.positive : color.negative, fontSize: fontSize[12], fontWeight: fontWeight.medium }}>
      {up ? '▲' : '▼'} {Math.abs(percent).toFixed(2)}%
    </span>
  );
}

export function Loading({ what }: { what: string }) {
  return <p style={{ color: color.textMuted, fontSize: fontSize[12] }}>Loading {what}…</p>;
}

export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div style={{ background: alpha(color.negative, 0.08), border: `1px solid ${alpha(color.negative, 0.4)}`, borderRadius: radius[8], padding: `${space[12]}px ${space[14]}px`, color: color.text }}>
      <strong style={{ color: color.negative }}>{title}</strong>
      {detail ? <p style={{ margin: `${space[6]}px 0 0`, fontSize: fontSize[12], color: color.textMuted }}>{detail}</p> : null}
    </div>
  );
}

/** A calm, non-error notice — the "nothing to do yet" state. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p style={{ margin: 0, padding: `${space[10]}px ${space[12]}px`, border: `1px dashed ${color.border}`, borderRadius: radius[6], fontSize: fontSize[11], color: color.textMuted, lineHeight: lineHeight.normal }}>
      {children}
    </p>
  );
}

/** The module's shared chrome: a title, a one-line description, and the entry nav. */
export function PageHeader({ title, description, nav }: { title: string; description: string; nav: readonly { href: string; label: string }[] }) {
  return (
    <header style={{ marginBottom: space[18] }}>
      <h1 style={{ margin: 0, fontSize: fontSize[24], fontWeight: fontWeight.bold, color: color.text }}>{title}</h1>
      <p style={{ margin: `${space[6]}px 0 ${space[12]}px`, fontSize: fontSize[12], color: color.textMuted, lineHeight: lineHeight.normal, maxWidth: 820 }}>{description}</p>
      <nav style={{ display: 'flex', flexWrap: 'wrap', gap: space[6] }}>
        {nav.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            style={{
              padding: `${space[4]}px ${space[10]}px`,
              border: `1px solid ${color.border}`,
              borderRadius: radius[6],
              color: color.text,
              fontSize: fontSize[11],
              textDecoration: 'none',
            }}
          >
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

/** A dense table whose rows optionally link to a canonical route. */
export function DataTable({ head, rows }: { head: readonly string[]; rows: readonly { cells: ReactNode[]; href?: string }[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: fontSize[12] }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: `${space[6]}px ${space[8]}px`, color: color.textMuted, fontWeight: fontWeight.medium, fontSize: fontSize[10], letterSpacing: letterSpacing.sm, textTransform: 'uppercase', borderBottom: `1px solid ${color.border}` }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.cells.map((c, j) => (
                <td key={j} style={{ padding: `${space[6]}px ${space[8]}px`, borderBottom: `1px solid ${alpha(color.border, 0.6)}`, color: color.text, whiteSpace: j === 0 ? 'normal' : 'nowrap' }}>
                  {j === 0 && r.href ? (
                    <Link href={r.href} style={{ color: color.accent, textDecoration: 'none' }}>{c}</Link>
                  ) : (
                    c
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}