// PanelService — turns a role-panel interaction into role changes. A button or
// select carries a `rp:<panelId>:<roleId>` custom id; the service finds the
// panel, computes the add/remove set with the pure panel logic, and applies it
// through RoleService (hierarchy-checked, recorded). It always answers the
// interaction (ephemeral), so a member sees what happened.

import { applySelect, panelIdFromCustomId, pickOption } from "./panel.ts";
import type { RoleService } from "./roles.ts";
import type { RolePanel } from "./types.ts";

/**
 * emojiKey normalises a reaction emoji to the string a panel option stores:
 * `name:id` for a custom emoji, the unicode name otherwise.
 */
export function emojiKey(emoji: { id?: string | null; name?: string | null } | undefined): string {
  if (!emoji) return "";
  if (emoji.id) return `${emoji.name ?? ""}:${emoji.id}`;
  return emoji.name ?? "";
}

export interface PanelDeps {
  /** The guild's panels (read fresh; the api caches them). */
  panels: () => Promise<RolePanel[]>;
  roles: RoleService;
  /** The member's current role ids (for toggle/exclusive decisions). */
  memberRoles: (userId: string) => Promise<string[]>;
  /** Answer the interaction ephemerally. */
  reply: (content: string, ephemeral: boolean) => Promise<void>;
  log: (msg: string) => void;
}

export class PanelService {
  constructor(private readonly deps: PanelDeps) {}

  /**
   * handleComponent processes a role-panel button/select. Returns true when the
   * interaction belonged to a panel and was handled; false when the custom id is
   * not a panel id (the caller then falls through to its normal router).
   */
  async handleComponent(customId: string, values: readonly string[] | undefined, userId: string): Promise<boolean> {
    const parsed = panelIdFromCustomId(customId);
    if (!parsed) return false;

    let panel: RolePanel | undefined;
    try {
      panel = (await this.deps.panels()).find((p) => p.id === parsed.panelId && p.enabled);
    } catch (err) {
      this.deps.log(`panel: lookup failed: ${errText(err)}`);
      await this.deps.reply("⚠️ Could not load the role panel — try again shortly.", true);
      return true;
    }
    if (!panel) {
      await this.deps.reply("That role panel is no longer available.", true);
      return true;
    }

    const option = panel.options.find((o) => o.roleId === parsed.roleId);
    if (!option && !(values && values.length > 0)) {
      await this.deps.reply("That option is no longer on this panel.", true);
      return true;
    }

    let held: string[];
    try {
      held = await this.deps.memberRoles(userId);
    } catch (err) {
      this.deps.log(`panel: member roles lookup failed: ${errText(err)}`);
      await this.deps.reply("⚠️ Could not read your roles — try again shortly.", true);
      return true;
    }

    const selection = values && values.length > 0 ? applySelect(panel, values, held) : pickOption(panel, option!, held);
    const result = await this.deps.roles.apply(userId, selection.add, selection.remove, "panel");

    if (selection.add.length === 0 && selection.remove.length === 0) {
      await this.deps.reply("No change — you already have that role set.", true);
      return true;
    }
    if (result.failed > 0) {
      await this.deps.reply(`⚠️ Updated ${result.ok} role(s); ${result.failed} could not be changed (check the bot's role position).`, true);
      return true;
    }
    const added = selection.add.length ? `added ${selection.add.map((r) => `<@&${r}>`).join(", ")}` : "";
    const removed = selection.remove.length ? `removed ${selection.remove.map((r) => `<@&${r}>`).join(", ")}` : "";
    await this.deps.reply(`✅ Roles updated — ${[added, removed].filter(Boolean).join("; ")}.`, true);
    return true;
  }
  /**
   * handleReaction processes a reaction-role panel: it finds the panel by the
   * message it was posted to and the option by emoji. `add` grants the role,
   * `!add` revokes it. Returns true when the message was a panel (so the caller
   * knows it was handled); unknown messages/emojis are a no-op.
   */
  async handleReaction(messageId: string, emoji: { id?: string | null; name?: string | null } | undefined, userId: string, add: boolean): Promise<boolean> {
    if (!messageId) return false;
    let panel: RolePanel | undefined;
    try {
      panel = (await this.deps.panels()).find((p) => p.messageId === messageId && p.kind === "reaction" && p.enabled);
    } catch (err) {
      this.deps.log(`panel: reaction lookup failed: ${errText(err)}`);
      return false;
    }
    if (!panel) return false;
    const key = emojiKey(emoji);
    const option = panel.options.find((o) => o.emoji === key);
    if (!option) return true; // the message IS a panel; this emoji is not mapped
    if (add) {
      await this.deps.roles.grant(userId, option.roleId, "panel-reaction");
    } else {
      await this.deps.roles.revoke(userId, option.roleId, "panel-reaction");
    }
    return true;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
