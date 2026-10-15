import { Command, type CommandContext } from "../../framework/command.ts";
import { ApplicationCommandOptionType } from "../../framework/types.ts";
import { embed, field } from "../../lib/embed.ts";
import type { ModerationCase } from "../../lib/cases.ts";

/** /case — look up one moderation case by its number. */
export class CaseCommand extends Command {
  constructor() {
    super({
      name: "case",
      description: "Show one moderation case by its number",
      preconditions: ["ModOnly"],
      capability: "moderation.read",
      options: [
        {
          name: "number",
          description: "The case number (from a moderation confirmation)",
          type: ApplicationCommandOptionType.Integer,
          required: true,
        },
      ],
    });
  }

  async run(ctx: CommandContext): Promise<void> {
    const number = ctx.options.integer("number");
    if (!number || number <= 0) {
      return void ctx.reply({ content: "Give me a positive case number.", ephemeral: true });
    }
    await ctx.defer();
    const c = await ctx.client.cases.byNumber(number);
    if (!c) {
      return void ctx.followUp({ content: `No case **#${number}** found.` });
    }
    await ctx.followUp({ embeds: [caseEmbed(c)] });
  }
}

/** caseEmbed renders one case as a moderation board (shared with /history). */
export function caseEmbed(c: ModerationCase): ReturnType<typeof embed> {
  const fields = [
    field("Action", c.action),
    field("Status", c.status),
    field("Target", `<@${c.targetUserId}>`),
    field("Moderator", `<@${c.moderatorUserId}>`),
    field("Reason", c.reason || "—", false),
    field("Source", c.source),
    field("Created", c.createdAt),
  ];
  if (c.expiresAt) fields.push(field("Expires", c.expiresAt));
  return embed({
    title: `Case #${c.caseNumber}`,
    color: c.status === "active" ? 0xf59e0b : 0x22c55e,
    fields,
    footer: "FUD Court",
  });
}

export default new CaseCommand();
