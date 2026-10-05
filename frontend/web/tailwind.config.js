/** @type {import('tailwindcss').Config} */
// Read the generated tokens through an ABSOLUTE path anchored at __dirname.
// `require('./tailwind.tokens.json')` is banned here: Tailwind loads config files through its own
// loader (and Next/Turbopack re-bundles them), so a bare relative specifier resolves against the
// LOADER's base rather than this file's directory and can throw MODULE_NOT_FOUND during
// `next build`. `__dirname` is always the directory holding tailwind.config.js.
const tokens = JSON.parse(
  require('fs').readFileSync(require('path').join(__dirname, 'tailwind.tokens.json'), 'utf8'),
);
module.exports = {
  darkMode: 'class',
  // One tree, one glob (DR-018): routes, features, platform, ui, styles and cms
  // all live under src/, so the previous `./app/**` + `./components/**` pair —
  // which had already gone stale once — cannot drift again.
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  // Every value here is a `var(--fc-…)` reference or a px literal generated from
  // `src/styles/tokens.ts` by `scripts/design/emit-tokens.ts` (DR-037) — this file
  // carries no raw visual values, so a utility class and the inline-style layer
  // cannot disagree. Do not hand-edit `tailwind.tokens.json`: `bun run check:design`
  // fails on drift.
  theme: { extend: tokens },
  plugins: [],
};