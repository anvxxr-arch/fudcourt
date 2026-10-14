import { Command, type CommandContext } from "../../framework/command.ts";
import { ApplicationCommandOptionType } from "../../framework/types.ts";
import { ModerationService } from "../../moderation/service.ts";
import { modReply } from "./_reply.ts";

/** /unlock — restore @everyone's ability to send in this channel. */
export class UnlockCommand extends Command {
  constructor() {
    super({
      name: "unlock",
      description: "Unlock this channel",
      preconditions: ["ModOnly"],
      options: [
        { name: "reason", description: "Why the channel is being unlocked", type: ApplicationCommandOptionType.String },
      ],
    });
  }

  async run(ctx: CommandContext): Promise<void> {
    const res = await new ModerationService(ctx.client).run({
      action: "unlock",
      guildId: ctx.guildId ?? "",
      actorId: ctx.user.id,
      actorRoles: ctx.member?.roles ?? [],
      actorPermissions: ctx.member?.permissions,
      channelId: ctx.channelId,
      reason: ctx.options.string("reason"),
    });
    await modReply(ctx, res);
  }
}

export default new UnlockCommand();
