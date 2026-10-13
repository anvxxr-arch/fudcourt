import { Command, type CommandContext } from "../../framework/command.ts";
import { embed } from "../../lib/embed.ts";

export class PingCommand extends Command {
  constructor() {
    super({ name: "ping", description: "Liveness check" });
  }

  async run(ctx: CommandContext): Promise<void> {
    await ctx.reply({
      embeds: [embed({ description: `🏓 pong — up ${ctx.client.uptimeSeconds}s` })],
    });
  }
}

export default new PingCommand();
