/**
 * The audit log: offline, no network, no DOM.
 *
 * Two halves. The READING — what moved between two snapshots, who made the change, and the window the
 * api actually honours — and the CONTRACT, because this panel leans on facts that live in the api:
 * the source vocabulary is a closed validated set, the resource type is NOT (so its labels are a
 * convenience), and the window defaults to 25 with a ceiling of 100. Those are read out of
 * apps/api/logging.go here, so changing them there fails here instead of quietly mislabelling a row.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'bun:test';

import { fetchAuditEntries, type AuditEntry } from '../src/features/admin/client';
import {
  ACTOR_NOTE,
  DEFAULT_WINDOW,
  FILTER_NOTE,
  GAP_NOTE,
  SOURCE_LABEL,
  WINDOWS,
  actorLabel,
  describeChange,
  diffSnapshots,
  formatSnapshot,
  resourceLabel,
  sourceLabel,
  summarize,
  typesIn,
  windowNote,
} from '../src/features/admin/audit-view';

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 1,
    guildId: '100',
    actorId: '111111111111111111',
    actorName: 'dwi',
    action: 'settings.update',
    resourceType: 'settings',
    resourceId: 'discord',
    before: { prefix: '!' },
    after: { prefix: '?' },
    source: 'dashboard',
    createdAt: '2026-10-14 23:10:00',
    ...over,
  };
}

// --- the wire -------------------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('audit: the read carries the window and the exact filter', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ entries: [entry()] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const body = await fetchAuditEntries(50, 'role_panel');
  assert.equal(seen[0], '/api/admin/logs/audit?limit=50&resourceType=role_panel');
  assert.equal(body.entries?.length, 1);

  await fetchAuditEntries(25);
  assert.equal(seen[1], '/api/admin/logs/audit?limit=25', 'no filter means no resourceType parameter');
});

test('audit: a resource type that needs escaping is escaped, never concatenated raw', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ entries: [] }), { status: 200 });
  }) as typeof fetch;

  await fetchAuditEntries(25, 'a b&c=d');
  assert.equal(seen[0], '/api/admin/logs/audit?limit=25&resourceType=a%20b%26c%3Dd');
});

test('audit: a refusal arrives as the detail sentence', async () => {
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ detail: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  await assert.rejects(() => fetchAuditEntries(DEFAULT_WINDOW), /forbidden/);
});

// --- reading one change ---------------------------------------------------------------------------

test('audit: a changed key reads as before → after, not as two blobs of JSON', () => {
  const changes = diffSnapshots({ prefix: '!', locale: 'id' }, { prefix: '?', locale: 'id' });
  assert.deepEqual(changes, [{ key: 'prefix', kind: 'changed', before: '"!"', after: '"?"' }]);
  assert.equal(describeChange(changes[0]!), 'prefix: "!" → "?"');
});

test('audit: keys that appeared and vanished are named as such', () => {
  const changes = diffSnapshots({ enabled: true }, { enabled: true, threshold: 7 });
  assert.deepEqual(changes, [{ key: 'threshold', kind: 'added', before: '', after: '7' }]);
  assert.equal(describeChange(changes[0]!), 'threshold: 7 (added)');

  const back = diffSnapshots({ a: 1, b: 2 }, { a: 1 });
  assert.deepEqual(back, [{ key: 'b', kind: 'removed', before: '2', after: '' }]);
  assert.equal(describeChange(back[0]!), 'b: 2 (removed)');
});

test('audit: a replaced list is ONE change, not a diff of two lists', () => {
  // Join roles arrive as two arrays. Diffing them element-wise would invent noise; the operator needs
  // to see that the set was replaced, and with what.
  const changes = diffSnapshots([{ roleId: '1' }], [{ roleId: '2' }, { roleId: '3' }]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.key, '');
  assert.equal(changes[0]!.kind, 'changed');
  assert.ok(changes[0]!.after.includes('"roleId":"2"'));
  assert.ok(!changes[0]!.after.includes(' '), 'the snapshot is compact JSON');
});

test('audit: a create has no before and a delete no after — both still read', () => {
  const created = diffSnapshots(undefined, { a: 1 });
  assert.deepEqual(created, [{ key: '', kind: 'added', before: '', after: '{"a":1}' }]);
  const deleted = diffSnapshots({ a: 1 }, undefined);
  assert.deepEqual(deleted, [{ key: '', kind: 'removed', before: '{"a":1}', after: '' }]);
  // No snapshots at all: not "no change", and the panel says "no snapshot" for this.
  assert.deepEqual(diffSnapshots(undefined, undefined), []);
});

test('audit: an unchanged snapshot yields nothing to show', () => {
  assert.deepEqual(diffSnapshots({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(diffSnapshots({ a: { deep: true } }, { a: { deep: true } }), []);
  // A nested object that moved is reported as one value, not descended into.
  const nested = diffSnapshots({ a: { deep: 1 } }, { a: { deep: 2 } });
  assert.deepEqual(nested, [{ key: 'a', kind: 'changed', before: '{"deep":1}', after: '{"deep":2}' }]);
});

test('audit: a long snapshot is capped so one row cannot own the table', () => {
  const long = formatSnapshot({ template: 'x'.repeat(400) });
  assert.ok(long.length <= 120);
  assert.ok(long.endsWith('…'));
  assert.equal(formatSnapshot('short'), '"short"');
});

// --- reading the row ------------------------------------------------------------------------------

test('audit: the actor falls back to the id and then admits it has neither', () => {
  assert.equal(actorLabel(entry()), 'dwi');
  assert.equal(actorLabel(entry({ actorName: '' })), '111111111111111111');
  assert.equal(actorLabel(entry({ actorName: '   ' })), '111111111111111111');
  assert.equal(actorLabel(entry({ actorName: '', actorId: '' })), 'not recorded');
});

test('audit: a resource type with no label is shown as the api wrote it', () => {
  // resource_type is free-form; the label table is a convenience for what the code writes today.
  assert.equal(resourceLabel('role_panel'), 'role panels');
  assert.equal(resourceLabel('seed-import'), 'seed-import');
  assert.equal(sourceLabel('automod'), 'AutoMod action');
  assert.equal(sourceLabel('nonsense'), 'nonsense');
});

test('audit: the page summary counts actors and points at the newest change', () => {
  const rows = [
    entry({ id: 3, actorName: 'dwi', createdAt: '2026-10-14 23:10:00' }),
    entry({ id: 2, actorName: 'dwi' }),
    entry({ id: 1, actorName: 'zed' }),
  ];
  const s = summarize(rows);
  assert.equal(s.total, 3);
  assert.deepEqual(s.actors, [
    { label: 'dwi', count: 2 },
    { label: 'zed', count: 1 },
  ]);
  // id descending on the wire, so the first row is the newest.
  assert.equal(s.newest, '2026-10-14 23:10:00');
  assert.deepEqual(summarize([]), { total: 0, actors: [], newest: '' });
});

test('audit: the filter offers only types that actually appeared', () => {
  const rows = [entry({ resourceType: 'settings' }), entry({ resourceType: 'welcome' }), entry({ resourceType: 'settings' })];
  assert.deepEqual(typesIn(rows), ['settings', 'welcome']);
  assert.deepEqual(typesIn([]), []);
  assert.ok(windowNote(25).includes('25'));
  assert.ok(windowNote(25).includes('older'));
});

// --- the contract with the api --------------------------------------------------------------------

function loggingSource(): string {
  return readFileSync(new URL('../../api/logging.go', import.meta.url), 'utf8');
}

test('audit: the source labels cover exactly the vocabulary the api accepts', () => {
  const source = loggingSource();
  const map = /var auditSources = map\[string\]bool\{([^}]*)\}/.exec(source);
  assert.ok(map !== null, 'auditSources must still be a map literal in the api');
  const accepted = [...map[1]!.matchAll(/"([a-z][a-z-]*)":/g)].map((m) => m[1]!);
  assert.ok(accepted.length >= 4, `expected at least four sources, extracted ${accepted.length}`);
  assert.deepEqual([...Object.keys(SOURCE_LABEL)].sort(), [...accepted].sort());
  // The api defaults an unlabelled source to "system"; that row must still have a label.
  assert.ok(accepted.includes('system'));
  assert.ok((SOURCE_LABEL['system'] ?? '').length > 0);
});

test('audit: the window selector offers only what the api honours', () => {
  const source = loggingSource();
  const fallback = /n := (\d+)\b/.exec(source);
  const ceiling = /if n > (\d+) \{/.exec(source);
  assert.ok(fallback !== null && ceiling !== null, 'auditLimit must still default and cap explicitly');
  assert.equal(DEFAULT_WINDOW, Number(fallback[1]));
  assert.equal(Math.max(...WINDOWS), Number(ceiling[1]));
  assert.ok(WINDOWS.every((n) => n >= 1 && n <= Number(ceiling[1])));
  assert.deepEqual([...WINDOWS], [...WINDOWS].sort((a, b) => a - b));
});

test('audit: the panel states the two things it must not imply', () => {
  // The trail is best-effort; a gap can be a lost write rather than a change that never happened.
  assert.ok(GAP_NOTE.toLowerCase().includes('best-effort'));
  assert.ok(GAP_NOTE.includes('cannot be written'));
  // The filter is unvalidated, so an empty result is ambiguous.
  assert.ok(FILTER_NOTE.includes('does not validate'));
  assert.ok(ACTOR_NOTE.length > 0);
});
