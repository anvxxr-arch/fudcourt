import { Command, type CommandContext } from "../../framework/command.ts";
import { ApplicationCommandOptionType } from "../../framework/types.ts";
import { buildPanelPoster } from "../../community/wiring.ts";
import { embed, field } from "../../lib/embed.ts";

/**
 * /panel — admin-only. Posts a configured role panel as a live message: the
 * message body, the buttons or select menu, and — for a reaction panel — the
 * reactions themselves. The new message id is recorded over loopback, so a
 * reaction panel becomes matchable and the dashboard can show which message is
 * live.
 *
 * Before this command there was no way to post a panel at all: the config could
 * be edited and the interactions were handled, but nothing rendered a message.
 */
export class PanelCommand extends Command {
  constructor() {
    super({
      name: "panel",
      description: "Post a role panel as a live message",
      adminOnly: true,
      options: [
        {
          name: "id",
          description: "The panel id (the dashboard's Role panels section lists them)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "channel",
          description: "Where to post it (defaults to the panel's own channel)",
          type: ApplicationCommandOptionType.Channel,
        },
        {
          name: "force",
          description: "Re-post even though a message id is already recorded",
          type: ApplicationCommandOptionType.Boolean,
        },
      ],
    });
  }

  async run(ctx: CommandContext): Promise<void> {
    const id = (ctx.options.string("id") ?? "").trim();
    const res = await buildPanelPoster(ctx.client).post(id, ctx.options.string("channel"), ctx.options.bool("force") ?? false);

    const fields = res.ok
      ? [
          field("panel", id),
          field("channel", res.channelId ? `<#${res.channelId}>` : "—"),
          field("message", res.messageId ?? "—"),
          ...(res.replaced ? [field("replaced", res.replaced)] : []),
          ...res.notes.map((note, i) => field(`note ${i + 1}`, note, false)),
        ]
      : [
          field("panel", id === "" ? "—" : id),
          field("reason", res.error ?? "unknown"),
          ...(res.notes.length > 0 ? res.notes.map((note, i) => field(`note ${i + 1}`, note, false)) : []),
          ...(res.available && res.available.length > 0 ? [field("panel ids", res.available.join(", "), false)] : []),
        ];

    await ctx.reply({
      ephemeral: true,
      embeds: [embed({ title: res.ok ? "panel posted" : "panel not posted", fields, footer: "FUD Court" })],
    });
  }
}

export default new PanelCommand();
