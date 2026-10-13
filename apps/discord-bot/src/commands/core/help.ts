import { Command, type CommandContext } from "../../framework/command.ts";
import { embed } from "../../lib/embed.ts";

export class HelpCommand extends Command {
  constructor() {
    super({ name: "help", description: "List the commands" });
  }

  async run(ctx: CommandContext): Promise<void> {
    const cmds = ctx.client.commands.all();
    const lines = cmds.map((c) => `\`/${c.name}\` — ${c.description}`);
    await ctx.reply({
      embeds: [
        embed({
          title: "🦊 FUDZIE — commands",
          description: lines.join("\n"),
          footer: "FUD Court",
        }),
      ],
    });
  }
}

export default new HelpCommand();
