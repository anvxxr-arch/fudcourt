// Template engine — the ONE renderer shared by welcome/goodbye, role-panel copy
// and (later) custom commands. It is pure: given a template string and a flat
// map of variable values it returns the substituted string, no client, no REST.
//
// Grammar is deliberately tiny — `{name}` where `name` is [a-z_]+ — so it cannot
// be a scripting surface: there is no expression evaluation, no function calls,
// no includes. Unknown placeholders are left VERBATIM (`{oops}` stays `{oops}`)
// rather than blanked, so an operator sees their typo in the dashboard preview
// instead of shipping a silent hole.
//
// Variable VALUES are pre-resolved strings. Resolving a member into the standard
// set is `memberVars` below; a feature that needs `{args}` just adds a key.

/** The flat name→value map a template renders against. */
export type TemplateVars = Readonly<Record<string, string>>;

// `{name}` — lowercase + underscore. The anchored, non-greedy body means a stray
// brace or a nested `{a{b}}` is NOT a token and is passed through untouched.
const TOKEN = /\{([a-z_]+)\}/g;

/**
 * renderTemplate substitutes every `{name}` whose name is present in `vars`.
 * A placeholder with no matching key is left exactly as written.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  if (!template) return "";
  return template.replace(TOKEN, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : whole,
  );
}

/**
 * A partial Discord embed whose string fields carry templates. Only the fields a
 * welcome/goodbye message plausibly sets are modelled; anything else the operator
 * stores is ignored rather than forwarded blindly.
 */
export interface TemplateEmbed {
  title?: string;
  description?: string;
  color?: number;
  footer?: { text?: string; icon_url?: string };
  author?: { name?: string; icon_url?: string };
  thumbnail?: { url?: string };
  image?: { url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

/**
 * renderEmbed templates every string field of an embed, recursively (title,
 * description, footer/author text, field names+values). Non-string fields
 * (color, inline) are copied through. Returns undefined for an absent embed so a
 * caller can `if (embed)` without a null check.
 */
export function renderEmbed(embed: TemplateEmbed | null | undefined, vars: TemplateVars): TemplateEmbed | undefined {
  if (!embed) return undefined;
  const r = (s: string | undefined): string | undefined => (s === undefined ? undefined : renderTemplate(s, vars));
  const out: TemplateEmbed = {};
  if (embed.title !== undefined) out.title = r(embed.title);
  if (embed.description !== undefined) out.description = r(embed.description);
  if (embed.color !== undefined) out.color = embed.color;
  if (embed.footer) out.footer = { text: r(embed.footer.text), icon_url: embed.footer.icon_url };
  if (embed.author) out.author = { name: r(embed.author.name), icon_url: embed.author.icon_url };
  if (embed.thumbnail) out.thumbnail = { url: embed.thumbnail.url };
  if (embed.image) out.image = { url: embed.image.url };
  if (embed.fields) {
    out.fields = embed.fields.map((f) => ({ name: renderTemplate(f.name, vars), value: renderTemplate(f.value, vars), inline: f.inline }));
  }
  return out;
}

/** The raw member facts `memberVars` needs; every field optional so a partial payload still renders. */
export interface MemberVarInput {
  userId: string;
  username: string;
  displayName?: string;
  guildName?: string;
  memberCount?: number;
  /** Account creation time, ISO-8601 or epoch ms as a string. */
  createdAt?: string;
}

/**
 * memberVars builds the standard variable set every community message can use:
 *   {user}         — mention (<@id>)
 *   {username}     — the account username
 *   {display_name} — the guild nickname, falling back to the username
 *   {server}       — the guild name
 *   {member_count} — the guild member count
 *   {created_at}   — the account creation time (Discord's <t:…:D> markdown)
 */
export function memberVars(input: MemberVarInput): TemplateVars {
  const display = input.displayName && input.displayName.length > 0 ? input.displayName : input.username;
  return {
    user: `<@${input.userId}>`,
    username: input.username,
    display_name: display,
    server: input.guildName ?? "",
    member_count: input.memberCount === undefined ? "" : String(input.memberCount),
    created_at: discordTimestamp(input.createdAt),
  };
}

/**
 * discordTimestamp turns an ISO string, an epoch-ms string, or a Discord
 * snowflake id into Discord's <t:…:D> markup; "" when unknown. A snowflake (the
 * account id) encodes its creation time, so `{created_at}` needs no API call.
 */
function discordTimestamp(createdAt: string | undefined): string {
  if (!createdAt) return "";
  const t = createdAt.trim();
  // A Discord snowflake is a 17-20 digit integer; its high bits are the epoch-ms
  // since 2015-01-01. Use BigInt — Number() would round a 18+ digit id.
  if (/^\d{17,20}$/.test(t)) {
    const ms = (BigInt(t) >> 22n) + 1420070400000n;
    return `<t:${ms / 1000n}:D>`;
  }
  let ms: number;
  const asNum = Number(t);
  if (Number.isFinite(asNum) && String(asNum) === t) {
    ms = asNum;
  } else {
    const parsed = Date.parse(t);
    if (!Number.isFinite(parsed)) return "";
    ms = parsed;
  }
  return `<t:${Math.floor(ms / 1000)}:D>`;
}
