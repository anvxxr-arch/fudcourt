// Context-menu command factory.
//
// A USER context command ("Warn", "Kick", …) and a MESSAGE context command
// ("Warn Author", "Delete Message", …) are the same moderation actions with a
// different target source, so they are built from one factory instead of six
// near-identical files. Each thin file under commands/moderation/ calls this and
// exports the result as its default, which is what the piece loader picks up.

import { Command, type CommandContext } from "../../framework/command.ts";
import { ApplicationCommandType } from "../../framework/types.ts";
import { ModerationService, type ModAction } from "../../moderation/service.ts";
import { modReply } from "./_reply.ts";

/** The author id of the message a MESSAGE context command was invoked on. */
function messageAuthor(ctx: CommandContext): string | undefined {
  const id = ctx.targetId;
  if (!id) return undefined;
  return ctx.interaction.data?.resolved?.messages?.[id]?.author?.id;
}

/** The moderation request shared by every context-menu action. */
function baseRequest(ctx: CommandContext, action: ModAction, targetId: string) {
  return {
    action,
    guildId: ctx.guildId ?? "",
    actorId: ctx.user.id,
    actorRoles: ctx.member?.roles ?? [],
    actorPermissions: ctx.member?.permissions,
    targetId,
    reason: `via context menu by ${ctx.user.username}`,
  };
}

/**
 * userContext builds a USER-targeted moderation command.
 * `extra` supplies action-specific fields (e.g. timeout duration).
 */
export function userContext(
  name: string,
  action: ModAction,
  extra: Partial<{ durationSeconds: number; deleteMessageSeconds: number }> = {},
): Command {
  class UserContext extends Command {
    constructor() {
      super({ name, description: `${name} a user`, type: ApplicationCommandType.User, preconditions: ["ModOnly"] });
    }
    async run(ctx: CommandContext): Promise<void> {
      const targetId = ctx.targetId;
      if (!targetId) return void ctx.reply({ content: "No target user.", ephemeral: true });
      const res = await new ModerationService(ctx.client).run({ ...baseRequest(ctx, action, targetId), ...extra });
      await modReply(ctx, res);
    }
  }
  return new UserContext();
}

/**
 * messageContext builds a MESSAGE context command. It resolves the author from
 * the interaction's resolved message and refuses clearly when Discord did not
 * include it, rather than acting on an empty id.
 */
export function messageContext(
  name: string,
  action: ModAction | "delete_message",
  extra: Partial<{ durationSeconds: number }> = {},
): Command {
  class MessageContext extends Command {
    constructor() {
      super({
        name,
        description: `${name} on a message`,
        type: ApplicationCommandType.Message,
        preconditions: ["ModOnly"],
      });
    }
    async run(ctx: CommandContext): Promise<void> {
      const messageId = ctx.targetId;
      if (!messageId) return void ctx.reply({ content: "No target message.", ephemeral: true });

      if (action === "delete_message") {
        const res = await new ModerationService(ctx.client).run({
          action: "purge",
          guildId: ctx.guildId ?? "",
          actorId: ctx.user.id,
          actorRoles: ctx.member?.roles ?? [],
          actorPermissions: ctx.member?.permissions,
          channelId: ctx.channelId,
          count: 1,
          reason: `message deleted via context menu by ${ctx.user.username}`,
        });
        await modReply(ctx, res);
        return;
      }

      const authorId = messageAuthor(ctx);
      if (!authorId) return void ctx.reply({ content: "I could not read that message's author.", ephemeral: true });
      const res = await new ModerationService(ctx.client).run({ ...baseRequest(ctx, action, authorId), ...extra });
      await modReply(ctx, res);
    }
  }
  return new MessageContext();
}
