// Minimal Discord API shapes — only the fields this bot reads or sends.
// Hand-rolled on purpose: the framework carries no discord.js dependency, so the
// types it needs are declared here rather than pulled from a package.

export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  Autocomplete: 4,
} as const;

export const InteractionCallbackType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5,
} as const;

export const ApplicationCommandOptionType = {
  SubCommand: 1,
  SubCommandGroup: 2,
  String: 3,
  Integer: 4,
  Boolean: 5,
  User: 6,
  Channel: 7,
  Role: 8,
  Number: 10,
} as const;

/** The three application-command kinds Discord registers separately. */
export const ApplicationCommandType = {
  ChatInput: 1,
  User: 2,
  Message: 3,
} as const;

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface GuildMember {
  user?: DiscordUser;
  nick?: string | null;
  roles: string[];
  joined_at?: string;
  /** Computed guild permissions bitfield (a decimal string) — present on an
   * interaction's `member`, which is the authoritative source for the actor. */
  permissions?: string;
}

export interface GuildRole {
  id: string;
  name: string;
  color: number;
  position: number;
  managed: boolean;
  permissions?: string;
}

export interface ApplicationCommandOption {
  name: string;
  description: string;
  type: number;
  required?: boolean;
  options?: ApplicationCommandOption[];
}

export interface ApplicationCommand {
  name: string;
  description: string;
  options?: ApplicationCommandOption[];
  default_member_permissions?: string | null;
  dm_permission?: boolean;
  /** 1 ChatInput (default), 2 User, 3 Message. Omitted for chat-input. */
  type?: number;
}

export interface APIEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface APIEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: APIEmbedField[];
  footer?: { text: string };
  timestamp?: string;
}

export interface InteractionData {
  id: string;
  name: string;
  type?: number;
  /** For USER (2) / MESSAGE (3) context commands: the target's id. */
  target_id?: string;
  options?: Array<{
    name: string;
    type: number;
    value?: string | number | boolean;
    options?: InteractionData["options"];
  }>;
  resolved?: {
    users?: Record<string, DiscordUser>;
    members?: Record<string, GuildMember>;
    roles?: Record<string, GuildRole>;
    /** Present on a MESSAGE context command — the target message + its author. */
    messages?: Record<string, { id: string; author?: DiscordUser; channel_id?: string; content?: string }>;
  };
  /** MESSAGE_COMPONENT (3): the clicked component's custom_id (buttons/selects). */
  custom_id?: string;
  /** MESSAGE_COMPONENT (3) select menus: the chosen option values. */
  values?: string[];
  /** MESSAGE_COMPONENT (3): the component type (2 = button, 3 = select). */
  component_type?: number;
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  data?: InteractionData;
  guild_id?: string;
  channel_id?: string;
  member?: GuildMember;
  user?: DiscordUser;
  token: string;
}

/** A message emoji: `{ name }` for a unicode emoji, `{ name, id }` for a custom one. */
export interface APIEmoji {
  name?: string;
  id?: string;
}

/**
 * Message COMPONENT types (not interaction types). A message carries up to five
 * action rows; a row carries up to five buttons or ONE select menu.
 */
export const ComponentType = { ActionRow: 1, Button: 2, StringSelect: 3 } as const;

/** Button styles, as Discord numbers them (the schema stores the names). */
export const ButtonStyle = { Primary: 1, Secondary: 2, Success: 3, Danger: 4 } as const;

export interface ButtonComponent {
  type: 2;
  style: number;
  custom_id: string;
  label?: string;
  emoji?: APIEmoji;
  disabled?: boolean;
}

export interface SelectOptionComponent {
  label: string;
  value: string;
  emoji?: APIEmoji;
  default?: boolean;
}

export interface StringSelectComponent {
  type: 3;
  custom_id: string;
  options: SelectOptionComponent[];
  min_values?: number;
  max_values?: number;
  placeholder?: string;
  disabled?: boolean;
}

export interface ActionRow {
  type: 1;
  components: Array<ButtonComponent | StringSelectComponent>;
}

export interface InteractionCallbackData {
  content?: string;
  embeds?: APIEmbed[];
  ephemeral?: boolean;
  flags?: number;
  allowed_mentions?: { parse: string[] };
  /** Post as a reply to this message (channel messages, not interactions). */
  message_reference?: { message_id: string };
  /** Buttons and select menus. Without this a role panel could be configured but
   * never POSTED — the REST layer could only carry text. */
  components?: ActionRow[];
}

export interface ReadyPayload {
  v: number;
  user: DiscordUser;
  guilds: Array<{ id: string; unavailable?: boolean }>;
  session_id: string;
  resume_gateway_url?: string;
  application?: { id: string; flags?: number };
}

/** The subset of a MESSAGE_CREATE payload AutoMod reads. */
export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  author?: DiscordUser;
  /** Users mentioned in the message (each carries an id). */
  mentions?: Array<{ id: string }>;
  /** Role ids mentioned (for exempt-role evaluation). */
  mention_roles?: string[];
  attachments?: unknown[];
  /** Present on a guild message — the author's member record (roles). */
  member?: GuildMember;
}

/** The subset of a GUILD_MEMBER_ADD payload AutoMod reads. */
export interface MemberAddPayload {
  user?: DiscordUser;
  nick?: string | null;
  roles?: string[];
  joined_at?: string;
  guild_id?: string;
}

/** Ephemeral flag bit (1 << 6) — used to make a reply visible only to the caller. */
export const EPHEMERAL_FLAG = 1 << 6;
