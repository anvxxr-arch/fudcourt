/**
 * Welcome panel tests: run OFFLINE, no network, no DOM.
 *
 * Three things are worth pinning, in this order of importance:
 *
 *  1. THE PREVIEW AGREES WITH THE BOT. `welcome-template.ts` mirrors the bot's renderer, and a
 *     preview that quietly disagrees is worse than no preview: the operator ships a message they
 *     were shown and get a different one. So the first groups below replay the BOT'S OWN fixtures
 *     (`apps/discord-bot/tests/community-welcome.test.ts` — same member, same inputs, same expected
 *     strings), and two drift guards read the bot's source and fail if the grammar or the variable
 *     set stops matching this mirror.
 *  2. THE WIRE BODY. The api's endpoint takes the config as the body directly, and the worker-owned
 *     nothing here means the whole draft is sent — but the exact key set is still pinned, because
 *     the day a field is added to one side and not the other is the day this test earns its keep.
 *  3. THE COUNTING UNIT. The api counts code points; `String.length` counts UTF-16 code units, so
 *     the panel's counter has to agree with the api's unit or it is a counter that lies about emoji.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { HttpError } from '@/lib/fetch';
import { fetchWelcome, saveWelcome, type WelcomeConfig } from '@/features/admin/client';
import {
  BLANK,
  MAX_MESSAGE,
  VARIABLES,
  adoptedNote,
  fromConfig,
  runeCount,
  sampleFrom,
  toConfig,
  type WelcomeDraft,
} from '@/features/admin/welcome-draft';
import {
  colorHex,
  joinPreview,
  leavePreview,
  parseEmbedText,
  payloadFor,
  previewVars,
  renderEmbed,
  renderTemplate,
} from '@/features/admin/welcome-template';

// The bot's own fixture member (community-welcome.test.ts line 7), so the two implementations are
// compared on the same input rather than on two batteries that happen to look similar.
const BOT_MEMBER = { userId: '123', username: 'bob', displayName: 'Bobby', guildName: 'Fud', memberCount: '10' };

function draft(over: Partial<WelcomeDraft> = {}): WelcomeDraft {
  return { ...BLANK, ...over };
}

function welcomeConfig(over: Partial<WelcomeConfig> = {}): WelcomeConfig {
  return {
    joinEnabled: true,
    joinChannelId: '555000000000000005',
    joinMessage: 'welcome {user}',
    joinEmbed: null,
    joinDm: false,
    joinDmMessage: '',
    leaveEnabled: false,
    leaveChannelId: '',
    leaveMessage: '',
    leaveEmbed: null,
    ...over,
  };
}

test('welcome preview: the grammar leaves an unknown placeholder exactly as written', () => {
  // The bot's own documented choice: a typo must be VISIBLE in the preview, not silently blanked.
  assert.equal(renderTemplate('hi {username}', { username: 'bob' }), 'hi bob');
  assert.equal(renderTemplate('hello {oops}', { username: 'bob' }), 'hello {oops}');
  assert.equal(renderTemplate('{a{b}}', { a: 'x' }), '{a{b}}');
  assert.equal(renderTemplate('{UserName}', { UserName: 'x' }), '{UserName}');
  assert.equal(renderTemplate('', { a: 'x' }), '');
  assert.equal(renderTemplate('{user} and {user}', { user: '<@1>' }), '<@1> and <@1>');
  // An OWNED key whose value is empty substitutes to empty — the difference between "no value" and
  // "no such variable", which is what makes the verbatim rule safe.
  assert.equal(renderTemplate('[{server}]', { server: '' }), '[]');
});

test('welcome preview: the variable set matches the bot fixture', () => {
  const vars = previewVars({ ...BOT_MEMBER, userId: '1750000000000' });
  assert.equal(vars.user, '<@1750000000000>');
  assert.equal(vars.username, 'bob');
  assert.equal(vars.display_name, 'Bobby');
  assert.equal(vars.server, 'Fud');
  assert.equal(vars.member_count, '10');
  // The bot's fixture value for createdAt '1750000000000' is <t:1750000000:D>; the same rule is
  // applied here to the sample's id, because the panel derives {created_at} from the id.
  assert.equal(vars.created_at, '<t:1750000000:D>');
});

test('welcome preview: {created_at} comes from a snowflake with no lookup, and from nothing when unknown', () => {
  // 1080000000000000000 is a real-shaped snowflake; its epoch-ms is its high bits plus Discord's
  // 2015-01-01 epoch, which is 2023-02-28T05:34:25Z.
  assert.equal(previewVars(sampleFrom({ userId: '1080000000000000000' })).created_at, '<t:1677562465:D>');
  assert.equal(previewVars(sampleFrom({ userId: 'not-an-id' })).created_at, '');
  assert.equal(previewVars(sampleFrom({ userId: '' })).created_at, '');
  // An empty nickname falls back to the username, as the bot does.
  assert.equal(previewVars(sampleFrom({ displayName: '' })).display_name, 'dwi');
  // A member count that is not a number renders empty rather than "abc".
  assert.equal(previewVars(sampleFrom({ memberCount: 'many' })).member_count, '');
});

test('welcome preview: an embed keeps only the fields the bot renders', () => {
  const rendered = renderEmbed(
    {
      title: '{server}',
      description: 'welcome {display_name}',
      color: 5793266,
      footer: { text: '{member_count} members', icon_url: 'https://cdn.example/f.png' },
      author: { name: '{username}' },
      thumbnail: { url: 'https://cdn.example/t.png' },
      image: { url: 'https://cdn.example/i.png' },
      fields: [{ name: 'joined', value: '{created_at}', inline: true }],
      // Not in the bot's field set: its renderer drops these deliberately, so the preview must not
      // show them — a preview of a field that never ships is worse than no preview.
      url: 'https://example.com',
      timestamp: '2026-01-01T00:00:00Z',
    },
    previewVars(sampleFrom({ userId: '1750000000000' })),
  );
  assert.deepEqual(rendered, {
    title: 'Fudcourt',
    description: 'welcome dwi',
    color: 5793266,
    footer: { text: '128 members', icon_url: 'https://cdn.example/f.png' },
    author: { name: 'dwi', icon_url: undefined },
    thumbnail: { url: 'https://cdn.example/t.png' },
    image: { url: 'https://cdn.example/i.png' },
    fields: [{ name: 'joined', value: '<t:1750000000:D>', inline: true }],
  });
  assert.equal('url' in (rendered ?? {}), false);
});

test('welcome preview: a hand-edited embed row cannot crash the preview', () => {
  // The api refuses these now (validateEmbed), so this is defence for a row that got in another way
  // — the bot's own renderer has the same guard, which is why the mirror has one too.
  const rendered = renderEmbed({ title: 5, description: null, color: 'red', fields: [{ name: 7, value: null }] }, {});
  assert.deepEqual(rendered, { fields: [{ name: '', value: '', inline: false }] });
  assert.equal(colorHex(5793266), '#5865f2');
});

test('welcome preview: buildPayload drops an empty post and trims content', () => {
  const vars = previewVars(sampleFrom({ userId: '1750000000000' }));
  // The bot's fixtures: "hi {username}" + {title:"{server}"} → content + embed; "   " + no embed →
  // undefined ("no empty post").
  const both = payloadFor('hi {username}', { title: '{server}' }, vars);
  assert.equal(both?.content, 'hi dwi');
  assert.equal(both?.embed?.title, 'Fudcourt');
  assert.equal(payloadFor('   ', undefined, vars), undefined);
  // Whitespace is trimmed BEFORE the emptiness test, so a message of spaces is nothing.
  assert.equal(payloadFor('  \n  ', undefined, vars), undefined);
  // An embed whose only keys the bot ignores renders to nothing, so it is dropped too.
  assert.equal(payloadFor('', { url: 'https://example.com' }, vars), undefined);
  // Embed only: content is absent rather than an empty string.
  const embedOnly = payloadFor('   ', { title: 'hi' }, vars);
  assert.equal(embedOnly?.content, undefined);
  assert.equal(embedOnly?.embed?.title, 'hi');
  assert.equal(colorHex(0), '#000000');
});

test('welcome preview: the join preview accounts for the channel, the DM and both payloads', () => {
  const sample = sampleFrom({ userId: '1750000000000' });

  // Switched off is its own sentence — not an absence the operator has to infer.
  assert.match(joinPreview({ enabled: false, channelId: '', message: 'hi', embedText: '', dm: false, dmMessage: '' }, sample).silent ?? '', /switched off/);

  // Enabled with no channel: nothing posts, and the reason names the api's normalisation, because
  // that is the thing the operator will otherwise discover on the next reload.
  const noChannel = joinPreview({ enabled: true, channelId: '  ', message: 'hi {user}', embedText: '', dm: false, dmMessage: '' }, sample);
  assert.equal(noChannel.post, undefined);
  assert.match(noChannel.postAbsent ?? '', /no channel is set.*switches the setting off/);
  assert.match(noChannel.silent ?? '', /^the bot sends nothing on a join/);

  // A channel with a blank message and no embed: there is a place, but nothing to put in it.
  const empty = joinPreview({ enabled: true, channelId: '555000000000000005', message: '   ', embedText: '', dm: false, dmMessage: '' }, sample);
  assert.match(empty.postAbsent ?? '', /message is blank and the embed has no fields/);
  assert.equal(empty.silent !== undefined, true);

  // A real post, with the DM carrying the SAME embed — the bot passes one embed to both sends.
  const live = joinPreview(
    { enabled: true, channelId: '555000000000000005', message: 'welcome {user}', embedText: '{"title":"{server}"}', dm: true, dmMessage: 'hi {username}' },
    sample,
  );
  assert.equal(live.post?.content, 'welcome <@1750000000000>');
  assert.equal(live.post?.embed?.title, 'Fudcourt');
  assert.equal(live.dm?.content, 'hi dwi');
  assert.deepEqual(live.dm?.embed, live.post?.embed);
  assert.equal(live.dmAbsent, undefined);
  assert.equal(live.silent, undefined);

  // DM on but nothing to put in it, and DM off: two different sentences, both stated.
  const emptyDm = joinPreview({ enabled: true, channelId: '555000000000000005', message: 'hi', embedText: '', dm: true, dmMessage: ' ' }, sample);
  assert.match(emptyDm.dmAbsent ?? '', /message is blank and the embed has no fields/);
  assert.equal(emptyDm.silent, undefined);
  const noDm = joinPreview({ enabled: true, channelId: '555000000000000005', message: 'hi', embedText: '', dm: false, dmMessage: 'hi' }, sample);
  assert.equal(noDm.dmAbsent, 'the DM is switched off');
});

test('welcome preview: the goodbye preview has no DM path at all', () => {
  const sample = sampleFrom({ userId: '1750000000000' });
  const off = leavePreview({ enabled: false, channelId: '', message: 'bye', embedText: '' }, sample);
  assert.match(off.silent ?? '', /goodbye message is switched off/);

  const live = leavePreview({ enabled: true, channelId: '555000000000000005', message: 'bye {username}', embedText: '' }, sample);
  assert.equal(live.post?.content, 'bye dwi');
  assert.equal(live.dm, undefined);
  assert.equal(live.dmAbsent, 'a member who left cannot be DMed, so there is no goodbye DM');
  assert.equal(live.silent, undefined);
});

test('welcome preview: embed text that is not a JSON object is refused locally, with the api\'s rule', () => {
  const sample = sampleFrom();
  const input = { enabled: true, channelId: '555000000000000005', message: 'hi', embedText: '{oops}', dm: false, dmMessage: '' };
  const preview = joinPreview(input, sample);
  assert.equal(preview.post, undefined);
  assert.match(preview.embedError ?? '', /not valid JSON/);
  // Nothing else was evaluated: pretending the rest of the preview is meaningful would be a lie.
  assert.equal(preview.silent, undefined);

  assert.deepEqual(parseEmbedText(''), {});
  assert.match(parseEmbedText('{oops}').error ?? '', /not valid JSON/);
  assert.match(parseEmbedText('[1,2]').error ?? '', /must be a JSON object/);
  assert.match(parseEmbedText('null').error ?? '', /must be a JSON object/);
  assert.match(parseEmbedText('"hi"').error ?? '', /must be a JSON object/);
  assert.deepEqual(parseEmbedText(' {"a":1} '), { embed: { a: 1 } });
});

test('welcome draft: the counter counts code points, which is the unit the api counts', () => {
  assert.equal(runeCount('hello'), 5);
  // Two emoji are TWO characters to the api (`utf8.RuneCountInString`) and would read as four to
  // `String.length`, which is the bug this function exists to not have.
  assert.equal(runeCount('😀😀'), 2);
  assert.equal('😀😀'.length, 4);
  assert.equal(runeCount(''), 0);
  assert.equal(MAX_MESSAGE, 2000);
  // An emoji message at the limit is AT the limit, not double it.
  assert.equal(runeCount('😀'.repeat(MAX_MESSAGE)), MAX_MESSAGE);
});

test('welcome draft: the body is the config itself, with the channel ids trimmed and the text untouched', () => {
  const built = toConfig(
    draft({
      joinEnabled: true,
      joinChannelId: '  555000000000000005  ',
      joinMessage: '  welcome {user}  ',
      joinEmbedText: '{"title":"hi"}',
      joinDmMessage: 'hi',
      leaveEnabled: true,
      leaveChannelId: '555000000000000006',
      leaveMessage: 'bye',
    }),
  );
  assert.equal(built.embedError, undefined);
  assert.deepEqual(Object.keys(built.config ?? {}).sort(), [
    'joinChannelId',
    'joinDm',
    'joinDmMessage',
    'joinEmbed',
    'joinEnabled',
    'joinMessage',
    'leaveChannelId',
    'leaveEmbed',
    'leaveEnabled',
    'leaveMessage',
  ]);
  // The api trims the ids, so the body is trimmed here too: the value the operator sees is the
  // value that gets stored, and a trailing space cannot make two ids look different.
  assert.equal(built.config?.joinChannelId, '555000000000000005');
  // The MESSAGE is not trimmed: whitespace in a template may be deliberate, and the renderer trims
  // only the final content. Text in, text stored, trimmed at post time.
  assert.equal(built.config?.joinMessage, '  welcome {user}  ');
  assert.deepEqual(built.config?.joinEmbed, { title: 'hi' });
  // No embed text is the wire's own "no embed": null, never {} and never "".
  assert.equal(built.config?.leaveEmbed, null);
});

test('welcome draft: unparseable embed text yields an error and NO body', () => {
  const built = toConfig(draft({ joinEmbedText: 'not json' }));
  assert.equal(built.config, undefined);
  assert.match(built.embedError ?? '', /^join embed: /);
  const leave = toConfig(draft({ leaveEmbedText: '[1]' }));
  assert.equal(leave.config, undefined);
  assert.match(leave.embedError ?? '', /^goodbye embed: /);
});

test('welcome draft: a never-configured guild and a stored config both round-trip', () => {
  assert.deepEqual(fromConfig(null), BLANK);
  const stored = welcomeConfig({ joinDm: true, joinDmMessage: 'hi {username}', joinEmbed: { title: 'x' }, leaveEnabled: true, leaveChannelId: '555000000000000006', leaveMessage: 'bye' });
  const back = fromConfig(stored);
  assert.equal(back.joinDm, true);
  assert.equal(back.joinEmbedText, '{\n  "title": "x"\n}');
  // The round trip is what makes Save idempotent: draft → body → draft → body must not drift.
  assert.deepEqual(toConfig(back).config, stored);
});

test('welcome draft: the note explains only a change the api actually made', () => {
  const sent = welcomeConfig({ joinEnabled: true, joinChannelId: '' });
  const saved = { ...sent, joinEnabled: false };
  assert.match(adoptedNote(sent, saved) ?? '', /join message was switched off.*no channel set/);
  // Nothing changed: no note, because a note for an unchanged value is noise.
  assert.equal(adoptedNote(sent, sent), undefined);
  // The operator switched it off themselves — the api did not do it, so there is nothing to explain.
  const off = welcomeConfig({ joinEnabled: false });
  assert.equal(adoptedNote(off, { ...off, joinEnabled: false }), undefined);
  const leaveSent = welcomeConfig({ leaveEnabled: true, leaveChannelId: '' });
  assert.match(adoptedNote(leaveSent, { ...leaveSent, leaveEnabled: false }) ?? '', /goodbye message was switched off/);
});

test('welcome panel: the api client reads and writes the documented shape', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, welcome: welcomeConfig() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await fetchWelcome();
    assert.equal(calls[0].url, '/api/admin/welcome');
    assert.equal(calls[0].init?.cache, 'no-store', 'a cached read would show a config the bot no longer has');

    await saveWelcome(welcomeConfig({ joinChannelId: '555000000000000005' }));
    const post = calls[1];
    assert.equal(post.init?.method, 'POST');
    assert.equal((post.init?.headers as Record<string, string>)['Content-Type'], 'application/json');
    const body = JSON.parse(String(post.init?.body)) as Record<string, unknown>;
    // The config IS the body on this endpoint — there is no wrapper to unwrap, and inventing one
    // would put a second shape between the panel and the api.
    assert.equal('welcome' in body, false);
    assert.equal(body.joinChannelId, '555000000000000005');
    assert.equal(typeof body.joinEnabled, 'boolean');
  } finally {
    globalThis.fetch = real;
  }
});

test('welcome panel: a rejection arrives as the server\'s sentence', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ detail: 'joinEmbed.fields[0].value must be a string' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => saveWelcome(welcomeConfig()),
      (err: unknown) => {
        assert.ok(err instanceof HttpError, 'a refusal must be typed so a caller can branch on it');
        assert.equal(err.status, 400);
        // The path is the whole point of the sentence: it names the field the operator has to fix.
        assert.match(err.detail, /joinEmbed\.fields\[0\]\.value must be a string/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = real;
  }
});

test('welcome panel: the mirror still matches the bot\'s grammar and variable set', () => {
  const source = readFileSync(new URL('../../../apps/discord-bot/src/community/templates.ts', import.meta.url), 'utf8');
  // The grammar: the bot's token is /\{([a-z_]+)\}/g. Changing it there must fail here.
  assert.ok(source.includes('const TOKEN = /\\{([a-z_]+)\\}/g;'), 'the bot token regex moved');
  assert.equal(/\{([a-z_]+)\}/g.source, '\\{([a-z_]+)\\}');
  // The variable set: every name the palette offers must be one the bot actually resolves, and the
  // bot must not have grown one the palette hides.
  const names = VARIABLES.map((v) => v.name.slice(1, -1)).sort();
  assert.deepEqual(names, ['created_at', 'display_name', 'member_count', 'server', 'user', 'username']);
  for (const name of names) {
    assert.ok(source.includes(`${name}:`), `{${name}} is offered by the panel but not by the bot's memberVars`);
  }
  // `memberVars` is where those keys are built, and the doc block above it is what the palette's
  // descriptions were written from.
  assert.ok(source.includes('export function memberVars'));
  assert.ok(source.includes('export function renderTemplate'));
});

test('welcome panel: the api still refuses what the panel expects it to refuse', () => {
  // The mirror of the api's write path, pinned from THIS side: the panel quotes
  // `validateWelcome`/`validateEmbed` in its notes and its preview, so the sentences have to exist
  // in the source it is quoting.
  const source = readFileSync(new URL('../../../apps/api/community_handlers.go', import.meta.url), 'utf8');
  assert.ok(source.includes('must be a Discord id (digits only)'));
  assert.ok(source.includes('welcome messages must be 2000 characters or fewer'));
  assert.ok(source.includes('must be a JSON object'));
  assert.ok(source.includes('func validateEmbed'));
  // The count unit the panel's `runeCount` mirrors. If this ever goes back to `len(`, the counter
  // and the api disagree about emoji and this test should be the thing that says so.
  assert.ok(source.includes('utf8.RuneCountInString(w.JoinMessage)'));
  assert.equal(source.includes('if len(w.JoinMessage) > 2000'), false);
  // The normalisation the panel explains in `adoptedNote`.
  assert.ok(source.includes('a join message with no channel is a silent no-op'));
});
