// Community types — the wire shapes the api serves over loopback for welcome/
// goodbye, autoroles and role panels. The bot parses defensively: a malformed
// row is dropped, never trusted, so a bad config edit degrades to "feature off"
// instead of a boot crash.
//
// Snowflakes are strings throughout (never JS numbers — that would lose the low
// bits). The api is the source of truth; these are read-only mirrors.

import type { TemplateEmbed } from "./templates.ts";

/** The welcome/goodbye configuration for the guild (one row, `welcome_configs`). */
export interface WelcomeConfig {
  joinEnabled: boolean;
  joinChannelId: string;
  joinMessage: string;
  joinEmbed?: TemplateEmbed;
  joinDm: boolean;
  joinDmMessage: string;
  leaveEnabled: boolean;
  leaveChannelId: string;
  leaveMessage: string;
  leaveEmbed?: TemplateEmbed;
}

/** How an autorole is triggered. */
export type AutoroleKind = "on_join" | "after_duration" | "after_verification";
/** Which members a rule applies to. */
export type AutoroleAppliesTo = "all" | "human" | "bot";

/** One autorole rule (`autorole_rules`). */
export interface AutoroleRule {
  id: string;
  roleId: string;
  kind: AutoroleKind;
  delaySeconds: number;
  appliesTo: AutoroleAppliesTo;
  enabled: boolean;
  priority: number;
}

/** The control a role panel renders. */
export type RolePanelKind = "reaction" | "button" | "select";
/** The selection semantics of a role panel. */
export type RolePanelMode = "toggle" | "single" | "multiple" | "exclusive";

/** One option (role) on a role panel (`role_panel_options`). */
export interface RolePanelOption {
  roleId: string;
  label: string;
  emoji: string;
  style: string;
  position: number;
  /** Options sharing a non-empty exclusive_group are mutually exclusive. */
  exclusiveGroup: string;
}

/** A self-serve role menu (`role_panels` + its options). */
export interface RolePanel {
  id: string;
  channelId: string;
  messageId: string;
  title: string;
  description: string;
  kind: RolePanelKind;
  mode: RolePanelMode;
  enabled: boolean;
  options: RolePanelOption[];
}

const KINDS: readonly AutoroleKind[] = ["on_join", "after_duration", "after_verification"];
const APPLIES: readonly AutoroleAppliesTo[] = ["all", "human", "bot"];
const PANEL_KINDS: readonly RolePanelKind[] = ["reaction", "button", "select"];
const PANEL_MODES: readonly RolePanelMode[] = ["toggle", "single", "multiple", "exclusive"];

/** parseWelcomeConfig validates a wire object; returns undefined when unusable. */
export function parseWelcomeConfig(raw: unknown): WelcomeConfig | undefined {
  if (!isObject(raw)) return undefined;
  const s = (k: string): string => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const b = (k: string): boolean => raw[k] === true;
  return {
    joinEnabled: b("joinEnabled"),
    joinChannelId: s("joinChannelId"),
    joinMessage: s("joinMessage"),
    joinEmbed: parseEmbed(raw["joinEmbed"]),
    joinDm: b("joinDm"),
    joinDmMessage: s("joinDmMessage"),
    leaveEnabled: b("leaveEnabled"),
    leaveChannelId: s("leaveChannelId"),
    leaveMessage: s("leaveMessage"),
    leaveEmbed: parseEmbed(raw["leaveEmbed"]),
  };
}

/** parseAutoroleRules validates the rule list, dropping any unusable row. */
export function parseAutoroleRules(raw: unknown): AutoroleRule[] {
  if (!Array.isArray(raw)) return [];
  const out: AutoroleRule[] = [];
  for (const r of raw) {
    if (!isObject(r)) continue;
    const kind = r["kind"];
    const applies = r["appliesTo"];
    const roleId = r["roleId"];
    if (typeof roleId !== "string" || roleId === "") continue;
    if (typeof kind !== "string" || !KINDS.includes(kind as AutoroleKind)) continue;
    if (typeof applies !== "string" || !APPLIES.includes(applies as AutoroleAppliesTo)) continue;
    out.push({
      id: str(r["id"]),
      roleId,
      kind: kind as AutoroleKind,
      delaySeconds: int(r["delaySeconds"]),
      appliesTo: applies as AutoroleAppliesTo,
      enabled: r["enabled"] !== false,
      priority: int(r["priority"]),
    });
  }
  return out;
}

/** parseRolePanels validates the panel list (with options), dropping unusable rows. */
export function parseRolePanels(raw: unknown): RolePanel[] {
  if (!Array.isArray(raw)) return [];
  const out: RolePanel[] = [];
  for (const p of raw) {
    if (!isObject(p)) continue;
    const kind = p["kind"];
    const mode = p["mode"];
    const channelId = p["channelId"];
    if (typeof channelId !== "string" || channelId === "") continue;
    if (typeof kind !== "string" || !PANEL_KINDS.includes(kind as RolePanelKind)) continue;
    if (typeof mode !== "string" || !PANEL_MODES.includes(mode as RolePanelMode)) continue;
    out.push({
      id: str(p["id"]),
      channelId,
      messageId: str(p["messageId"]),
      title: str(p["title"]),
      description: str(p["description"]),
      kind: kind as RolePanelKind,
      mode: mode as RolePanelMode,
      enabled: p["enabled"] !== false,
      options: parseOptions(p["options"]),
    });
  }
  return out;
}

function parseOptions(raw: unknown): RolePanelOption[] {
  if (!Array.isArray(raw)) return [];
  const out: RolePanelOption[] = [];
  for (const o of raw) {
    if (!isObject(o)) continue;
    const roleId = o["roleId"];
    if (typeof roleId !== "string" || roleId === "") continue;
    out.push({
      roleId,
      label: str(o["label"]),
      emoji: str(o["emoji"]),
      style: str(o["style"]) || "secondary",
      position: int(o["position"]),
      exclusiveGroup: str(o["exclusiveGroup"]),
    });
  }
  return out;
}

function parseEmbed(raw: unknown): TemplateEmbed | undefined {
  if (!isObject(raw)) return undefined;
  // The embed is passed to renderEmbed which reads only known fields, so a light
  // shape check is enough here — no need to clone the whole tree.
  return raw as TemplateEmbed;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function int(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}
