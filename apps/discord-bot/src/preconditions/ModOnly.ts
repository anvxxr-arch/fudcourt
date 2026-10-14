// ModOnly — the gate on moderation commands. A caller passes if they hold a
// configured admin role OR the Discord "Moderate Members" permission. The role
// path keeps working when an admin maps a moderation role in the panel; the
// permission path means the bot honours Discord's own model instead of forcing
// every server to invent a role. Fail-closed: neither → refused.

import { Precondition, type PreconditionResult, PASS, fail } from "../framework/precondition.ts";
import type { CommandContext } from "../framework/command.ts";
import { has, Perm } from "../lib/permissions.ts";

export class ModOnly extends Precondition {
  constructor() {
    super({ name: "ModOnly" });
  }

  check(ctx: CommandContext): PreconditionResult {
    const admins = ctx.client.config.adminRoleIds;
    if (admins.length > 0 && (ctx.member?.roles ?? []).some((r) => admins.includes(r))) return PASS;
    if (has(ctx.member?.permissions, Perm.MODERATE_MEMBERS)) return PASS;
    return fail("This command is for moderators — you need the **Moderate Members** permission or an admin role.");
  }
}

export default new ModOnly();
