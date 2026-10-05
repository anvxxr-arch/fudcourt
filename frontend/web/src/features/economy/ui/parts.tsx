'use client';

/**
 * Shared presentational pieces for the economy module.
 *
 * Kept in one small file so every board renders the same way: one Card, one
 * table, one sparkline, one error state. The alternative — each board rolling its
 * own table — is how two pages end up disagreeing about what an em dash looks
 * like, which for a data module is a correctness bug, not a style one.
 *
 * All values go through `client.ts`'s formatters, so `NO_VALUE` is spelled once.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { alpha, color, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import { NO_VALUE, formatDate, formatValue } from '@/features/economy/model';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';

export function Card({ title, subtitle, right, children }: { title?: string; subtitle?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section
      style={{
        background: color.bgSecondary,
        border: `1px solid ${color.separator}`,
        borderRadius: radius[8],
        padding: `${space[12]}px ${space[16]}px`,
      }}
    >
      {(title || right) && (
        <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: space[8], marginBottom: space[8] }}>
          <div>
            {title && <h2 style={{ margin: 0, fontSize: fontSize[13], fontWeight: fontWeight.semibold, color: color.labelPrimary, letterSpacing: letterSpacing.xs }}>{title}</h2>}
            {subtitle && <p style={{ margin: `${space[4]}px 0 0`, fontSize: fontSize[11], color: color.labelTertiary }}>{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

/** A label/value pair; a null value prints the module's single em dash. */
export function Value({ label, value, decimals = 2, unit, hint }: { label: string; value: number | null; decimals?: number; unit?: string; hint?: string }) {
  const missing = value === null || value === undefined;
  return (
    <div title={hint} style={{ display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 0 }}>
      <span style={{ fontSize: fontSize[11], color: color.labelTertiary, letterSpacing: letterSpacing.sm, textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: fontSize[17], fontWeight: fontWeight.semibold, color: missing ? color.labelTertiary : color.labelPrimary, fontFamily: 'inherit' }}>
        {missing ? NO_VALUE : formatValue(value, decimals)}
        {!missing && unit ? <span style={{ fontSize: fontSize[11], color: color.labelTertiary, marginLeft: space[4] }}>{unit}</span> : null}
      </span>
    </div>
  );
}

export function ImportanceDots({ level }: { level: number }) {
  return (
    <span aria-label={`importance ${level} of 3`} style={{ color: color.orange, letterSpacing: letterSpacing.none }}>
      {'●'.repeat(Math.max(0, Math.min(3, level)))}
      <span style={{ color: color.separator }}>{'●'.repeat(Math.max(0, 3 - level))}</span>
    </span>
  );
}

/** A tiny inline sparkline. Renders nothing (not a flat line) when there is no trend. */
export function Sparkline({ points, width = 120, height = 28 }: { points: (number | null)[]; width?: number; height?: number }) {
  const vals = points.filter((p): p is number => p !== null && Number.isFinite(p));
  if (vals.length < 2) return <span style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>{NO_VALUE}</span>;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = width / (vals.length - 1);
  const path = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg width={width} height={height} role="img" aria-label={`trend ${up ? 'up' : 'down'}`} style={{ display: 'block' }}>
      <path d={path} fill="none" stroke={up ? color.green : color.red} strokeWidth={1.5} />
    </svg>
  );
}

export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div style={{ background: alpha(color.red, 0.08), border: `1px solid ${alpha(color.red, 0.4)}`, borderRadius: radius[8], padding: `${space[12]}px ${space[12]}px`, color: color.labelPrimary }}>
      <strong style={{ color: color.red }}>{title}</strong>
      {detail ? <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[12], color: color.labelTertiary }}>{detail}</p> : null}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p style={{ color: color.labelTertiary, fontSize: fontSize[12] }}>Loading {what}…</p>;
}

/** The module's shared chrome: a title, a one-line description, and the entry nav. */
export function PageHeader({ title, description, nav }: { title: string; description: string; nav: readonly { href: string; label: string }[] }) {
  return (
    <header style={{ marginBottom: space[20] }}>
      <h1 style={{ margin: 0, fontSize: fontSize[22], fontWeight: fontWeight.bold, color: color.labelPrimary }}>{title}</h1>
      <p style={{ margin: `${space[8]}px 0 ${space[12]}px`, fontSize: fontSize[12], color: color.labelTertiary, lineHeight: lineHeight.normal, maxWidth: 760 }}>{description}</p>
      <nav style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
        {nav.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            style={{
              padding: `${space[4]}px ${space[8]}px`,
              border: `1px solid ${color.separator}`,
              borderRadius: radius[8],
              color: color.labelPrimary,
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

export const ECONOMY_NAV = [
  { href: '/economy', label: 'Dashboard' },
  { href: '/economy/nation', label: 'Nations' },
  { href: '/economy/indicator', label: 'Indicators' },
  { href: '/economy/central-bank', label: 'Central banks' },
  { href: '/economy/regime', label: 'Regime' },
  { href: '/economy/liquidity', label: 'Liquidity' },
  { href: '/economy/calendar', label: 'Calendar' },
  { href: '/economy/compare', label: 'Compare' },
] as const;

/** A dense table whose rows link to a canonical slug. */
export function DataTable({ head, rows }: { head: readonly string[]; rows: readonly { cells: ReactNode[]; href?: string }[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <Table>
        <THead>
          <TR>
            {head.map((h) => (
              <TH key={h} style={{ textAlign: 'left', padding: `${space[8]}px ${space[8]}px`, color: color.labelTertiary, fontWeight: fontWeight.medium, fontSize: fontSize[11], letterSpacing: letterSpacing.sm, textTransform: 'uppercase', borderBottom: `1px solid ${color.separator}` }}>{h}</TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {rows.map((r, i) => (
            <TR key={i}>
              {r.cells.map((c, j) => (
                <TD key={j} style={{ padding: `${space[8]}px ${space[8]}px`, borderBottom: `1px solid ${alpha(color.separator, 0.6)}`, color: color.labelPrimary, whiteSpace: j === 0 ? 'normal' : 'nowrap' }}>
                  {j === 0 && r.href ? (
                    <Link href={r.href} style={{ color: color.blue, textDecoration: 'none' }}>{c}</Link>
                  ) : (
                    c
                  )}
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

export { formatDate, formatValue };
