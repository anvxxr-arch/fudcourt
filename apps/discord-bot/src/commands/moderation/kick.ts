import { Command, type CommandContext } from "../../framework/command.ts";
import { ApplicationCommandOptionType } from "../../framework/types.ts";
import { ModerationService } from "../../moderation/service.ts";
import { modReply } from "./_reply.ts";

/** /kick — remove a member (they may rejoin). */
export class KickCommand extends Command {
  constructor() {
    super({
      name: "kick",
      description: "Kick a member from the server",
      preconditions: ["ModOnly"],
      options: [
        { name: "user", description: "The member to kick", type: ApplicationCommandOptionType.User, required: true },
        { name: "reason", description: "Why they are being kicked", type: ApplicationCommandOptionType.String },
      ],
    });
  }

  async run(ctx: CommandContext): Promise<void> {
    const targetId = ctx.options.user("user");
    if (!targetId) return void ctx.reply({ content: "Pick a user to kick.", ephemeral: true });
    const res = await new ModerationService(ctx.client).run({
      action: "kick",
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

export default new KickCommand();
