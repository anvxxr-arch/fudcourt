import { Command, type CommandContext } from "../../framework/command.ts";
import { embed, field } from "../../lib/embed.ts";

/**
 * /whoami — admin-only. Reports the caller's resolved tier from the configured
 * role ids, the same way the web tier resolves a session: admin > team > magang
 * > member. The role ids come from the admin panel (Postgres `settings`),
 * overlaid on the env baseline by the client's config refresh.
 * This is the live exercise of the AdminOnly precondition.
 */
export class WhoamiCommand extends Command {
  constructor() {
    super({ name: "whoami", description: "Show your resolved FUD Court tier", adminOnly: true });
  }

  async run(ctx: CommandContext): Promise<void> {
    const cfg = ctx.client.config;
    const roles = ctx.member?.roles ?? [];
    let tier = "member";
    if (roles.some((r) => cfg.adminRoleIds.includes(r))) tier = "admin";
    else if (roles.some((r) => cfg.teamRoleIds.includes(r))) tier = "team";
    else if (roles.some((r) => cfg.magangRoleIds.includes(r))) tier = "magang";

    const roleLines = roles.length > 0 ? roles.map((r) => `<@&${r}>`).join(" ") : "—";
    await ctx.reply({
      ephemeral: true,
      embeds: [
        embed({
          title: "whoami",
          fields: [
            field("user", `${ctx.user.username} (${ctx.user.id})`),
            field("tier", tier),
            field("guild", ctx.guildId ?? "—"),
            field("roles", roleLines, false),
          ],
          footer: "FUD Court",
        }),
      ],
    });
  }
}

export default new WhoamiCommand();
