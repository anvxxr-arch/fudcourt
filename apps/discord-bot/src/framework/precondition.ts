// Precondition — a gate a command declares by name. The client runs each
// precondition before the command body and, on refusal, replies with the
// precondition's own message (ephemeral) instead of executing. This is
// Sapphire's precondition contract, kept deliberately small.

import type { CommandContext } from "./command.ts";

export interface PreconditionResult {
  ok: boolean;
  /** Shown to the caller when ok is false. */
  message?: string;
}

export const PASS: PreconditionResult = { ok: true };

export function fail(message: string): PreconditionResult {
  return { ok: false, message };
}

export interface PreconditionOptions {
  name: string;
  /** Optional: restrict to specific command names. Empty/omitted = applies to any command that names it. */
  appliesTo?: string[];
}

export abstract class Precondition {
  readonly name: string;
  readonly appliesTo: string[];

  constructor(opts: PreconditionOptions) {
    this.name = opts.name;
    this.appliesTo = opts.appliesTo ?? [];
  }

  /** runsFor reports whether this precondition should run for a command name. */
  runsFor(commandName: string): boolean {
    return this.appliesTo.length === 0 || this.appliesTo.includes(commandName);
  }

  abstract check(ctx: CommandContext): Promise<PreconditionResult> | PreconditionResult;
}
