import { Command, type CommandContext } from "../../framework/command.ts";
import { ApplicationCommandOptionType } from "../../framework/types.ts";
import { ModerationService } from "../../moderation/service.ts";
import { modReply } from "./_reply.ts";

/** /purge — bulk-delete the most recent N messages in this channel. */
export class PurgeCommand extends Command {
  constructor() {
    super({
      name: "purge",
      description: "Delete recent messages in this channel",
      preconditions: ["ModOnly"],
      options: [
        {
          name: "count",
          description: "How many messages to delete (1-100)",
          type: ApplicationCommandOptionType.Integer,
          required: true,
        },
        { name: "reason", description: "Why the messages are being deleted", type: ApplicationCommandOptionType.String },
      ],
    });
  }

  async run(ctx: CommandContext): Promise<void> {
    const res = await new ModerationService(ctx.client).run({
      action: "purge",
      guildId: ctx.guildId ?? "",
      actorId: ctx.user.id,
      actorRoles: ctx.member?.roles ?? [],
      actorPermissions: ctx.member?.permissions,
      channelId: ctx.channelId,
      count: ctx.options.integer("count") ?? 10,
      reason: ctx.options.string("reason"),
    });
    await modReply(ctx, res);
  }
}

export default new PurgeCommand();
