// Moderation hierarchy — the pure rule that decides whether one member may act
// on another. It is deliberately I/O-free so the rules are unit-tested directly
// rather than only through a live guild; the service (service.ts) fetches the
// roles/members and hands the resolved numbers in here.
//
// The rules mirror Discord's own, in the order Discord enforces them:
//   1. the guild owner is untouchable by anyone (including an admin);
//   2. you cannot act on yourself;
//   3. the bot cannot act on itself;
//   4. the bot's highest role must be strictly ABOVE the target's;
//   5. the actor's highest role must be strictly ABOVE the target's — unless the
//      actor IS the owner, who outranks everyone.
//
// "Highest role" is the maximum role POSITION the member holds. @everyone is
// position 0 and everyone holds it, so an unroled member resolves to 0 — which
// is what makes rule 4/5 correct: a bot whose only role is @everyone (0) can
// act on nobody, and a moderator with position 5 cannot touch position 5+.

import type { GuildRole } from "../framework/types.ts";

export interface GuardInput {
  /** The acting moderator's user id. */
  actorId: string;
  /** The target member's user id. */
  targetId: string;
  /** The guild owner's user id. */
  ownerId: string;
  /** The bot's own user id. */
  botUserId: string;
  /** The actor's highest role position (0 when unroled). */
  actorTop: number;
  /** The bot's highest role position. */
  botTop: number;
  /** The target's highest role position. */
  targetTop: number;
  /** True when the actor is the guild owner (bypasses the actor-rank rule). */
  actorIsOwner: boolean;
}

export interface GuardResult {
  ok: boolean;
  /** Shown to the caller when ok is false. */
  reason?: string;
}

/** topPosition returns the highest role position a member holds, or 0. */
export function topPosition(roleIds: readonly string[], roles: readonly GuildRole[]): number {
  let top = 0;
  for (const id of roleIds) {
    const role = roles.find((r) => r.id === id);
    if (role && role.position > top) top = role.position;
  }
  return top;
}

/** guardTarget applies the five hierarchy rules and returns the first refusal. */
export function guardTarget(i: GuardInput): GuardResult {
  if (i.targetId === i.ownerId) return { ok: false, reason: "the server owner cannot be moderated" };
  if (i.targetId === i.actorId) return { ok: false, reason: "you cannot moderate yourself" };
  if (i.targetId === i.botUserId) return { ok: false, reason: "I cannot moderate myself" };
  if (i.targetTop >= i.botTop) {
    return { ok: false, reason: "the target's highest role is not below mine — move my role above theirs" };
  }
  if (!i.actorIsOwner && i.targetTop >= i.actorTop) {
    return { ok: false, reason: "the target's highest role is not below yours" };
  }
  return { ok: true };
}
