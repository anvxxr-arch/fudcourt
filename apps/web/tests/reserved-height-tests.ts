/**
 * Reserved-height contract tests: run OFFLINE, no network, no clock, no DOM.
 *
 * WHY THIS CONTRACT EXISTS
 * ------------------------
 * Every home board fetches on the client (`useJson`), so between first paint and
 * the figures arriving a panel is EMPTY. Measured on `/` 2026-10-09 (Lighthouse,
 * mobile): the loading state of a board panel was a 49px heading, while its
 * loaded state was 259–727px. Each arrival therefore pushed every section below
 * it, and all four recorded shifts landed on one panel — CLS 0.160 on `/` and
 * 0.259 on `/market/crypto`.
 *
 * The fix is a reservation: the loading state already occupies the height the
 * body will be, so nothing moves when the data lands. That reservation is the
 * contract pinned here, and it is exactly the kind of thing that silently
 * regresses — a new panel with no `rows`, or a body that grows a second block
 * without its reservation following, looks completely fine until someone
 * measures CLS again.
 *
 * What this file can and cannot check: the arithmetic (`rows × rowHeight + note`)
 * and the presence of a reservation on each fetch-driven home panel are static
 * facts about the source. The CLS NUMBER itself needs a browser, so it is
 * measured with Lighthouse and the PerformanceObserver, not asserted here.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HOME = path.join(process.cwd(), 'src', 'features', 'home');
const read = (file: string) => readFileSync(path.join(HOME, file), 'utf8');

test('reserved height: the row and note tokens are a single source, in px', () => {
  const src = read('ui-shared.tsx');
  // One line of the caption/list type (the `11` rung, rendered at 12px so it
  // clears the legibility floor); exported so every panel sizes from the
  // same number instead of each inventing one.
  assert.match(src, /export const ROW_MIN_HEIGHT = \d+;/, 'ROW_MIN_HEIGHT must be declared');
  assert.match(src, /export const NOTE_MIN_HEIGHT = \d+;/, 'NOTE_MIN_HEIGHT must be declared');
  const row = Number(src.match(/export const ROW_MIN_HEIGHT = (\d+);/)?.[1]);
  const note = Number(src.match(/export const NOTE_MIN_HEIGHT = (\d+);/)?.[1]);
  assert.ok(row > 0 && row <= 30, `a reserved row must be a text line, got ${row}`);
  // The note wraps the raw upstream URL to two lines at phone width; a
  // one-line reservation would under-reserve every panel that carries one.
  assert.ok(note >= 32 && note <= 64, `the note reserves two wrapped lines, got ${note}`);
});

test('reserved height: a list row reserves its own line box', () => {
  const src = read('ui-shared.tsx');
  const style = src.slice(src.indexOf('export const listRowStyle'));
  const body = style.slice(0, style.indexOf('};'));
  // Without a floor the row is its content height and the loading/loaded
  // heights differ; the line-height keeps the glyphs optically centred in it.
  assert.match(body, /minHeight: ROW_MIN_HEIGHT/, 'the row must reserve its line box');
  assert.match(body, /lineHeight: `\$\{ROW_MIN_HEIGHT\}px`/, 'the line box and the leading must be the same number');
});

test('reserved height: Panel reserves rows × rowHeight + the note', () => {
  const src = read('ui-shared.tsx');
  // The panel's own contract carries both numbers: `rows` is a count, and
  // `rowHeight` exists because news rows are cards (~98px) while a market row is
  // one line of figures (18px). A single hard-coded height got news wrong by
  // 5×, which is what the earlier under-reservation measured.
  assert.match(src, /rows\?: number;/, 'Panel must take a row count');
  assert.match(src, /rowHeight\?: number;/, 'Panel must take an optional row height');
  assert.match(
    src,
    /minHeight: \(rows \?\? 0\) \* \(rowHeight \?\? ROW_MIN_HEIGHT\) \+ NOTE_MIN_HEIGHT/,
    'the reservation must be rows × rowHeight + note',
  );
});

test('reserved height: every fetch-driven home panel declares its reservation', () => {
  const ui = read('ui.tsx');
  const panels = [...ui.matchAll(/<Panel<[^>]*>[\s\S]*?\/>/g)].map((m) => m[0]);
  assert.ok(panels.length >= 4, `expected the home board panels, saw ${panels.length}`);
  for (const panel of panels) {
    const title = panel.match(/title=\{?['"`]([^'"`]{0, 34})/)?.[1] ?? '(untitled)';
    // `rows` is what makes the loading state the height of the loaded body; a
    // panel without it silently reintroduces the shift this run removed.
    assert.match(panel, /rows=\{/, `<Panel ${title}> must declare rows`);
  }
});

test('reserved height: the panels that do not use Panel still reserve', () => {
  // These four bypass `Panel` (they hold their own section or are one column of
  // a pair), and each was a measured contributor: the overview tile grid, the
  // two movers cards, and the signal-quality meters.
  const ui = read('ui.tsx');
  assert.match(ui, /2 \* 148 \+ NOTE_MIN_HEIGHT/, 'the 6-tile overview grid must reserve two tile rows + the note');
  assert.match(ui, /rowHeight=\{98\}/, 'the news panel must reserve its card-shaped rows');
  const panels = read('ui-panels.tsx');
  assert.equal(
    (panels.match(/6 \* ROW_MIN_HEIGHT \+ NOTE_MIN_HEIGHT/g) ?? []).length,
    2,
    'both movers/FX columns must reserve 6 rows + the note',
  );
  const signal = read('ui-boards-signal.tsx');
  assert.match(signal, /minHeight: 2 \* 62 \+ NOTE_MIN_HEIGHT/, 'signal quality must reserve its meter blocks + the note');
});

test('reserved height: the LCP wrapper never starts at opacity 0', () => {
  // The other half of this run: `layout.tsx` wraps every page's content — the
  // LCP element included — in an animated div. `fc-fade-in` starts at
  // `opacity: 0`, so the ANIMATION decided when the largest element could paint
  // (measured LCP render delay 2416ms of a 2900ms LCP on `/`). The route wrapper
  // must therefore use the present-at-first-frame variant, while the
  // per-component `fc-fade-in` keeps its full entry for non-LCP elements.
  const layout = readFileSync(path.join(process.cwd(), 'src', 'app', '(frontend)', 'layout.tsx'), 'utf8');
  assert.match(layout, /className="fc-route-enter"/, 'the route wrapper must use fc-route-enter');
  assert.equal(/className="fc-fade-in"/.test(layout), false, 'the route wrapper must not use fc-fade-in');
  const css = readFileSync(path.join(process.cwd(), 'src', 'app', '(frontend)', 'globals.css'), 'utf8');
  assert.match(css, /@keyframes fc-route-enter \{ from \{ opacity: 0\.\d+;/, 'the route enter must start above opacity 0');
  // The design system keeps its motion: the component-level classes still exist.
  assert.match(css, /\.fc-fade-in \{ animation: fc-fade-in/, 'per-component motion must be untouched');
  assert.match(css, /\.fc-fade-in-slow \{ animation: fc-fade-in/, 'per-component motion (slow) must be untouched');
  // Reduced-motion already collapses every animation duration globally.
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]{0,200}animation-duration: 0\.01ms !important/);
});

test('hub stability: the venue sub-line is one line in both states', () => {
  // The other half of the CLS work, on /market/crypto. The ticker board's
  // sub-line names the venues it is quoting, and `venues` is EMPTY until the
  // first response lands: the empty state rendered "…relayed from — and
  // cross-checked…" as two text lines, and the loaded state rendered the same
  // sentence with nine venue names as FOUR. Measured at 412px, the paragraph
  // went 33px -> 66px, and that +33px — not the row count — is what pushed the
  // board and produced the /market/crypto CLS of 0.265.
  //
  // The fix is the geometry, not a bigger box: reserving the loaded height would
  // waste up to five lines at 360px and two at 768px (measured line counts), so
  // the line is CLAMPED to one at every width and the full list moves to the
  // tooltip and the accessible name. What is assertable offline is that clamp
  // and the ordering, which are what make the state change height-neutral.
  const src = readFileSync(
    path.join(process.cwd(), 'src', 'features', 'market', 'ticker', 'ui-board.tsx'),
    'utf8',
  );
  const from = src.indexOf('ONE LINE, ALWAYS');
  const note = src.slice(from, src.indexOf('</p>', from));
  assert.ok(note.length > 0, 'the stabilised sub-line must be present');
  assert.match(note, /whiteSpace: 'nowrap'/, 'the sub-line must not wrap');
  assert.match(note, /overflow: 'hidden'/, 'the clamp must not spill');
  assert.match(note, /textOverflow: 'ellipsis'/, 'a clamped line must be visibly truncated');
  // A sorted list is what stops an upstream reorder from changing which names
  // the visible slice shows mid-session.
  assert.ok(
    (note.match(/\[\.\.\.venues\]\.sort\(\)\.join\(', '\)/g) ?? []).length >= 2,
    'the visible list and the tooltip/aria name must both be sorted, so they cannot disagree',
  );
  assert.match(note, /aria-label=/, 'truncation must not hide the text from assistive tech');
  assert.match(note, /title=/, 'the full list must stay reachable on hover');
});

test('hub stability: the dex toolbar is a fixed-height block in both states', () => {
  // The second half of the hub CLS work, on /market/trench. The dex toolbar's
  // `filter rows…` input was gated on `rows.length > 0`, so at hydrate the
  // toolbar went 0px -> 35px and shoved the hint paragraph below it 34px down
  // (measured 567 -> 601; the bulk of that route's 0.144 CLS). The control now
  // renders unconditionally, in the same toolbar row as the other controls.
  const src = readFileSync(
    path.join(process.cwd(), 'src', 'features', 'market', 'dex', 'ui.tsx'),
    'utf8',
  );
  // Strip block comments (which mention the old gate by name) so this reads
  // CODE, then assert the control is a plain sibling in the toolbar: a gate
  // would put `{rows.length > 0 && (` immediately before the `<input`.
  // The control is identified by `value={filter}` — its state binding, not its
  // placeholder (the placeholder text is a dictionary key now that the toolbar
  // is translated; the binding is the invariant).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = code.indexOf('value={filter}');
  assert.ok(at > 0, 'the filter-rows control must still exist');
  const open = code.lastIndexOf('<input', at);
  const close = code.indexOf('/>', at);
  assert.ok(open > 0 && close > open, 'the control must be a self-closing input');
  const control = code.slice(open, close);
  assert.ok(/value=\{filter\}/.test(control), 'the control is still the row filter');
  const before = code.slice(Math.max(0, open - 80), open);
  assert.equal(
    /&&/.test(before),
    false,
    `the filter must be a sibling in the toolbar, not the body of a gate: before it reads ${JSON.stringify(before.slice(-40))}`,
  );
});

test('economy stability: the dashboard ships its boards in the first paint', () => {
  // /economy was the last page holding CLS: it is prerendered with `revalidate`
  // and its boards were fetched on the CLIENT, so the shell carried `Loading`
  // placeholders that grew when the data landed — measured 2026-10-09
  // (Lighthouse mobile): `Pulse snapshot` 112px in the shell vs 532px loaded,
  // the cards below moving 136px (CLS 0.2704, the only shift on the page). Two
  // wrong fixes were measured and rejected first: removing the `translateY`
  // from `fc-fade-in` (the animation was NOT the cause — the box moves 136px of
  // real layout, not 4px of transform) and pre-fetching the boards per request
  // (a single FRED series takes ~4s here, so SSR would push TTFB past 10s).
  // The fix is a BUILD-time read that keeps the page static, so the contract is
  // that the page passes the boards into the dashboard's first render.
  const page = readFileSync(
    path.join(process.cwd(), 'src', 'app', '(frontend)', '(public)', 'economy', 'page.tsx'),
    'utf8',
  );
  assert.match(page, /loadEconomyBoards\(\)/, 'the page must read its boards on the server');
  assert.match(page, /await loadEconomyBoards\(\)/, 'the build-time read must be awaited before render');
  assert.match(page, /<EconomyDashboard initial=\{boards\}/, 'the boards must reach the dashboard first render');
  assert.match(page, /export const revalidate = \d+;/, 'the page must keep its revalidate window');
  assert.equal(/dynamic = 'force-dynamic'/.test(page), false, 'the page must stay static, not request-time');

  const dash = readFileSync(
    path.join(process.cwd(), 'src', 'features', 'economy', 'ui', 'dashboard.tsx'),
    'utf8',
  );
  // The first paint must seed from `initial`, and the effect must only fetch a
  // board the server could not resolve (a null), never refetch a good one.
  assert.match(dash, /initial\?\.\w+ \?\? null/, 'state must seed from the server boards');
  assert.match(
    dash,
    /missing\(seed\?\.\w+\)[\s\S]{0,400}fetchCompare|missing\(seed\?\.\w+\)[\s\S]{0,400}want\.push/,
    'only the boards the server could not read may be fetched on the client',
  );
});
