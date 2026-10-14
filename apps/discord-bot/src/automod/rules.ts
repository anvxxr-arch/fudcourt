// Rule parsing/validation — the gate between an operator-authored JSON row and the
// typed rule the engine trusts. Anything that fails validation is rejected BEFORE it
// is stored, so a malformed or hostile rule can never reach the message hot path.

import {
  compileSafeRegex,
  type AutomodAction,
  type AutomodEventKind,
  type AutomodRule,
  type Matcher,
  type MatcherType,
} from "./matchers.ts";

export const MATCHER_TYPES: readonly MatcherType[] = [
  "mentions",
  "duplicate",
  "caps",
  "emoji",
  "invite",
  "url",
  "blocked_domain",
  "blocked_word",
  "regex",
  "attachment",
  "new_account",
  "rapid_join",
  "spam",
];

export const ACTION_TYPES: readonly AutomodAction[] = [
  "delete",
  "warn",
  "timeout",
  "kick",
  "ban",
  "log_only",
  "notify_mod",
  "add_role",
  "remove_role",
];

export const EVENT_KINDS: readonly AutomodEventKind[] = ["message", "member_join"];

export class RuleValidationError extends Error {}

function asStringArray(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RuleValidationError(`${field} must be an array`);
  return v.map((x) => {
    if (typeof x !== "string") throw new RuleValidationError(`${field} entries must be strings`);
    return x;
  });
}

function parseMatcher(raw: unknown, i: number): Matcher {
  if (!raw || typeof raw !== "object") throw new RuleValidationError(`matchers[${i}] must be an object`);
  const m = raw as Record<string, unknown>;
  const type = m.type;
  if (typeof type !== "string" || !MATCHER_TYPES.includes(type as MatcherType)) {
    throw new RuleValidationError(`matchers[${i}].type "${String(type)}" is not a known matcher`);
  }
  const out: Matcher = { type: type as MatcherType };
  if (m.threshold !== undefined) {
    if (typeof m.threshold !== "number" || !Number.isFinite(m.threshold) || m.threshold < 0) {
      throw new RuleValidationError(`matchers[${i}].threshold must be a non-negative number`);
    }
    out.threshold = m.threshold;
  }
  if (type === "blocked_word" || type === "blocked_domain") {
    const values = asStringArray(m.values, `matchers[${i}].values`);
    if (values.length === 0) throw new RuleValidationError(`matchers[${i}] (${type}) needs a non-empty values list`);
    out.values = values;
  }
  if (type === "regex") {
    if (typeof m.pattern !== "string" || m.pattern.length === 0) {
      throw new RuleValidationError(`matchers[${i}] (regex) needs a pattern`);
    }
    if (compileSafeRegex(m.pattern) === null) {
      throw new RuleValidationError(`matchers[${i}].pattern is rejected (too long, invalid, or a ReDoS shape)`);
    }
    out.pattern = m.pattern;
  }
  return out;
}

/**
 * parseRule validates one raw rule row and returns the typed rule. It throws
 * RuleValidationError with a specific message on the first problem it finds.
 */
export function parseRule(raw: unknown): AutomodRule {
  if (!raw || typeof raw !== "object") throw new RuleValidationError("rule must be an object");
  const r = raw as Record<string, unknown>;

  const id = r.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new RuleValidationError("id must be a positive integer");
  }
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (name.length === 0) throw new RuleValidationError("name is required");

  const event = r.event;
  if (typeof event !== "string" || !EVENT_KINDS.includes(event as AutomodEventKind)) {
    throw new RuleValidationError(`event "${String(event)}" must be one of ${EVENT_KINDS.join(", ")}`);
  }

  if (!Array.isArray(r.matchers) || r.matchers.length === 0) {
    throw new RuleValidationError("matchers must be a non-empty array");
  }
  const matchers = r.matchers.map((m, i) => parseMatcher(m, i));

  if (!Array.isArray(r.actions) || r.actions.length === 0) {
    throw new RuleValidationError("actions must be a non-empty array");
  }
  const actions = r.actions.map((a) => {
    if (typeof a !== "string" || !ACTION_TYPES.includes(a as AutomodAction)) {
      throw new RuleValidationError(`action "${String(a)}" is not a known action`);
    }
    return a as AutomodAction;
  });

  const needsRole = actions.some((a) => a === "add_role" || a === "remove_role");
  const roleId = typeof r.roleId === "string" ? r.roleId : undefined;
  if (needsRole && !roleId) throw new RuleValidationError("add_role/remove_role need a roleId");

  const timeoutSeconds =
    typeof r.timeoutSeconds === "number" && r.timeoutSeconds > 0 ? Math.floor(r.timeoutSeconds) : undefined;
  if (actions.includes("timeout") && timeoutSeconds === undefined) {
    throw new RuleValidationError("the timeout action needs timeoutSeconds");
  }

  return {
    id,
    name,
    enabled: r.enabled !== false,
    priority: typeof r.priority === "number" && Number.isFinite(r.priority) ? Math.floor(r.priority) : 0,
    event: event as AutomodEventKind,
    matchers,
    actions,
    exemptRoles: asStringArray(r.exemptRoles, "exemptRoles"),
    exemptUsers: asStringArray(r.exemptUsers, "exemptUsers"),
    exemptChannels: asStringArray(r.exemptChannels, "exemptChannels"),
    cooldownSeconds:
      typeof r.cooldownSeconds === "number" && r.cooldownSeconds >= 0 ? Math.floor(r.cooldownSeconds) : 0,
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(roleId !== undefined ? { roleId } : {}),
  };
}

/** parseRules validates a list, dropping nothing silently — one bad rule fails the load. */
export function parseRules(raws: readonly unknown[]): AutomodRule[] {
  return raws.map(parseRule);
}
