import { Command, type CommandContext } from "../../framework/command.ts";
import { embed, field } from "../../lib/embed.ts";

export class VersionCommand extends Command {
  constructor() {
    super({ name: "version", description: "Bot identity and uptime" });
  }

  async run(ctx: CommandContext): Promise<void> {
    const me = ctx.client.identity;
    await ctx.reply({
      embeds: [
        embed({
          title: "FUDZIE",
          fields: [
            field("bot", me ? `${me.username}` : "—"),
            field("app", ctx.client.config.applicationId || "—"),
            field("guild", ctx.client.config.guildId || "—"),
            field("uptime", `${ctx.client.uptimeSeconds}s`),
            field("commands", String(ctx.client.commands.size)),
          ],
        }),
      ],
    });
  }
}

export default new VersionCommand();
