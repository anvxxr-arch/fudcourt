import { Command, type CommandContext } from "../../framework/command.ts";
import { embed, glyph } from "../../lib/embed.ts";
import { fudServices, probeAll } from "../../lib/probe.ts";

export class StatusCommand extends Command {
  constructor() {
    super({ name: "status", description: "fudcourt service health" });
  }

  async run(ctx: CommandContext): Promise<void> {
    // The probes touch four loopback services — defer so the 3s ack budget holds.
    await ctx.defer();
    const results = await probeAll(fudServices(ctx.client.config.dataUrl));
    const lines = results.map((r) => `${glyph(r.ok, r.detail.startsWith("http"))} **${r.label}** — ${r.detail}`);
    const down = results.filter((r) => !r.ok).length;
    await ctx.followUp({
      embeds: [
        embed({
          title: "fudcourt status",
          description: lines.join("\n"),
          color: down === 0 ? 0x22c55e : 0xf59e0b,
          footer: down === 0 ? "all services up" : `${down} service(s) not healthy`,
        }),
      ],
    });
  }
}

export default new StatusCommand();
