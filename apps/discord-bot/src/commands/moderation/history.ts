import { Command, type CommandContext } from "../../framework/command.ts";
import { ApplicationCommandOptionType } from "../../framework/types.ts";
import { embed } from "../../lib/embed.ts";

/** /history — a member's moderation history, newest first. */
export class HistoryCommand extends Command {
  constructor() {
    super({
      name: "history",
      description: "Show a member's moderation history",
      preconditions: ["ModOnly"],
      options: [
        { name: "user", description: "The member whose history to show", type: ApplicationCommandOptionType.User, required: true },
        {
          name: "limit",
          description: "How many recent cases to show (1-25, default 10)",
          type: ApplicationCommandOptionType.Integer,
        },
      ],
    });
  }

  async run(ctx: CommandContext): Promise<void> {
    const targetId = ctx.options.user("user");
    if (!targetId) return void ctx.reply({ content: "Pick a user.", ephemeral: true });
    await ctx.defer();
    const limit = ctx.options.integer("limit") ?? 10;
    const cases = await ctx.client.cases.history(targetId, limit);
    if (cases.length === 0) {
      return void ctx.followUp({ content: `<@${targetId}> has no moderation history.` });
    }
    const lines = cases.map((c) => `**#${c.caseNumber}** \`${c.action}\` — ${c.reason || "no reason"} · ${c.createdAt}`);
    await ctx.followUp({
      embeds: [
        embed({
          title: `History for <@${targetId}>`,
          description: lines.join("\n").slice(0, 4000),
          footer: `FUD Court · ${cases.length} case(s)`,
        }),
      ],
    });
  }
}

export default new HistoryCommand();
