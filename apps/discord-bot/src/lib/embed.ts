// Tiny embed helper — the house accent colour plus the few shapes the FUD
// commands need. Kept in one place so every board looks the same.

import type { APIEmbed, APIEmbedField } from "../framework/types.ts";

/** FUD Court accent (Discord blurple-adjacent green used across the site). */
export const ACCENT = 0x22c55e;
export const DANGER = 0xef4444;
export const WARN = 0xf59e0b;

export function embed(opts: {
  title?: string;
  description?: string;
  color?: number;
  fields?: APIEmbedField[];
  footer?: string;
}): APIEmbed {
  const e: APIEmbed = { color: opts.color ?? ACCENT };
  if (opts.title) e.title = opts.title;
  if (opts.description) e.description = opts.description;
  if (opts.fields && opts.fields.length > 0) e.fields = opts.fields;
  if (opts.footer) e.footer = { text: opts.footer };
  return e;
}

export function field(name: string, value: string, inline = true): APIEmbedField {
  return { name, value: value || "—", inline };
}

/** glyph renders the same ✅/⚠️/❌ vocabulary the Telegram bot uses. */
export function glyph(ok: boolean, warn = false): string {
  if (ok) return "✅";
  return warn ? "⚠️" : "❌";
}
