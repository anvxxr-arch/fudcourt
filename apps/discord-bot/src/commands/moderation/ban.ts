import { Command, type CommandContext } from "../../framework/command.ts";
import { ApplicationCommandOptionType } from "../../framework/types.ts";
import { ModerationService } from "../../moderation/service.ts";
import { modReply } from "./_reply.ts";

/** /ban — ban a member, optionally deleting their recent messages. */
export class BanCommand extends Command {
  constructor() {
    super({
      name: "ban",
      description: "Ban a member from the server",
      preconditions: ["ModOnly"],
      capability: "moderation.ban",
      options: [
        { name: "user", description: "The member to ban", type: ApplicationCommandOptionType.User, required: true },
        { name: "reason", description: "Why they are being banned", type: ApplicationCommandOptionType.String },
        {
          name: "delete_seconds",
          description: "Delete this many seconds of their recent messages (0-604800)",
          type: ApplicationCommandOptionType.Integer,
        },
      ],
    });
  }

  async run(ctx: CommandContext): Promise<void> {
    const targetId = ctx.options.user("user");
    if (!targetId) return void ctx.reply({ content: "Pick a user to ban.", ephemeral: true });
    const res = await new ModerationService(ctx.client).run({
      action: "ban",
      guildId: ctx.guildId ?? "",
      actorId: ctx.user.id,
      actorRoles: ctx.member?.roles ?? [],
      actorPermissions: ctx.member?.permissions,
      targetId,
      reason: ctx.options.string("reason"),
      deleteMessageSeconds: ctx.options.integer("delete_seconds") ?? 0,
    });
    await modReply(ctx, res);
  }
}

export default new BanCommand();
