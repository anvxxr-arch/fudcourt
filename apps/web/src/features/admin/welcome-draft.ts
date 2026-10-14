import type { WelcomeConfig } from './client';
import { parseEmbedText, type SampleMember } from './welcome-template';

// The welcome/goodbye editor's draft: the ten fields the api stores, with the two embeds held as
// TEXT because that is how an operator writes them.
//
// This module owns exactly two things — the shape of a draft, and the shape of the body — and
// deliberately owns neither the render (welcome-template.ts) nor any of the api's rules. A blank
// channel, a 2001-character message, an embed field of the wrong type: all the SERVER's refusals,
// shown with the server's own words. The one local refusal is JSON SYNTAX, because text the api
// cannot parse cannot be sent at all, and saying so locally quotes the same rule instead of adding
// an opinion about it.

export type WelcomeDraft = {
  joinEnabled: boolean;
  joinChannelId: string;
  joinMessage: string;
  joinEmbedText: string;
  joinDm: boolean;
  joinDmMessage: string;
  leaveEnabled: boolean;
  leaveChannelId: string;
  leaveMessage: string;
  leaveEmbedText: string;
};

/** The api's limit, in the unit the api counts: `utf8.RuneCountInString`, i.e. code points. */
export const MAX_MESSAGE = 2000;

/**
 * runeCount is the counter the panel shows, and it must agree with the api's or the operator gets
 * a surprise at save time. `String.length` counts UTF-16 code units — an emoji is 2 there and 1
 * rune here — so a message full of emoji would read 4000 against the api's 2000. `Array.from`
 * iterates code points, which is the same unit Go counts.
 */
export function runeCount(text: string): number {
  return Array.from(text).length;
}

/**
 * The variables the engine resolves, with what each renders — for the panel's palette. Mirrored
 * from the bot's `memberVars`; `tests/welcome-panel-tests.ts` pins this list against that source.
 */
export const VARIABLES: { name: string; renders: string }[] = [
  { name: '{user}', renders: 'a mention of the member' },
  { name: '{username}', renders: 'the account username' },
  { name: '{display_name}', renders: 'the server nickname, falling back to the username' },
  { name: '{server}', renders: 'the server name' },
  { name: '{member_count}', renders: 'the member count' },
  { name: '{created_at}', renders: "the account's creation date, in Discord's localized date format" },
];

/** Offered as a button, not applied silently: an operator should never find message text they did
 *  not write. */
export const STARTER_JOIN = 'Welcome to {server}, {user}! You are member #{member_count}.';
export const STARTER_LEAVE = 'Goodbye {display_name} — thanks for being part of {server}.';

export const EMBED_HINT = 'JSON object, or empty for a plain message. Only the embed fields the bot renders are used: title, description, color, footer.text, author.name, thumbnail.url, image.url, fields[].name/value.';

/** A first draft for a guild that has never configured welcome: everything off, nothing written. */
export const BLANK: WelcomeDraft = {
  joinEnabled: false,
  joinChannelId: '',
  joinMessage: '',
  joinEmbedText: '',
  joinDm: false,
  joinDmMessage: '',
  leaveEnabled: false,
  leaveChannelId: '',
  leaveMessage: '',
  leaveEmbedText: '',
};

/** fromConfig builds the draft from the wire, or from a null ("never configured") row. */
export function fromConfig(config: WelcomeConfig | null): WelcomeDraft {
  if (config === null) return { ...BLANK };
  return {
    joinEnabled: config.joinEnabled,
    joinChannelId: config.joinChannelId,
    joinMessage: config.joinMessage,
    joinEmbedText: embedText(config.joinEmbed),
    joinDm: config.joinDm,
    joinDmMessage: config.joinDmMessage,
    leaveEnabled: config.leaveEnabled,
    leaveChannelId: config.leaveChannelId,
    leaveMessage: config.leaveMessage,
    leaveEmbedText: embedText(config.leaveEmbed),
  };
}

/** The stored embed as text the operator can edit: pretty-printed, because they will read it. */
function embedText(embed: Record<string, unknown> | null | undefined): string {
  if (embed === null || embed === undefined) return '';
  return JSON.stringify(embed, null, 2);
}

/**
 * toConfig turns the draft into the body. The embeds become objects or null — never the empty
 * string: the wire's own "no embed" is null, and the api's column is jsonb.
 *
 * A draft whose embed text cannot be parsed yields an error instead of a body, so a save is never
 * sent with text the api would refuse. The sentence is the same rule the api applies.
 */
export function toConfig(d: WelcomeDraft): { config?: WelcomeConfig; embedError?: string } {
  const join = parseEmbedText(d.joinEmbedText);
  if (join.error !== undefined) return { embedError: `join embed: ${join.error}` };
  const leave = parseEmbedText(d.leaveEmbedText);
  if (leave.error !== undefined) return { embedError: `goodbye embed: ${leave.error}` };

  return {
    config: {
      joinEnabled: d.joinEnabled,
      joinChannelId: d.joinChannelId.trim(),
      joinMessage: d.joinMessage,
      joinEmbed: join.embed ?? null,
      joinDm: d.joinDm,
      joinDmMessage: d.joinDmMessage,
      leaveEnabled: d.leaveEnabled,
      leaveChannelId: d.leaveChannelId.trim(),
      leaveMessage: d.leaveMessage,
      leaveEmbed: leave.embed ?? null,
    },
  };
}

/**
 * sampleFrom is the preview's sample member, and it is operator-editable because the preview's job
 * is to show THIS message with a plausible member in it: `{display_name}` behaves differently for a
 * long nickname, and a template that only looks right for a two-letter name is a template that will
 * ship broken.
 */
export function sampleFrom(over: Partial<SampleMember> = {}): SampleMember {
  return {
    userId: '1080000000000000000',
    username: 'dwi',
    displayName: 'dwi',
    guildName: 'Fudcourt',
    memberCount: '128',
    ...over,
  };
}

/**
 * adoptedNote explains a difference between what was sent and what came back, and it is the only
 * reason the panel compares the two at all.
 *
 * The api FORCES `joinEnabled` off when the channel is blank — a join message with nowhere to go is
 * a silent no-op that looks like a bug, so it normalises instead of rejecting. That is a mutation
 * the operator did not perform and would not otherwise see: the checkbox would simply flip off on
 * the next reload with no reason given. One case is worth a sentence; anything else the server
 * normalises is not (yet) a case the panel knows about, and guessing at a cause would be worse than
 * saying nothing.
 */
export function adoptedNote(sent: WelcomeConfig, saved: WelcomeConfig): string | undefined {
  if (sent.joinEnabled && !saved.joinEnabled) {
    return 'saved — the join message was switched off: with no channel set there is nowhere to post, so the api normalises it off rather than storing a message nobody can receive.';
  }
  if (sent.leaveEnabled && !saved.leaveEnabled) {
    return 'saved — the goodbye message was switched off: with no channel set there is nowhere to post.';
  }
  return undefined;
}
