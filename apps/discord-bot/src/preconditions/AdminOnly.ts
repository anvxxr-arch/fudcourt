// AdminOnly — the gate on the admin commands. Mirrors the Telegram bot's
// `AdminOnly` flag: the caller must hold a configured admin role in the guild.
//
// Fail-closed, exactly like the site: with no admin role configured there is no
// way to prove admin, so the command is refused rather than allowed.

import { Precondition, type PreconditionResult, PASS, fail } from "../framework/precondition.ts";
import type { CommandContext } from "../framework/command.ts";

export class AdminOnly extends Precondition {
  constructor() {
    super({ name: "AdminOnly" });
  }

  check(ctx: CommandContext): PreconditionResult {
    const admins = ctx.client.config.adminRoleIds;
    if (admins.length === 0) {
      return fail("No admin role is configured. Set it in the dashboard → Settings, or `FUDCOURT_ROLE_ADMIN`.");
    }
    const roles = ctx.member?.roles ?? [];
    if (roles.some((r) => admins.includes(r))) return PASS;
    return fail("This command is admin-only.");
  }
}

export default new AdminOnly();
