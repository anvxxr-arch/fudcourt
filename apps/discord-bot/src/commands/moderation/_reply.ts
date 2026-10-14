// modReply — the one renderer for a ModResult, shared by every mod command so
// the success/refusal UX is identical everywhere. A refusal is ephemeral (only
// the caller sees why); a success is public, so the channel sees that the
// moderation happened — the same convention Dyno/Sapphire use.

import type { CommandContext } from "../../framework/command.ts";
import { embed, glyph } from "../../lib/embed.ts";
import type { ModResult } from "../../moderation/service.ts";

export async function modReply(ctx: CommandContext, res: ModResult): Promise<void> {
  if (!res.ok) {
    await ctx.reply({ content: `⚠️ ${res.refusal ?? "that action is not permitted"}`, ephemeral: true });
    return;
  }
  const footer = res.caseNumber ? `FUD Court · case #${res.caseNumber}` : "FUD Court";
  await ctx.reply({
    embeds: [
      embed({
        title: `${glyph(true)} ${res.action}`,
        description: res.summary ?? "done",
        footer,
      }),
    ],
  });
}
