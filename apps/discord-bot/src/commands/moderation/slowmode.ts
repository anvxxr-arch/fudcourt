import { Command, type CommandContext } from "../../framework/command.ts";
import { ApplicationCommandOptionType } from "../../framework/types.ts";
import { ModerationService } from "../../moderation/service.ts";
import { modReply } from "./_reply.ts";

/** /slowmode — set this channel's per-user message cooldown (0 disables). */
export class SlowmodeCommand extends Command {
  constructor() {
    super({
      name: "slowmode",
      description: "Set this channel's slowmode",
      preconditions: ["ModOnly"],
      options: [
        {
          name: "seconds",
          description: "Seconds between messages (0 to disable, max 21600)",
          type: ApplicationCommandOptionType.Integer,
          required: true,
        },
        { name: "reason", description: "Why slowmode is being changed", type: ApplicationCommandOptionType.String },
      ],
    });
  }

  async run(ctx: CommandContext): Promise<void> {
    const res = await new ModerationService(ctx.client).run({
      action: "slowmode",
      guildId: ctx.guildId ?? "",
      actorId: ctx.user.id,
      actorRoles: ctx.member?.roles ?? [],
      actorPermissions: ctx.member?.permissions,
      channelId: ctx.channelId,
      seconds: ctx.options.integer("seconds") ?? 0,
      reason: ctx.options.string("reason"),
    });
    await modReply(ctx, res);
  }
}

export default new SlowmodeCommand();
