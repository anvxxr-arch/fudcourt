import { Command, type CommandContext } from "../../framework/command.ts";
import { ApplicationCommandOptionType } from "../../framework/types.ts";
import { ModerationService } from "../../moderation/service.ts";
import { modReply } from "./_reply.ts";

/** /timeout — temporarily mute a member (Discord communication timeout). */
export class TimeoutCommand extends Command {
  constructor() {
    super({
      name: "timeout",
      description: "Temporarily time a member out",
      preconditions: ["ModOnly"],
      capability: "moderation.timeout",
      options: [
        { name: "user", description: "The member to time out", type: ApplicationCommandOptionType.User, required: true },
        {
          name: "duration",
          description: "How long, in seconds (max 2419200 = 28 days)",
          type: ApplicationCommandOptionType.Integer,
          required: true,
        },
        { name: "reason", description: "Why they are being timed out", type: ApplicationCommandOptionType.String },
      ],
    });
  }

  async run(ctx: CommandContext): Promise<void> {
    const targetId = ctx.options.user("user");
    if (!targetId) return void ctx.reply({ content: "Pick a user to time out.", ephemeral: true });
    const res = await new ModerationService(ctx.client).run({
      action: "timeout",
      guildId: ctx.guildId ?? "",
      actorId: ctx.user.id,
      actorRoles: ctx.member?.roles ?? [],
      actorPermissions: ctx.member?.permissions,
      targetId,
      durationSeconds: ctx.options.integer("duration") ?? 600,
      reason: ctx.options.string("reason"),
    });
    await modReply(ctx, res);
  }
}

export default new TimeoutCommand();
