// Custom-command types — the wire shapes the api serves over loopback for the
// declarative custom-command set. Parsed defensively: a malformed row is
// dropped, never trusted, so a bad config edit degrades to "command unknown"
// instead of a boot crash.
//
// The set is DATA, not code. Nothing here is ever evaluated — a response is a
// string the template engine renders and an embed it templates. There is no
// scripting surface.

import type { TemplateEmbed } from "../community/templates.ts";

/** One possible response: a templated text and/or a templated embed. */
export interface CommandResponse {
  text?: string;
  embed?: TemplateEmbed;
}

/**
 * One operator-authored command. `allowedRoles`/`allowedChannels` are allow-lists
 * (empty = everyone / any channel). `reply` posts as a Discord reply to the
 * trigger; `dm` sends the response by direct message; `deleteTrigger` removes the
 * invoking message.
 */
export interface CustomCommand {
  id: string;
  name: string;
  aliases: string[];
  responses: CommandResponse[];
  allowedRoles: string[];
  allowedChannels: string[];
  cooldownSeconds: number;
  deleteTrigger: boolean;
  reply: boolean;
  dm: boolean;
  enabled: boolean;
}

/** parseCustomCommands validates the command list, dropping any unusable row. */
export function parseCustomCommands(raw: unknown): CustomCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomCommand[] = [];
  for (const c of raw) {
    if (!isObject(c)) continue;
    const name = typeof c["name"] === "string" ? c["name"].trim().toLowerCase() : "";
    if (name === "") continue;
    out.push({
      id: idString(c["id"]),
      name,
      aliases: strList(c["aliases"]).map((a) => a.toLowerCase()),
      responses: parseResponses(c["responses"]),
      allowedRoles: strList(c["allowedRoles"]),
      allowedChannels: strList(c["allowedChannels"]),
      cooldownSeconds: int(c["cooldownSeconds"]),
      deleteTrigger: c["deleteTrigger"] === true,
      reply: c["reply"] !== false,
      dm: c["dm"] === true,
      enabled: c["enabled"] !== false,
    });
  }
  return out;
}

function parseResponses(raw: unknown): CommandResponse[] {
  if (!Array.isArray(raw)) return [];
  const out: CommandResponse[] = [];
  for (const r of raw) {
    if (!isObject(r)) continue;
    const text = typeof r["text"] === "string" ? r["text"] : undefined;
    const embed = isObject(r["embed"]) ? (r["embed"] as TemplateEmbed) : undefined;
    if (text === undefined && embed === undefined) continue;
    out.push({ text, embed });
  }
  return out;
}

function strList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) if (typeof v === "string" && v !== "") out.push(v);
  return out;
}

/** idString keeps a DB surrogate id stable across a numeric or string wire form. */
function idString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
  return "";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function int(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}
