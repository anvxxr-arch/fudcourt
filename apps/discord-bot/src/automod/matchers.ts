// AutoMod matcher engine — the pure core of the rule model.
//
// A rule is data (stored in Postgres, editable from the dashboard), not code:
//   event | matchers | exemptions | actions | cooldown
// Every matcher here is a pure function of (matcher, event, context), so the whole
// engine is unit-testable without a gateway, a database or Valkey. Persistence and
// delivery live in sibling modules; this file decides *what* a rule means.

export type AutomodEventKind = "message" | "member_join";

export type MatcherType =
  | "mentions"
  | "duplicate"
  | "caps"
  | "emoji"
  | "invite"
  | "url"
  | "blocked_domain"
  | "blocked_word"
  | "regex"
  | "attachment"
  | "new_account"
  | "rapid_join"
  | "spam";

export type AutomodAction =
  | "delete"
  | "warn"
  | "timeout"
  | "kick"
  | "ban"
  | "log_only"
  | "notify_mod"
  | "add_role"
  | "remove_role";

export interface MessageEvent {
  kind: "message";
  guildId: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  mentionIds: string[];
  roleIds: string[];
  attachments: number;
  /** epoch ms the author's account was created, when known. */
  accountCreatedAt?: number;
  /** The author's recent normalized messages, INCLUDING this one (duplicate/spam). */
  recentContents: string[];
}

export interface JoinEvent {
  kind: "member_join";
  guildId: string;
  userId: string;
  accountCreatedAt?: number;
  /** Joins in the burst window, including this one. */
  recentJoinCount: number;
}

export type AutomodEventData = MessageEvent | JoinEvent;

export interface Matcher {
  type: MatcherType;
  /** Count / ratio / age threshold. Matcher-specific default when omitted. */
  threshold?: number;
  /** Word list (blocked_word) or domain list (blocked_domain). */
  values?: string[];
  /** Regex source (regex matcher). */
  pattern?: string;
}

export interface AutomodRule {
  id: number;
  name: string;
  enabled: boolean;
  /** Higher fires first; ties keep insertion order. */
  priority: number;
  event: AutomodEventKind;
  /** ALL matchers must match (AND). An empty list never matches. */
  matchers: Matcher[];
  actions: AutomodAction[];
  exemptRoles: string[];
  exemptUsers: string[];
  exemptChannels: string[];
  cooldownSeconds: number;
  /** Duration for the `timeout` action, seconds. */
  timeoutSeconds?: number;
  /** Role id for add_role / remove_role. */
  roleId?: string;
}

export interface MatchContext {
  now: number;
  /** Deterministic anti-spam score for this message, when computed. */
  spamScore?: number;
  /** True when this (rule, user) pair is inside its cooldown window. */
  isCoolingDown?: (ruleId: number, userId: string) => boolean;
}

export interface FiredRule {
  rule: AutomodRule;
  actions: AutomodAction[];
  /** Human-readable, e.g. `automod "mass-mention": mentions>=7`. */
  reason: string;
}

/** Default thresholds — one place, so a rule can omit a number and stay sane. */
export const DEFAULTS = {
  mentions: 7,
  duplicate: 3,
  capsRatio: 0.7,
  capsMinLetters: 10,
  emoji: 5,
  attachment: 1,
  newAccountHours: 24,
  rapidJoin: 5,
  spam: 61,
} as const;

const INVITE_RE = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[A-Za-z0-9-]+/i;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const CUSTOM_EMOJI_RE = /<a?:\w{2,}:\d{15,}>/g;
const UNICODE_EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

/** normalize folds case + whitespace so "Hello  world" and "hello world" collide. */
export function normalize(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

export function countEmoji(content: string): number {
  const custom = content.match(CUSTOM_EMOJI_RE)?.length ?? 0;
  // Strip custom emoji first so their digits/letters are not counted twice.
  const bare = content.replace(CUSTOM_EMOJI_RE, "");
  const unicode = bare.match(UNICODE_EMOJI_RE)?.length ?? 0;
  return custom + unicode;
}

/** capsRatio is uppercase-letters / letters, or null when too few letters to judge. */
export function capsRatio(content: string): number | null {
  const letters = content.match(/[A-Za-z]/g);
  if (!letters || letters.length < DEFAULTS.capsMinLetters) return null;
  const upper = letters.filter((c) => c >= "A" && c <= "Z").length;
  return upper / letters.length;
}

/** extractUrls returns the absolute http(s) URLs in a message. */
export function extractUrls(content: string): string[] {
  return content.match(URL_RE) ?? [];
}

/** hostOf returns a URL's lowercase hostname, or null when it will not parse. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** domainMatches is true for an exact host or any subdomain of the blocked domain. */
export function domainMatches(host: string, blocked: string): boolean {
  const b = blocked.toLowerCase().replace(/^\./, "");
  return host === b || host.endsWith(`.${b}`);
}

/** matcherMatches evaluates one matcher against one event. Pure. */
export function matcherMatches(m: Matcher, ev: AutomodEventData, ctx: MatchContext): boolean {
  switch (m.type) {
    case "mentions":
      if (ev.kind !== "message") return false;
      return ev.mentionIds.length >= (m.threshold ?? DEFAULTS.mentions);

    case "duplicate": {
      if (ev.kind !== "message") return false;
      const norm = normalize(ev.content);
      if (norm.length === 0) return false;
      const count = ev.recentContents.filter((c) => normalize(c) === norm).length;
      return count >= (m.threshold ?? DEFAULTS.duplicate);
    }

    case "caps": {
      if (ev.kind !== "message") return false;
      const ratio = capsRatio(ev.content);
      return ratio !== null && ratio >= (m.threshold ?? DEFAULTS.capsRatio);
    }

    case "emoji":
      if (ev.kind !== "message") return false;
      return countEmoji(ev.content) >= (m.threshold ?? DEFAULTS.emoji);

    case "invite":
      return ev.kind === "message" && INVITE_RE.test(ev.content);

    case "url":
      return ev.kind === "message" && extractUrls(ev.content).length > 0;

    case "blocked_domain": {
      if (ev.kind !== "message") return false;
      const domains = m.values ?? [];
      if (domains.length === 0) return false;
      for (const url of extractUrls(ev.content)) {
        const host = hostOf(url);
        if (host && domains.some((d) => domainMatches(host, d))) return true;
      }
      return false;
    }

    case "blocked_word": {
      if (ev.kind !== "message") return false;
      const words = m.values ?? [];
      if (words.length === 0) return false;
      const hay = ev.content.toLowerCase();
      return words.some((w) => w.length > 0 && hay.includes(w.toLowerCase()));
    }

    case "regex": {
      if (ev.kind !== "message" || !m.pattern) return false;
      const re = compileSafeRegex(m.pattern);
      return re ? re.test(ev.content) : false;
    }

    case "attachment":
      return ev.kind === "message" && ev.attachments >= (m.threshold ?? DEFAULTS.attachment);

    case "new_account": {
      const created = ev.kind === "message" ? ev.accountCreatedAt : ev.accountCreatedAt;
      if (!created) return false;
      const ageHours = (ctx.now - created) / 3_600_000;
      return ageHours >= 0 && ageHours < (m.threshold ?? DEFAULTS.newAccountHours);
    }

    case "rapid_join":
      return ev.kind === "member_join" && ev.recentJoinCount >= (m.threshold ?? DEFAULTS.rapidJoin);

    case "spam":
      return ev.kind === "message" && (ctx.spamScore ?? 0) >= (m.threshold ?? DEFAULTS.spam);

    default:
      return false;
  }
}

/** The user a rule acts on, for exemptions and cooldown. */
function subjectId(ev: AutomodEventData): string {
  return ev.kind === "message" ? ev.authorId : ev.userId;
}

function isExempt(rule: AutomodRule, ev: AutomodEventData): boolean {
  const id = subjectId(ev);
  if (rule.exemptUsers.includes(id)) return true;
  if (ev.kind === "message") {
    if (rule.exemptChannels.includes(ev.channelId)) return true;
    if (ev.roleIds.some((r) => rule.exemptRoles.includes(r))) return true;
  }
  return false;
}

/** describe renders a matched rule for a case reason. */
function describe(rule: AutomodRule): string {
  const parts = rule.matchers.map((m) => {
    if (m.type === "blocked_word" || m.type === "blocked_domain") return `${m.type}[${(m.values ?? []).length}]`;
    if (m.type === "regex") return "regex";
    return m.threshold !== undefined ? `${m.type}>=${m.threshold}` : m.type;
  });
  return `automod "${rule.name}": ${parts.join(" & ")}`;
}

/**
 * evaluateRules returns the rules that fired, highest priority first. A rule fires
 * when it is enabled, for the event's kind, not exempt, not cooling down, and every
 * one of its matchers matches. An empty matcher list never fires (fail-safe).
 */
export function evaluateRules(
  rules: readonly AutomodRule[],
  ev: AutomodEventData,
  ctx: MatchContext,
): FiredRule[] {
  const fired: FiredRule[] = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.event !== ev.kind) continue;
    if (rule.matchers.length === 0) continue;
    if (isExempt(rule, ev)) continue;
    if (ctx.isCoolingDown?.(rule.id, subjectId(ev))) continue;
    if (!rule.matchers.every((m) => matcherMatches(m, ev, ctx))) continue;
    fired.push({ rule, actions: rule.actions, reason: describe(rule) });
  }
  return fired.sort((a, b) => b.rule.priority - a.rule.priority || a.rule.id - b.rule.id);
}

/** Bound on a user-supplied regex source — keeps a stored pattern from being a bomb. */
export const REGEX_MAX_LEN = 200;

/**
 * compileSafeRegex compiles a bounded regex, or returns null when the source is
 * too long or uses a nested-quantifier shape that can blow up (ReDoS). Callers treat
 * null as "no match" rather than crashing the hot path.
 */
export function compileSafeRegex(pattern: string): RegExp | null {
  if (pattern.length === 0 || pattern.length > REGEX_MAX_LEN) return null;
  // Reject the classic catastrophic shapes: a quantifier applied to a group that
  // itself ends in a quantifier, e.g. (a+)+ or (a*)* or (.*)*.
  if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern)) return null;
  if (/\([^)]*\)\{\d+,\}[+*]/.test(pattern)) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}
