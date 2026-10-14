import { Command, type CommandContext } from "../../framework/command.ts";
import { ApplicationCommandOptionType } from "../../framework/types.ts";
import { ModerationService } from "../../moderation/service.ts";
import { modReply } from "./_reply.ts";

/** /nick — change (or clear) a member's nickname. */
export class NickCommand extends Command {
  constructor() {
    super({
      name: "nick",
      description: "Change a member's nickname",
      preconditions: ["ModOnly"],
      options: [
        { name: "user", description: "The member to rename", type: ApplicationCommandOptionType.User, required: true },
        { name: "name", description: "The new nickname (leave empty to clear it)", type: ApplicationCommandOptionType.String },
        { name: "reason", description: "Why the nickname is being changed", type: ApplicationCommandOptionType.String },
      ],
    });
  }

  async run(ctx: CommandContext): Promise<void> {
    const targetId = ctx.options.user("user");
    if (!targetId) return void ctx.reply({ content: "Pick a user.", ephemeral: true });
    const res = await new ModerationService(ctx.client).run({
      action: "nick",
      guildId: ctx.guildId ?? "",
      actorId: ctx.user.id,
      actorRoles: ctx.member?.roles ?? [],
      actorPermissions: ctx.member?.permissions,
      targetId,
      nick: ctx.options.string("name") ?? "",
      reason: ctx.options.string("reason"),
    });
    await modReply(ctx, res);
  }
}

export default new NickCommand();
