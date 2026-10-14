// The welcome/goodbye templates, rendered for the dashboard's preview.
//
// This is a MIRROR of the bot's renderer — `apps/discord-bot/src/community/templates.ts` plus
// `buildPayload` in `welcome.ts` — and mirroring is a deliberate cost, not laziness: the engine
// ships inside the bot's bundle, the dashboard ships its own, and a preview is only worth having
// if it agrees with the code that will actually post the message. Two implementations of one
// grammar is a real risk, so the risk is pinned instead of hoped away:
//
//   • `tests/welcome-panel-tests.ts` replays the bot's OWN fixtures (same inputs, same expected
//     strings) against this file, and
//   • a drift guard reads the bot's source and fails if the token grammar or the variable set
//     stops matching this mirror.
//
// The grammar is the bot's, verbatim: `{name}` for `[a-z_]+`, and a placeholder with no value is
// left EXACTLY as written — `{oops}` stays `{oops}`. That is the bot's own choice, made so an
// operator sees their typo in this preview rather than shipping a silent hole. It is also the one
// behaviour a preview must not get wrong, so it is pinned twice.
//
// What this file deliberately does NOT do: validate the operator's text against the api's rules. A
// blank channel, a 2001-character message and a non-object embed are the api's refusals
// (`validateWelcome`/`validateEmbed`), and the panel shows those sentences. The one exception is
// JSON SYNTAX — a malformed embed cannot be sent at all, and a local refusal that quotes the same
// rule saves the operator a round trip without inventing a second opinion about what is allowed.

/** The flat name→value map a template renders against. */
export type TemplateVars = Readonly<Record<string, string>>;

// The bot's token: `{name}` with a lowercase + underscore body. A stray brace or a nested
// `{a{b}}` is not a token and passes through untouched.
const TOKEN = /\{([a-z_]+)\}/g;

/**
 * renderTemplate substitutes every `{name}` present in `vars`. A placeholder with no matching key
 * is left exactly as written — see the header, this is the behaviour the preview exists for.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  if (!template) return '';
  return template.replace(TOKEN, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : whole,
  );
}

/**
 * The embed fields the bot's renderer templates, and no others. An operator who puts `url` or
 * `timestamp` in the JSON gets them IGNORED by the bot ("rather than forwarded blindly", its own
 * words), so the preview ignores them too: showing them would preview something that never ships.
 */
export type PreviewEmbed = {
  title?: string;
  description?: string;
  color?: number;
  footer?: { text?: string; icon_url?: string };
  author?: { name?: string; icon_url?: string };
  thumbnail?: { url?: string };
  image?: { url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * renderEmbed templates every string field the bot templates, recursively, and copies `color` and
 * `inline` through. Non-string values are treated as absent rather than rendered: the api refuses
 * them now (`validateEmbed`), and a hand-edited row that got past it must still not crash the
 * preview — the bot's own `renderTemplate` has the same falsy guard for null.
 */
export function renderEmbed(embed: Record<string, unknown> | undefined, vars: TemplateVars): PreviewEmbed | undefined {
  if (embed === undefined) return undefined;
  const out: PreviewEmbed = {};
  const text = (value: unknown): string | undefined => {
    const s = asString(value);
    return s === undefined ? undefined : renderTemplate(s, vars);
  };

  const title = text(embed.title);
  if (title !== undefined) out.title = title;
  const description = text(embed.description);
  if (description !== undefined) out.description = description;
  if (typeof embed.color === 'number') out.color = embed.color;

  const footer = asObject(embed.footer);
  if (footer !== undefined) out.footer = { text: text(footer.text), icon_url: asString(footer.icon_url) };
  const author = asObject(embed.author);
  if (author !== undefined) out.author = { name: text(author.name), icon_url: asString(author.icon_url) };
  const thumbnail = asObject(embed.thumbnail);
  if (thumbnail !== undefined) out.thumbnail = { url: asString(thumbnail.url) };
  const image = asObject(embed.image);
  if (image !== undefined) out.image = { url: asString(image.url) };

  if (Array.isArray(embed.fields)) {
    out.fields = embed.fields.map((raw) => {
      const f = asObject(raw) ?? {};
      return { name: renderTemplate(asString(f.name) ?? '', vars), value: renderTemplate(asString(f.value) ?? '', vars), inline: f.inline === true };
    });
  }
  return out;
}

/** The facts the preview renders with; every field is the operator's to change. `sampleFrom` in
 *  `welcome-draft.ts` is the one place the defaults live, so the panel and the tests share them. */
export type SampleMember = {
  userId: string;
  username: string;
  displayName: string;
  guildName: string;
  memberCount: string;
};

/**
 * previewVars mirrors the bot's `memberVars`:
 *   {user}         — mention (<@id>)
 *   {username}     — the account username
 *   {display_name} — the nickname, falling back to the username
 *   {server}       — the server name
 *   {member_count} — the member count, or empty when the sample's is not a number
 *   {created_at}   — the account creation date, as Discord's localized date markup
 */
export function previewVars(sample: SampleMember): TemplateVars {
  const displayName = sample.displayName.trim() === '' ? sample.username : sample.displayName;
  const count = sample.memberCount.trim();
  return {
    user: `<@${sample.userId.trim()}>`,
    username: sample.username,
    display_name: displayName,
    server: sample.guildName,
    member_count: /^\d+$/.test(count) ? count : '',
    created_at: discordTimestamp(sample.userId),
  };
}

/**
 * discordTimestamp mirrors the bot's: a snowflake id (17–20 digits) encodes its epoch-ms in its
 * high bits, an all-digits string is epoch-ms, and anything else parses as a date. Unknown is "".
 *
 * Arithmetic in BigInt because a 19-digit id loses precision in `Number`. Written with `BigInt(x)`
 * calls rather than `22n` literals: this app's TypeScript target predates BigInt literals, and the
 * alternative — raising the target for a preview — would change how the whole dashboard compiles.
 * Same arithmetic as the bot; the parity test compares the output, which is what the operator sees.
 */
function discordTimestamp(value: string | undefined): string {
  if (!value) return '';
  const t = value.trim();
  if (/^\d{17,20}$/.test(t)) {
    const ms = (BigInt(t) >> BigInt(22)) + BigInt(1420070400000);
    return `<t:${ms / BigInt(1000)}:D>`;
  }
  let ms: number;
  const asNum = Number(t);
  if (Number.isFinite(asNum) && String(asNum) === t) {
    ms = asNum;
  } else {
    const parsed = Date.parse(t);
    if (!Number.isFinite(parsed)) return '';
    ms = parsed;
  }
  return `<t:${Math.floor(ms / 1000)}:D>`;
}

/** #rrggbb for an embed colour, so the preview can show the stripe the operator will get. */
export function colorHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * parseEmbedText applies the api's own rule to the embed textarea: empty means no embed, valid
 * JSON that is an OBJECT means an embed, and everything else is a refusal. The api says the same
 * thing (`must be a JSON object`), so a save is never sent with text the server would reject.
 */
export function parseEmbedText(text: string): { embed?: Record<string, unknown>; error?: string } {
  const t = text.trim();
  if (t === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return { error: 'the embed text is not valid JSON, and the api refuses a save it cannot parse' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'the embed must be a JSON object — the api refuses an array or a bare value' };
  }
  return { embed: parsed as Record<string, unknown> };
}

/** One thing the bot would send: content, an embed, or both. */
export type PreviewPayload = { content?: string; embed?: PreviewEmbed };

/**
 * payloadFor mirrors `buildPayload`: the content is TRIMMED, an embed that rendered to no fields is
 * DROPPED, and when both are gone there is no payload at all — the bot posts nothing rather than an
 * empty message. That last rule is why the preview can say "nothing would be sent" with confidence.
 */
export function payloadFor(
  message: string,
  embed: Record<string, unknown> | undefined,
  vars: TemplateVars,
): PreviewPayload | undefined {
  const content = renderTemplate(message, vars).trim();
  const rendered = renderEmbed(embed, vars);
  const out: PreviewPayload = {};
  if (content !== '') out.content = content;
  if (rendered !== undefined && Object.keys(rendered).length > 0) out.embed = rendered;
  return out.content !== undefined || out.embed !== undefined ? out : undefined;
}

/** What the bot would do with one direction of the config, and why it would not. */
export type DirectionPreview = {
  /** The channel post, when there would be one. */
  post?: PreviewPayload;
  /** Why there would be no channel post. */
  postAbsent?: string;
  /** The DM (join only; a member who left cannot be DMed). */
  dm?: PreviewPayload;
  /** Why there would be no DM. */
  dmAbsent?: string;
  /** Set when nothing at all would be sent — the sentence the panel leads with. */
  silent?: string;
  /** The operator's embed text cannot be sent; nothing else in the preview was evaluated. */
  embedError?: string;
};

export type WelcomeInput = {
  enabled: boolean;
  channelId: string;
  message: string;
  embedText: string;
};

export type JoinInput = WelcomeInput & { dm: boolean; dmMessage: string };

const NO_CHANNEL = 'no channel is set, so there is nowhere to post — saving it this way switches the setting off';
const NOTHING_TO_SEND = 'the message is blank and the embed has no fields the bot renders';

/** joinPreview mirrors `WelcomeService.onJoin`, including the DM carrying the SAME embed. */
export function joinPreview(input: JoinInput, sample: SampleMember): DirectionPreview {
  const parsed = parseEmbedText(input.embedText);
  if (parsed.error !== undefined) return { embedError: parsed.error };
  if (!input.enabled) return { silent: 'the bot sends nothing on a join: the join message is switched off.' };

  const vars = previewVars(sample);
  const channel = input.channelId.trim();
  const post = channel === '' ? undefined : payloadFor(input.message, parsed.embed, vars);
  const dm = input.dm ? payloadFor(input.dmMessage, parsed.embed, vars) : undefined;

  const out: DirectionPreview = {};
  if (post !== undefined) out.post = post;
  else out.postAbsent = channel === '' ? NO_CHANNEL : NOTHING_TO_SEND;
  if (dm !== undefined) out.dm = dm;
  else out.dmAbsent = input.dm ? NOTHING_TO_SEND : 'the DM is switched off';
  if (post === undefined && dm === undefined) {
    out.silent = `the bot sends nothing on a join: ${out.postAbsent}.`;
  }
  return out;
}

/** leavePreview mirrors `WelcomeService.onLeave`, which has no DM path at all. */
export function leavePreview(input: WelcomeInput, sample: SampleMember): DirectionPreview {
  const parsed = parseEmbedText(input.embedText);
  if (parsed.error !== undefined) return { embedError: parsed.error };
  if (!input.enabled) return { silent: 'the bot sends nothing on a leave: the goodbye message is switched off.' };

  const vars = previewVars(sample);
  const channel = input.channelId.trim();
  const post = channel === '' ? undefined : payloadFor(input.message, parsed.embed, vars);

  const out: DirectionPreview = { dmAbsent: 'a member who left cannot be DMed, so there is no goodbye DM' };
  if (post !== undefined) out.post = post;
  else out.postAbsent = channel === '' ? NO_CHANNEL : NOTHING_TO_SEND;
  if (post === undefined) out.silent = `the bot sends nothing on a leave: ${out.postAbsent}.`;
  return out;
}
