/**
 * Activity-log routing tests: offline, no network, no DOM.
 *
 * The interesting half is the WRITE, because the api gives "turn it off" two different meanings and
 * only one of them keeps your channel:
 *
 *   • an EMPTY channelId DELETES the routing row (the channel is forgotten) — so a clear must not
 *     smuggle an `enabled` field, which would suggest the request can keep something;
 *   • a channel with `enabled: false` keeps the row and stops delivery.
 *
 * The last test is a contract guard: the category set lives in THREE places — the api's Go list, the
 * OpenAPI enum, and this dashboard's labels — and the api list is what the panel actually renders
 * (it arrives in every read). A category added to the api must not arrive as a bare string here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'bun:test';

import {
  CATEGORY_LABEL,
  CATEGORY_NOTE,
  CHANNEL_HINT,
  ROUTING_NOTE,
  clearWarning,
  draftFrom,
  intentFor,
  isOff,
  isRouted,
  labelFor,
  noteFor,
  outcomeSentence,
  summarize,
  type LogDestination,
  type Row,
} from '../src/features/admin/log-destinations-draft';

const CATEGORIES = ['message', 'member', 'role', 'voice', 'channel', 'moderation', 'automod'];

function stored(over: Partial<LogDestination> = {}): LogDestination {
  return {
    category: 'moderation',
    channelId: '555555555555555555',
    enabled: true,
    updatedAt: '2026-10-15 04:00:00',
    ...over,
  };
}

function row(over: Partial<Row> = {}): Row {
  return { category: 'moderation', channelId: '', enabled: true, stored: null, ...over };
}

test('draftFrom gives every category the api lists a row, unrouted by default', () => {
  const draft = draftFrom({ categories: CATEGORIES, destinations: [stored()] });
  assert.equal(draft.rows.length, 7);
  assert.deepEqual(draft.rows.map((r) => r.category), CATEGORIES, 'the api order is the render order');
  const moderation = draft.rows.find((r) => r.category === 'moderation')!;
  assert.equal(moderation.channelId, '555555555555555555');
  assert.equal(moderation.stored?.enabled, true);
  assert.equal(isRouted(moderation), true);
  // a category with no row is still shown, and shown as unrouted
  const feeds = draft.rows.find((r) => r.category === 'voice')!;
  assert.equal(feeds.channelId, '');
  assert.equal(isRouted(feeds), false);
  assert.equal(draft.unlabelled.length, 0);
});

test('draftFrom keeps a stored row the api did not list, and reports an unlabelled category', () => {
  const draft = draftFrom({ categories: ['message'], destinations: [stored({ category: 'threads' })] });
  assert.deepEqual(draft.rows.map((r) => r.category), ['message', 'threads']);
  assert.deepEqual(draft.unlabelled, ['threads'], 'a category this dashboard cannot describe is reported');
  assert.equal(labelFor('threads'), 'threads', 'and rendered as its raw name, never dropped');
});

test('a blank channel on an unrouted category sends nothing', () => {
  assert.equal(intentFor(row({ channelId: '   ', stored: null })).kind, 'none');
});

test('a blank channel on a ROUTED category is a delete, and does not carry an enabled field', () => {
  const intent = intentFor(row({ channelId: '', stored: stored() }));
  assert.equal(intent.kind, 'clear');
  assert.deepEqual(intent.body, { category: 'moderation', channelId: '' });
  assert.equal(
    Object.prototype.hasOwnProperty.call(intent.body, 'enabled'),
    false,
    'the delete path ignores enabled; sending it would imply the row is kept in some form',
  );
});

test('a whitespace channel is blank, not a channel named spaces', () => {
  assert.equal(intentFor(row({ channelId: '  ', stored: stored() })).kind, 'clear');
});

test('a new channel is a save that carries the delivery switch', () => {
  const intent = intentFor(row({ channelId: ' 666666666666666666 ', stored: null }));
  assert.equal(intent.kind, 'save');
  assert.deepEqual(intent.body, {
    category: 'moderation',
    channelId: '666666666666666666',
    enabled: true,
  });
});

test('flipping the toggle alone keeps the channel and says delivery is off', () => {
  const intent = intentFor(row({ channelId: '555555555555555555', enabled: false, stored: stored() }));
  assert.equal(intent.kind, 'save');
  assert.deepEqual(intent.body, {
    category: 'moderation',
    channelId: '555555555555555555',
    enabled: false,
  });
  assert.equal(isOff(row({ channelId: '555555555555555555', enabled: false, stored: stored() })), true);
});

test('an unchanged row sends nothing', () => {
  assert.equal(intentFor(row({ channelId: '555555555555555555', enabled: true, stored: stored() })).kind, 'none');
});

test('the api answer is said back in the operator terms', () => {
  assert.match(outcomeSentence({ ok: true, cleared: 'moderation' }), /deleted/);
  assert.match(outcomeSentence({ ok: true, cleared: 'moderation' }), /forgotten/);
  assert.match(outcomeSentence({ destination: stored() }), /delivery on/);
  assert.match(outcomeSentence({ destination: stored({ enabled: false }) }), /delivery off, the channel is kept/);
});

test('the clear warning names the deletion and the alternative', () => {
  const warn = clearWarning('moderation');
  assert.match(warn, /DELETES/);
  assert.match(warn, /forgotten/);
  assert.match(warn, /switch the toggle off/, 'the operator is told how to stop delivery instead');
  assert.match(ROUTING_NOTE, /every event/);
  assert.match(ROUTING_NOTE, /no restart/);
  assert.match(CHANNEL_HINT, /channel id/);
});

test('summarize counts routed and switched-off rows', () => {
  const stats = summarize([
    row({ category: 'message', channelId: '111111111111111111' }),
    row({ category: 'member', channelId: '222222222222222222', enabled: false }),
    row({ category: 'role' }),
  ]);
  assert.deepEqual(stats, { routed: 2, off: 1, total: 3 });
});

test('every category has a label and a description — and the api list is the authority', () => {
  const api = readFileSync(new URL('../../api/logging.go', import.meta.url), 'utf8');
  const list = /var logCategoryList = \[\]string\{([^}]*)\}/.exec(api)?.[1];
  assert.ok(list !== undefined, 'logCategoryList must exist in apps/api/logging.go');
  const fromApi = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fromApi, CATEGORIES, 'the api list is what the panel renders — keep this file in step');

  const yaml = readFileSync(new URL('../../../contracts/openapi/fudcourt.yaml', import.meta.url), 'utf8');
  const enumBlock = /LogDestination:[\s\S]{0,400}?enum: \[([^\]]+)\]/.exec(yaml)?.[1];
  assert.ok(enumBlock !== undefined, 'the contract must enumerate the log categories');
  const fromContract = enumBlock.split(',').map((s) => s.trim());
  assert.deepEqual(fromContract, CATEGORIES, 'the contract enum and the api list describe one set');

  for (const c of CATEGORIES) {
    assert.equal(typeof CATEGORY_LABEL[c], 'string', `${c} needs a label`);
    assert.equal(typeof CATEGORY_NOTE[c], 'string', `${c} needs a description`);
    assert.equal(noteFor(c) !== null, true);
  }
  assert.equal(Object.keys(CATEGORY_LABEL).length, CATEGORIES.length, 'no label for a category nobody can route');
});
