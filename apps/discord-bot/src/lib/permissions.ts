// Discord permission bitfields.
//
// Two reasons this is its own module and not inline in the commands:
//
//  1. Permissions do not fit in a JS number. MANAGE_ROLES is bit 28 and
//     MODERATE_MEMBERS is bit 40, so the value overflows 2^31 — every check
//     goes through BigInt. A `number` bitwise AND would silently truncate and
//     report "allowed" for a permission the member does not hold.
//  2. Discord returns these as DECIMAL STRINGS (a snowflake-adjacent shape),
//     never as numbers, so parsing has to be defensive: an absent or garbage
//     value must fail CLOSED, not throw.

/** The permission bits this bot checks. Values are 1n << bit. */
export const Perm = {
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MODERATE_MEMBERS: 1n << 40n,
} as const;

/**
 * has reports whether a permissions bitfield string holds `bit`.
 *
 * ADMINISTRATOR implies every permission, so it short-circuits. A missing,
 * empty, or unparseable field yields false (fail closed) — the caller then
 * refuses with a permissions message rather than attempting the action.
 */
export function has(raw: string | undefined | null, bit: bigint): boolean {
  if (!raw) return false;
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return false;
  }
  if (value < 0n) return false;
  if ((value & Perm.ADMINISTRATOR) !== 0n) return true;
  return (value & bit) !== 0n;
}

/** union ORs every role's permission string — used for the bot's own rights. */
export function union(raws: ReadonlyArray<string | undefined | null>): bigint {
  let acc = 0n;
  for (const r of raws) {
    if (!r) continue;
    try {
      acc |= BigInt(r);
    } catch {
      /* skip an unparseable role permission */
    }
  }
  return acc;
}
