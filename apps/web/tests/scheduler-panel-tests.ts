/**
 * Scheduler panel draft tests: run OFFLINE, no network, no DOM.
 *
 * The panel is a REPLACE editor for `scheduled_jobs` — the rows the worker's tick turns into
 * jobs. Two rules are worth pinning here because getting either wrong is SILENT:
 *
 *  - WHAT THE SAVE SENDS (`writableDefinitions`, in client.ts). `scheduled_jobs` is shared
 *    with the feeds panel, and a read-only row sent back is a guaranteed 409 — so the filter
 *    is not a nicety, it is the difference between a save and a refusal. The body must also
 *    carry an OPERATOR's fields only: posting `nextRunAt` or `attempts` back would describe an
 *    edit this panel cannot make.
 *  - WHAT A DRAFT ROUND-TRIPS (`draftFrom` → `toDefinition`). The fields an operator owns must
 *    survive a load/save cycle untouched, and a kind whose payload the panel does not show
 *    must keep the payload it read — a save must never delete data it cannot display.
 *
 * The rules the SERVER owns — snowflake shape, interval bounds, cron fields, zones, the
 * ownership predicate — are deliberately NOT re-implemented on this side, so there is nothing
 * to assert about them: a refusal is surfaced as the server's own sentence, and that mapping
 * (`describeSaveFailure`) is what the last group tests.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSchedules, saveSchedules, writableDefinitions, type ScheduleDefinition } from '@/features/admin/client';
import {
  JOB_KINDS,
  PAYLOAD_FIELDS,
  SCHEDULE_KINDS,
  SCHEDULER_CONFLICT,
  draftFrom,
  expressionHint,
  newDraft,
  payloadValue,
  reportLine,
  scheduleHint,
  setPayloadValue,
  toDefinition,
  writablePayload,
} from '@/features/admin/scheduler-draft';
import { describeSaveFailure } from '@/features/admin/save-error';
import { HttpError } from '@/lib/fetch';

/** A row as the Go api returns it: worker columns present, `readOnly` derived server-side. */
function row(over: Partial<ScheduleDefinition> = {}): ScheduleDefinition {
  return {
    id: 7,
    name: 'standup',
    jobKind: 'discord.message',
    scheduleKind: 'interval',
    scheduleExpr: '3600',
    timezone: 'UTC',
    payload: { channel_id: '1234567890123456789', content: 'stand up' },
    enabled: true,
    attempts: 0,
    maxAttempts: 5,
    owner: 'scheduler',
    readOnly: false,
    ...over,
  };
}

test('scheduler panel: the save body drops read-only rows and worker-owned columns', () => {
  const mine = row();
  // The feeds' row: the panel SHOWS it (to explain why a feed is polling) but must not send it.
  const theirs = row({ id: 8, name: 'news', jobKind: 'feed.poll', owner: 'feeds', readOnly: true });

  const body = writableDefinitions([mine, theirs]);
  assert.equal(body.length, 1, 'a read-only row in the body is a guaranteed 409');
  assert.equal(body[0].name, 'standup');

  // Exactly the operator's fields: nothing the worker owns, nothing the server derives.
  assert.deepEqual(
    Object.keys(body[0]).sort(),
    ['enabled', 'jobKind', 'name', 'payload', 'scheduleExpr', 'scheduleKind', 'timezone'],
  );

  // With no read-only row present, every row is sent.
  assert.equal(writableDefinitions([mine, row({ id: 9, name: 'ping', jobKind: 'health.ping' })]).length, 2);
});

test('scheduler panel: the save body trims the fields the server stores trimmed', () => {
  const body = writableDefinitions([
    row({ name: '  news ', scheduleExpr: ' 3600 ', timezone: ' Asia/Jakarta ' }),
    row({ name: 'news', scheduleExpr: '3600', timezone: 'Asia/Jakarta' }),
  ]);
  // "news " and "news" must not become two rows that collide on the next save.
  assert.deepEqual(
    body.map((d) => [d.name, d.scheduleExpr, d.timezone]),
    [['news', '3600', 'Asia/Jakarta'], ['news', '3600', 'Asia/Jakarta']],
  );
});

test('scheduler panel: a payload-less row sends an object, never undefined', () => {
  // `payload` is a NOT NULL jsonb column the worker reads as an object.
  const body = writableDefinitions([row({ jobKind: 'health.ping', payload: undefined as never })]);
  assert.deepEqual(body[0].payload, {});
});

test('scheduler panel: a draft round-trips the operator fields and the worker report', () => {
  const from = draftFrom(row({ nextRunAt: '2026-10-14T09:00:00Z', lastStatus: 'failed', lastError: 'boom' }), 'row-7');
  assert.equal(from.id, 7);
  assert.equal(from.readOnly, false);
  // The pair the panel toggles: `enabled` is the operator's, `nextRunAt` the worker's.
  assert.equal(from.enabled, true);
  assert.equal(from.nextRunAt, '2026-10-14T09:00:00Z');

  const back = toDefinition(from);
  assert.equal(back.name, 'standup');
  assert.equal(back.jobKind, 'discord.message');
  assert.equal(back.scheduleKind, 'interval');
  assert.equal(back.scheduleExpr, '3600');
  assert.equal(back.timezone, 'UTC');
  assert.equal(back.enabled, true);
  assert.deepEqual(back.payload, { channel_id: '1234567890123456789', content: 'stand up' });
  // Even though the wire object carries them, the body builder drops them again.
  assert.deepEqual(Object.keys(writableDefinitions([back])[0]).includes('id' as never), false);
});

test('scheduler panel: a new definition is enabled, explicit about its zone, and has a name to fill', () => {
  const d = newDraft('new-1');
  assert.equal(d.id, 0, 'an unsaved definition has no row id');
  assert.equal(d.name, '', 'a blank name is the server\'s refusal to name, not a silent default');
  assert.equal(d.enabled, true, 'saving a definition that starts disabled is the "nothing happened" bug');
  assert.equal(d.timezone, 'UTC', 'the zone is explicit and editable — never a guess at the operator\'s');
  assert.equal(d.readOnly, false);
  assert.equal(d.jobKind, 'discord.message');
  assert.equal(d.scheduleKind, 'interval');
});

test('scheduler panel: payload edits are immutable and never sent for a kind the panel does not edit', () => {
  const d = newDraft('new-1');
  const withChannel = setPayloadValue(d, 'channel_id', '1234567890123456789');
  assert.notEqual(withChannel, d, 'a mutated draft would not re-render');
  assert.deepEqual(d.payload, {}, 'the original draft must be untouched');
  assert.equal(payloadValue(withChannel, 'channel_id'), '1234567890123456789');

  // discord.message: exactly the fields it shows — clearing the message really clears it.
  assert.deepEqual(writablePayload(setPayloadValue(withChannel, 'content', 'hi')), {
    channel_id: '1234567890123456789',
    content: 'hi',
  });
  assert.deepEqual(writablePayload(withChannel), { channel_id: '1234567890123456789', content: '' });

  // An unknown/other kind: the payload it read passes through, so a save cannot delete what
  // the panel does not display.
  const ping = { ...newDraft('new-2'), jobKind: 'health.ping', payload: { note: 'kept' } };
  assert.deepEqual(writablePayload(ping), { note: 'kept' });
  assert.equal(PAYLOAD_FIELDS['health.ping'], undefined);
});

test('scheduler panel: a non-string payload value is shown as JSON, and a snowflake never travels as a number', () => {
  const d = { ...newDraft('new-1'), payload: { tries: 3, key: 'abc' } };
  assert.equal(payloadValue(d, 'tries'), '3', 'a stored number is shown as JSON, not [object Object]');
  assert.equal(payloadValue(d, 'key'), 'abc');
  assert.equal(payloadValue(d, 'absent'), '');

  // WHY the payload's fields are strings end to end, and why payloadValue stringifies rather than
  // coercing: a Discord snowflake cannot be held by a JS number. 1234567890123456789 parses to
  // 1234567890123456800, so a numeric channel_id would round-trip to a channel that does not
  // exist. The panel shows what was stored instead of pretending to repair it.
  const lossy = { ...newDraft('new-2'), payload: { channel_id: 1234567890123456789 as unknown as string } };
  assert.equal(payloadValue(lossy, 'channel_id'), '1234567890123456800');
  assert.notEqual(payloadValue(lossy, 'channel_id'), '1234567890123456789');
});

test('scheduler panel: report line answers "why has this not run"', () => {
  const fresh = draftFrom(row({ attempts: 0 }), 'row-1');
  delete fresh.nextRunAt;
  assert.match(reportLine(fresh), /next run: not anchored yet/, 'a cron with no anchor must say so, not show a blank');

  const spent = draftFrom(
    row({ nextRunAt: '2026-10-14T09:00:00Z', lastRunAt: '2026-10-13T09:00:00Z', lastStatus: 'failed', lastError: 'channel not found', attempts: 3, maxAttempts: 5 }),
    'row-1',
  );
  assert.match(reportLine(spent), /next: 2026-10-14T09:00:00Z/);
  assert.match(reportLine(spent), /last: 2026-10-13T09:00:00Z/);
  assert.match(reportLine(spent), /failed/);
  assert.match(reportLine(spent), /attempts 3\/5/);
  assert.match(reportLine(spent), /error: channel not found/);
});

test('scheduler panel: every offered kind has a hint and the shape is described, not validated', () => {
  for (const kind of SCHEDULE_KINDS) {
    assert.notEqual(expressionHint(kind), '', `${kind} needs a placeholder: the shape the server accepts`);
    assert.notEqual(scheduleHint(kind), '', `${kind} needs to explain anchoring`);
  }
  assert.match(expressionHint('cron'), /5, 6 or 7 fields/, 'a cron is not a number of seconds');
  assert.match(expressionHint('interval'), /60 to 604800/);
  assert.match(scheduleHint('cron'), /anchors it/, 'an operator must know a cron has no next run until the tick');
  assert.equal(expressionHint('weekly'), '');
});

test('scheduler panel: a refusal is the server\'s sentence, and a 409 says to rename', () => {
  const conflict = new HttpError('/api/admin/scheduler', 409, 'the name "news" is owned by the feeds panel');
  const told = describeSaveFailure(conflict, SCHEDULER_CONFLICT);
  assert.match(told, /owned by the feeds panel/, 'the detail names what actually happened');
  assert.match(told, /rename it/, 'a 409 is resolved by renaming, not by retrying or by filing a bug');

  const invalid = describeSaveFailure(new HttpError('/api/admin/scheduler', 400, 'definition 2: interval must be 60..604800'));
  assert.match(invalid, /definition 2: interval must be 60\.\.604800/);

  // An HttpError with no body still says something actionable rather than "undefined".
  assert.equal(describeSaveFailure(new HttpError('/x', 503, '')), 'refused (HTTP 503)');
  assert.equal(describeSaveFailure(new Error('network down')), 'network down');
  assert.equal(describeSaveFailure('nope'), 'save failed');
});

test('scheduler panel: the offered kinds are the ones the contract documents', () => {
  // Drift guard: the panel offers a kind because the WORKER registers a handler for it, and
  // the contract is where that fact is written down. Offering a kind the contract does not
  // document (or documenting one the panel cannot reach) is the drift this catches.
  const contract = readFileSync(new URL('../../../contracts/openapi/fudcourt.yaml', import.meta.url), 'utf8');
  const post = contract.slice(contract.indexOf('operationId: setAdminScheduler'));
  assert.ok(post.length > 0, 'the scheduler POST is documented');
  for (const kind of JOB_KINDS) {
    assert.ok(
      post.slice(0, post.indexOf('/api/admin/feeds:')).includes(`\`${kind}\``),
      `${kind} must be documented where the endpoint describes what it accepts`,
    );
  }
});

/** Run one call against a stubbed fetch: the api client is the only place the panel talks to
 *  the wire, so this is where "the panel must never send a read-only row" and "a refusal must
 *  never look like a save" are actually provable — not on the pure helpers alone. */
async function withStubbedFetch<T>(
  response: () => Response,
  run: (calls: { url: string; init?: RequestInit }[]) => Promise<T>,
): Promise<T> {
  const calls: { url: string; init?: RequestInit }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(response());
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test('scheduler panel: the client reads the panel uncached and posts only this panel\'s rows', async () => {
  await withStubbedFetch(
    () => new Response(JSON.stringify({ definitions: [] }), { headers: { 'content-type': 'application/json' } }),
    async (calls) => {
      await fetchSchedules();
      assert.equal(calls[0].url, '/api/admin/scheduler');
      assert.equal(calls[0].init?.cache, 'no-store', 'a cached read would show a next run that has already passed');

      await saveSchedules([
        row(),
        row({ id: 8, name: 'news', jobKind: 'feed.poll', owner: 'feeds', readOnly: true }),
      ]);
      const post = calls[1];
      assert.equal(post.url, '/api/admin/scheduler');
      assert.equal(post.init?.method, 'POST');
      const body = JSON.parse(String(post.init?.body)) as { definitions: Record<string, unknown>[] };
      assert.deepEqual(body.definitions.map((d) => d.name), ['standup'], 'the feeds\' row must never be in the body');
      assert.equal('nextRunAt' in body.definitions[0], false, 'a worker column in the body describes an edit this panel cannot make');
      assert.equal('readOnly' in body.definitions[0], false);
      assert.deepEqual(body.definitions[0].payload, { channel_id: '1234567890123456789', content: 'stand up' });
    },
  );
});

test('scheduler panel: a refusal arrives as the server\'s sentence, not as a status code', async () => {
  // The Go api's envelope.
  await withStubbedFetch(
    () => new Response(JSON.stringify({ detail: 'the name "news" is owned by the feeds panel' }), { status: 409 }),
    async () => {
      await assert.rejects(
        () => saveSchedules([row()]),
        (err: unknown) => {
          assert.ok(err instanceof HttpError, 'a refusal must be typed so a caller can branch on it');
          assert.equal(err.status, 409);
          assert.match(err.detail, /owned by the feeds panel/);
          assert.match(err.message, /HTTP 409: the name "news" is owned by the feeds panel/);
          assert.match(describeSaveFailure(err, SCHEDULER_CONFLICT), /rename it/);
          return true;
        },
      );
    },
  );

  // The BFF proxy's envelope, for an api that is not running: still a sentence, not "undefined".
  await withStubbedFetch(
    () => new Response(JSON.stringify({ error: 'api unreachable: connect ECONNREFUSED' }), { status: 502 }),
    async () => {
      await assert.rejects(
        () => fetchSchedules(),
        (err: unknown) => {
          assert.match(describeSaveFailure(err), /api unreachable/);
          return true;
        },
      );
    },
  );

  // A body that is not JSON at all must not turn a refusal into an unhandled parse error.
  await withStubbedFetch(
    () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    async () => {
      await assert.rejects(
        () => fetchSchedules(),
        (err: unknown) => {
          assert.match(describeSaveFailure(err), /502 Bad Gateway/);
          return true;
        },
      );
    },
  );
});
