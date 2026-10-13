/**
 * Functional-visual contract tests for the primitives the whole app rides on.
 *
 * These pin the accessibility behaviour that was MISSING on the served build and
 * that no other gate covers: async state is announced, the modal is a labelled
 * dialog, a sortable header is a real control, a banner announces itself, and a
 * failed endpoint is reported instead of silently rendering an empty board.
 * Each component assertion is on the markup a browser receives, rendered
 * through `react-dom/server` — the same convention the atom tests use, so no DOM
 * emulator is introduced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { ErrorState, Loading } from '@/ui/feedback';
import { Banner } from '@/ui/banner';
import { Button, Input, Modal } from '@/ui/primitives';
import { TH } from '@/ui/table';
import { Field } from '@/ui/field';
import { loadOverviewBundle } from '@/features/overview/client';

test('Loading is a live status region, so an arriving board is announced', () => {
  const out = renderToStaticMarkup(createElement(Loading, { what: 'assets' }));
  assert.match(out, /role="status"/, out);
  assert.match(out, /aria-live="polite"/, out);
  assert.match(out, /aria-busy="true"/, out);
  assert.match(out, /Loading assets…/);
});

test('ErrorState is an alert, so a failed read is announced the moment it renders', () => {
  const out = renderToStaticMarkup(createElement(ErrorState, { title: 'Could not load', detail: 'upstream refused' }));
  assert.match(out, /role="alert"/, out);
  assert.match(out, /Could not load/);
});

test('Modal is a labelled dialog with a named close control', () => {
  const out = renderToStaticMarkup(
    createElement(Modal, {
      title: 'Add wallet',
      onClose: () => {},
      children: createElement('span', null, 'body'),
    }),
  );
  assert.match(out, /role="dialog"/, out);
  assert.match(out, /aria-modal="true"/, out);
  // The dialog must point at its OWN title id, not at an unrelated node.
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(out);
  assert.ok(labelledBy, `no aria-labelledby: ${out}`);
  assert.match(out, new RegExp(`id="${labelledBy![1]}"`), 'aria-labelledby must resolve to an id in the dialog');
  assert.match(out, /<h2 id="/, 'the labelled element is the dialog title');
  // The ✕ is a real control with an accessible name, not a bare glyph.
  assert.match(out, /aria-label="Close dialog"/, out);
});

test('Button defaults to type=button (a non-submit control must not submit a form)', () => {
  const def = renderToStaticMarkup(createElement(Button, { onClick: () => {}, children: 'Generate' }));
  assert.match(def, /type="button"/, def);
  const sub = renderToStaticMarkup(createElement(Button, { onClick: () => {}, type: 'submit', children: 'Save' }));
  assert.match(sub, /type="submit"/, 'an explicit submit type must be honoured');
  const busy = renderToStaticMarkup(createElement(Button, { onClick: () => {}, busy: true, children: 'Saving' }));
  assert.match(busy, /aria-busy="true"/, busy);
  const idle = renderToStaticMarkup(createElement(Button, { onClick: () => {}, children: 'Idle' }));
  assert.doesNotMatch(idle, /aria-busy/, 'an idle button carries no aria-busy');
});

test('TH marks a sortable column with scope + aria-sort, and leaves a plain header untouched', () => {
  const asc = renderToStaticMarkup(createElement(TH, { sort: 'asc', children: 'Price' }));
  assert.match(asc, /scope="col"/, asc);
  assert.match(asc, /aria-sort="ascending"/, asc);

  const desc = renderToStaticMarkup(createElement(TH, { sort: 'desc', children: 'Price' }));
  assert.match(desc, /aria-sort="descending"/, desc);

  const none = renderToStaticMarkup(createElement(TH, { sort: 'none', children: 'Price' }));
  assert.match(none, /aria-sort="none"/, none);

  // Regression guard: a header with no sort must NOT gain scope/aria-sort — the
  // grouped-header tables use rowSpan <th>s where scope="col" would be wrong.
  const plain = renderToStaticMarkup(createElement(TH, { children: 'Venues' }));
  assert.doesNotMatch(plain, /scope=/, plain);
  assert.doesNotMatch(plain, /aria-sort/, plain);
});

test('Field wires its label to the control, so the field is not visually labelled only', () => {
  const out = renderToStaticMarkup(
    createElement(Field, {
      label: 'Stop loss',
      hint: 'required by §38',
      children: createElement(Input, { value: '', onChange: () => {}, type: 'number' }),
    }),
  );
  const htmlFor = /<label[^>]*for="([^"]+)"/.exec(out);
  assert.ok(htmlFor, `no label[for]: ${out}`);
  // The id must EXIST and be on the input — a for= pointing at nothing is the
  // classic half-fix that reads as labelled in review but is not.
  assert.match(out, new RegExp(`<input[^>]*id="${htmlFor![1]}"`), out);
  // useId produces a stable, colon-delimited id; the attribute must survive it.
  assert.match(out, /<label[^>]*>Stop loss<\/label>/, out);
});

test('Banner announces a failure by default, and can be silenced when it is decorative', () => {
  const alert = renderToStaticMarkup(createElement(Banner, { children: 'Sync failed' }));
  assert.match(alert, /role="alert"/, alert);
  assert.match(alert, /aria-live="assertive"/, alert);

  const status = renderToStaticMarkup(createElement(Banner, { live: 'status', children: 'Advisory' }));
  assert.match(status, /role="status"/, status);
  assert.match(status, /aria-live="polite"/, status);

  const quiet = renderToStaticMarkup(createElement(Banner, { live: 'none', children: 'Tint only' }));
  assert.doesNotMatch(quiet, /role=/, quiet);
  assert.doesNotMatch(quiet, /aria-live/, quiet);
});

test('loadOverviewBundle reports which endpoints fell back to an empty payload', async () => {
  const original = globalThis.fetch;
  // /api/all and /api/coins answer; /api/wallets and /api/reconcile fail.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/wallets') || url.includes('/api/reconcile')) {
      return new Response('{"error":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/api/coins')) {
      return new Response('{"coins":[],"total":0}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{"assets":[],"transactions":[],"venues":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  try {
    const bundle = await loadOverviewBundle();
    assert.deepEqual(bundle.failed.sort(), ['/api/reconcile', '/api/wallets']);
    // The bundle still resolves (the board stays up) — the failure is REPORTED,
    // not thrown, which is what lets the shell name it on screen.
    assert.deepEqual(bundle.reconData.rows, []);
  } finally {
    globalThis.fetch = original;
  }
});
