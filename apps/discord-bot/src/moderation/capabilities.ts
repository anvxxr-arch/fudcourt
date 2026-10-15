// The capability each moderation action requires.
//
// It lives next to the actions it guards instead of inside each command file, because a right-click
// Kick and a `/kick` are the SAME action reached two ways, and two hand-written lists of strings
// eventually disagree — the failure being that one of the two doors to a ban is unlocked. The
// context-menu factories derive from this map; the slash commands name the capability explicitly so it
// stays visible in the file a reader opens first, and a test asserts the two views agree.
//
// Actions with NO entry have no capability in the api's vocabulary yet (purge, lock, unlock, slowmode,
// nick): they remain guarded by the ModOnly precondition alone. That is a real gap and it is left
// visible rather than papered over — the api refuses to store a capability outside its vocabulary, so
// coining a name here would produce a grant that the dashboard cannot hand out and the resolver drops.

import type { ModAction } from "./service.ts";

export const ACTION_CAPABILITY: Partial<Record<ModAction, string>> = {
  kick: "moderation.kick",
  ban: "moderation.ban",
  timeout: "moderation.timeout",
  untimeout: "moderation.timeout",
  warn: "moderation.warn",
};

/** The capability for an action, if the vocabulary has one. */
export function capabilityFor(action: ModAction): string | undefined {
  return ACTION_CAPABILITY[action];
}
