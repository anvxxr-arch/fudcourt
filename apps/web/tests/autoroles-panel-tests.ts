/**
 * Autorole panel tests: offline, no network, no DOM.
 *
 * Same two jobs as the welcome panel's suite, and the same order of importance:
 *
 *  1. THE PREVIEW AGREES WITH THE BOT. `autorole-select.ts` mirrors `selectAutoroles`, so the first
 *     group replays the BOT'S OWN fixtures (`apps/discord-bot/tests/community-autorole.test.ts` —
 *     same rules, same `isBot`, same buckets) and guards the parts of the bot's source the mirror
 *     copies: the comparator (priority then ROW ID) and the switch (including "a zero wait is
 *     immediate").
 *  2. THE WRITE SHAPE IS THE READ SHAPE MINUS THE ID. The api deletes every rule and re-inserts, so
 *     the id is reassigned on every save. The panel keeps the loaded id for the ordering preview and
 *     never sends it, and both halves of that are asserted, because "we send the id back because it
 *     was there" is a mistake that would look harmless and mean nothing.
 *
 * One guard is unusual on purpose: `DEFERRED_NOTE` claims nothing triggers verification, and a test
 * fails if a caller of `onVerified` ever appears — so the day that note becomes a lie, the suite says
 * so instead of the note quietly turning into misinformation.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { HttpError } from '@/lib/fetch';
import { fetchAutoroles, saveAutoroles } from '@/features/admin/client';
import {
  APPLIES,
  DEFERRED_NOTE,
  KINDS,
  MAX_DELAY,
  MAX_RULES,
  blankRule,
  duplicateRoleIds,
  fromRules,
  missingRoleIds,
  previewRules,
  toRules,
  type AutoroleDraftRule,
} from '@/features/admin/autoroles-draft';
import { compareAutoroles, delayLabel, selectAutoroles, type AutoroleRule } from '@/features/admin/autorole-select';

// The bot's own fixture builder (community-autorole.test.ts), so both implementations are compared
// on the same input. Its role ids are letters: `selectAutoroles` is pure, and the snowflake rule
// belongs to the api, which the last group guards.
function rule(over: Partial<AutoroleRule> = {}): AutoroleRule {
  return { id: '1', roleId: 'r', kind: 'on_join', delaySeconds: 0, appliesTo: 'all', enabled: true, priority: 0, ...over };
}

function draft(over: Partial<AutoroleDraftRule> = {}): AutoroleDraftRule {
  return { ...blankRule(), ...over };
}

function botSource(): string {
  return readFileSync(new URL('../../../apps/discord-bot/src/community/autorole.ts', import.meta.url), 'utf8');
}

test('autorole preview: on_join is immediate, and nothing else fires', () => {
  const sel = selectAutoroles([rule({ roleId: 'a' })], false);
  assert.deepEqual(sel.immediate.map((r) => r.roleId), ['a']);
  assert.deepEqual(sel.delayed, []);
  assert.deepEqual(sel.deferred, []);
});

test('autorole preview: a wait goes to delayed, and a zero wait is IMMEDIATE', () => {
  // The bot's fixture: id 1 waits 300s, id 2 waits nothing.
  const sel = selectAutoroles(
    [rule({ id: '1', roleId: 'd', kind: 'after_duration', delaySeconds: 300 }), rule({ id: '2', roleId: 'z', kind: 'after_duration', delaySeconds: 0 })],
    false,
  );
  assert.equal(sel.delayed.length, 1);
  assert.equal(sel.delayed[0]?.delaySeconds, 300);
  assert.equal(sel.delayed[0]?.rule.roleId, 'd');
  assert.deepEqual(sel.immediate.map((r) => r.roleId), ['z']);
  // A NEGATIVE wait is also immediate — the bot's test is `<= 0`, not `=== 0`. A hand-edited row can
  // hold one; the api's range check would refuse it on write.
  assert.deepEqual(selectAutoroles([rule({ roleId: 'n', kind: 'after_duration', delaySeconds: -5 })], false).immediate.map((r) => r.roleId), ['n']);
});

test('autorole preview: after_verification is its own bucket, and disabled rules vanish first', () => {
  const sel = selectAutoroles([rule({ roleId: 'v', kind: 'after_verification' })], false);
  assert.deepEqual(sel.deferred.map((r) => r.roleId), ['v']);
  assert.deepEqual(sel.immediate, []);
  assert.deepEqual(selectAutoroles([rule({ roleId: 'a', enabled: false })], false).immediate, []);
});

test('autorole preview: appliesTo filters the joiner, not the rule set', () => {
  assert.deepEqual(selectAutoroles([rule({ roleId: 'h', appliesTo: 'human' })], true).immediate, []);
  assert.deepEqual(selectAutoroles([rule({ roleId: 'b', appliesTo: 'bot' })], false).immediate, []);
  // The same rule for the joiner it DOES apply to: the filter is about the joiner.
  assert.deepEqual(selectAutoroles([rule({ roleId: 'h', appliesTo: 'human' })], false).immediate.map((r) => r.roleId), ['h']);
  assert.deepEqual(selectAutoroles([rule({ roleId: 'b', appliesTo: 'bot' })], true).immediate.map((r) => r.roleId), ['b']);
});

test('autorole preview: priority decides the order, and the row id decides the ties', () => {
  // The bot's fixture: id 1 has priority 1, id 2 has priority 9.
  const sel = selectAutoroles([rule({ id: '1', roleId: 'lo', priority: 1 }), rule({ id: '2', roleId: 'hi', priority: 9 })], false);
  assert.deepEqual(sel.immediate.map((r) => r.roleId), ['hi', 'lo']);

  // Equal priorities fall back to the ROW ID — which is list order, because replaceAutoroles
  // re-inserts in the order the dashboard sent. This is the fact `ORDER_NOTE` tells the operator.
  // Numerically, not lexicographically: as strings "10" sorts BEFORE "2", which is the classic way
  // this comparison goes wrong.
  assert.ok(compareAutoroles(rule({ id: '2' }), rule({ id: '10' })) < 0);
  assert.ok('10' < '2');
  assert.deepEqual(
    selectAutoroles([rule({ id: '10', roleId: 'second' }), rule({ id: '2', roleId: 'first' })], false).immediate.map((r) => r.roleId),
    ['first', 'second'],
  );

  // Before the first save there are no ids at all: `Number("")` is 0, the comparator ties, and a
  // STABLE sort keeps the panel's arrangement. That is what makes the preview agree with the bot
  // both before and after a save.
  assert.deepEqual(
    selectAutoroles([rule({ id: '', roleId: 'top' }), rule({ id: '', roleId: 'bottom' })], false).immediate.map((r) => r.roleId),
    ['top', 'bottom'],
  );
});

test('autorole preview: a wait is shown in the unit the operator would have written', () => {
  assert.equal(delayLabel(0), 'immediately');
  assert.equal(delayLabel(-1), 'immediately');
  assert.equal(delayLabel(90), 'after 90 seconds');
  assert.equal(delayLabel(60), 'after 1 minute');
  assert.equal(delayLabel(300), 'after 5 minutes');
  assert.equal(delayLabel(3600), 'after 1 hour');
  assert.equal(delayLabel(7200), 'after 2 hours');
  assert.equal(delayLabel(86400), 'after 1 day');
  assert.equal(delayLabel(172800), 'after 2 days');
  assert.equal(delayLabel(MAX_DELAY), 'after 30 days');
});

test('autorole draft: the body carries every field EXCEPT the id', () => {
  const drafts = [draft({ id: '42', roleId: ' 1234567890123456789 ', kind: 'after_duration', delaySeconds: 600.7, appliesTo: 'human', enabled: false, priority: 3 })];
  const body = toRules(drafts);
  assert.deepEqual(body, [
    { roleId: '1234567890123456789', kind: 'after_duration', delaySeconds: 600, appliesTo: 'human', enabled: false, priority: 3 },
  ]);
  // The id is the api's to assign: sending it back would imply a column the write path never reads.
  assert.equal('id' in body[0], false);
  assert.deepEqual(Object.keys(body[0]).sort(), ['appliesTo', 'delaySeconds', 'enabled', 'kind', 'priority', 'roleId']);

  // The preview keeps it, because the bot's tiebreak uses it.
  assert.equal(previewRules(drafts)[0]?.id, '42');

  // The array ORDER is preserved — it is the tiebreak the api will persist.
  const ordered = toRules([draft({ roleId: '1' }), draft({ roleId: '2' }), draft({ roleId: '3' })]);
  assert.deepEqual(ordered.map((r) => r.roleId), ['1', '2', '3']);
});

test('autorole draft: a form field that is not a number does not become NaN on the wire', () => {
  const body = toRules([draft({ delaySeconds: Number(''), priority: Number('abc') })]);
  assert.equal(body[0]?.delaySeconds, 0);
  assert.equal(body[0]?.priority, 0);
  assert.equal(Number.isNaN(body[0]?.priority), false);
});

test('autorole draft: the api\'s refusals are surfaced as notes, with the api\'s words', () => {
  const dupes = duplicateRoleIds([draft({ roleId: '5' }), draft({ roleId: '6' }), draft({ roleId: '5' })]);
  assert.deepEqual(dupes, ['5']);
  // The same role twice with DIFFERENT kinds is still a duplicate: the api refuses it whatever the
  // kind, which is stricter than the table's (guild_id, role_id, kind) index.
  assert.deepEqual(duplicateRoleIds([draft({ roleId: '5', kind: 'on_join' }), draft({ roleId: '5', kind: 'after_duration' })]), ['5']);
  // Whitespace is not a role id: the panel trims before comparing, as the api does before validating.
  assert.deepEqual(duplicateRoleIds([draft({ roleId: ' 5 ' }), draft({ roleId: '5' })]), ['5']);
  assert.deepEqual(duplicateRoleIds([draft({ roleId: '' }), draft({ roleId: '' })]), []);

  assert.deepEqual(missingRoleIds([draft({ roleId: '1' }), draft({ roleId: '  ' }), draft({ roleId: '' })]), [1, 2]);
});

test('autorole draft: the palette matches the api\'s two enums', () => {
  assert.deepEqual(KINDS.map((k) => k.value), ['on_join', 'after_duration', 'after_verification']);
  assert.deepEqual(APPLIES.map((a) => a.value), ['all', 'human', 'bot']);
  const source = readFileSync(new URL('../../../apps/api/community_handlers.go', import.meta.url), 'utf8');
  assert.ok(source.includes(`var autoroleKinds = map[string]bool{"on_join": true, "after_duration": true, "after_verification": true}`));
  assert.ok(source.includes(`var autoroleApplies = map[string]bool{"all": true, "human": true, "bot": true}`));
  assert.ok(source.includes('at most 100 autorole rules'));
  assert.equal(MAX_RULES, 100);
  assert.equal(MAX_DELAY, 2592000);
  assert.ok(source.includes('r.DelaySeconds < 0 || r.DelaySeconds > 30*24*3600'));
  assert.ok(source.includes('duplicate roleId %s'));
});

test('autorole panel: the api client reads and writes the documented envelopes', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, autoroles: [rule({ id: '7', roleId: '555000000000000001' })] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await fetchAutoroles();
    assert.equal(calls[0].url, '/api/admin/autoroles');
    assert.equal(calls[0].init?.cache, 'no-store', 'a cached read would show rules the bot no longer has');

    await saveAutoroles(toRules([draft({ roleId: '555000000000000001' })]));
    const post = calls[1];
    assert.equal(post.init?.method, 'POST');
    assert.equal((post.init?.headers as Record<string, string>)['Content-Type'], 'application/json');
    const body = JSON.parse(String(post.init?.body)) as { autoroles?: Record<string, unknown>[] };
    // This endpoint's envelope is `{autoroles}`, where the welcome one takes the object itself:
    // the wire is what it is, and both are pinned so a change on either side fails here.
    assert.ok(Array.isArray(body.autoroles));
    assert.equal(body.autoroles?.length, 1);
    assert.equal('id' in (body.autoroles?.[0] ?? {}), false);
  } finally {
    globalThis.fetch = real;
  }
});

test('autorole panel: a refusal arrives as the server\'s sentence and its status', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ detail: 'rule 1: duplicate roleId 555000000000000001' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => saveAutoroles([]),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 400);
        assert.match(err.detail, /duplicate roleId 555000000000000001/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = real;
  }
});

test('autorole panel: the mirror still matches the bot\'s switch and comparator', () => {
  const source = botSource();
  assert.ok(source.includes('export function selectAutoroles'), 'the bot no longer exports selectAutoroles');
  // The comparator, verbatim: priority descending, then row id ascending.
  assert.ok(source.includes('b.priority - a.priority || Number(a.id) - Number(b.id)'), 'the bot\'s ordering comparator moved');
  // The zero-wait collapse, verbatim: `<= 0`, so a negative wait is immediate too.
  assert.ok(source.includes('if (rule.delaySeconds <= 0) immediate.push(rule);'), 'the zero-wait rule moved');
  // The switch's three kinds, and that `deferred` is granted by verify() rather than onJoin.
  assert.ok(source.includes('case "on_join":') && source.includes('case "after_duration":') && source.includes('case "after_verification":'));
  assert.ok(source.includes('// `deferred` (after_verification) is granted by verify(), not here.'));
  assert.ok(source.includes('for (const rule of sel.deferred) await this.deps.roles.grant(userId, rule.roleId, "verification");'));
});

test('autorole panel: the "nothing triggers verification" note is still true', () => {
  // The note in `autoroles-draft.ts` says the after_verification bucket never fires. That is a claim
  // about the WHOLE bot, so it is checked against the whole bot: `onVerified` is defined and never
  // called. Wire a verification flow and this fails — which is the point, because the note has to be
  // deleted in the same change, not discovered by an operator waiting for a role.
  const dir = new URL('../../../apps/discord-bot/src/', import.meta.url);
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  let callers = 0;
  for (const file of files) {
    for (const line of readFileSync(new URL(file, dir), 'utf8').split('\n')) {
      if (line.includes('onVerified(')) callers += 1;
    }
  }
  assert.equal(callers, 1, `onVerified has ${callers} mentions (expected only its definition): a verification flow now exists, so DEFERRED_NOTE must go`);
  assert.match(DEFERRED_NOTE, /no flow in it triggers verification/);
});
