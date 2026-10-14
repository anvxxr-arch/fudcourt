/**
 * Role-assignment log tests: offline, no network, no DOM.
 *
 * This panel is read-only, so the interesting half is the READING: the window the api actually
 * honours, the reasons it sends, and the one question a flat list cannot answer — whether the same
 * role keeps failing. The other half is a contract guard: the source vocabulary lives in the api
 * (a Go set) and the labels live here, and a source the api accepts but this file does not know would
 * render as a bare string with no explanation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'bun:test';

import { fetchRoleAssignments, type RoleAssignment } from '../src/features/admin/client';
import {
  DEFAULT_LIMIT,
  LIMITS,
  SOURCE_LABEL,
  SOURCE_NOTE,
  failuresOnly,
  groupFailures,
  isFailure,
  reasonOf,
  sourceLabel,
  summarize,
  windowNote,
} from '../src/features/admin/role-assignments-view';
import { formatWireTime } from '../src/features/admin/wire-time';

function row(over: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    id: 1,
    userId: '111111111111111111',
    roleId: '222222222222222222',
    action: 'add',
    source: 'autorole',
    status: 'ok',
    createdAt: '2026-10-14T23:10:00Z',
    ...over,
  };
}

// --- the wire -------------------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('role assignments: the read asks for the window it says it is showing', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ assignments: [row()] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const body = await fetchRoleAssignments(200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], '/api/admin/role-assignments?limit=200');
  assert.equal(body.assignments?.length, 1);
  assert.equal(body.assignments?.[0]?.roleId, '222222222222222222');
});

test('role assignments: a refusal arrives as the detail sentence', async () => {
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ detail: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  await assert.rejects(() => fetchRoleAssignments(DEFAULT_LIMIT), /forbidden/);
});

test('role assignments: the selector only offers windows the api honours', () => {
  // The api caps at 200 and silently falls back to 50 for anything else, so offering 500 would show
  // the operator a 50-row window labelled 500.
  assert.equal(DEFAULT_LIMIT, 50);
  assert.deepEqual([...LIMITS], [25, 50, 100, 200]);
  assert.ok(LIMITS.every((n) => n >= 1 && n <= 200));
  assert.ok(windowNote(25).includes('25'));
  assert.ok(windowNote(25).includes('older'));
});

// --- reading the log ------------------------------------------------------------------------------

test('role assignments: successes and failures are counted apart, and `error` may be absent', () => {
  const rows = [
    row({ id: 3, status: 'ok', error: undefined }),
    row({ id: 2, status: 'failed', error: 'role 222 is above the bot' }),
    row({ id: 1, status: 'failed', error: 'role 222 is above the bot' }),
  ];
  assert.deepEqual(summarize(rows), { total: 3, failed: 2, ok: 1 });
  assert.equal(failuresOnly(rows).length, 2);
  assert.equal(isFailure(rows[0]!), false);
  // omitempty means an `ok` row has no error key at all; the panel must still render something.
  assert.equal(reasonOf(rows[0]!), '');
});

test('role assignments: one role failing repeatedly is visible, newest reason first', () => {
  // The api returns id descending, so the FIRST row for a role carries its most recent reason.
  const rows = [
    row({ id: 9, status: 'failed', roleId: '999', error: 'newest reason' }),
    row({ id: 8, status: 'failed', roleId: '999', error: 'older reason' }),
    row({ id: 7, status: 'failed', roleId: '999', error: 'oldest reason' }),
    row({ id: 6, status: 'failed', roleId: '888', error: 'one off' }),
    row({ id: 5, status: 'ok', roleId: '777' }),
  ];
  const groups = groupFailures(rows);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { roleId: '999', count: 3, reason: 'newest reason', lastAt: '2026-10-14T23:10:00Z' });
  assert.deepEqual(groups[1], { roleId: '888', count: 1, reason: 'one off', lastAt: '2026-10-14T23:10:00Z' });
});

test('role assignments: equal failure counts order by role id, deterministically', () => {
  const rows = [
    row({ id: 4, status: 'failed', roleId: '300' }),
    row({ id: 3, status: 'failed', roleId: '100' }),
    row({ id: 2, status: 'failed', roleId: '200' }),
  ];
  assert.deepEqual(
    groupFailures(rows).map((g) => g.roleId),
    ['100', '200', '300'],
  );
});

test('role assignments: a timestamp it cannot read is shown verbatim, not swallowed', () => {
  // The real wire value: the api writes created_at as UTC with no zone marker, and the reader's
  // clock must not get a say (see wire-time-tests.ts for the timezone proof).
  assert.equal(formatWireTime('2026-10-14 23:10:00'), '14/10/2026, 23:10:00 UTC');
  assert.equal(formatWireTime('not-a-date'), 'not-a-date');
  assert.equal(formatWireTime(''), '');
});

test('role assignments: a source with no label falls back to the api string', () => {
  assert.equal(sourceLabel('panel-reaction'), 'reaction role');
  assert.equal(sourceLabel('something-new'), 'something-new');
});

// --- the contract with the api -------------------------------------------------------------------

test('role assignments: the label table covers exactly the sources the api accepts', () => {
  // The api owns this vocabulary (apps/api/community_handlers.go); a source it accepts but this panel
  // does not label renders as a bare string with no explanation of where the assignment came from.
  const source = readFileSync(new URL('../../api/community_handlers.go', import.meta.url), 'utf8');
  const list = /var assignmentSources = \[\]string\{([^}]*)\}/.exec(source);
  assert.ok(list !== null, 'assignmentSources must still be a slice literal in the api handler');
  const accepted = [...list[1]!.matchAll(/"([a-z][a-z-]*)"/g)].map((m) => m[1]!);
  assert.ok(accepted.length >= 5, `expected at least five accepted sources, extracted ${accepted.length}`);
  for (const want of ['autorole', 'panel', 'panel-reaction', 'verification', 'manual']) {
    assert.ok(accepted.includes(want), `the api must still accept ${want}`);
  }
  assert.deepEqual([...Object.keys(SOURCE_LABEL)].sort(), [...accepted].sort());
  assert.deepEqual([...Object.keys(SOURCE_NOTE)].sort(), [...accepted].sort());
});
