import { Command, type CommandContext } from "../../framework/command.ts";
import { embed } from "../../lib/embed.ts";
import { ethGetBalance, weiToEther } from "../../lib/rpc.ts";

export class BalanceCommand extends Command {
  constructor() {
    super({ name: "balance", description: "Native balance of the configured wallets" });
  }

  async run(ctx: CommandContext): Promise<void> {
    const { evmRpc, wallets } = ctx.client.config;
    if (evmRpc === "") {
      await ctx.reply({ content: "No RPC configured. Set `EVM_RPC_URL` to enable `/balance`.", ephemeral: true });
      return;
    }
    if (wallets.length === 0) {
      await ctx.reply({ content: "No wallets configured (set `FUD_WALLETS`).", ephemeral: true });
      return;
    }
    await ctx.defer();
    const lines: string[] = [];
    for (const w of wallets) {
      try {
        const wei = await ethGetBalance(evmRpc, w.address);
        lines.push(`• **${w.label}** — \`${weiToEther(wei).toFixed(6)}\``);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lines.push(`• **${w.label}** — ⚠️ ${msg}`);
      }
    }
    await ctx.followUp({ embeds: [embed({ title: "Balances", description: lines.join("\n") })] });
  }
}

export default new BalanceCommand();
