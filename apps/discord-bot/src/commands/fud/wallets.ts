import { Command, type CommandContext } from "../../framework/command.ts";
import { embed } from "../../lib/embed.ts";

export class WalletsCommand extends Command {
  constructor() {
    super({ name: "wallets", description: "List the configured FUD wallets" });
  }

  async run(ctx: CommandContext): Promise<void> {
    const wallets = ctx.client.config.wallets;
    if (wallets.length === 0) {
      await ctx.reply({ content: "No wallets configured. Set `FUD_WALLETS=label:0xaddr,label:0xaddr`.", ephemeral: true });
      return;
    }
    const lines = wallets.map((w) => `• **${w.label}** — \`${w.address}\``);
    await ctx.reply({ embeds: [embed({ title: "FUD wallets", description: lines.join("\n") })] });
  }
}

export default new WalletsCommand();
