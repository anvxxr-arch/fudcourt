import { Command, type CommandContext } from "../../framework/command.ts";
import { ApplicationCommandOptionType } from "../../framework/types.ts";
import { ModerationService } from "../../moderation/service.ts";
import { modReply } from "./_reply.ts";

/** /warn — record a warning against a member. */
export class WarnCommand extends Command {
  constructor() {
    super({
      name: "warn",
      description: "Warn a member",
      preconditions: ["ModOnly"],
      options: [
        { name: "user", description: "The member to warn", type: ApplicationCommandOptionType.User, required: true },
        { name: "reason", description: "Why they are being warned", type: ApplicationCommandOptionType.String, required: true },
      ],
    });
  }

  async run(ctx: CommandContext): Promise<void> {
    const targetId = ctx.options.user("user");
    if (!targetId) return void ctx.reply({ content: "Pick a user to warn.", ephemeral: true });
    const res = await new ModerationService(ctx.client).run({
      action: "warn",
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

export default new WarnCommand();
