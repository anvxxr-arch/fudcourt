/**
 * Custom commands: the reading rules, and the two contracts the panel mirrors.
 *
 * The GUARDS here read the other side of the wire — the bot's template engine and the api's own
 * limits — because a panel that advertises a variable the bot does not supply, or a limit the api
 * does not enforce, is a confident lie. Extraction asserts it found something before comparing, so a
 * pattern that stops matching fails loudly instead of passing on an empty set.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'bun:test';

import { fetchCustomCommands, saveCustomCommands, type CustomCommand } from '../src/features/admin/client';
import {
  EMBED_NOTE,
  GRAMMAR_NOTE,
  LIMITS,
  NAME_RE,
  NORMALISE_NOTE,
  RCE_NOTE,
  TOKEN,
  VARIABLES,
  fromDraft,
  placeholders,
  preview,
  responseKind,
  summarize,
  toDraft,
  triggerProblem,
  unknownPlaceholders,
} from '../src/features/admin/commands-view';

const botDir = new URL('../../discord-bot/src', import.meta.url).pathname;
const apiDir = new URL('../../api', import.meta.url).pathname;

function cmd(over: Partial<CustomCommand> = {}): CustomCommand {
  return {
    name: 'rules',
    aliases: ['rule'],
    responses: [{ text: 'Read {channel} rules, {user}.' }],
    allowedRoles: [],
    allowedChannels: [],
    cooldownSeconds: 0,
    deleteTrigger: false,
    reply: true,
    dm: false,
    enabled: true,
    ...over,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('commands: the read is a plain GET of the whole set', async () => {
  let seen: { url: string; method: string } | null = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), method: init?.method ?? 'GET' };
    return new Response(JSON.stringify({ commands: [cmd()] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const body = await fetchCustomCommands();
  assert.equal(seen!.url, '/api/admin/custom-commands');
  assert.equal(seen!.method, 'GET');
  assert.equal(body.commands?.length, 1);
  assert.equal(body.commands?.[0]?.name, 'rules');
});

test('commands: a save posts the WHOLE set, because that is what the api replaces', async () => {
  let seen: { url: string; method: string; body: string; type: string } | null = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
      type: new Headers(init?.headers).get('content-type') ?? '',
    };
    return new Response(JSON.stringify({ ok: true, commands: [cmd()] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const sent = [cmd({ enabled: false }), cmd({ name: 'site', aliases: [] })];
  const body = await saveCustomCommands(sent);

  assert.equal(seen!.url, '/api/admin/custom-commands');
  assert.equal(seen!.method, 'POST');
  assert.match(seen!.type, /application\/json/);
  assert.deepEqual(JSON.parse(seen!.body), { commands: sent });
  // The answer is the stored set (normalised) and is what the editor adopts.
  assert.equal(body.ok, true);
  assert.equal(body.commands?.[0]?.name, 'rules');
});

test('commands: a refusal arrives as the detail sentence', async () => {
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ detail: 'command 0: trigger "rules" already used by rules' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  await assert.rejects(() => fetchCustomCommands(), /already used/);
});

test('commands: only the engine\'s own grammar is treated as a token', () => {
  // The bot's TOKEN is `{([a-z_]+)}`: uppercase, hyphens and a lone brace are NOT tokens.
  assert.deepEqual(placeholders('hi {user}, {args} and {user} again'), ['user', 'args']);
  assert.deepEqual(placeholders('{Evil} {a-b} {'), []);
  // Nested braces are not special to the regex, so the INNER pair still matches — `{a{b}}` yields
  // the token `b`. The panel must see exactly what the engine sees, including this corner.
  assert.deepEqual(placeholders('{a{b}}'), ['b']);
  assert.deepEqual(unknownPlaceholders('{user} {bot} {oops} {bot}'), ['bot', 'oops']);
  assert.deepEqual(unknownPlaceholders('{Evil}{user}'), []);
});

test('commands: the variable table is exactly what the bot supplies', () => {
  const templates = readFileSync(`${botDir}/community/templates.ts`, 'utf8');
  const memberBlock = templates.slice(templates.indexOf('export function memberVars('));
  assert.ok(memberBlock.length > 0, 'memberVars not found — the guard\'s anchor moved');
  const memberKeys = [...memberBlock.slice(0, memberBlock.indexOf('};')).matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]!);
  assert.ok(memberKeys.length >= 6, `extracted ${memberKeys.length} member vars — the pattern stopped matching`);

  const service = readFileSync(`${botDir}/customcommands/service.ts`, 'utf8');
  const anchor = service.indexOf('return { ...base,');
  assert.ok(anchor >= 0, 'the vars() spread not found — the guard\'s anchor moved');
  // Slice to the END OF LINE, not to the first `}` — a template literal in the same line contains
  // one (`<#${m.channel_id}>`), and stripping template literals first leaves only real variable names.
  const spreadLine = service.slice(anchor, service.indexOf('\n', anchor));
  const extras = (spreadLine.replace('return { ...base,', '').replace(/`[^`]*`/g, '').match(/[a-z_]+/g) ?? []);
  assert.ok(extras.length >= 3, `extracted ${extras.length} extras (${extras.join(',')}) — the pattern stopped matching`);

  assert.deepEqual(
    [...VARIABLES.map((v) => v.name)].sort(),
    [...new Set([...memberKeys, ...extras])].sort(),
  );
});

test('commands: the token grammar and the limits mirror the runtime, not a guess', () => {
  const templates = readFileSync(`${botDir}/community/templates.ts`, 'utf8');
  // Extract by index, not by regex: matching `/\{` against a file that literally contains `\{` is a
  // backslash-escaping trap, and the pattern text is what has to be compared.
  const at = templates.indexOf('const TOKEN = /');
  assert.ok(at >= 0, 'the engine\'s TOKEN declaration not found');
  const start = at + 'const TOKEN = /'.length;
  const end = templates.indexOf('/g;', start);
  assert.ok(end > start, 'the end of the TOKEN declaration not found');
  assert.equal(templates.slice(start, end), TOKEN.source);

  const api = readFileSync(`${apiDir}/customcommands_handlers.go`, 'utf8');
  const num = (name: string): number => {
    const m = api.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
    assert.ok(m, `${name} not found in the api — the limit moved`);
    return Number(m![1]);
  };
  assert.equal(LIMITS.commands, num('maxCustomCommands'));
  assert.equal(LIMITS.aliases, num('maxAliases'));
  assert.equal(LIMITS.responses, num('maxResponses'));
  assert.equal(LIMITS.responseText, num('maxResponseText'));

  // Same index-of extraction for the trigger grammar (the comparative backtick is the trap here).
  const reAt = api.indexOf('var nameRe = regexp.MustCompile(`');
  assert.ok(reAt >= 0, 'the api\'s nameRe not found');
  const reStart = reAt + 'var nameRe = regexp.MustCompile(`'.length;
  const reEnd = api.indexOf('`)', reStart);
  assert.ok(reEnd > reStart, 'the end of the api\'s nameRe not found');
  assert.equal(NAME_RE.source, api.slice(reStart, reEnd));

  const schema = readFileSync(new URL('../../../db/schema/pg-schema.sql', import.meta.url).pathname, 'utf8');
  const cooldown = schema.match(/custom_commands_cooldown_chk CHECK \(cooldown_seconds >= 0 AND cooldown_seconds <= (\d+)\)/);
  assert.ok(cooldown, 'the cooldown check not found in the schema');
  assert.equal(LIMITS.cooldownSeconds, Number(cooldown![1]));
});

test('commands: the trigger namespace is shared between names and aliases, and said so', () => {
  assert.equal(triggerProblem([cmd()]), null);
  assert.match(String(triggerProblem([cmd(), cmd()])), /answered by two commands/);
  assert.match(String(triggerProblem([cmd(), cmd({ name: 'site', aliases: ['rules'] })])), /both an alias of site and a trigger of rules/);
  assert.match(String(triggerProblem([cmd({ name: 'Rules Now' })])), /1-32 chars/);
  assert.match(String(triggerProblem([cmd({ aliases: ['Bad Alias'] })])), /same grammar/);
  assert.match(String(triggerProblem([cmd({ responses: [] })])), /at least one response/);
  assert.match(String(triggerProblem([cmd({ aliases: Array.from({ length: 11 }, (_, i) => `a${i}`) })])), /at most 10 aliases/);
  // A duplicate alias inside ONE command is normalised away by the api, not an error here either.
  assert.equal(triggerProblem([cmd({ aliases: ['rule', 'rule', 'r2'] })]), null);
});

test('commands: a draft round-trips through the wire shape without inventing or losing fields', () => {
  const stored = cmd({ name: 'rules', aliases: ['rule', 'r2'], cooldownSeconds: 30 });
  const [row] = toDraft([stored]);
  assert.equal(row!.aliases, 'rule, r2');
  assert.equal(row!.cooldownSeconds, '30');

  const [back] = fromDraft([row!]);
  assert.equal(back!.name, 'rules');
  assert.deepEqual(back!.aliases, ['rule', 'r2']);
  assert.equal(back!.cooldownSeconds, 30);
  assert.deepEqual(back!.responses, [{ text: 'Read {channel} rules, {user}.' }]);
  assert.equal(back!.id, undefined);

  // And the encoder normalises what an operator TYPES, the way the api would.
  const [typed] = fromDraft([{ ...row!, name: '  Rules  ', aliases: ' RULE , rule , r9 ', cooldownSeconds: 'not a number' }]);
  assert.equal(typed!.name, 'rules');
  assert.deepEqual(typed!.aliases, ['rule', 'r9']);
  assert.equal(typed!.cooldownSeconds, 0);
});

test('commands: an embed is carried through untouched, and an empty response is dropped', () => {
  const withEmbed: CustomCommand = cmd({
    responses: [{ embed: { title: 'hi' } }, { text: 'both', embed: { title: 'x' } }, { text: '   ' }],
  });
  const [back] = fromDraft(toDraft([withEmbed]));
  // Embed-only keeps its embed and gains no text field; text+embed keeps both; the blank is gone
  // because the api would refuse an entry with neither, and this dashboard cannot fill an embed in.
  assert.deepEqual(back!.responses, [
    { embed: { title: 'hi' } },
    { text: 'both', embed: { title: 'x' } },
  ]);
  assert.equal(responseKind({ embed: { title: 'hi' } }), 'embed');
  assert.equal(responseKind({ text: 'x' }), 'text');
  assert.equal(responseKind({ text: 'x', embed: { title: 'y' } }), 'text + embed');
});

test('commands: previews stay one line, and the summary counts what an operator asks about', () => {
  assert.equal(preview('  a\n  b\t c  '), 'a b c');
  assert.equal(preview('x'.repeat(100)).length, 80);
  assert.ok(preview('x'.repeat(100)).endsWith('…'));
  assert.deepEqual(summarize([cmd(), cmd({ enabled: false }), cmd({ responses: [{ embed: {} }] })]), {
    total: 3,
    disabled: 1,
    embedded: 1,
  });
});

test('commands: the panel states the runtime property and the two editor behaviours', () => {
  // These are claims about the runtime, and they live here so a reader cannot miss them.
  assert.match(RCE_NOTE, /never code/);
  assert.match(RCE_NOTE, /no JavaScript, Lua, shell or SQL path/);
  assert.match(GRAMMAR_NOTE, /EXACTLY AS WRITTEN/);
  assert.match(NORMALISE_NOTE, /replaces the whole set/);
  assert.match(EMBED_NOTE, /preserved byte-for-byte/);
});
