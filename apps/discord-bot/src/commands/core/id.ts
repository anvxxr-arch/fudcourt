import { Command, type CommandContext } from "../../framework/command.ts";
import { embed, field } from "../../lib/embed.ts";

export class IdCommand extends Command {
  constructor() {
    super({ name: "id", description: "Show this guild, channel and your user id" });
  }

  async run(ctx: CommandContext): Promise<void> {
    const roles = ctx.member?.roles ?? [];
    await ctx.reply({
      ephemeral: true,
      embeds: [
        embed({
          title: "IDs",
          fields: [
            field("guild", ctx.guildId ?? "—"),
            field("channel", ctx.channelId ?? "—"),
            field("user", ctx.user.id),
            field("roles", roles.length > 0 ? roles.map((r) => `<@&${r}>`).join(" ") : "—", false),
          ],
        }),
      ],
    });
  }
}

export default new IdCommand();
