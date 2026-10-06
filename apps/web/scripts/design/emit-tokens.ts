#!/usr/bin/env bun
/**
 * emit-tokens.ts — the generated-artifact emitter for the design system (DR-037).
 *
 *   cd apps/web
 *   bun scripts/design/emit-tokens.ts            # write the generated artifacts
 *   bun scripts/design/emit-tokens.ts --check    # render in memory, diff against disk
 *
 * SOURCE OF TRUTH: `src/styles/tokens.ts`. This script invents nothing — it renders the token
 * module and writes exactly two derived artifacts:
 *
 *   1. the `:root` custom-property block inside `src/app/(frontend)/globals.css`, delimited by the
 *      two sentinel lines below. Text outside the sentinels (the `@tailwind` directives, the
 *      hand-written `body` rule) is NEVER touched; only the region between the sentinels is
 *      replaced. Missing sentinels are created at the end of the file. A file carrying exactly ONE
 *      of the two is an error, not a guess: inserting a block into an unknown region is how a
 *      stylesheet silently loses a rule.
 *   2. `tailwind.tokens.json`, which `tailwind.config.js` requires into `theme.extend`; every
 *      Tailwind-side value is a `var(--fc-…)` reference, so the config carries zero raw values.
 *
 * DETERMINISM: values are emitted in the literal declaration order of `tokens.ts` (`Object.entries`
 * preserves it; nothing is re-sorted at render time), there is no timestamp, seed, random or
 * environment input, and comparison is byte-for-byte. Emitting twice produces identical bytes;
 * `--check` is therefore a real drift gate rather than a decoration.
 *
 * `--check` CATCHES: a hand-edit to either generated artifact, and a change to the rendered source
 * that was not re-emitted (it re-renders and compares bytes). It cannot catch whether the rest of
 * the tree has been migrated off raw literals — that is `scripts/checks/check-design-tokens.py`,
 * which is deliberately red until the migration lands and must not be worked around here.
 *
 * EXIT: 0 on success (`TOKENS_OK`, or a successful write); 1 on `TOKENS_DRIFT`, a missing sentinel,
 * a missing file, unknown arguments, or a value that no longer matches the current effective value.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  color,
  darkColor,
  fontFamily,
  fontSize,
  fontWeight,
  letterSpacing,
  lineHeight,
  motion,
  radius,
  space,
  target,
  zIndex,
} from '../../src/styles/tokens';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..', '..');
const TOKENS_TS = join(WEB_ROOT, 'src', 'styles', 'tokens.ts');
const GLOBALS_CSS = join(WEB_ROOT, 'src', 'app', '(frontend)', 'globals.css');
const TAILWIND_JSON = join(WEB_ROOT, 'tailwind.tokens.json');

const SENTINEL_START = '/* @generated design-tokens:start — bun scripts/design/emit-tokens.ts */';
const SENTINEL_END = '/* @generated design-tokens:end */';
const JSON_INDENT = 2;

/** Every `:root` declaration, in emission order: `--fc-<scheme>` → a rendered CSS value. */
const cssVars: Array<{ name: string; value: string }> = [
  ...Object.entries(color).map(([k, v]) => ({ name: `--fc-color-${k}`, value: v })),
  ...Object.entries(fontFamily).map(([k, v]) => ({ name: `--fc-font-${k}`, value: v })),
  ...Object.entries(space).map(([k, v]) => ({ name: `--fc-space-${k}`, value: `${v}px` })),
  // `radius.circle` is the `'50%'` keyword, not a px scale entry: strings render verbatim.
  ...Object.entries(radius).map(([k, v]) => ({
    name: `--fc-radius-${k}`,
    value: typeof v === 'number' ? `${v}px` : v,
  })),
  ...Object.entries(fontSize).map(([k, v]) => ({ name: `--fc-font-size-${k}`, value: `${v}px` })),
  ...Object.entries(fontWeight).map(([k, v]) => ({ name: `--fc-font-weight-${k}`, value: String(v) })),
  ...Object.entries(lineHeight).map(([k, v]) => ({ name: `--fc-line-height-${k}`, value: String(v) })),
  ...Object.entries(letterSpacing).map(([k, v]) => ({ name: `--fc-letter-spacing-${k}`, value: String(v) })),
  ...Object.entries(zIndex).map(([k, v]) => ({ name: `--fc-z-index-${k}`, value: String(v) })),
  ...Object.entries(motion).map(([k, v]) => ({ name: `--fc-motion-${k}`, value: v })),
  ...Object.entries(target).map(([k, v]) => ({ name: `--fc-target-${k}`, value: `${v}px` })),
];

function renderRootBlock(): string {
  const lines = [SENTINEL_START, ':root {'];
  for (const v of cssVars) lines.push(`  ${v.name}: ${v.value};`);
  lines.push('}');
  lines.push('.dark {');
  for (const [k, v] of Object.entries(darkColor)) lines.push(`  --fc-color-${k}: ${v};`);
  lines.push('}');
  lines.push('@media (prefers-reduced-motion: reduce) {');
  lines.push('  *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }');
  lines.push('}');
  lines.push(SENTINEL_END);
  return lines.join('\n');
}

function tokensJson(): Record<string, unknown> {
  const colors: Record<string, string> = {};
  for (const k of Object.keys(color)) colors[k] = `var(--fc-color-${k})`;
  const spacing: Record<string, string> = {};
  for (const [k, v] of Object.entries(space)) spacing[k] = `${v}px`;
  const borderRadius: Record<string, string> = {};
  for (const k of Object.keys(radius)) borderRadius[k] = `var(--fc-radius-${k})`;
  const fontSizeMap: Record<string, string> = {};
  for (const k of Object.keys(fontSize)) fontSizeMap[k] = `var(--fc-font-size-${k})`;
  const fontFamilyMap: Record<string, string[]> = {};
  for (const k of Object.keys(fontFamily)) fontFamilyMap[k] = [`var(--fc-font-${k})`];
  return { colors, spacing, borderRadius, fontSize: fontSizeMap, fontFamily: fontFamilyMap };
}

// ---------------------------------------------------------------------------
// Unified diff over the two artifacts. Hand-rolled (no dependency) because the
// artifacts are tens of lines and stdlib has no diff: an LCS table plus hunks.
// ---------------------------------------------------------------------------
type Op = { type: ' ' | '-' | '+'; text: string };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: '-', text: a[i] });
      i++;
    } else {
      ops.push({ type: '+', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: '-', text: a[i++] });
  while (j < m) ops.push({ type: '+', text: b[j++] });
  return ops;
}

function unifiedDiff(oldText: string, newText: string, label: string): string {
  const split = (t: string) => (t.length ? t.replace(/\n$/, '').split('\n') : []);
  const recs: Array<Op & { oln: number | null; nln: number | null }> = [];
  let oldNo = 0;
  let newNo = 0;
  for (const op of lcsOps(split(oldText), split(newText))) {
    if (op.type !== '+') oldNo++;
    if (op.type !== '-') newNo++;
    recs.push({ ...op, oln: op.type === '+' ? null : oldNo, nln: op.type === '-' ? null : newNo });
  }

  const changed = recs.map((r, k) => (r.type === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (changed.length === 0) return '';
  const CONTEXT = 3;
  const groups: number[][] = [];
  for (const k of changed) {
    const last = groups[groups.length - 1];
    if (last && k - last[last.length - 1] <= CONTEXT * 2 + 1) last.push(k);
    else groups.push([k]);
  }
  const out = [`--- a/${label}`, `+++ b/${label}`];
  for (const g of groups) {
    const slice = recs.slice(Math.max(0, g[0] - CONTEXT), Math.min(recs.length - 1, g[g.length - 1] + CONTEXT) + 1);
    const oldStart = slice.find((r) => r.oln !== null)?.oln ?? 0;
    const newStart = slice.find((r) => r.nln !== null)?.nln ?? 0;
    out.push(
      `@@ -${oldStart},${slice.filter((r) => r.type !== '+').length} ` +
        `+${newStart},${slice.filter((r) => r.type !== '-').length} @@`,
    );
    for (const r of slice) out.push(r.type + r.text);
  }
  return out.join('\n');
}

function spliceRootBlock(css: string): string {
  const lines = css.split('\n');
  const start = lines.indexOf(SENTINEL_START);
  const end = lines.indexOf(SENTINEL_END);
  if (start !== -1 && end !== -1) {
    if (end < start) throw new Error('globals.css: design-tokens:end appears before design-tokens:start');
    return [...lines.slice(0, start), ...renderRootBlock().split('\n'), ...lines.slice(end + 1)].join('\n');
  }
  if (start !== -1 || end !== -1) {
    throw new Error(
      'globals.css carries exactly one design-tokens sentinel — re-add the missing one ' +
        `(${start === -1 ? SENTINEL_START : SENTINEL_END}) before running the emitter`,
    );
  }
  return `${css.replace(/\n*$/, '\n')}\n${renderRootBlock()}\n`;
}

// ---------------------------------------------------------------------------
function main(): number {
  const unknown = process.argv.slice(2).filter((a) => a !== '--check');
  if (unknown.length > 0) {
    console.error(`TOKENS_FAIL unknown argument(s): ${unknown.join(' ')} (only --check is accepted)`);
    return 1;
  }
  const check = process.argv.includes('--check');

  if (!existsSync(TOKENS_TS)) {
    console.error(`TOKENS_FAIL ${TOKENS_TS} is missing — the token source of truth is gone`);
    return 1;
  }
  if (!existsSync(GLOBALS_CSS)) {
    console.error(`TOKENS_FAIL ${GLOBALS_CSS} is missing — the sentinels have no home`);
    return 1;
  }

  const currentCss = readFileSync(GLOBALS_CSS, 'utf8');
  const cssLines = currentCss.split('\n');
  const hasStart = cssLines.includes(SENTINEL_START);
  const hasEnd = cssLines.includes(SENTINEL_END);
  if (hasStart !== hasEnd) {
    console.error(
      `TOKENS_FAIL ${GLOBALS_CSS} carries exactly one design-tokens sentinel — the pair must be ` +
        `present or absent together (${hasStart ? SENTINEL_END : SENTINEL_START} is missing)`,
    );
    return 1;
  }
  if (check && !hasStart) {
    console.error(
      `TOKENS_FAIL missing sentinels in ${GLOBALS_CSS} — look for '${SENTINEL_START}' ... ` +
        `'${SENTINEL_END}' (run 'bun scripts/design/emit-tokens.ts' to create them)`,
    );
    return 1;
  }

  let nextCss: string;
  try {
    nextCss = spliceRootBlock(currentCss);
  } catch (err) {
    console.error(`TOKENS_FAIL ${(err as Error).message}`);
    return 1;
  }
  const nextJson = `${JSON.stringify(tokensJson(), null, JSON_INDENT)}\n`;
  const currentJson = existsSync(TAILWIND_JSON) ? readFileSync(TAILWIND_JSON, 'utf8') : '';

  if (check) {
    const drifts: string[] = [];
    if (currentCss !== nextCss) {
      drifts.push(unifiedDiff(currentCss, nextCss, 'src/app/(frontend)/globals.css') || '  (whitespace-only difference)');
    }
    if (currentJson !== nextJson) {
      drifts.push(unifiedDiff(currentJson, nextJson, 'tailwind.tokens.json') || '  (whitespace-only difference)');
    }
    if (drifts.length > 0) {
      console.log('TOKENS_DRIFT');
      console.log(drifts.join('\n'));
      console.log('re-run: bun scripts/design/emit-tokens.ts');
      return 1;
    }
    console.log(
      `TOKENS_OK (${Object.keys(color).length} colors, ${Object.keys(space).length} space, ` +
        `${Object.keys(fontSize).length} font-size, ${cssVars.length} vars total)`,
    );
    return 0;
  }

  writeFileSync(GLOBALS_CSS, nextCss);
  writeFileSync(TAILWIND_JSON, nextJson);

  console.log(`emitted: src/app/(frontend)/globals.css (between the design-tokens sentinels)`);
  console.log('emitted: tailwind.tokens.json');
  console.log('check with: bun scripts/design/emit-tokens.ts --check');
  return 0;
}

process.exit(main());
