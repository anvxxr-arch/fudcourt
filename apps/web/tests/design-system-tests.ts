/**
 * Theme parity and contrast tests — the two automated contracts the plan makes
 * authoritative.
 *
 * 1. PARITY: light and dark expose the SAME semantic token names. A role that exists in one
 *    theme and not the other is a component that renders an invisible border in one of them,
 *    which is the exact failure the plan names as "Light/Dark semantic drift".
 *
 * 2. CONTRAST: every semantic role clears its target against the background it is actually
 *    rendered on. AA for normal text, AAA (7:1) for the critical financial foregrounds, 3:1
 *    for boundaries and the focus ring. A critical token that falls below target FAILS —
 *    the plan says the tests are authoritative, not the palette.
 *
 * Offline, no DOM: the contrast maths runs on the token values directly, which is the same
 * number a browser computes for an opaque colour on an opaque background.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  criticalDark,
  criticalLight,
  darkSemantic,
  lightSemantic,
  marketRamp,
  neutralRamp,
  orangeRamp,
  primitiveTokens,
} from '@/styles/tokens';
import { resolve, semanticRoles, themes, type SemanticToken, type Theme } from '@/ui/foundations/color';
import { contrastTargets } from '@/ui/foundations/accessibility';

// ---------------------------------------------------------------------------
// WCAG relative luminance and contrast ratio.
// ---------------------------------------------------------------------------
function channels(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`expected #rrggbb, got '${hex}'`);
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// 1. Light/Dark parity
// ---------------------------------------------------------------------------

test('theme parity: light and dark expose an identical semantic key set', () => {
  const light = Object.keys(lightSemantic).sort();
  const dark = Object.keys(darkSemantic).sort();
  assert.deepEqual(dark, light, 'dark semantic keys drifted from light');
});

test('theme parity: every semantic role resolves in both themes', () => {
  for (const role of semanticRoles) {
    const l = resolve(role, 'light');
    const d = resolve(role, 'dark');
    assert.ok(l.length > 0, `light '${role}' resolved empty`);
    assert.ok(d.length > 0, `dark '${role}' resolved empty`);
    assert.ok(/^(#|rgb)/.test(l), `light '${role}' is not a colour: '${l}'`);
    assert.ok(/^(#|rgb)/.test(d), `dark '${role}' is not a colour: '${d}'`);
  }
});

test('theme parity: the resolved theme objects share a key set with the source maps', () => {
  assert.deepEqual(Object.keys(themes.dark).sort(), Object.keys(themes.light).sort());
  assert.deepEqual(Object.keys(themes.light).sort(), Object.keys(lightSemantic).sort());
});

test('theme parity: the two themes are genuinely different, not one map twice', () => {
  // A parity test that passes because both themes are identical would be worthless.
  const differing = semanticRoles.filter((r) => themes.light[r] !== themes.dark[r]);
  assert.ok(
    differing.length >= 20,
    `only ${differing.length} roles differ between themes — expected the surface/text/border families to flip`,
  );
  // The roles that MUST differ: the baseline surface and text families.
  for (const role of ['background', 'surface-primary', 'surface-secondary', 'surface-raised', 'text-primary', 'text-secondary', 'border-default', 'border-strong'] as SemanticToken[]) {
    assert.notEqual(themes.light[role], themes.dark[role], `'${role}' is identical in both themes`);
  }
});

test('theme parity: critical foregrounds are theme-specific', () => {
  for (const key of Object.keys(criticalLight) as (keyof typeof criticalLight)[]) {
    assert.notEqual(
      criticalLight[key],
      criticalDark[key],
      `'${key}' is the same in both themes — a critical foreground tuned for one background cannot serve the other`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Contrast
// ---------------------------------------------------------------------------

/** The background a role is rendered on, per theme. */
function bgFor(theme: Theme): string {
  return resolve('background', theme);
}

test('contrast: primary text clears AA in both themes', () => {
  for (const t of ['light', 'dark'] as Theme[]) {
    const r = ratio(resolve('text-primary', t), bgFor(t));
    assert.ok(r >= contrastTargets.aaText, `text-primary on ${t} is ${r.toFixed(2)}:1, need ${contrastTargets.aaText}`);
  }
});

test('contrast: secondary and muted text clear AA in both themes', () => {
  for (const t of ['light', 'dark'] as Theme[]) {
    for (const role of ['text-secondary', 'text-muted'] as SemanticToken[]) {
      const r = ratio(resolve(role, t), bgFor(t));
      assert.ok(r >= contrastTargets.aaText, `${role} on ${t} is ${r.toFixed(2)}:1, need ${contrastTargets.aaText}`);
    }
  }
});

test('contrast: critical financial foregrounds clear AAA (7:1) in both themes', () => {
  // The plan: "Fail CI when a critical semantic token falls below its target."
  for (const t of ['light', 'dark'] as Theme[]) {
    for (const role of [
      'positive-critical',
      'negative-critical',
      'warning-critical',
      'info-critical',
    ] as SemanticToken[]) {
      const r = ratio(resolve(role, t), bgFor(t));
      assert.ok(
        r >= contrastTargets.criticalText,
        `${role} on ${t} is ${r.toFixed(2)}:1, need ${contrastTargets.criticalText}:1 (AAA critical foreground)`,
      );
    }
  }
});

test('contrast: brand-critical foreground clears AAA in both themes', () => {
  for (const t of ['light', 'dark'] as Theme[]) {
    const r = ratio(resolve('brand-critical', t), bgFor(t));
    assert.ok(r >= contrastTargets.criticalText, `brand-critical on ${t} is ${r.toFixed(2)}:1`);
  }
});

test('contrast: critical foregrounds also clear AAA on the raised surface', () => {
  // A critical value is frequently rendered inside a card, not on the page background.
  for (const t of ['light', 'dark'] as Theme[]) {
    const surface = resolve('surface-primary', t);
    for (const role of ['positive-critical', 'negative-critical', 'warning-critical', 'info-critical', 'brand-critical'] as SemanticToken[]) {
      const r = ratio(resolve(role, t), surface);
      assert.ok(r >= contrastTargets.criticalText, `${role} on ${t} surface-primary is ${r.toFixed(2)}:1`);
    }
  }
});

test('contrast: focus ring clears 3:1 against both theme backgrounds', () => {
  for (const t of ['light', 'dark'] as Theme[]) {
    const r = ratio(resolve('focus-ring', t), bgFor(t));
    assert.ok(r >= contrastTargets.uiBoundary, `focus-ring on ${t} is ${r.toFixed(2)}:1, need ${contrastTargets.uiBoundary}`);
  }
});

test('contrast: the strong interactive boundary clears 3:1 against every surface', () => {
  // `border-default` is a hairline separator — WCAG does not require a decorative divider
  // to clear 3:1, and forcing it to would make every card edge shout. `border-strong` is
  // the boundary a user must perceive to operate a control, so THAT is the 3:1 one.
  for (const t of ['light', 'dark'] as Theme[]) {
    const surfaces: SemanticToken[] = ['surface-primary', 'surface-secondary', 'surface-raised', 'background'];
    for (const s of surfaces) {
      const r = ratio(resolve('border-strong', t), resolve(s, t));
      assert.ok(r >= contrastTargets.uiBoundary, `border-strong on ${t} ${s} is ${r.toFixed(2)}:1`);
    }
  }
});

test('contrast: the default border is a visible hairline, not invisible', () => {
  // Asserted so the exemption above is deliberate: a default border must still be
  // perceptible, just not at the interactive-boundary target.
  for (const t of ['light', 'dark'] as Theme[]) {
    const r = ratio(resolve('border-default', t), resolve('surface-primary', t));
    assert.ok(r >= 1.15, `border-default on ${t} surface is ${r.toFixed(2)}:1 — effectively invisible`);
  }
});

test('contrast: brand foreground on brand background clears AA', () => {
  for (const t of ['light', 'dark'] as Theme[]) {
    const r = ratio(resolve('brand-foreground', t), resolve('brand-primary', t));
    assert.ok(r >= contrastTargets.aaText, `brand-foreground on brand-primary (${t}) is ${r.toFixed(2)}:1`);
  }
});

test('contrast: text-inverse clears AA against the inverted surface it is designed for', () => {
  // `text-inverse` is text sitting on an INVERTED surface — a dark chip in the light theme,
  // a light chip in the dark one. So the surface it must clear is the opposite theme's
  // primary surface, which is exactly what "inverse" names.
  const r = ratio(resolve('text-inverse', 'light'), resolve('surface-primary', 'dark'));
  assert.ok(r >= contrastTargets.aaText, `light text-inverse on the dark surface it inverts onto is ${r.toFixed(2)}:1`);
  const r2 = ratio(resolve('text-inverse', 'dark'), resolve('surface-primary', 'light'));
  assert.ok(r2 >= contrastTargets.aaText, `dark text-inverse on the light surface it inverts onto is ${r2.toFixed(2)}:1`);
});

test('contrast: muted market colours clear 3:1 as indicators on every surface of their theme', () => {
  // The plan is explicit: base market colours are NOT required to pass AAA as normal text.
  // The MUTED set is what carries portfolio/research/analytics text and indicators, so it
  // must clear the 3:1 large-text/graphical boundary on every surface it can land on.
  const lightSurfaces = [neutralRamp['neutral-50'], neutralRamp['neutral-0'], neutralRamp['neutral-100']];
  const darkSurfaces = [neutralRamp['neutral-1000'], neutralRamp['neutral-950'], neutralRamp['neutral-925'], neutralRamp['neutral-900']];
  for (const [name, hex] of Object.entries(marketRamp)) {
    if (!name.endsWith('-muted')) continue;
    for (const s of lightSurfaces) {
      assert.ok(ratio(hex, s) >= contrastTargets.aaTextLarge, `${name} on light ${s} is ${ratio(hex, s).toFixed(2)}:1`);
    }
    for (const s of darkSurfaces) {
      assert.ok(ratio(hex, s) >= contrastTargets.aaTextLarge, `${name} on dark ${s} is ${ratio(hex, s).toFixed(2)}:1`);
    }
  }
});

test('contrast: vivid market colours clear 3:1 on the dark surfaces they are reserved for', () => {
  // Vivid is reserved for live ticks, orderbook, execution state and urgent signals —
  // surfaces that render on the dark theme's raised/background layers. On the LIGHT
  // background a vivid value is used as a graphical indicator only (a bar, a dot), where
  // the 3:1 non-text boundary applies against the surface it is drawn on, and the light
  // theme renders those indicators with the muted set instead.
  for (const [name, hex] of Object.entries(marketRamp)) {
    if (!name.endsWith('-vivid')) continue;
    for (const s of [neutralRamp['neutral-1000'], neutralRamp['neutral-950'], neutralRamp['neutral-925'], neutralRamp['neutral-900']]) {
      assert.ok(ratio(hex, s) >= contrastTargets.aaTextLarge, `${name} on dark ${s} is ${ratio(hex, s).toFixed(2)}:1`);
    }
  }
});

test('contrast: the disabled text role is exempt from the AA target by design', () => {
  // WCAG exempts inactive/disabled controls. Asserted so the exemption is deliberate
  // rather than an accident of the palette.
  for (const t of ['light', 'dark'] as Theme[]) {
    const r = ratio(resolve('text-disabled', t), bgFor(t));
    assert.ok(r > 1.5, `text-disabled on ${t} is ${r.toFixed(2)}:1 — too low to read at all`);
  }
});

// ---------------------------------------------------------------------------
// 3. Ramp integrity
// ---------------------------------------------------------------------------

test('ramps: every approved primitive colour exists with the exact approved value', () => {
  const expectedOrange: Record<string, string> = {
    'orange-50': '#FFF4EC',
    'orange-100': '#FFE5D1',
    'orange-200': '#FFC79E',
    'orange-300': '#FFA267',
    'orange-400': '#F57E35',
    'orange-500': '#E86A17',
    'orange-600': '#C95710',
    'orange-700': '#9F430D',
    'orange-800': '#79340F',
    'orange-900': '#5F2C10',
    'orange-950': '#341507',
  };
  assert.deepEqual(orangeRamp, expectedOrange, 'the brand orange ramp drifted from the frozen spec');

  const expectedNeutral: Record<string, string> = {
    'neutral-0': '#FFFFFF',
    'neutral-50': '#FAF9F7',
    'neutral-100': '#F3F1EE',
    'neutral-200': '#E6E2DE',
    'neutral-300': '#D3CEC8',
    'neutral-400': '#AAA39B',
    'neutral-500': '#817A73',
    'neutral-600': '#625C56',
    'neutral-700': '#48433E',
    'neutral-800': '#312E2B',
    'neutral-850': '#272421',
    'neutral-900': '#1E1C1A',
    'neutral-925': '#181614',
    'neutral-950': '#11100F',
    'neutral-1000': '#090908',
  };
  assert.deepEqual(neutralRamp, expectedNeutral, 'the warm graphite ramp drifted from the frozen spec');

  // The market ramp carries two values the contrast tests adjusted from the spec's first
  // draft, both recorded in the spec's adjustment note: `warning-muted` was 2.99:1 on the
  // light background (a hair under the 3:1 indicator boundary) and the critical
  // foregrounds were tuned per theme. The plan makes the tests authoritative.
  const expectedMarket: Record<string, string> = {
    'positive-muted': '#3F8F68',
    'positive-vivid': '#22C55E',
    'negative-muted': '#B85C5C',
    'negative-vivid': '#EF4444',
    'warning-muted': '#AF823B',
    'warning-vivid': '#F59E0B',
    'info-muted': '#4E7FA8',
    'info-vivid': '#3B82F6',
  };
  assert.deepEqual(marketRamp, expectedMarket, 'the market semantic ramp drifted');
});

test('ramps: canonical brand is orange-500', () => {
  assert.equal(orangeRamp['orange-500'], '#E86A17');
});

test('ramps: every semantic role names a primitive that exists', () => {
  // `resolve` throws on an unknown name, so calling it for every role in both themes IS
  // the assertion. The explicit loop keeps the failure message legible.
  for (const t of ['light', 'dark'] as Theme[]) {
    for (const role of semanticRoles) {
      assert.doesNotThrow(() => resolve(role, t), `${role} (${t}) names no primitive`);
    }
  }
});

test('ramps: primitiveTokens is the flat union of every ramp', () => {
  for (const k of Object.keys(orangeRamp)) assert.ok(k in primitiveTokens, `primitiveTokens is missing ${k}`);
  for (const k of Object.keys(neutralRamp)) assert.ok(k in primitiveTokens, `primitiveTokens is missing ${k}`);
  for (const k of Object.keys(marketRamp)) assert.ok(k in primitiveTokens, `primitiveTokens is missing ${k}`);
  for (const k of Object.keys(criticalLight)) assert.ok(k in primitiveTokens, `primitiveTokens is missing ${k}`);
});
