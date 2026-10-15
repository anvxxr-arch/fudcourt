import { Command, type CommandContext } from "../../framework/command.ts";
import { ApplicationCommandOptionType } from "../../framework/types.ts";
import { ModerationService } from "../../moderation/service.ts";
import { modReply } from "./_reply.ts";

/** /untimeout — lift a member's communication timeout early. */
export class UntimeoutCommand extends Command {
  constructor() {
    super({
      name: "untimeout",
      description: "Remove a member's timeout",
      preconditions: ["ModOnly"],
      capability: "moderation.timeout",
      options: [
        { name: "user", description: "The member to restore", type: ApplicationCommandOptionType.User, required: true },
        { name: "reason", description: "Why the timeout is being lifted", type: ApplicationCommandOptionType.String },
      ],
    });
  }

  async run(ctx: CommandContext): Promise<void> {
    const targetId = ctx.options.user("user");
    if (!targetId) return void ctx.reply({ content: "Pick a user.", ephemeral: true });
    const res = await new ModerationService(ctx.client).run({
      action: "untimeout",
      guildId: ctx.guildId ?? "",
      actorId: ctx.user.id,
      actorRoles: ctx.member?.roles ?? [],
      actorPermissions: ctx.member?.permissions,
      targetId,
      reason: ctx.options.string("reason"),
    });
    await modReply(ctx, res);
  }
}

export default new UntimeoutCommand();
