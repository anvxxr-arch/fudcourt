import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_STYLE,
  LIMITS,
  OPTION_STYLES,
  PANEL_KINDS,
  PANEL_MODES,
  deadReactionOptions,
  describeKind,
  describeMode,
  duplicateRoleIds,
  emojiKey,
  fromDraft,
  groups,
  isSnowflake,
  normalisedEmojiOptions,
  panelProblem,
  summarize,
  toDraft,
  type OptionDraft,
  type PanelDraft,
} from '../src/features/admin/role-panels-view';
import { fetchRolePanels, saveRolePanels, type RolePanel } from '../src/features/admin/client';

/**
 * Role panels: the encoding rules, the problems only this editor can see, and the mirrors.
 *
 * The GUARDS read the other side of the wire — the api's enum maps and validator, the schema's CHECK
 * constraints, and the bot's own selection logic — because three claims here are about code that does
 * not live in this app: what each mode does, how an emoji is matched, and who refuses a bad write.
 */

const root = new URL('../../../', import.meta.url).pathname;
const read = (p: string): string => readFileSync(`${root}${p}`, 'utf8');
const apiHandlers = read('apps/api/community_handlers.go');
const schema = read('db/schema/pg-schema.sql');
const botPanel = read('apps/discord-bot/src/community/panel.ts');
const botPanels = read('apps/discord-bot/src/community/panels.ts');

/** cut returns the text between two anchors, asserting both were found so a moved anchor fails. */
function cut(src: string, from: string, to: string): string {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `anchor not found: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j > i, `closing anchor not found after: ${from}`);
  return src.slice(i + from.length, j);
}

/** num pulls one group out of a pattern, asserting the pattern still matches. */
function num(src: string, re: RegExp, group: number, what: string): number {
  const m = src.match(re);
  assert.ok(m?.[group] !== undefined, `pattern stopped matching: ${what}`);
  return Number(m[group]);
}

const opt = (over: Partial<OptionDraft> = {}): OptionDraft => ({
  roleId: '100000000000000010',
  label: '',
  emoji: '',
  style: 'primary',
  exclusiveGroup: '',
  ...over,
});

function draft(over: Partial<PanelDraft> = {}): PanelDraft {
  return {
    id: 'colors',
    channelId: '',
    messageId: '',
    title: '',
    description: '',
    kind: 'button',
    mode: 'toggle',
    enabled: true,
    options: [{ roleId: '100000000000000010', label: 'Red', emoji: '', style: 'primary', exclusiveGroup: '' }],
    ...over,
  };
}

function panel(over: Partial<RolePanel> = {}): RolePanel {
  return { id: 'colors', kind: 'button', mode: 'toggle', options: [], ...over };
}

// ---------------------------------------------------------------- mirrors

test('role-panels: the kind, mode and style sets are the ones the api and the DB accept', () => {
  const members = (block: string): string[] => [...block.matchAll(/"([a-z]+)": true/g)].map((m) => m[1]!);
  const apiKinds = members(cut(apiHandlers, 'var panelKinds = map[string]bool{', '}'));
  const apiModes = members(cut(apiHandlers, 'var panelModes = map[string]bool{', '}'));
  assert.ok(apiKinds.length >= 3, 'kind extraction found nothing');
  assert.ok(apiModes.length >= 4, 'mode extraction found nothing');
  assert.deepEqual([...PANEL_KINDS].sort(), [...apiKinds].sort());
  assert.deepEqual([...PANEL_MODES].sort(), [...apiModes].sort());

  // style is not validated by the api at all — the DB CHECK is the only authority.
  const check = cut(schema, 'role_panel_options_style_chk CHECK (style IN (', ')');
  const styles = [...check.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
  assert.ok(styles.length >= 4, 'style extraction found nothing');
  assert.deepEqual([...OPTION_STYLES].sort(), [...styles].sort());
  assert.ok(styles.includes(DEFAULT_STYLE), 'the default style must be one the DB accepts');
});

test('role-panels: the limits are the api\u2019s numbers, extracted from its validator', () => {
  const body = cut(apiHandlers, 'func validatePanels(panels []rolePanel) string {', '\n}\n');
  assert.ok(body.includes('len(p.ID) > '), 'validator shape changed');
  const labelEmoji = /len\(o\.Label\) > (\d+) \|\| len\(o\.Emoji\) > (\d+)/;
  assert.ok(labelEmoji.test(body), 'label/emoji comparison not found');
  assert.equal(LIMITS.panels, num(body, /len\(panels\) > (\d+)/, 1, 'panel cap'));
  assert.equal(LIMITS.idLength, num(body, /len\(p\.ID\) > (\d+)/, 1, 'id cap'));
  assert.equal(LIMITS.options, num(body, /len\(p\.Options\) > (\d+)/, 1, 'option cap'));
  assert.equal(LIMITS.label, num(body, labelEmoji, 1, 'label cap'));
  assert.equal(LIMITS.emoji, num(body, labelEmoji, 2, 'emoji cap'));
});

test('role-panels: isSnowflake is the api\u2019s 15..21 digit rule, not a guess', () => {
  const fn = cut(read('apps/api/admin_settings.go'), 'func isSnowflake(v string) bool {', '\n}\n');
  const bounds = /len\(v\) < (\d+) \|\| len\(v\) > (\d+)/;
  assert.ok(bounds.test(fn), 'the api\u2019s bounds changed shape');
  const lo = num(fn, bounds, 1, 'lower bound');
  const hi = num(fn, bounds, 2, 'upper bound');
  const cases: [string, boolean][] = [
    ['1'.repeat(lo), true],
    ['1'.repeat(lo - 1), false],
    ['1'.repeat(hi), true],
    ['1'.repeat(hi + 1), false],
    ['', false],
    [`${'1'.repeat(lo - 1)}a`, false],
    [` ${'1'.repeat(lo)}`, false],
  ];
  for (const [v, want] of cases) assert.equal(isSnowflake(v), want, `isSnowflake(${JSON.stringify(v)})`);
});

test('role-panels: each mode\u2019s description matches a real branch in the bot\u2019s pickOption', () => {
  for (const mode of PANEL_MODES) {
    assert.ok(describeMode(mode).length > 20, `${mode} has no copy`);
    assert.ok(botPanel.includes(`case "${mode}"`), `${mode} is not a branch in pickOption`);
  }
  // `exclusive` is the only mode scoped by exclusiveGroup — the copy claims exactly that.
  assert.ok(
    botPanel.includes('o.exclusiveGroup === option.exclusiveGroup'),
    'exclusive scoping changed; the description says it revokes only the same group',
  );
  // A select submission replaces the member's whole panel-role set, which the copy states.
  assert.ok(botPanels.includes('applySelect(panel, values, held)'), 'select path changed');
  assert.ok(
    botPanel.includes('if (!chosenSet.has(o.roleId) && held.includes(o.roleId)) remove.push(o.roleId);'),
    'applySelect no longer revokes unselected panel roles; the select copy is wrong',
  );
  for (const kind of PANEL_KINDS) assert.ok(describeKind(kind).length > 20, `${kind} has no copy`);
});

test('role-panels: emojiKey agrees with the bot\u2019s own derivation for custom emoji', () => {
  // The bot's emojiKey returns `${name}:${id}` for a custom emoji; the editor must agree, because the
  // option lookup is an EXACT string compare against the option's stored emoji.
  assert.ok(
    botPanels.includes('return `${emoji.name ?? ""}:${emoji.id}`;'),
    'the bot\u2019s emoji key derivation changed',
  );
  assert.equal(emojiKey('<:rules:1234567890>'), 'rules:1234567890');
  assert.equal(emojiKey('<a:spin:99>'), 'spin:99');
  assert.equal(emojiKey('rules:1234567890'), 'rules:1234567890');
  assert.equal(emojiKey(' 👍 '), '👍');
  assert.equal(emojiKey(''), '');
  assert.equal(emojiKey('<:broken:>'), '<:broken:>');
});

// ---------------------------------------------------------------- encoding

test('role-panels: toDraft fills the defaults the wire omits, and keeps what is stored', () => {
  const [row] = toDraft([panel({ options: [opt({ style: 'danger' })] })]);
  assert.equal(row!.kind, 'button');
  assert.equal(row!.mode, 'toggle');
  assert.equal(row!.enabled, true);
  assert.equal(row!.channelId, '');
  assert.equal(row!.options[0]!.style, 'danger');
  assert.equal(row!.options[0]!.emoji, '');
  const [off] = toDraft([panel({ enabled: false, mode: 'exclusive', channelId: '100000000000000010' })]);
  assert.equal(off!.enabled, false);
  assert.equal(off!.mode, 'exclusive');
  assert.equal(off!.channelId, '100000000000000010');
});

test('role-panels: fromDraft owns position and repairs style, because the api validates neither', () => {
  const rows = [
    draft({
      id: '  colors  ',
      options: [
        { roleId: '100000000000000010', label: 'A', emoji: '', style: 'primary', exclusiveGroup: '' },
        { roleId: '   ', label: 'ghost', emoji: '', style: 'primary', exclusiveGroup: '' },
        { roleId: '100000000000000011', label: 'B', emoji: '', style: 'Bogus', exclusiveGroup: '' },
        { roleId: '100000000000000012', label: 'C', emoji: '', style: '', exclusiveGroup: '' },
      ],
    }),
  ];
  const out = fromDraft(rows);
  assert.equal(out[0]!.id, 'colors');
  assert.deepEqual(
    out[0]!.options.map((o) => [o.roleId, o.position]),
    [
      ['100000000000000010', 0],
      ['100000000000000011', 1],
      ['100000000000000012', 2],
    ],
  );
  assert.equal(out[0]!.options[1]!.style, DEFAULT_STYLE);
  assert.equal(out[0]!.options[2]!.style, DEFAULT_STYLE);
});

// ---------------------------------------------------------------- the problems only this editor sees

test('role-panels: the pre-check never refuses what the api accepts', () => {
  // The api's validator does NOT look at style or an empty emoji: these must pass the pre-check and be
  // FLAGGED instead. A pre-check stricter than the api blocks a save the api would have taken.
  const pending = fromDraft([draft({ options: [{ roleId: '100000000000000010', label: '', emoji: '', style: '', exclusiveGroup: '' }] })]);
  assert.equal(panelProblem(pending), null);
  const [row] = toDraft(pending);
  assert.deepEqual(deadReactionOptions({ ...row!, kind: 'reaction' }), [0]);
  assert.deepEqual(deadReactionOptions(row!), [], 'a button option needs no emoji');
});

test('role-panels: a panel with its optional fields missing is checked, not crashed on', () => {
  // The wire type has every field but `id` optional, and `undefined !== ''` is true — so a missing
  // channelId used to reach isSnowflake(undefined) and throw. Lock that in.
  assert.equal(panelProblem([{ id: 'x', kind: 'button', mode: 'toggle' }]), 'panel 0: at least one option is required');
  assert.equal(
    panelProblem([{ id: 'x', kind: 'button', mode: 'toggle', options: [{ roleId: '123' }] }]),
    'panel 0 option 0: roleId must be a Discord id',
  );
  assert.equal(
    panelProblem([{ id: 'x', kind: 'button', mode: 'toggle', options: [{ roleId: '100000000000000010' }] }]),
    null,
  );
});

test('role-panels: the pre-check repeats the api\u2019s own sentences', () => {
  const cases: [RolePanel[], string | null][] = [
    [[panel()], 'panel 0: at least one option is required'],
    [[panel({ id: '' })], `panel 0: id is required (<= ${LIMITS.idLength} chars)`],
    [[panel({ id: 'x'.repeat(LIMITS.idLength + 1) })], `panel 0: id is required (<= ${LIMITS.idLength} chars)`],
    [[panel({ id: 'a', options: [opt()] }), panel({ id: 'a', options: [opt()] })], 'panel 1: duplicate id a'],
    [[panel({ kind: 'vibes' })], 'panel 0: kind must be reaction, button or select'],
    [[panel({ mode: 'vibes' })], 'panel 0: mode must be toggle, single, multiple or exclusive'],
    [[panel({ channelId: '123' })], 'panel 0: channelId must be a Discord id'],
    [[panel({ options: [opt({ roleId: '123' })] })], 'panel 0 option 0: roleId must be a Discord id'],
    [[panel({ options: [opt(), opt()] })], 'panel 0 option 1: duplicate roleId 100000000000000010'],
    [[panel({ options: [opt({ label: 'l'.repeat(LIMITS.label + 1) })] })], 'panel 0 option 0: label/emoji too long'],
    [[panel({ options: [opt({ emoji: 'e'.repeat(LIMITS.emoji + 1) })] })], 'panel 0 option 0: label/emoji too long'],
  ];
  for (const [panels, want] of cases) assert.equal(panelProblem(panels), want);

  const tooMany = Array.from({ length: LIMITS.panels + 1 }, (_, i) => panel({ id: `p${i}` }));
  assert.equal(panelProblem(tooMany), `at most ${LIMITS.panels} role panels`);
  const tooManyOptions = panel({
    options: Array.from({ length: LIMITS.options + 1 }, (_, i) => opt({ roleId: `1000000000000000${10 + i}` })),
  });
  assert.equal(panelProblem([tooManyOptions]), `panel 0: at most ${LIMITS.options} options`);

  // The happy path, including the two things the api accepts and this editor merely flags.
  assert.equal(panelProblem([panel({ id: 'colors', options: [opt({ style: '', emoji: '' })] })]), null);
  assert.equal(panelProblem([]), null, 'removing every panel is a legitimate save');
});

test('role-panels: a dead reaction option and a pasted emoji are flagged, not silently kept', () => {
  const row = draft({
    kind: 'reaction',
    options: [
      { roleId: '100000000000000010', label: 'A', emoji: '👍', style: 'secondary', exclusiveGroup: '' },
      { roleId: '100000000000000011', label: 'B', emoji: '', style: 'secondary', exclusiveGroup: '' },
      { roleId: '100000000000000012', label: 'C', emoji: '<:rules:1234567890>', style: 'secondary', exclusiveGroup: '' },
    ],
  });
  assert.deepEqual(deadReactionOptions(row), [1]);
  assert.deepEqual(normalisedEmojiOptions(row), [2]);
  assert.equal(emojiKey(row.options[2]!.emoji), 'rules:1234567890');
  assert.deepEqual(normalisedEmojiOptions(draft({ options: [{ roleId: '100000000000000010', label: '', emoji: 'rules:1234567890', style: '', exclusiveGroup: '' }] })), []);
});

test('role-panels: exclusive groups are shown, and the blank group is named', () => {
  const row = draft({
    mode: 'exclusive',
    options: [
      opt({ roleId: '100000000000000010', label: 'Red', exclusiveGroup: 'color' }),
      opt({ roleId: '100000000000000011', label: 'Blue', exclusiveGroup: 'color' }),
      opt({ roleId: '100000000000000012', label: 'On', style: 'secondary' }),
    ],
  });
  assert.deepEqual(groups(row), [
    { name: 'color', count: 2, blank: false },
    { name: '(ungrouped)', count: 1, blank: true },
  ]);
  assert.deepEqual(duplicateRoleIds(row), []);
  const dupe = draft({ options: [opt(), opt()] });
  assert.deepEqual(duplicateRoleIds(dupe), ['100000000000000010']);
});

test('role-panels: summarize counts the kinds and the switched-off panels', () => {
  const rows = [
    draft({ id: 'a', kind: 'reaction' }),
    draft({ id: 'b', kind: 'reaction', enabled: false }),
    draft({ id: 'c', kind: 'select' }),
  ];
  assert.deepEqual(summarize(rows), { total: 3, disabled: 1, byKind: { reaction: 2, select: 1 } });
});

// ---------------------------------------------------------------- wire

test('role-panels: the read is a GET and the save posts the whole set', async () => {
  const real = globalThis.fetch;
  const seen: { url: string; method: string; body: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(JSON.stringify({ ok: true, panels: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  try {
    const view = await fetchRolePanels();
    assert.deepEqual(view.panels, []);
    assert.equal(seen[0]!.method, 'GET');
    assert.ok(seen[0]!.url.endsWith('/api/admin/role-panels'));

    const sent = fromDraft([draft()]);
    const answer = await saveRolePanels(sent);
    assert.equal(seen[1]!.method, 'POST');
    assert.deepEqual(JSON.parse(seen[1]!.body), { panels: sent });
    assert.equal(answer.ok, true);
  } finally {
    globalThis.fetch = real;
  }
});

test('role-panels: a refusal surfaces the api\u2019s detail', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ detail: 'panel 0: at least one option is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  try {
    await assert.rejects(() => saveRolePanels([]), /at least one option/);
  } finally {
    globalThis.fetch = real;
  }
});
